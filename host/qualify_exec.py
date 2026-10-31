"""Disposable CI only: qualify real rootless exec streams and independent removal."""

import concurrent.futures
import json
import os
import pathlib
import secrets
import struct
import time
import subprocess
import tempfile
import threading
import uuid
from fence import Fence
from runtime import PodmanRuntime
from podman_exec import ExecApi, CompletionDecoder


def main():
    if os.environ.get("GITHUB_ACTIONS") != "true" or os.geteuid() == 0:
        raise ValueError("disposable_nonroot_ci_required")
    image = os.environ["JETSKI_TEST_IMAGE"]
    api = ExecApi(os.getuid())
    supervisor = pathlib.Path(os.environ["JETSKI_TEST_SUPERVISOR"]).resolve()
    if not supervisor.is_file():
        raise ValueError("missing_supervisor_fixture")

    def run(args):
        if args[0] == "run":
            # Fixture-only mount: public runtime wiring follows qualification.
            args = [
                *args[:1],
                "--mount",
                f"type=bind,src={supervisor},dst=/jetski-supervisor,ro",
                *args[1:],
            ]
        proc = subprocess.run(["podman", *args], capture_output=True, text=True, timeout=120)
        return dict(exitCode=proc.returncode, stdout=proc.stdout, stderr=proc.stderr)

    subprocess.run(["systemctl", "--user", "start", "podman.socket"], check=True, timeout=30)
    with tempfile.TemporaryDirectory(prefix="jetski-exec-") as directory:
        base = pathlib.Path(directory)
        fence = Fence(base / "control")
        lease = dict(
            owner="qualification",
            poolId="test",
            machineId="ci",
            slotId=str(uuid.uuid4()),
            sandboxId=str(uuid.uuid4()),
            assignmentId=str(uuid.uuid4()),
            generation=1,
        )
        fence.claim(lease)
        data = base / "data"
        for name in ("workspace", "home"):
            (data / lease["assignmentId"] / name).mkdir(parents=True)
        runtime = PodmanRuntime(fence, run, image, data, [image])
        container = runtime.container(lease)
        sessions = []

        nonces, completions = {}, {}

        def create(argv):
            session = api.create(container, argv, stdin=True)
            nonces[session] = secrets.token_bytes(32)
            return session

        def output(session, timeout=40):
            decoder = CompletionDecoder(nonces[session])
            for channel, chunk in api.output(
                session, timeout=timeout, initial_input=nonces[session]
            ):
                if channel == "stderr":
                    chunk = decoder.feed(chunk)
                if chunk:
                    yield channel, chunk
            completions[session] = decoder.finish()

        try:
            runtime.create(lease)
            binary = create(
                [
                    "/jetski-supervisor",
                    "/bin/sh",
                    "-c",
                    "test $(wc -c) = 0; printf 'a\\000b'; printf 'err\\377' >&2",
                ],
            )
            sessions.append(binary)
            binary_output = {"stdout": b"", "stderr": b""}
            for channel, chunk in output(binary, timeout=30):
                binary_output[channel] += chunk
            assert binary_output == {"stdout": b"a\0b", "stderr": b"err\xff"}, binary_output
            assert completions[binary] == dict(cancelled=False, exitCode=0, descendantsReaped=True)
            assert api.inspect(binary)["ExitCode"] == 0
            killed = create(
                ["/jetski-supervisor", "/bin/sh", "-c", "printf killed; kill -KILL $PPID"]
            )
            sessions.append(killed)
            try:
                list(output(killed, timeout=30))
            except ValueError as error:
                assert "completion_unconfirmed" in str(error)
            else:
                raise AssertionError("Killed supervisor falsely reported clean completion")
            assert killed not in completions
            api.remove(binary)
            api.remove(binary)
            victim = create(
                [
                    "/jetski-supervisor",
                    "/bin/sh",
                    "-c",
                    "sleep 120 & echo $! > /workspace/victim-child; printf ready; wait",
                ],
            )
            survivor = create(
                ["/jetski-supervisor", "/bin/sh", "-c", "printf live; sleep 3; printf survived"],
            )
            sessions.extend([victim, survivor])
            ready = {session: threading.Event() for session in (victim, survivor)}

            def consume(session):
                collected = b""
                for channel, chunk in output(session, timeout=40):
                    assert channel == "stdout"
                    collected += chunk
                    ready[session].set()
                return collected

            with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
                victim_output = pool.submit(consume, victim)
                survivor_output = pool.submit(consume, survivor)
                assert ready[victim].wait(15) and ready[survivor].wait(15)
                assert api.inspect(victim)["Running"] is True
                assert api.inspect(survivor)["Running"] is True
                api.remove(victim)
                api.remove(victim)
                assert victim_output.result(timeout=20) == b"ready"
                assert survivor_output.result(timeout=20) == b"livesurvived"
            child_check = run(
                [
                    "exec",
                    container,
                    "/bin/sh",
                    "-c",
                    "test ! -e /proc/$(cat /workspace/victim-child)/stat",
                ]
            )
            assert completions[victim] == dict(cancelled=True, exitCode=143, descendantsReaped=True)
            assert child_check["exitCode"] == 0, "Cancelled session left a live descendant"
            assert api.inspect(survivor)["ExitCode"] == 0
            detached = create(
                [
                    "/jetski-supervisor",
                    "/bin/sh",
                    "-c",
                    "setsid sh -c 'sleep 120 & echo $! > /workspace/detached-child; exit 0' >/dev/null 2>&1 & wait; printf detached",
                ],
            )
            sessions.append(detached)
            detached_ready = threading.Event()

            def detached_stream():
                data = b""
                for channel, chunk in output(detached, timeout=40):
                    assert channel == "stdout"
                    data += chunk
                    detached_ready.set()
                return data

            with concurrent.futures.ThreadPoolExecutor(max_workers=1) as pool:
                stream = pool.submit(detached_stream)
                assert detached_ready.wait(15)
                assert api.inspect(detached)["Running"] is True
                api.remove(detached)
                assert stream.result(timeout=20) == b"detached"
            detached_check = run(
                [
                    "exec",
                    container,
                    "/bin/sh",
                    "-c",
                    "test ! -e /proc/$(cat /workspace/detached-child)/stat",
                ]
            )
            assert completions[detached] == dict(
                cancelled=True, exitCode=143, descendantsReaped=True
            )
            assert detached_check["exitCode"] == 0, "Detached descendant was not reaped"
            assert (
                run(["inspect", "--format", "{{.State.Running}}", container])["stdout"].strip()
                == "true"
            )
            assert run(["exec", container, "/bin/sh", "-c", "printf usable"])["stdout"] == "usable"

            def terminal(argv, exercise):
                session = create(["/jetski-supervisor", "--jetski-pty-v1", *argv])
                sessions.append(session)
                ready = threading.Event()
                senders = []
                observed = bytearray()
                decoder = CompletionDecoder(nonces[session])

                def input_ready(send):
                    senders.append(send)
                    ready.set()

                def consume():
                    for channel, chunk in api.output(
                        session, timeout=40, initial_input=nonces[session], input_ready=input_ready
                    ):
                        if channel == "stderr":
                            assert decoder.feed(chunk) == b"", "Private control data leaked"
                        else:
                            observed.extend(chunk)
                    return decoder.finish()

                with concurrent.futures.ThreadPoolExecutor(max_workers=1) as executor:
                    future = executor.submit(consume)
                    assert ready.wait(10), "Terminal attach did not become ready"

                    def wait_for(marker):
                        deadline = time.monotonic() + 10
                        while marker not in observed:
                            if future.done():
                                future.result()
                                raise AssertionError("Terminal exited before expected output")
                            if time.monotonic() >= deadline:
                                raise AssertionError(
                                    "Terminal output deadline: " + repr(bytes(observed))
                                )
                            time.sleep(0.01)

                    def send(kind, payload=b""):
                        senders[0](kind + struct.pack(">I", len(payload)) + payload)

                    exercise(wait_for, send)
                    proof = future.result(timeout=15)
                    return bytes(observed), proof

            def interaction(wait_for, send):
                wait_for(b"READY")
                send(b"R", struct.pack(">HH", 40, 100))
                send(b"I", b"terminal-input\n")
                wait_for(b"SIGNAL-READY")
                send(b"S", bytes([2]))

            rendered, proof = terminal(
                [
                    "/bin/sh",
                    "-ec",
                    "test -t 0; test -t 1; test -t 2; stty -echo; "
                    "printf READY; IFS= read -r line; printf 'LINE:%s\\n' \"$line\"; stty size; "
                    "trap 'printf SIGNAL; exit 0' INT; printf SIGNAL-READY; while :; do sleep 1; done",
                ],
                interaction,
            )
            assert b"LINE:terminal-input\r\n40 100\r\n" in rendered, rendered
            assert rendered.endswith(b"SIGNAL"), rendered
            assert proof == dict(cancelled=False, exitCode=0, descendantsReaped=True), proof

            def binary_input(wait_for, send):
                wait_for(b"RAW-READY")
                send(b"I", b"\0\xff\r")

            rendered, proof = terminal(
                ["/bin/sh", "-ec", "stty raw -echo; printf RAW-READY; dd bs=1 count=3 2>/dev/null"],
                binary_input,
            )
            assert rendered == b"RAW-READY\0\xff\r", rendered
            assert proof == dict(cancelled=False, exitCode=0, descendantsReaped=True), proof

            def close_terminal(wait_for, send):
                wait_for(b"CLOSE-READY")
                send(b"C")

            _, proof = terminal(
                ["/bin/sh", "-ec", "printf CLOSE-READY; sleep 120 & wait"], close_terminal
            )
            assert proof == dict(cancelled=True, exitCode=143, descendantsReaped=True), proof
            print(
                json.dumps(
                    dict(
                        rootless=True,
                        binaryStreams=True,
                        authenticatedCompletion=True,
                        killedSupervisorRejected=True,
                        independentSessionRemoval=True,
                        ordinaryDescendantReaped=True,
                        detachedDescendantReaped=True,
                        repeatedRemoval=True,
                        sandboxRemainsRunning=True,
                        commandApiIntegrated=False,
                        nativePtyInputResizeSignalClose=True,
                        nativePtyBinaryInput=True,
                        terminalApiIntegrated=False,
                    )
                ),
                flush=True,
            )
        finally:
            for session in sessions:
                try:
                    api.remove(session)
                except Exception:
                    pass
            run(["rm", "--force", "--ignore", container])
            if run(["container", "exists", container])["exitCode"] != 1:
                raise RuntimeError("exec_fixture_cleanup_unconfirmed")
            subprocess.run(
                ["systemctl", "--user", "stop", "podman.socket", "podman.service"],
                check=True,
                timeout=30,
            )


if __name__ == "__main__":
    main()
