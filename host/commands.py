"""Durable host command admission and bounded output cursors.

Workers outlive SSH connections. A running receipt is never automatically replayed
following a worker/host restart. Interim cancellation stops the entire assignment;
precise per-process signals and PTYs remain separate runtime capabilities.
"""

import base64
import json
import os
import pathlib
import signal
import resource
import subprocess
import sys
import time
import uuid

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))

from fence import Fence, identity  # noqa: E402

OUTPUT_BYTES = 16 * 1024 * 1024


def command_id(value):
    if not isinstance(value, str) or str(uuid.UUID(value)) != value:
        raise ValueError("invalid_command_id")
    return value


def specification(argv, cwd, timeout):
    if (
        not isinstance(argv, list)
        or not 1 <= len(argv) <= 256
        or any(not isinstance(arg, str) or "\0" in arg for arg in argv)
        or not argv[0]
    ):
        raise ValueError("invalid_command_argv")
    if len(json.dumps(argv).encode("utf8")) > 65536:
        raise ValueError("command_input_limit")
    path = pathlib.PurePosixPath(cwd)
    if (
        str(path) != cwd
        or ".." in path.parts
        or not any(
            path == root or path.is_relative_to(root)
            for root in (
                pathlib.PurePosixPath("/workspace"),
                pathlib.PurePosixPath("/home/sandbox"),
            )
        )
    ):
        raise ValueError("invalid_command_cwd")
    if type(timeout) is not int or not 1 <= timeout <= 3600:
        raise ValueError("invalid_command_timeout")
    return dict(argv=argv, cwd=cwd, timeout=timeout)


class Commands:
    def __init__(self, fence, root, launch):
        self.fence, self.root, self.launch = fence, pathlib.Path(root), launch

    def start(self, raw, command, argv, cwd="/workspace", timeout=120):
        lease = identity(raw)
        command_id(command)
        spec = specification(argv, cwd, timeout)
        with self.fence.locked():
            state = self.fence.read()
            self.fence.match(state, lease)
            commands = state.get("commands", {})
            previous = commands.get(command)
            if previous:
                if previous["spec"] != spec:
                    raise ValueError("command_identity_conflict")
                return previous
            if state["phase"] != "open" or state.get("runtime", {}).get("phase") != "running":
                raise ValueError("runtime_not_running")
            if len(commands) >= 256:
                raise ValueError("command_history_limit")
            receipt = dict(
                id=command, spec=spec, phase="queued", exitCode=None, cancelRequested=False
            )
            commands[command] = receipt
            self.fence.write({**state, "commands": commands})
            # The launch can be uncertain; leave the persisted queued receipt.
            # A reconnect observes it rather than launching a duplicate worker.
            self.launch(command)
            return receipt

    def status(self, raw, command):
        lease = identity(raw)
        command_id(command)
        with self.fence.locked():
            state = self.fence.read()
            self.fence.match(state, lease)
            receipt = state.get("commands", {}).get(command)
            if receipt is None:
                raise ValueError("unknown_command")
            return receipt

    def output(self, raw, command, channel, offset, count):
        lease = identity(raw)
        receipt = self.status(lease, command)
        if (
            channel not in ("stdout", "stderr")
            or type(offset) is not int
            or type(count) is not int
            or offset < 0
            or not 1 <= count <= 256 * 1024
        ):
            raise ValueError("invalid_output_cursor")
        path = self.root / lease["assignmentId"] / command / channel
        try:
            fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
        except FileNotFoundError:
            if offset:
                raise ValueError("output_cursor_beyond_end") from None
            return dict(
                base64="",
                nextOffset=0,
                terminal=receipt["phase"] in ("succeeded", "failed", "cancelled", "uncertain"),
            )
        with os.fdopen(fd, "rb") as source:
            size = os.fstat(source.fileno()).st_size
            if size > OUTPUT_BYTES or offset > size:
                raise ValueError("output_extent_invalid")
            source.seek(offset)
            data = source.read(count)
        return dict(
            base64=base64.b64encode(data).decode("ascii"),
            nextOffset=offset + len(data),
            terminal=receipt["phase"] in ("succeeded", "failed", "cancelled", "uncertain")
            and offset + len(data) == size,
        )

    def cancel(self, raw, command, runtime):
        lease = identity(raw)
        command_id(command)
        with self.fence.locked():
            state = self.fence.read()
            self.fence.match(state, lease)
            receipt = state.get("commands", {}).get(command)
            if receipt is None:
                raise ValueError("unknown_command")
            if receipt["phase"] in ("succeeded", "failed", "cancelled"):
                return receipt
            state["commands"][command] = {**receipt, "cancelRequested": True}
            self.fence.write(state)
        # Conservative cancellation: observe container stop, never infer remote
        # cancellation from termination of the local SSH/Podman client.
        runtime.quiesce(lease)
        return self.status(lease, command)


