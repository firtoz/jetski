"""Local process fixture tests; not native runsc qualification."""

import pathlib
import os
import sys
import tempfile
import types
import unittest

from gvisor_exec import ExecApi
from gvisor_oci import RunscCommands


class ExecTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(
            prefix=".jetski-exec-test-", dir=pathlib.Path.home()
        )
        self.addCleanup(self.temp.cleanup)
        self.root = pathlib.Path(self.temp.name)
        runtime = self.root / "runtime"
        runtime.mkdir(mode=0o700)
        (runtime / "exec").mkdir(mode=0o700)
        script = 'import os,sys; nonce=sys.stdin.buffer.read(4); sys.stdout.buffer.write(nonce+b"\\x00\\xff"); sys.stdout.buffer.flush(); sys.stdin.buffer.read(); sys.stderr.buffer.write(b"closed"); sys.stderr.buffer.flush()'
        self.arguments = []

        def argv(args):
            self.arguments.append(args)
            return [sys.executable, "-c", script]

        self.environment = types.SimpleNamespace(
            root=runtime,
            account=types.SimpleNamespace(pw_uid=os.geteuid(), pw_gid=os.getegid()),
            commands=RunscCommands("/unexecuted/runsc", "/unexecuted/state"),
            argv=argv,
        )
        self.api = ExecApi(self.environment, self.root)
        self.container = "jetski-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa-g1"

    def test_binary_stream_close_and_start_replay(self):
        session = self.api.create(self.container, ["/jetski-supervisor"], stdin=True)

        def ready(close):
            close()

        chunks = list(self.api.output(session, initial_input=b"test", input_close_ready=ready))
        self.assertEqual(
            b"".join(data for channel, data in chunks if channel == "stdout"), b"test\0\xff"
        )
        self.assertEqual(
            b"".join(data for channel, data in chunks if channel == "stderr"), b"closed"
        )
        self.assertNotIn("--new-pidns", self.arguments[0])
        self.assertIn("exec", self.arguments[0])
        self.assertEqual(self.api.inspect(session), {"Running": False, "ExitCode": 0})
        self.api.remove(session)
        with self.assertRaisesRegex(ValueError, "already_dispatched"):
            list(self.api.output(session))

    def test_user_exit_code_is_not_confused_with_watchdog_timeout(self):
        self.environment.argv = lambda args: [sys.executable, "-c", "raise SystemExit(137)"]
        session = self.api.create(self.container, ["user-command"])
        self.assertEqual(list(self.api.output(session)), [])
        self.assertEqual(self.api.inspect(session), {"Running": False, "ExitCode": 137})

    def test_cancel_before_start_has_no_effect_and_missing_worker_is_uncertain(self):
        session = self.api.create(self.container, ["true"])
        self.api.remove(session)
        with self.assertRaisesRegex(ValueError, "already_dispatched"):
            list(self.api.output(session))
        with self.api.locked(session) as path:
            state = self.api.read(path)
            self.api.save(path, {**state, "phase": "running"})
        with self.assertRaisesRegex(ValueError, "completion_uncertain"):
            self.api.remove(session)
        self.assertTrue(self.api.inspect(session)["Running"])
