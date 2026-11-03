"""Composition tests use a driver double; not native gVisor qualification."""

import copy
import os
import pathlib
import tempfile
import unittest
import uuid

from fence import Fence
from gvisor_lifecycle import MemoryLifecycle


class Driver:
    def __init__(self, path, compatibility):
        self.path = path
        self.config = compatibility
        self.freezes, self.restores = 0, 0
        self.active = True
        self.fail_freeze = self.fail_restore = False

    def container(self, lease):
        return f"test-g{lease['generation']}"

    def checkpoint(self, lease, checkpoint_id):
        self.freezes += 1
        self.active = False
        (self.path / "pages.img").write_bytes(b"memory pages")
        (self.path / "pages.img").chmod(0o600)
        if self.fail_freeze:
            raise ConnectionError("lost acknowledgement")

    def stopped(self, lease):
        return not self.active

    def memory_path(self, lease, checkpoint_id):
        return self.path

    def memory_owner(self):
        return os.geteuid()

    def restore(self, previous, successor, checkpoint_id):
        self.restores += 1
        self.active = True
        if self.fail_restore:
            raise ConnectionError("lost acknowledgement")

    def running(self, lease):
        return self.active

    def compatibility(self, lease):
        return self.config


class MemoryLifecycleTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        root = pathlib.Path(self.temp.name)
        self.fence = Fence(root / "control")
        self.lease = dict(
            owner="owner",
            poolId="pool",
            machineId="machine",
            slotId=str(uuid.uuid4()),
            sandboxId=str(uuid.uuid4()),
            assignmentId=str(uuid.uuid4()),
            generation=1,
        )
        self.successor = {**self.lease, "generation": 2}
        self.id = str(uuid.uuid4())
        self.binding = dict(
            version=1,
            lease=self.lease,
            checkpointId=self.id,
            filesystemSha256="a" * 64,
            filesystemIdentitySha256="f" * 64,
            runtimeSha256="b" * 64,
            image="example/linux@sha256:" + "c" * 64,
            configurationSha256="d" * 64,
            platform="systrap",
            kernelVersion="test",
            cpuFeaturesSha256="e" * 64,
        )
        compatibility = {
            key: self.binding[key]
            for key in (
                "runtimeSha256",
                "image",
                "configurationSha256",
                "platform",
                "kernelVersion",
                "cpuFeaturesSha256",
            )
        }
        memory = root / "memory"
        memory.mkdir(mode=0o700)
        self.driver = Driver(memory, compatibility)
        self.life = MemoryLifecycle(self.fence, self.driver)
        self.fence.claim(self.lease)
        self.fence.write(
            {
                **self.fence.read(),
                "runtime": {"phase": "running"},
                "commands": {"original": {"phase": "succeeded", "outputSha256": "f" * 64}},
            }
        )

    def frozen(self):
        self.life.freeze(self.lease, self.id)
        # Stand-in for independently captured, frozen filesystem receipt.
        self.fence.write({**self.fence.read(), "checkpoint": {"sha256": "a" * 64}})

    def sealed(self):
        self.frozen()
        self.life.seal(self.lease, self.id, self.binding, lambda binding: True)

    def resume(self, filesystem=lambda binding: True, publication=lambda binding: True):
        return self.life.resume(
            self.lease, self.successor, self.id, self.binding, filesystem, publication
        )

    def test_successor_fences_old_writes_and_preserves_original_output_identity(self):
        self.sealed()
        original = copy.deepcopy(self.fence.read()["commands"])
        resumed = self.resume()
        self.assertEqual(resumed, self.resume())
        self.assertEqual(self.driver.restores, 1)
        self.assertEqual(self.fence.read()["commands"], original)
        self.assertEqual(self.fence.read()["lease"], self.successor)
        with self.assertRaisesRegex(ValueError, "slot_not_released"):
            self.fence.claim(self.lease)
        with self.assertRaisesRegex(ValueError, "stale_lease"):
            self.fence.close(self.lease)

    def test_busy_command_stream_and_upload_do_not_close_or_freeze(self):
        for key, row in (
            ("commands", {"phase": "uncertain"}),
            ("streams", {"phase": "open"}),
            ("uploads", {"phase": "receiving"}),
        ):
            before = self.fence.read()
            self.fence.write({**before, key: {"busy": row}})
            with self.assertRaisesRegex(ValueError, "memory_requires"):
                self.life.freeze(self.lease, self.id)
            self.assertEqual(self.fence.read()["phase"], "open")
            self.assertEqual(self.driver.freezes, 0)
            self.fence.write(before)

    def test_lost_freeze_ack_is_quarantined_and_never_replayed(self):
        self.driver.fail_freeze = True
        with self.assertRaises(ConnectionError):
            self.life.freeze(self.lease, self.id)
        self.assertEqual(self.fence.read()["phase"], "quarantined")
        with self.assertRaisesRegex(ValueError, "effect_uncertain"):
            self.life.freeze(self.lease, self.id)
        self.assertEqual(self.driver.freezes, 1)

    def test_unpublished_filesystem_cannot_seal_or_resume(self):
        self.frozen()
        with self.assertRaisesRegex(ValueError, "durable_publication_unconfirmed"):
            self.life.seal(self.lease, self.id, self.binding, lambda binding: False)
        self.assertEqual(self.fence.read()["memory"]["phase"], "frozen")
        self.life.seal(self.lease, self.id, self.binding, lambda binding: True)
        with self.assertRaisesRegex(ValueError, "durable_publication_unconfirmed"):
            self.resume(publication=lambda binding: False)
        with self.assertRaisesRegex(ValueError, "filesystem_mismatch"):
            self.resume(filesystem=lambda binding: False)
        self.assertEqual(self.driver.restores, 0)

    def test_restart_observes_sealed_and_resumed_outcomes(self):
        self.sealed()
        self.life = MemoryLifecycle(Fence(self.fence.root), self.driver)
        self.life.freeze(self.lease, self.id)
        self.life.seal(self.lease, self.id, self.binding, lambda binding: True)
        self.resume()
        self.life = MemoryLifecycle(Fence(self.fence.root), self.driver)
        self.resume()
        self.assertEqual((self.driver.freezes, self.driver.restores), (1, 1))

    def test_lost_restore_ack_cannot_execute_restore_twice(self):
        self.sealed()
        self.driver.fail_restore = True
        with self.assertRaises(ConnectionError):
            self.resume()
        self.assertEqual(self.fence.read()["phase"], "quarantined")
        with self.assertRaisesRegex(ValueError, "memory_not_sealed"):
            self.resume()
        self.assertEqual(self.driver.restores, 1)

    def test_corruption_and_runtime_change_refuse_before_restore(self):
        self.sealed()
        self.driver.config = {**self.driver.config, "kernelVersion": "changed"}
        with self.assertRaisesRegex(ValueError, "runtime_incompatible"):
            self.resume()
        self.driver.config["kernelVersion"] = "test"
        (self.driver.path / "pages.img").write_bytes(b"corrupt data")
        with self.assertRaisesRegex(ValueError, "image_integrity"):
            self.resume()
        self.assertEqual(self.driver.restores, 0)

    def test_owner_or_generation_substitution_refused_before_effect(self):
        self.sealed()
        for next_lease in (
            {**self.successor, "owner": "other"},
            {**self.successor, "generation": 3},
        ):
            with self.assertRaisesRegex(ValueError, "invalid_memory_successor"):
                self.life.resume(
                    self.lease,
                    next_lease,
                    self.id,
                    self.binding,
                    lambda binding: True,
                    lambda binding: True,
                )
        self.assertEqual(self.driver.restores, 0)


if __name__ == "__main__":
    unittest.main()