def worker(command):
    from supervisor import (
        CONTROL_ROOT,
        configuration,
        runtime_account,
        runtime_argv,
        bounded_command,
    )
    from runtime import PodmanRuntime

    command_id(command)
    config = configuration()
    account = runtime_account()
    fence = Fence(CONTROL_ROOT / "slot")
    with fence.locked():
        state = fence.read()
        receipt = state.get("commands", {}).get(command) if state else None
        if not receipt or receipt["phase"] != "queued":
            return
        lease = identity(state["lease"])
        if state["phase"] != "open" or receipt["cancelRequested"]:
            state["commands"][command] = {**receipt, "phase": "cancelled"}
            fence.write(state)
            return
        receipt = {**receipt, "phase": "running"}
        state["commands"][command] = receipt
        fence.write(state)
        image = state["runtime"]["image"]

    def run(args):
        return bounded_command(runtime_argv(account) + args, CONTROL_ROOT)

    runtime = PodmanRuntime(
        fence, run, image, pathlib.Path("/var/lib/jetski/data"), config["images"]
    )
    root = CONTROL_ROOT / "commands" / lease["assignmentId"] / command
    root.mkdir(parents=True, mode=0o700, exist_ok=False)
    spec = receipt["spec"]
    argv = runtime_argv(account) + [
        "exec",
        "--user",
        "1000:1000",
        "--workdir",
        spec["cwd"],
        "--",
        runtime.container(lease),
        *spec["argv"],
    ]
    phase, exit_code, reason = "uncertain", None, None
    proc = None
    try:
        with open(root / "stdout", "xb") as out, open(root / "stderr", "xb") as err:

            def output_limit():
                resource.setrlimit(resource.RLIMIT_FSIZE, (OUTPUT_BYTES, OUTPUT_BYTES))

            proc = subprocess.Popen(
                argv,
                stdin=subprocess.DEVNULL,
                stdout=out,
                stderr=err,
                start_new_session=True,
                preexec_fn=output_limit,
                env={"PATH": "/usr/bin:/bin", "LANG": "C.UTF-8"},
            )
            deadline = time.monotonic() + spec["timeout"]
            while proc.poll() is None:
                if (
                    max(os.fstat(out.fileno()).st_size, os.fstat(err.fileno()).st_size)
                    > OUTPUT_BYTES
                ):
                    reason = "output_limit"
                    break
                if time.monotonic() > deadline:
                    reason = "timeout"
                    break
                time.sleep(0.01)
            if max(os.fstat(out.fileno()).st_size, os.fstat(err.fileno()).st_size) >= OUTPUT_BYTES:
                reason = "output_limit"
            if proc.returncode is not None and proc.returncode < 0 and reason is None:
                reason = "exec_transport_terminated"
            if reason:
                runtime.quiesce(lease)
                proc.wait(timeout=20)
            exit_code = proc.returncode
            phase = "succeeded" if exit_code == 0 and reason is None else "failed"
            out.flush()
            err.flush()
            os.fsync(out.fileno())
            os.fsync(err.fileno())
    except BaseException:
        reason = "worker_failure"
        # Do not call this complete. Recovery must inspect the preserved state.
        try:
            runtime.quiesce(lease)
        except BaseException:
            pass
    finally:
        if proc and proc.poll() is None:
            os.killpg(proc.pid, signal.SIGKILL)
            proc.wait(timeout=10)
        with fence.locked():
            state = fence.read()
            fence.match(state, lease)
            current = state["commands"][command]
            if current["cancelRequested"] and state.get("runtime", {}).get("phase") == "stopped":
                phase = "cancelled"
            state["commands"][command] = {
                **current,
                "phase": phase,
                "exitCode": exit_code,
                "reason": reason,
            }
            fence.write(state)


if __name__ == "__main__":
    if len(sys.argv) != 2:
        raise SystemExit("worker_command_id_required")
    worker(sys.argv[1])
