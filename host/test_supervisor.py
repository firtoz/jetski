"""Control-channel loss must not remove a host command's execution deadline."""

import json
import os
import pathlib
import signal
import subprocess
import sys
import tempfile
import time
import unittest
import types
from unittest.mock import patch, Mock

from supervisor import bounded_command, runtime_argv, runtime_control_argv


class SupervisorTests(unittest.TestCase):
    def test_control_uses_same_private_engine_and_rejects_unsafe_socket(self):
        account = types.SimpleNamespace(pw_uid=1002, pw_dir="/var/lib/jetski-runtime")
        connection = Mock()
        with patch("podman_exec.ExecApi.connection", return_value=connection):
            argv = runtime_control_argv(account)
        self.assertEqual(
            argv,
            runtime_argv(account) + ["--remote", "--url=unix:///run/user/1002/podman/podman.sock"],
        )
        connection.close.assert_called_once_with()
        with patch(
            "podman_exec.ExecApi.connection", side_effect=ValueError("unsafe_runtime_socket")
        ):
            with self.assertRaisesRegex(ValueError, "unsafe_runtime_socket"):
                runtime_control_argv(account)
        with self.assertRaisesRegex(ValueError, "invalid_runtime_uid"):
            runtime_control_argv(types.SimpleNamespace(pw_uid=0))

    def test_exact_output_and_nonzero_exit(self):
        with tempfile.TemporaryDirectory() as root:
            result = bounded_command(
                [
                    sys.executable,
                    "-c",
                    "import sys;print('hello');sys.stderr.write('error');sys.exit(7)",
                ],
                root,
            )
        self.assertEqual(result, dict(exitCode=7, stdout="hello\n", stderr="error"))

    def test_timeout_and_output_bound(self):
        with tempfile.TemporaryDirectory() as root:
            with self.assertRaisesRegex(TimeoutError, "host_command_timeout"):
                bounded_command(
                    [sys.executable, "-c", "import time;time.sleep(30)"], root, timeout=0.1
                )
            with self.assertRaisesRegex(ValueError, "host_command_output_limit"):
                bounded_command([sys.executable, "-c", "print('x'*4096)"], root, max_output=32)
            for timeout in (0, -1, float("nan"), float("inf")):
                with self.assertRaisesRegex(ValueError, "invalid_host_command_timeout"):
                    bounded_command([sys.executable, "-c", "pass"], root, timeout=timeout)

    def test_deadline_survives_control_process_death_and_kills_descendants(self):
        with tempfile.TemporaryDirectory() as root:
            receipt = pathlib.Path(root) / "processes.json"
            grandchild = (
                "import signal,time;signal.signal(signal.SIGTERM,signal.SIG_IGN);time.sleep(30)"
            )
            child = (
                "import os,json,pathlib,signal,subprocess,sys,time;"
                "signal.signal(signal.SIGTERM,signal.SIG_IGN);"
                f"p=subprocess.Popen([sys.executable,'-c',{grandchild!r}]);"
                f"pathlib.Path({str(receipt)!r}).write_text(json.dumps([os.getpid(),p.pid,os.getpgrp()]));"
                "time.sleep(30)"
            )
            parent = (
                f"import sys;sys.path.insert(0,{str(pathlib.Path(__file__).parent)!r});"
                "from supervisor import bounded_command, runtime_argv, runtime_control_argv;"
                f"bounded_command({[sys.executable, '-c', child]!r},{root!r},timeout=0.5)"
            )
            proc = subprocess.Popen([sys.executable, "-c", parent])
            try:
                deadline = time.monotonic() + 5
                while not receipt.exists() and time.monotonic() < deadline:
                    time.sleep(0.01)
                self.assertTrue(receipt.exists())
                child_pid, descendant_pid, _ = json.loads(receipt.read_text())
                proc.kill()
                proc.wait(timeout=5)

                def alive(pid):
                    status = pathlib.Path("/proc") / str(pid) / "stat"
                    try:
                        return status.read_text().split()[2] != "Z"
                    except FileNotFoundError:
                        return False

                deadline = time.monotonic() + 3
                while (alive(child_pid) or alive(descendant_pid)) and time.monotonic() < deadline:
                    time.sleep(0.02)
                self.assertFalse(alive(child_pid), "command outlived its independent deadline")
                self.assertFalse(alive(descendant_pid), "descendant escaped deadline cleanup")
            finally:
                if proc.poll() is None:
                    proc.kill()
                    proc.wait(timeout=5)
                if receipt.exists():
                    try:
                        os.killpg(json.loads(receipt.read_text())[2], signal.SIGKILL)
                    except ProcessLookupError:
                        pass


if __name__ == "__main__":
    unittest.main()
