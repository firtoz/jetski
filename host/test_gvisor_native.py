"""Lifecycle journal checks; the driver is deliberately not a native runtime."""

import unittest
import test_gvisor_lifecycle as fixture
from gvisor_native import GvisorRuntime, RunscDriver
from gvisor_oci import RunscCommands


class NativeJournalTests(unittest.TestCase):
    setUp = fixture.MemoryLifecycleTests.setUp

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
