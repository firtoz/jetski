import base64
import pathlib
import tempfile
import unittest
import uuid
from unittest.mock import patch
from commands import Commands, specification, worker_guard
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

    def test_bounded_wait_observes_completion_without_relaunch(self):
        self.commands.start(self.lease, self.command, ["true"])
        clock = [0.0]

        def finish(delay):
            clock[0] += delay
            with self.fence.locked():
                state = self.fence.read()
                state["commands"][self.command].update(phase="succeeded", exitCode=0)
                self.fence.write(state)

        with (
            patch("commands.time.monotonic", side_effect=lambda: clock[0]),
            patch("commands.time.sleep", side_effect=finish),
        ):
            result = self.commands.wait(self.lease, self.command, 250)
        self.assertEqual(result["phase"], "succeeded")
        self.assertEqual(self.commands.wait(self.lease, self.command, 0), result)
        self.assertEqual(self.launched, [self.command])

    def test_wait_timeout_and_uncertainty_never_admit_another_worker(self):
        self.commands.start(self.lease, self.command, ["true"])
        clock = [0.0]
        with (
            patch("commands.time.monotonic", side_effect=lambda: clock[0]),
            patch(
                "commands.time.sleep",
                side_effect=lambda delay: clock.__setitem__(0, clock[0] + delay),
            ),
        ):
            self.assertEqual(self.commands.wait(self.lease, self.command, 20)["phase"], "queued")
        self.assertLessEqual(clock[0], 0.021)
        for value in (-1, True, 1001, 1.5):
            with self.assertRaisesRegex(ValueError, "invalid_command_wait"):
                self.commands.wait(self.lease, self.command, value)
        with self.fence.locked():
            state = self.fence.read()
            state["commands"][self.command]["phase"] = "uncertain"
            self.fence.write(state)
        with patch(
            "commands.time.sleep", side_effect=AssertionError("must not wait for uncertainty")
        ):
            self.assertEqual(
                self.commands.wait(self.lease, self.command, 250)["phase"], "uncertain"
            )
        self.assertEqual(self.launched, [self.command])

    def test_quiesce_closes_admission_and_cancels_unstarted_commands(self):
        self.commands.start(self.lease, self.command, ["true"])
        self.commands.prepare_quiesce(self.lease)
        self.assertEqual(self.fence.read()["phase"], "closed")
        receipt = self.commands.status(self.lease, self.command)
        self.assertEqual(receipt["phase"], "cancelled")
        self.assertTrue(receipt["neverStarted"])
        with self.assertRaises(ValueError):
            self.commands.start(self.lease, str(uuid.uuid4()), ["true"])
        self.commands.prepare_quiesce(self.lease)

    def test_quiesce_waits_without_locking_out_worker_completion(self):
        self.commands.start(self.lease, self.command, ["true"])
        with worker_guard(self.fence, self.lease, self.command, create=True):
            with self.fence.locked():
                state = self.fence.read()
                state["commands"][self.command]["phase"] = "running"
                self.fence.write(state)

            def finish(_delay):
                with self.fence.locked():
                    state = self.fence.read()
                    self.assertEqual(state["phase"], "closed")
                    self.assertTrue(state["commands"][self.command]["cancelRequested"])
                    state["commands"][self.command]["phase"] = "cancelled"
                    self.fence.write(state)

            with patch("commands.time.sleep", side_effect=finish):
                self.commands.prepare_quiesce(self.lease)
            self.assertEqual(self.commands.status(self.lease, self.command)["phase"], "cancelled")

    def test_quiesce_timeout_preserves_cancel_intent_without_completion(self):
        self.commands.start(self.lease, self.command, ["true"])
        with worker_guard(self.fence, self.lease, self.command, create=True):
            with self.fence.locked():
                state = self.fence.read()
                state["commands"][self.command]["phase"] = "running"
                self.fence.write(state)
            with patch("commands.time.monotonic", side_effect=[0, 11]):
                with self.assertRaisesRegex(RuntimeError, "quiescence_pending"):
                    self.commands.prepare_quiesce(self.lease)
            receipt = self.commands.status(self.lease, self.command)
            self.assertEqual(receipt["phase"], "running")
            self.assertTrue(receipt["cancelRequested"])

    def test_quiesce_preserves_lost_worker_uncertainty(self):
        self.commands.start(self.lease, self.command, ["true"])
        with self.fence.locked():
            state = self.fence.read()
            state["commands"][self.command]["phase"] = "running"
            self.fence.write(state)
        self.commands.prepare_quiesce(self.lease)
        self.assertEqual(self.commands.status(self.lease, self.command)["phase"], "uncertain")

    def test_lost_running_worker_quarantines_without_replay(self):
        self.commands.start(self.lease, self.command, ["true"])
        with worker_guard(self.fence, self.lease, self.command, create=True) as acquired:
            self.assertTrue(acquired)
            with self.fence.locked():
                state = self.fence.read()
                state["commands"][self.command]["phase"] = "running"
                self.fence.write(state)
            self.assertEqual(self.commands.status(self.lease, self.command)["phase"], "running")
            with worker_guard(self.fence, self.lease, self.command, create=True) as duplicate:
                self.assertFalse(duplicate)
        restarted = Commands(Fence(self.fence.root), self.base / "outputs", self.launched.append)
        outcome = restarted.status(self.lease, self.command)
        self.assertEqual(outcome["phase"], "uncertain")
        self.assertEqual(outcome["reason"], "worker_lost")
        self.assertEqual(self.fence.read()["phase"], "quarantined")
        self.assertEqual(restarted.start(self.lease, self.command, ["true"]), outcome)
        self.assertEqual(self.launched, [self.command])
        with self.assertRaisesRegex(ValueError, "not_running"):
            restarted.start(self.lease, str(uuid.uuid4()), ["true"])
        with self.assertRaisesRegex(ValueError, "stale_lease"):
            restarted.status(dict(self.lease, generation=2), self.command)

    def test_missing_worker_guard_cannot_keep_command_running(self):
        self.commands.start(self.lease, self.command, ["true"])
        with self.fence.locked():
            state = self.fence.read()
            state["commands"][self.command]["phase"] = "running"
            self.fence.write(state)
        self.assertEqual(self.commands.status(self.lease, self.command)["reason"], "worker_lost")

    def test_terminal_geometry_is_validated_and_bound_to_identity(self):
        for rows, columns in [(0, 80), (True, 80), (24, 4097), (1.5, 80)]:
            with self.assertRaisesRegex(ValueError, "invalid_terminal_geometry"):
                self.commands.start(
                    self.lease, self.command, ["true"], terminal=True, rows=rows, columns=columns
                )
        self.assertEqual(self.launched, [])
        first = self.commands.start(
            self.lease, self.command, ["true"], terminal=True, rows=37, columns=101
        )
        self.assertEqual(first["spec"]["rows"], 37)
        self.assertEqual(
            self.commands.start(
                self.lease, self.command, ["true"], terminal=True, rows=37, columns=101
            ),
            first,
        )
        with self.assertRaisesRegex(ValueError, "identity_conflict"):
            self.commands.start(
                self.lease, self.command, ["true"], terminal=True, rows=38, columns=101
            )
        self.assertEqual(self.launched, [self.command])

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

    def test_queued_cancel_is_durable_and_never_quiesces_other_commands(self):
        self.commands.start(self.lease, self.command, ["true"])
        result = self.commands.cancel(self.lease, self.command, None)
        self.assertEqual(result["phase"], "cancelled")
        self.assertTrue(result["neverStarted"])
        restarted = Commands(
            Fence(self.base / "control"), self.base / "outputs", self.launched.append
        )
        self.assertEqual(restarted.cancel(self.lease, self.command, None), result)
        self.assertEqual(restarted.start(self.lease, self.command, ["true"]), result)
        self.assertEqual(self.launched, [self.command])
        with self.assertRaisesRegex(ValueError, "stale_lease"):
            restarted.cancel(dict(self.lease, generation=2), self.command, None)
        with self.assertRaises(ValueError):
            restarted.cancel(dict(self.lease, owner="other"), self.command, None)

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
