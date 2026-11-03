"""Host-protocol composition checks; no native runtime or remote-store claim."""

import pathlib
import types
import unittest

import test_gvisor_lifecycle as fixture
from archive import capture
from memory_control import handle


class MemoryControlTests(unittest.TestCase):
    setUp = fixture.MemoryLifecycleTests.setUp

    def prepared(self):
        root = pathlib.Path(self.temp.name)
        self.data, self.archives = root / "data", root / "archives"
        self.archives.mkdir(mode=0o700)
        self.roots = {
            name: self.data / self.lease["assignmentId"] / name for name in ("workspace", "home")
        }
        for path in self.roots.values():
            path.mkdir(parents=True, mode=0o700)
        (self.roots["workspace"] / "file").write_bytes(b"exact frozen bytes")
        self.fence.write(
            {**self.fence.read(), "runtime": {"phase": "running", "image": self.binding["image"]}}
        )
        self.backend = types.SimpleNamespace(memory_driver=lambda: self.driver)
        self.payload = dict(lease=self.lease, image=self.binding["image"], checkpointId=self.id)
        self.call("memory-freeze")
        receipt = capture(
            self.roots, self.archives / (self.lease["assignmentId"] + ".tgz"), frame_bytes=262144
        )
        self.fence.write(
            {
                **self.fence.read(),
                "checkpoint": receipt,
                "memory": {**self.fence.read()["memory"], "captureFrameBytes": 262144},
            }
        )
        self.payload["publication"] = dict(checkpointId=self.id, sha256=receipt["sha256"])

    def call(self, action, **extra):
        return handle(
            action, {**self.payload, **extra}, self.fence, self.backend, self.archives, self.data
        )

    def test_freeze_seal_resume_and_lost_ack_replay_preserve_exact_identity(self):
        self.prepared()
        self.assertEqual(self.call("memory-seal")["phase"], "sealed")
        resumed = self.call("memory-resume", nextLease=self.successor)
        self.assertTrue(resumed["memoryPreserved"])
        self.assertEqual(resumed, self.call("memory-resume", nextLease=self.successor))
        self.assertEqual(self.driver.restores, 1)
        self.assertEqual(self.fence.read()["lease"], self.successor)

    def test_repeated_changed_save_after_resume_keeps_assignment_and_uses_fresh_archive(self):
        self.prepared()
        self.call("memory-seal")
        self.call("memory-resume", nextLease=self.successor)
        self.assertFalse((self.archives / (self.lease["assignmentId"] + ".tgz")).exists())
        self.payload["lease"] = self.successor
        import uuid

        self.payload["checkpointId"] = str(uuid.uuid4())
        (self.roots["workspace"] / "file").write_bytes(b"acknowledge these changed bytes next")
        self.call("memory-freeze")
        receipt = capture(
            self.roots, self.archives / (self.lease["assignmentId"] + ".tgz"), frame_bytes=262144
        )
        self.fence.write(
            {
                **self.fence.read(),
                "checkpoint": receipt,
                "memory": {**self.fence.read()["memory"], "captureFrameBytes": 262144},
            }
        )
        self.payload["publication"] = dict(
            checkpointId=self.payload["checkpointId"], sha256=receipt["sha256"]
        )
        sealed = self.call("memory-seal")
        self.assertEqual(sealed["filesystemSha256"], receipt["sha256"])
        self.assertEqual(self.driver.freezes, 2)

    def test_identical_bytes_on_replaced_inode_cannot_resume_old_memory(self):
        self.prepared()
        self.call("memory-seal")
        file = self.roots["workspace"] / "file"
        original = file.read_bytes()
        replacement = self.roots["workspace"] / "replacement"
        replacement.write_bytes(original)
        replacement.replace(file)
        with self.assertRaisesRegex(ValueError, "filesystem_mismatch"):
            self.call("memory-resume", nextLease=self.successor)
        self.assertEqual(self.driver.restores, 0)
        self.assertEqual(self.fence.read()["phase"], "closed")

    def test_publication_binding_and_corrupted_memory_fail_before_execution(self):
        self.prepared()
        with self.assertRaisesRegex(ValueError, "publication_mismatch"):
            self.call("memory-seal", publication=dict(checkpointId=self.id, sha256="0" * 64))
        self.call("memory-seal")
        (self.driver.path / "pages.img").write_bytes(b"corrupted snapshot")
        with self.assertRaisesRegex(ValueError, "memory_image_integrity"):
            self.call("memory-resume", nextLease=self.successor)
        self.assertEqual(self.driver.restores, 0)
