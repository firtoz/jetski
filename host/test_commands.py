import base64
import pathlib
import tempfile
import unittest
import uuid
from commands import Commands, specification
from fence import Fence


class CommandTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.base = pathlib.Path(self.temp.name)
        self.fence = Fence(self.base / "control")
        self.lease = dict(
            owner="alice",
            machineId="host",
            poolId="pool",
            slotId=str(uuid.uuid4()),
            sandboxId=str(uuid.uuid4()),
            assignmentId=str(uuid.uuid4()),
            generation=1,
        )
        self.fence.claim(self.lease)
        with self.fence.locked():
            state = self.fence.read()
            self.fence.write({**state, "runtime": dict(phase="running", name="container")})
        self.launched = []
        self.commands = Commands(self.fence, self.base / "outputs", self.launched.append)
        self.command = str(uuid.uuid4())

    def test_replay_and_new_controller_do_not_launch_again(self):
        original = self.commands.start(self.lease, self.command, ["printf", "hello"])
        restarted = Commands(
            Fence(self.base / "control"), self.base / "outputs", self.launched.append
        )
        self.assertEqual(restarted.start(self.lease, self.command, ["printf", "hello"]), original)
        self.assertEqual(self.launched, [self.command])
        with self.assertRaisesRegex(ValueError, "identity_conflict"):
            restarted.start(self.lease, self.command, ["printf", "changed"])

    def test_lost_worker_launch_ack_does_not_relaunch(self):
        def lost(_command):
            raise ConnectionError("lost")

        commands = Commands(self.fence, self.base / "outputs", lost)
        with self.assertRaises(ConnectionError):
            commands.start(self.lease, self.command, ["true"])
        self.assertEqual(self.commands.start(self.lease, self.command, ["true"])["phase"], "queued")
        self.assertEqual(self.launched, [])

    def test_binary_output_cursors_are_resumable(self):
        self.commands.start(self.lease, self.command, ["true"])
        folder = self.base / "outputs" / self.lease["assignmentId"] / self.command
        folder.mkdir(parents=True)
        payload = bytes(range(256)) * 3
        (folder / "stdout").write_bytes(payload)
        first = self.commands.output(self.lease, self.command, "stdout", 0, 31)
        second = self.commands.output(self.lease, self.command, "stdout", 31, 256 * 1024)
        self.assertEqual(
            base64.b64decode(first["base64"]) + base64.b64decode(second["base64"]), payload
        )
        self.assertEqual(second["nextOffset"], len(payload))
        self.assertFalse(second["terminal"])
        with self.assertRaisesRegex(ValueError, "extent_invalid"):
            self.commands.output(self.lease, self.command, "stdout", len(payload) + 1, 1)

    def test_stale_generation_and_closed_assignment_deny_new_commands(self):
        with self.assertRaisesRegex(ValueError, "stale_lease"):
            self.commands.start(dict(self.lease, generation=2), self.command, ["true"])
        self.fence.close(self.lease)
        with self.assertRaisesRegex(ValueError, "not_running"):
            self.commands.start(self.lease, self.command, ["true"])
        self.assertEqual(self.launched, [])

    def test_unresolved_commands_block_host_release(self):
        self.commands.start(self.lease, self.command, ["true"])
        self.fence.close(self.lease)
        with self.assertRaisesRegex(ValueError, "commands_unresolved"):
            self.fence.release(
                self.lease, lambda *_: True, dict(checkpointId=str(uuid.uuid4()), sha256="a" * 64)
            )

    def test_invalid_command_specs(self):
        for argv, cwd, timeout in [
            ([], "/workspace", 1),
            (["true"], "/workspace/../../etc", 1),
            (["a\0b"], "/workspace", 1),
            (["true"], "/workspace", True),
        ]:
            with self.assertRaises(ValueError):
                specification(argv, cwd, timeout)


if __name__ == "__main__":
    unittest.main()
