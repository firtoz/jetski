"""Lifecycle journal checks; the driver is deliberately not a native runtime."""

import unittest
from unittest.mock import Mock, patch
import test_gvisor_lifecycle as fixture
from gvisor_native import GvisorRuntime, RunscDriver
from gvisor_oci import RunscCommands


class NativeJournalTests(unittest.TestCase):
    setUp = fixture.MemoryLifecycleTests.setUp

    def test_filesystem_import_cannot_start_a_process_when_memory_restore_is_required(self):
        state = self.fence.read()
        state["phase"] = "open"
        state.pop("runtime", None)
        state["import"] = {"phase": "ready", "portableMemoryRequired": True}
        self.fence.write(state)
        driver = Mock()
        runtime = GvisorRuntime(self.fence, driver, self.binding["image"], [self.binding["image"]])
        with self.assertRaisesRegex(ValueError, "portable_memory_restore_required"):
            runtime.create(self.lease)
        driver.create.assert_not_called()

    def test_failed_native_create_never_replays(self):
        state = self.fence.read()
        state.pop("runtime")
        self.fence.write(state)

        class Driver:
            creates = 0

            def container(self, lease):
                return "container"

            def create(self, *args):
                self.creates += 1
                raise ConnectionError("lost create ACK")

        driver = Driver()
        runtime = GvisorRuntime(self.fence, driver, self.binding["image"], [self.binding["image"]])
        with self.assertRaises(ConnectionError):
            runtime.create(self.lease)
        with self.assertRaisesRegex(ValueError, "closed_lease"):
            runtime.create(self.lease)
        self.assertEqual(driver.creates, 1)
        self.assertEqual(self.fence.read()["phase"], "quarantined")

    def test_stop_observes_asynchronous_termination_without_replaying_kill(self):
        driver = RunscDriver(Mock())
        driver.stopped = Mock(side_effect=[False, False, True])
        driver._checked = Mock(return_value="")
        with patch("gvisor_native.time.sleep") as sleep:
            driver.stop(self.lease)
        self.assertEqual(driver._checked.call_count, 1)
        sleep.assert_called_once_with(0.05)

    def test_verified_quiescence_cancels_streams_without_claiming_delivery(self):
        state = self.fence.read()
        self.fence.write({**state, "streams": {"relay": {"phase": "running"}}})
        driver = Mock()
        runtime = GvisorRuntime(self.fence, driver, self.binding["image"], [self.binding["image"]])
        runtime.quiesce(self.lease)
        saved = self.fence.read()
        self.assertEqual(saved["runtime"]["phase"], "stopped")
        self.assertEqual(saved["streams"]["relay"]["phase"], "cancelled")
        self.assertEqual(saved["streams"]["relay"]["delivery"], "unknown")
        driver.stop.assert_called_once_with(self.lease)

    def test_runtime_absence_requires_a_valid_inventory(self):
        class Environment:
            commands = RunscCommands("/opt/runsc", "/state")
            result = dict(exitCode=1, stdout="")

            def run(self, argv):
                return self.result

        env = Environment()
        driver = RunscDriver(env)
        with self.assertRaisesRegex(RuntimeError, "effect_unconfirmed"):
            driver.absent(self.lease)
        env.result = dict(exitCode=0, stdout="{}")
        with self.assertRaisesRegex(ValueError, "inventory_unavailable"):
            driver.absent(self.lease)
        env.result = dict(exitCode=0, stdout="[]")
        self.assertTrue(driver.absent(self.lease))

        env.result = dict(exitCode=0, stdout="null")
        self.assertTrue(driver.absent(self.lease))
