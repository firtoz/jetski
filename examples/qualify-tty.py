"""Owned disposable CI only: drive the CLI through a real local PTY."""

import errno
import fcntl
import os
import pathlib
import pty
import select
import signal
import struct
import subprocess
import sys
import termios
import time

if os.environ.get("GITHUB_ACTIONS") != "true":
    raise SystemExit("disposable_ci_required")
node, sandbox, terminal, attachment, directory, mode = sys.argv[1:]
master, slave = pty.openpty()
original = termios.tcgetattr(slave)
fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 40, 100, 0, 0))
process = subprocess.Popen(
    [
        node,
        "dist/cli.js",
        "terminal-attach",
        sandbox,
        terminal,
        "--id",
        attachment,
        "--state-dir",
        directory,
    ],
    stdin=slave,
    stdout=slave,
    stderr=subprocess.PIPE,
    start_new_session=True,
)
observed = bytearray()


def wait_for(marker, timeout=20):
    deadline = time.monotonic() + timeout
    while marker not in observed:
        assert time.monotonic() < deadline, "CLI output deadline"
        assert process.poll() is None, "CLI exited before expected output"
        if select.select([master], [], [], 0.1)[0]:
            try:
                observed.extend(os.read(master, 65536))
            except OSError as error:
                if error.errno != errno.EIO:
                    raise
                raise AssertionError("CLI PTY closed unexpectedly") from error
        assert len(observed) < 65536, "CLI output exceeded fixture bound"


try:
    deadline = time.monotonic() + 20
    while termios.tcgetattr(slave)[3] & termios.ICANON:
        assert time.monotonic() < deadline, "CLI did not enter raw mode"
        assert process.poll() is None, "CLI exited before raw mode"
        time.sleep(0.02)
    if mode == "detach":
        wait_for(b"ATTACH-READY")
        os.write(master, b"first\n")
        wait_for(b"FIRST-OK")
        os.write(master, b"\x1d")
    elif mode == "finish":
        fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 57, 123, 0, 0))
        os.kill(process.pid, signal.SIGWINCH)
        os.write(master, b"size\n")
        wait_for(b"57 123")
        os.write(master, b"second\n")
        wait_for(b"SIGNAL-READY")
        os.write(master, b"\x03")
        wait_for(b"INTERRUPTED")
    else:
        raise AssertionError("Unknown fixture mode")
    assert process.wait(timeout=20) == 0, "CLI attach failed"
    assert termios.tcgetattr(slave) == original, "CLI did not restore terminal attributes"
    state = pathlib.Path(directory) / "terminal.sqlite"
    assert state.is_file() and state.stat().st_mode & 0o077 == 0
    print("CLI PTY " + mode + " verified", flush=True)
finally:
    if process.poll() is None:
        process.terminate()
        try:
            process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait(timeout=5)
    if process.stderr:
        process.stderr.close()
    os.close(master)
    os.close(slave)
