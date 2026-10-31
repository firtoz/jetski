"""Durable host command admission and bounded output cursors.

Workers outlive SSH connections. A running receipt is never automatically replayed
following a worker/host restart. Cancellation is durable intent; authenticated supervisor completion proves that
command descendants were reaped without stopping unrelated commands.
"""

import base64
import contextlib
import fcntl
import json
import os
import pathlib
import sys
import time
import uuid

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))

from fence import Fence, identity  # noqa: E402

OUTPUT_BYTES = 16 * 1024 * 1024
QUIESCE_COMMAND_SECONDS = 10


def command_id(value):
    if not isinstance(value, str) or str(uuid.UUID(value)) != value:
        raise ValueError("invalid_command_id")
    return value


@contextlib.contextmanager
def worker_guard(fence, lease, command, create=False):
    """Lifetime lock, private to the host and never inherited by child execs."""
    command_id(command)
    path = fence.root / (lease["assignmentId"] + "-" + command + ".worker")
    flags = os.O_RDWR | os.O_NOFOLLOW | os.O_CLOEXEC
    if create:
        flags |= os.O_CREAT
    try:
        fd = os.open(path, flags, 0o600)
    except FileNotFoundError:
        yield True
        return
    try:
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            yield False
            return
        yield True
    finally:
        os.close(fd)


def reconcile_workers_locked(fence, state):
    """Caller holds fence. An unlocked running worker has lost completion proof."""
    changed = False
    for command, receipt in state.get("commands", {}).items():
        if receipt["phase"] != "running":
            continue
        with worker_guard(fence, state["lease"], command) as absent:
            if absent:
                state["commands"][command] = {
                    **receipt,
                    "phase": "uncertain",
                    "exitCode": None,
                    "reason": "worker_lost",
                }
                state["phase"] = "quarantined"
                changed = True
    if changed:
        fence.write(state)
    return state


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

    def start(
        self, raw, command, argv, cwd="/workspace", timeout=120, terminal=False, rows=24, columns=80
    ):
        lease = identity(raw)
        command_id(command)
        spec = specification(argv, cwd, timeout)
        if type(terminal) is not bool:
            raise ValueError("invalid_terminal_mode")
        spec["terminal"] = terminal
        if terminal:
            if any(type(size) is not int or not 1 <= size <= 4096 for size in (rows, columns)):
                raise ValueError("invalid_terminal_geometry")
            spec.update(rows=rows, columns=columns)
        with self.fence.locked():
            state = self.fence.read()
            self.fence.match(state, lease)
            reconcile_workers_locked(self.fence, state)
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
            if terminal:
                from terminal_input import TerminalInputs

                TerminalInputs(self.fence, self.root.parent / "terminal-input").initialize_locked(
                    lease, command
                )
            commands[command] = receipt
            self.fence.write({**state, "commands": commands})
            # The launch can be uncertain; leave the persisted queued receipt.
            # A reconnect observes it rather than launching a duplicate worker.
            self.launch(command)
            return receipt

    def prepare_quiesce(self, raw):
        """Close admission, then let live supervisors finish before stopping their container.

        The fence lock must be released while waiting: workers need it to observe
        cancellation and persist authenticated completion/output synchronization.
        Uncertain receipts remain unchanged: container termination is still safe,
        but the control-plane publication gate must not treat them as completed work.
        """
        lease = identity(raw)
        self.fence.close(lease)
        deadline = time.monotonic() + QUIESCE_COMMAND_SECONDS
        while True:
            with self.fence.locked():
                state = self.fence.read()
                self.fence.match(state, lease)
                reconcile_workers_locked(self.fence, state)
                pending = False
                unresolved = False
                for command, receipt in state.get("commands", {}).items():
                    phase = receipt["phase"]
                    if phase == "queued":
                        state["commands"][command] = {
                            **receipt,
                            "phase": "cancelled",
                            "cancelRequested": True,
                            "neverStarted": True,
                        }
                    elif phase == "running":
                        state["commands"][command] = {**receipt, "cancelRequested": True}
                        pending = True
                    elif phase not in ("succeeded", "failed", "cancelled", "uncertain"):
                        unresolved = True
                self.fence.write(state)
                if unresolved:
                    raise RuntimeError("command_outcome_unresolved_before_quiesce")
                if not pending:
                    return
            if time.monotonic() >= deadline:
                raise RuntimeError("command_quiescence_pending")
            time.sleep(0.05)

    def status(self, raw, command):
        lease = identity(raw)
        command_id(command)
        with self.fence.locked():
            state = self.fence.read()
            self.fence.match(state, lease)
            reconcile_workers_locked(self.fence, state)
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
            reconcile_workers_locked(self.fence, state)
            receipt = state.get("commands", {}).get(command)
            if receipt is None:
                raise ValueError("unknown_command")
            if receipt["phase"] in ("succeeded", "failed", "cancelled"):
                return receipt
            state["commands"][command] = {**receipt, "cancelRequested": True}
            if receipt["phase"] == "queued":
                state["commands"][command].update(phase="cancelled", neverStarted=True)
            self.fence.write(state)
        return self.status(lease, command)


def worker(command, expected_lease):
    from supervisor import CONTROL_ROOT

    expected_lease = identity(expected_lease)
    command_id(command)
    fence = Fence(CONTROL_ROOT / "slot")
    with worker_guard(fence, expected_lease, command, create=True) as acquired:
        if not acquired:
            return
        run_worker(command, expected_lease, fence)


