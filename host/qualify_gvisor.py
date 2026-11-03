"""Targeted disposable-CI native qualification. Never run on an operator host."""

import json
import os
import pathlib
import secrets
import shutil
import struct
import time
import uuid

from archive import capture, digest, restore, sync_dir
from fence import Fence
from gvisor_exec import ExecApi
from gvisor_environment import RootlessEnvironment
from gvisor_native import GvisorRuntime, RunscDriver
from memory_control import handle
from memory_filesystem import frozen_identity
from podman_exec import CompletionDecoder
from stream_protocol import Decoder
from supervisor import (
    configuration,
    runtime_account,
    CONTROL_ROOT,
    DATA_ROOT,
    ARCHIVE_ROOT,
    bounded_command,
    runtime_argv,
)
from test_archive import oracle


def main():
    if os.environ.get("GITHUB_ACTIONS") != "true" or os.geteuid() != 0:
        raise ValueError("disposable_root_ci_required")
    config, account = configuration(), runtime_account()
    image = config["images"][0]
    environment = RootlessEnvironment(account, [image], init_argv=config["workloadInit"])
    native_run = environment.run

    def diagnostic_run(arguments):
        result = native_run(arguments)
        if result["exitCode"]:
            # This guarded disposable fixture contains no provider credentials
            # or user workload; preserve bounded native errors for diagnosis.
            print(json.dumps({"nativeFailure": result}), flush=True)
        return result

    environment.run = diagnostic_run
    namespace_proof = bounded_command(
        runtime_argv(account)[:-1]
        + environment.namespace_argv
        + [
            "/bin/cat",
            "/proc/self/uid_map",
            "/proc/self/gid_map",
            "/proc/self/setgroups",
            "/proc/self/attr/current",
            "/proc/self/status",
        ],
        CONTROL_ROOT,
        timeout=20,
    )
    print(json.dumps({"namespaceProof": namespace_proof}), flush=True)
    driver, fence = RunscDriver(environment), Fence(CONTROL_ROOT / "native-qualification")
    lease = dict(
        owner="qualification",
        poolId=config["poolId"],
        machineId=config["machineId"],
        slotId=str(uuid.uuid4()),
        sandboxId=str(uuid.uuid4()),
        assignmentId=str(uuid.uuid4()),
        generation=1,
    )
    fence.claim(lease)
    runtime = GvisorRuntime(fence, driver, image, [image])
    identity = environment.ownership
    assignment = DATA_ROOT / lease["assignmentId"]
    assignment.mkdir(mode=0o711)
    roots = {name: assignment / name for name in ("workspace", "home")}
    for path in roots.values():
        path.mkdir(mode=0o700)
        os.chown(path, identity["workloadUid"], identity["workloadGid"])
    app = roots["workspace"] / "application"
    shutil.copyfile(os.environ["JETSKI_TEST_MEMORY_SERVER"], app)
    app.chmod(0o755)
    os.chown(app, identity["workloadUid"], identity["workloadGid"])
    file = roots["workspace"] / "bytes"
    file.write_bytes(b"unchanged\0bytes\xff" * 8192)
    file.chmod(0o640)
    os.chown(file, identity["workloadUid"], identity["workloadGid"])
    os.link(file, roots["home"] / "hard")
    (roots["home"] / "link").symlink_to("../workspace/bytes")
    api = ExecApi(environment)
    observed = []

    def command(argv, pty=False):
        nonce = secrets.token_bytes(32)
        process = (
            ["/jetski-supervisor", "--jetski-pty-v1", "31", "91", *argv]
            if pty
            else ["/jetski-supervisor", "--jetski-exec-v1", *argv]
        )
        session = api.create(runtime.container(lease), process, stdin=True)
        decoder = CompletionDecoder(nonce)
        result = {"stdout": b"", "stderr": b""}
        for channel, data in api.output(session, initial_input=nonce, timeout=40):
            if channel == "stderr":
                data = decoder.feed(data)
            result[channel] += data
        assert decoder.finish()["exitCode"] == 0, result
        return result

    def query():
        session = api.create(
            runtime.container(lease), ["/jetski-tcp-relay", "--jetski-tcp-v1", "8080"], stdin=True
        )
        request = b"GET / HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n"
        initial = b"D" + struct.pack(">I", len(request)) + request + b"F" + struct.pack(">I", 0)
        parser, response = Decoder(output=True), bytearray()
        for channel, data in api.output(session, initial_input=initial, timeout=40):
            assert channel == "stdout" or not data, data
            if channel == "stdout":
                for tag, payload in parser.feed(data):
                    if tag == b"D":
                        response.extend(payload[5:])
        status = api.inspect(session)
        assert status["ExitCode"] == 0, {
            "relayStatus": status,
            "response": bytes(response)[:1024].hex(),
        }
        parser.finish()
        assert api.inspect(session)["ExitCode"] == 0
        return json.loads(bytes(response).split(b"\r\n\r\n", 1)[1])

    class Backend:
        def memory_driver(self):
            return driver

    backend = Backend()
    current_lease = lease
    try:
        runtime.create(lease, 512, 1)
        result = command(
            ["/bin/sh", "-c", "test $(id -u) = 1000; printf 'a\\000b'; printf 'err\\377' >&2"]
        )
        assert result == {"stdout": b"a\0b", "stderr": b"err\xff"}, result
        terminal = command(["/bin/sh", "-c", "test -t 0; stty size; printf pty-ok"], pty=True)
        assert b"31 91" in terminal["stdout"] and b"pty-ok" in terminal["stdout"], terminal
        original = result
        deadline = time.monotonic() + 30
        while True:
            try:
                before = query()
                break
            except (AssertionError, ValueError):
                if time.monotonic() >= deadline:
                    raise
                time.sleep(0.1)
        assert before["heapBytes"] == 64 * 1024 * 1024, before
        checkpoint = str(uuid.uuid4())
        payload = dict(lease=lease, image=image, checkpointId=checkpoint)
        handle("memory-freeze", payload, fence, backend, ARCHIVE_ROOT, DATA_ROOT)
        physical = frozen_identity(roots)
        snapshot = oracle(assignment)
        receipt = capture(
            roots, ARCHIVE_ROOT / (lease["assignmentId"] + ".tgz"), frame_bytes=262144
        )
        fence.write(
            {
                **fence.read(),
                "checkpoint": receipt,
                "memory": {**fence.read()["memory"], "captureFrameBytes": 262144},
            }
        )
        # Independent control-plane storage directory. This is local durability
        # qualification; real R2 and physical replacement belong to hosted runs.
        durable = CONTROL_ROOT / "independent-store.tgz"
        shutil.copyfile(ARCHIVE_ROOT / (lease["assignmentId"] + ".tgz"), durable)
        with durable.open("rb") as source:
            os.fsync(source.fileno())
        sync_dir(durable.parent)
        assert digest(durable) == receipt["sha256"]
        payload["publication"] = dict(checkpointId=checkpoint, sha256=receipt["sha256"])
        sealed = handle("memory-seal", payload, fence, backend, ARCHIVE_ROOT, DATA_ROOT)
        payload["memorySha256"] = sealed["sha256"]
        successor = {**lease, "generation": 2}
        resumed = handle(
            "memory-resume",
            {**payload, "nextLease": successor},
            fence,
            backend,
            ARCHIVE_ROOT,
            DATA_ROOT,
        )
        assert resumed["memoryPreserved"]
        current_lease = successor
        lease = successor
        after = query()
        assert before["token"] == after["token"] and after["counter"] == before["counter"] + 1, (
            before,
            after,
        )
        assert snapshot == oracle(assignment)
        assert physical == frozen_identity(roots)
        assert original == command(
            ["/bin/sh", "-c", "test $(id -u) = 1000; printf 'a\\000b'; printf 'err\\377' >&2"]
        )
        runtime.quiesce(lease)
        runtime.remove(lease)
        assert runtime.absent(lease)
        shutil.rmtree(assignment)
        restore(durable, assignment, receipt["sha256"])
        assert snapshot == oracle(assignment)
        observed.append(
            dict(
                nativeRuntime=True,
                rootless=True,
                memoryContinuity=True,
                heapBytes=after["heapBytes"],
                filesystemExact=True,
                pty=True,
                tcp=True,
                sourceDeleted=True,
                replacementHost=False,
                r2=False,
                release=config["runtime"]["release"],
            )
        )
        print(json.dumps(observed))
    except Exception:
        state_result = environment.run(environment.commands.command("state", current_lease))
        limits = environment.limits_path(current_lease)
        diagnostics = {"state": state_result, "expectedCgroup": str(limits)}
        diagnostics["limits"] = {
            name: (limits / name).read_text()
            for name in ("memory.max", "cpu.max", "pids.max", "cgroup.procs")
            if (limits / name).exists()
        }
        if state_result["exitCode"] == 0:
            observed_state = json.loads(state_result["stdout"])
            if observed_state.get("status") == "stopped":
                diagnostics["exit"] = environment.run(
                    environment.commands.prefix() + ["wait", runtime.container(current_lease)]
                )
            pid = json.loads(state_result["stdout"]).get("pid")
            proc = pathlib.Path("/proc", str(pid), "cgroup")
            diagnostics["actualCgroup"] = proc.read_text() if proc.exists() else "process absent"
        diagnostics["inventory"] = environment.run(
            environment.commands.prefix() + ["list", "--format=json"]
        )
        print(json.dumps({"nativeDiagnostics": diagnostics}), flush=True)
        raise
    finally:
        # Only positively owned identities of this disposable qualification.
        for candidate in (
            current_lease,
            {**current_lease, "generation": 1},
            {**current_lease, "generation": 2},
        ):
            if driver.absent(candidate):
                continue
            driver.stop(candidate)
            driver.remove(candidate)
        if assignment.exists():
            shutil.rmtree(assignment)


if __name__ == "__main__":
    main()
