"""One-shot native exec streams with durable identities and bounded cancellation.

Public commands use the trusted command supervisor; TCP uses the trusted relay.
Cancellation closes their private input and waits for native exit. A missing
worker or stuck process is uncertainty, never permission to signal a reused PID
or replay a command. The enclosing lifecycle quarantines such an assignment.
"""

import contextlib
import fcntl
import json
import os
import pathlib
import re
import select
import stat
import secrets
import selectors
import shutil
import subprocess
import threading
import time

from archive import sync_dir
from gvisor_environment import private_directory, write_json
from gvisor_oci import CONTAINER_PATTERN, process_spec
from podman_exec import session_id
from supervisor import CONTROL_ROOT

_ACTIVE = {}
_ACTIVE_LOCK = threading.Lock()


class ExecApi:
    def __init__(self, environment, control_root=CONTROL_ROOT):
        self.env = environment
        self.root = pathlib.Path(control_root) / "gvisor-exec"
        self.root.mkdir(mode=0o700, exist_ok=True)
        meta = self.root.lstat()
        if self.root.is_symlink() or meta.st_uid != os.geteuid() or meta.st_mode & 0o077:
            raise ValueError("unsafe_exec_journal")

    @contextlib.contextmanager
    def locked(self, session):
        path = self.root / session_id(session)
        meta = path.lstat()
        if (
            not path.is_dir()
            or path.is_symlink()
            or meta.st_uid != os.geteuid()
            or meta.st_mode & 0o077
        ):
            raise ValueError("unsafe_exec_journal")
        fd = os.open(path / "lock", os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
        try:
            fcntl.flock(fd, fcntl.LOCK_EX)
            yield path
        finally:
            os.close(fd)

    def read(self, path):
        fd = os.open(path / "state.json", os.O_RDONLY | os.O_NOFOLLOW)
        with os.fdopen(fd, "r") as source:
            meta = os.fstat(source.fileno())
            if (
                not stat.S_ISREG(meta.st_mode)
                or meta.st_uid != os.geteuid()
                or meta.st_mode & 0o077
                or meta.st_size > 128 * 1024
            ):
                raise ValueError("unsafe_exec_journal")
            return json.load(source)

    def save(self, path, value):
        fd = os.open(
            path / "state.next", os.O_WRONLY | os.O_CREAT | os.O_TRUNC | os.O_NOFOLLOW, 0o600
        )
        with os.fdopen(fd, "w") as target:
            json.dump(value, target)
            target.flush()
            os.fsync(target.fileno())
        os.replace(path / "state.next", path / "state.json")
        sync_dir(path)

    def create(self, container, argv, cwd="/workspace", tty=False, stdin=False):
        if (
            not isinstance(container, str)
            or not re.fullmatch(CONTAINER_PATTERN, container)
            or tty is not False
            or type(stdin) is not bool
        ):
            raise ValueError("unsupported_native_exec_configuration")
        process = process_spec(argv, cwd)
        identifier = secrets.token_hex(32)
        path = self.root / identifier
        path.mkdir(mode=0o700)
        sync_dir(self.root)
        runtime_path = private_directory(
            self.env.root / "exec" / identifier, self.env.account, create=True
        )
        write_json(runtime_path / "process.json", process, self.env.account)
        with self.locked(identifier):
            self.save(
                path,
                dict(
                    version=1,
                    phase="created",
                    container=container,
                    stdin=stdin,
                    process=str(runtime_path / "process.json"),
                    exitCode=None,
                ),
            )
        return identifier

    def inspect(self, session):
        with self.locked(session) as path:
            state = self.read(path)
        return dict(
            Running=state["phase"] in ("starting", "running", "uncertain"),
            ExitCode=state["exitCode"],
        )

    def remove(self, session):
        with self.locked(session) as path:
            state = self.read(path)
            if state["phase"] == "created":
                self.save(path, {**state, "phase": "cancelled"})
                return
            if state["phase"] in ("exited", "cancelled"):
                return
        with _ACTIVE_LOCK:
            active = _ACTIVE.get((str(self.root), session))
        if active is None:
            raise ValueError("native_exec_completion_uncertain")
        proc, close_input = active
        close_input()
        try:
            proc.wait(timeout=30)
        except subprocess.TimeoutExpired:
            raise ValueError("native_exec_cleanup_unconfirmed") from None
        # wait() is runsc's WaitPID completion, not merely EOF on stdout. The
        # command layer separately requires its authenticated tree-reaping proof.

    def output(
        self,
        session,
        timeout=150,
        initial_input=b"",
        on_started=None,
        input_ready=None,
        input_close_ready=None,
        abort_ready=None,
    ):
        if (
            type(timeout) not in (int, float)
            or not 0 < timeout <= 3700
            or not isinstance(initial_input, bytes)
            or len(initial_input) > 65536
        ):
            raise ValueError("invalid_native_exec_bounds")
        watchdog = shutil.which("timeout", path="/usr/bin:/bin")
        if watchdog is None:
            raise ValueError("host_command_watchdog_unavailable")
        with self.locked(session) as path:
            state = self.read(path)
            if state["phase"] != "created":
                raise ValueError("native_exec_start_already_dispatched")
            self.save(path, {**state, "phase": "starting"})
        arguments = self.env.commands.prefix() + [
            "exec",
            "--new-pidns",
            "--process=" + state["process"],
            state["container"],
        ]
        proc = None
        selector = selectors.DefaultSelector()
        input_lock = threading.Lock()
        deadline = time.monotonic() + timeout

        def send(data):
            if not isinstance(data, bytes) or len(data) > 65536:
                raise ValueError("native_exec_input_bound")
            with input_lock:
                if proc is None or proc.stdin.closed:
                    raise ValueError("native_exec_input_closed")
                # Bounded backpressure: a stalled workload holds this input lock
                # for at most one second, then the caller fails closed.
                input_deadline = min(deadline, time.monotonic() + 1)
                view = memoryview(data)
                while view:
                    try:
                        count = os.write(proc.stdin.fileno(), view)
                        view = view[count:]
                    except BlockingIOError:
                        remaining = input_deadline - time.monotonic()
                        if (
                            remaining <= 0
                            or not select.select([], [proc.stdin.fileno()], [], remaining)[1]
                        ):
                            raise ValueError("native_exec_input_backpressure") from None

        def close_input():
            with input_lock:
                if proc is not None and not proc.stdin.closed:
                    proc.stdin.close()

        try:
            proc = subprocess.Popen(
                [
                    watchdog,
                    "--signal=KILL",
                    "--kill-after=2s",
                    str(timeout) + "s",
                    *self.env.argv(arguments),
                ],
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                start_new_session=True,
                cwd="/",
                env={"PATH": "/usr/bin:/bin", "LANG": "C.UTF-8"},
                bufsize=0,
            )
            os.set_blocking(proc.stdin.fileno(), False)
            with _ACTIVE_LOCK:
                _ACTIVE[(str(self.root), session)] = (proc, close_input)
            with self.locked(session) as path:
                self.save(path, {**state, "phase": "running"})
            for channel, stream in (("stdout", proc.stdout), ("stderr", proc.stderr)):
                os.set_blocking(stream.fileno(), False)
                selector.register(stream, selectors.EVENT_READ, channel)
            if initial_input:
                send(initial_input)
            if input_ready is not None:
                input_ready(send)
            if input_close_ready is not None:
                input_close_ready(close_input)
            if abort_ready is not None:
                abort_ready(close_input)
            if on_started is not None:
                on_started()
            if not state["stdin"]:
                close_input()
            while selector.get_map():
                if time.monotonic() > deadline + 2:
                    raise TimeoutError("native_exec_stream_timeout")
                for key, _events in selector.select(timeout=0.1):
                    data = os.read(key.fileobj.fileno(), 65536)
                    if data:
                        yield key.data, data
                    else:
                        selector.unregister(key.fileobj)
            code = proc.wait(timeout=max(0.1, deadline + 2 - time.monotonic()))
            if code < 0 or time.monotonic() >= deadline:
                raise ValueError("native_exec_completion_uncertain")
            with self.locked(session) as path:
                self.save(path, {**state, "phase": "exited", "exitCode": code})
        except BaseException:
            with self.locked(session) as path:
                self.save(path, {**state, "phase": "uncertain"})
            raise
        finally:
            close_input()
            selector.close()
            if proc is not None:
                if proc.poll() is None:
                    # Do not signal a numeric PID or claim remote cleanup. The
                    # independent watchdog expires; lifecycle handles uncertainty.
                    try:
                        proc.wait(timeout=1)
                    except subprocess.TimeoutExpired:
                        pass
                proc.stdout.close()
                proc.stderr.close()
            with _ACTIVE_LOCK:
                _ACTIVE.pop((str(self.root), session), None)
