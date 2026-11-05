"""Exercise real foreground PTY signals, including kernels without TIOCSIG."""

import os
import pathlib
import select
import shutil
import signal
import struct
import subprocess
import tempfile
import time
import unittest


@unittest.skipUnless(shutil.which("cc"), "C compiler unavailable")
class NativeTerminalTests(unittest.TestCase):
    def test_signal_receipt_with_native_and_missing_ioctl(self):
        source = pathlib.Path(__file__).parent / "native" / "command-supervisor.c"
        with tempfile.TemporaryDirectory() as directory:
            for fallback in (False, True):
                wrapper = pathlib.Path(directory) / "wrapper.c"
                wrapper.write_text(
                    "#define _GNU_SOURCE\n#include <sys/ioctl.h>\n#include <errno.h>\n"
                    "#include <stdarg.h>\n"
                    "static int test_ioctl(int fd,unsigned long request,...){\n"
                    "va_list args;va_start(args,request);\n"
                    "if(request==TIOCSIG){va_end(args);errno=ENOTTY;return -1;}\n"
                    "void *arg=va_arg(args,void*);va_end(args);return ioctl(fd,request,arg);}\n"
                    "#define ioctl test_ioctl\n"
                    f'#include "{source.resolve()}"\n'
                )
                binary = pathlib.Path(directory) / "supervisor"
                subprocess.run(
                    [
                        "cc",
                        "-O2",
                        "-Wall",
                        "-Wextra",
                        "-Werror",
                        str(wrapper if fallback else source),
                        "-o",
                        str(binary),
                    ],
                    check=True,
                    capture_output=True,
                )
                process = subprocess.Popen(
                    [
                        str(binary),
                        "--jetski-pty-v1",
                        "24",
                        "80",
                        "/bin/sh",
                        "-ec",
                        "trap 'printf SIGNALLED; exit 0' INT; printf READY; while :; do sleep 1; done",
                    ],
                    stdin=subprocess.PIPE,
                    stdout=subprocess.PIPE,
                    stderr=subprocess.PIPE,
                    start_new_session=True,
                )
                try:
                    process.stdin.write(b"n" * 32)
                    process.stdin.flush()
                    output = b""
                    deadline = time.monotonic() + 5
                    while b"READY" not in output and time.monotonic() < deadline:
                        if select.select([process.stdout], [], [], 0.1)[0]:
                            output += os.read(process.stdout.fileno(), 4096)
                    self.assertIn(b"READY", output)
                    process.stdin.write(b"S" + struct.pack("!I", 1) + bytes([signal.SIGINT]))
                    process.stdin.flush()
                    self.assertEqual(process.wait(timeout=5), 0)
                    self.assertIn(b"SIGNALLED", process.stdout.read())
                    self.assertIn(
                        b"jetski-complete-v1:" + b"6e" * 32 + b":0:000", process.stderr.read()
                    )
                finally:
                    if process.poll() is None:
                        os.killpg(process.pid, signal.SIGKILL)
                        process.wait()
                    for stream in (process.stdin, process.stdout, process.stderr):
                        stream.close()

    def test_nonterminal_private_eof_cancels_and_authenticates_cleanup(self):
        source = pathlib.Path(__file__).parent / "native" / "command-supervisor.c"
        with tempfile.TemporaryDirectory() as directory:
            binary = pathlib.Path(directory) / "supervisor"
            subprocess.run(
                ["cc", "-O2", "-Wall", "-Wextra", "-Werror", str(source), "-o", str(binary)],
                check=True,
                capture_output=True,
            )
            process = subprocess.Popen(
                [str(binary), "--jetski-exec-v1", "/bin/sh", "-ec", "printf READY; sleep 30"],
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                start_new_session=True,
            )
            try:
                process.stdin.write(b"n" * 32)
                process.stdin.flush()
                self.assertTrue(select.select([process.stdout], [], [], 5)[0])
                self.assertEqual(os.read(process.stdout.fileno(), 5), b"READY")
                process.stdin.close()
                self.assertEqual(process.wait(timeout=5), 143)
                self.assertIn(
                    b"jetski-complete-v1:" + b"6e" * 32 + b":1:143", process.stderr.read()
                )
            finally:
                if process.poll() is None:
                    os.killpg(process.pid, signal.SIGKILL)
                    process.wait()
                for stream in (process.stdin, process.stdout, process.stderr):
                    stream.close()