def run_worker(command, expected_lease, fence):
    import secrets
    import threading
    from podman_exec import ExecApi, CompletionDecoder
    from terminal_input import TerminalInputs
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
    api = ExecApi(account.pw_uid)
    with fence.locked():
        state = fence.read()
        fence.match(state, expected_lease)
        receipt = state.get("commands", {}).get(command) if state else None
        if not receipt or receipt["phase"] != "queued":
            return
        lease = identity(state["lease"])
        if state["phase"] != "open" or receipt["cancelRequested"]:
            state["commands"][command] = {**receipt, "phase": "cancelled", "neverStarted": True}
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
    spec = receipt["spec"]
    phase, exit_code, reason = "uncertain", None, None
    complete, started = threading.Event(), threading.Event()
    watcher = None
    session = None
    authenticated = False
    failure = []
    stop_reason = []
    failure_stage, failure_type = "prepare", None
    terminal_inputs = TerminalInputs(fence, CONTROL_ROOT / "terminal-input")
    input_sender, input_closer = [], []
    try:
        root.mkdir(parents=True, mode=0o700, exist_ok=False)
        nonce = secrets.token_bytes(32)
        # Nonce remains in this host worker's memory; never in public receipts.
        decoder = CompletionDecoder(nonce)
        failure_stage = "exec-create"
        geometry_args = [str(spec["rows"]), str(spec["columns"])] if spec["terminal"] else []
        session = api.create(
            runtime.container(lease),
            [
                "/jetski-supervisor",
                "--jetski-pty-v1" if spec["terminal"] else "--jetski-exec-v1",
                *geometry_args,
                *spec["argv"],
            ],
            spec["cwd"],
            stdin=True,
        )
        failure_stage = "start-intent"
        with fence.locked():
            state = fence.read()
            fence.match(state, lease)
            current = state["commands"][command]
            if current["cancelRequested"] or state["phase"] != "open":
                api.remove(session)
                phase, reason = "cancelled", "never_started"
                return
            state["commands"][command] = {
                **current,
                "execSession": session,
                "startDispatched": True,
            }
            fence.write(state)
        deadline = time.monotonic() + spec["timeout"]

        def send_terminal(data):
            if data[:1] == b"C" and not stop_reason:
                stop_reason.append("cancelled")
            input_sender[0](data)

        def monitor():
            try:
                while not complete.wait(0.05):
                    if not started.is_set():
                        continue
                    with fence.locked():
                        state = fence.read()
                        fence.match(state, lease)
                        requested = state["commands"][command]["cancelRequested"]
                    if requested or time.monotonic() >= deadline or stop_reason:
                        if not stop_reason:
                            stop_reason.append("cancelled" if requested else "timeout")
                        if input_closer:
                            input_closer[0]()
                        api.remove(session)
                        return
                    if spec["terminal"] and input_sender:
                        terminal_inputs.dispatch_one(lease, command, send_terminal)
            except BaseException:
                failure.append("command_stop_uncertain")
                if not stop_reason:
                    stop_reason.append("terminal_input_uncertain")
                try:
                    if input_closer:
                        input_closer[0]()
                    api.remove(session)
                except BaseException:
                    pass

        watcher = threading.Thread(target=monitor, daemon=True)
        watcher.start()
        with (
            open(root / "stdout", "xb", buffering=0) as out,
            open(root / "stderr", "xb", buffering=0) as err,
        ):
            outputs = {"stdout": out, "stderr": err}
            sizes = {"stdout": 0, "stderr": 0}
            failure_stage = "attach-stream"
            for channel, data in api.output(
                session,
                timeout=spec["timeout"] + 30,
                initial_input=nonce,
                on_started=started.set,
                input_ready=input_sender.append if spec["terminal"] else None,
                input_close_ready=input_closer.append if spec["terminal"] else None,
            ):
                if channel == "stderr":
                    data = decoder.feed(data)
                allowed = max(0, OUTPUT_BYTES - sizes[channel])
                outputs[channel].write(data[:allowed])
                sizes[channel] += len(data[:allowed])
                if len(data) > allowed and not stop_reason:
                    stop_reason.append("output_limit")
            failure_stage = "completion-proof"
            proof = decoder.finish()
            authenticated = True
            exit_code = proof["exitCode"]
            reason = stop_reason[0] if stop_reason else None
            if not proof["cancelled"] and reason == "cancelled":
                reason = None
            if proof["cancelled"] and reason == "cancelled":
                phase = "cancelled"
            elif exit_code == 0 and reason is None:
                phase = "succeeded"
            else:
                phase = "failed"
            failure_stage = "output-sync"
            for output in outputs.values():
                output.flush()
                os.fsync(output.fileno())
    except BaseException as error:
        failure_type = type(error).__name__
        phase, reason = "uncertain", "worker_failure"
        # An absent exec session/EOF is not proof of command-tree cleanup.
        try:
            runtime.quiesce(lease)
        except BaseException:
            pass
    finally:
        complete.set()
        if watcher is not None:
            watcher.join(timeout=35)
            if watcher.is_alive() or (failure and not authenticated):
                phase, reason = "uncertain", "command_stop_uncertain"
        with fence.locked():
            state = fence.read()
            fence.match(state, lease)
            current = state["commands"][command]
            state["commands"][command] = {
                **current,
                "phase": phase,
                "exitCode": exit_code,
                "reason": reason,
                "failureStage": failure_stage if failure_type else None,
                "failureType": failure_type,
            }
            if phase == "uncertain":
                state["phase"] = "quarantined"
            fence.write(state)


if __name__ == "__main__":
    if len(sys.argv) != 3:
        raise SystemExit("worker_command_id_required")
    worker(sys.argv[1], json.loads(sys.argv[2]))
