"""Disposable CI only: qualify real rootless exec streams and independent removal."""

import concurrent.futures
import json
import os
import pathlib
import subprocess
import tempfile
import threading
import uuid
from fence import Fence
from runtime import PodmanRuntime
from podman_exec import ExecApi


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
        try:
            runtime.create(lease)
            binary = api.create(
                container,
                ["/jetski-supervisor", "/bin/sh", "-c", "printf 'a\\000b'; printf 'err\\377' >&2"],
            )
            sessions.append(binary)
            output = {"stdout": b"", "stderr": b""}
            for channel, chunk in api.output(binary, timeout=30):
                output[channel] += chunk
            assert output == {"stdout": b"a\0b", "stderr": b"err\xff"}, output
            assert api.inspect(binary)["ExitCode"] == 0
            api.remove(binary)
            api.remove(binary)
            victim = api.create(
                container,
                [
                    "/jetski-supervisor",
                    "/bin/sh",
                    "-c",
                    "sleep 120 & echo $! > /workspace/victim-child; printf ready; wait",
                ],
            )
            survivor = api.create(
                container,
                ["/jetski-supervisor", "/bin/sh", "-c", "printf live; sleep 3; printf survived"],
            )
            sessions.extend([victim, survivor])
            ready = {session: threading.Event() for session in (victim, survivor)}

            def consume(session):
                collected = b""
                for channel, chunk in api.output(session, timeout=40):
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
            assert child_check["exitCode"] == 0, "Cancelled session left a live descendant"
            assert api.inspect(survivor)["ExitCode"] == 0
            detached = api.create(
                container,
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
                for channel, chunk in api.output(detached, timeout=40):
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
            assert detached_check["exitCode"] == 0, "Detached descendant was not reaped"
            assert (
                run(["inspect", "--format", "{{.State.Running}}", container])["stdout"].strip()
                == "true"
            )
            assert run(["exec", container, "/bin/sh", "-c", "printf usable"])["stdout"] == "usable"
            print(
                json.dumps(
                    dict(
                        rootless=True,
                        binaryStreams=True,
                        independentSessionRemoval=True,
                        ordinaryDescendantReaped=True,
                        detachedDescendantReaped=True,
                        repeatedRemoval=True,
                        sandboxRemainsRunning=True,
                        commandApiIntegrated=False,
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
