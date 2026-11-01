import base64
import hashlib
import os
import pathlib
import shutil
import tempfile
import types
import unittest
import uuid
from unittest.mock import patch

from archive import capture
from fence import Fence
from import_checkpoint import CheckpointImport
from local_checkpoint import LocalCheckpoint
from test_archive import oracle


class LocalCheckpointTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = pathlib.Path(self.temp.name)
        self.archives = self.root / "archives"
        self.archives.mkdir()
        self.data = self.root / "data"
        self.data.mkdir()
        source = self.root / "source"
        (source / "workspace").mkdir(parents=True)
        (source / "home").mkdir()
        (source / "workspace/bytes").write_bytes(bytes(range(256)) * 300)
        os.chmod(source / "workspace/bytes", 0o640)
        os.link(source / "workspace/bytes", source / "home/hard")
        (source / "home/link").symlink_to("/workspace/bytes")
        self.expected = oracle(source)
        self.fence = Fence(self.root / "fence")
        self.lease = dict(
            owner="owner",
            poolId="pool",
            machineId="host",
            slotId=str(uuid.uuid4()),
            sandboxId=str(uuid.uuid4()),
            assignmentId=str(uuid.uuid4()),
            generation=1,
        )
        self.fence.claim(self.lease)
        self.source = self.archives / (self.lease["assignmentId"] + ".tgz")
        self.archive = capture({name: source / name for name in ("workspace", "home")}, self.source)
        self.bytes = self.source.read_bytes()
        shutil.rmtree(source)
        with self.fence.locked():
            self.fence.write(
                {**self.fence.read(), "checkpoint": self.archive, "runtime": {"phase": "removed"}}
            )
        self.publication = dict(checkpointId=str(uuid.uuid4()), sha256=self.archive["sha256"])
        self.cache = LocalCheckpoint(self.fence, self.archives)

    def publish(self):
        self.fence.close(self.lease)
        self.fence.release(self.lease, lambda *_: True, self.publication)
        result = self.cache.publish(self.lease, self.publication)
        self.assertEqual(self.cache.publish(self.lease, self.publication), result)
        self.source.unlink()

    def next(self, foreign=False):
        lease = {**self.lease, "assignmentId": str(uuid.uuid4()), "generation": 2}
        if foreign:
            lease["sandboxId"] = str(uuid.uuid4())
        self.fence.claim(lease)
        importer = CheckpointImport(
            self.fence,
            self.archives,
            self.data,
            types.SimpleNamespace(pw_uid=os.getuid(), pw_gid=os.getgid()),
        )
        return lease, importer

    def begin(self, lease, importer):
        return importer.begin(
            lease, self.publication["checkpointId"], self.archive["sha256"], len(self.bytes)
        )

    def assert_restored(self, lease, importer):
        self.assertEqual(importer.finish(lease)["phase"], "ready")
        self.assertEqual(oracle(self.data / lease["assignmentId"]), self.expected)

    def test_publication_gates_cache_and_verified_hit_restores_without_upload(self):
        with self.assertRaisesRegex(ValueError, "durable_release"):
            self.cache.publish(self.lease, self.publication)
        self.assertFalse((self.archives / "cache").exists())
        self.publish()
        lease, importer = self.next()
        receipt = self.begin(lease, importer)
        self.assertEqual(receipt["phase"], "extracting")
        self.assertEqual(receipt["offset"], len(self.bytes))
        self.assert_restored(lease, importer)
        with self.assertRaisesRegex(ValueError, "stale"):
            self.begin(self.lease, importer)

    def test_corrupt_cache_and_different_sandbox_fall_back_to_verified_remote_bytes(self):
        for foreign in (False, True):
            with self.subTest(foreign=foreign):
                # Independent fixtures retain their own scope and generation.
                case = LocalCheckpointTests()
                case.setUp()
                try:
                    case.publish()
                    if not foreign:
                        (case.archives / "cache/archive.tgz").write_bytes(b"corrupt")
                    lease, importer = case.next(foreign)
                    self.assertEqual(case.begin(lease, importer)["phase"], "receiving")
                    self.assertFalse(importer.path(lease).exists())
                    importer.chunk(
                        lease,
                        0,
                        base64.b64encode(case.bytes).decode(),
                        hashlib.sha256(case.bytes).hexdigest(),
                    )
                    case.assert_restored(lease, importer)
                finally:
                    case.doCleanups()

    def test_crash_after_cache_copy_before_import_receipt_recovers(self):
        self.publish()
        lease, importer = self.next()
        write = self.fence.write
        lost = True

        def interrupted(state):
            nonlocal lost
            if lost and state.get("import", {}).get("phase") == "extracting":
                lost = False
                raise OSError("injected crash after cache copy")
            write(state)

        with patch.object(self.fence, "write", side_effect=interrupted):
            with self.assertRaisesRegex(OSError, "injected"):
                self.begin(lease, importer)
        self.assertEqual(importer.path(lease).read_bytes(), self.bytes)
        self.assertEqual(self.begin(lease, importer)["phase"], "extracting")
        self.assert_restored(lease, importer)

    def test_cache_publication_lost_metadata_ack_replays_without_losing_source(self):
        self.fence.close(self.lease)
        self.fence.release(self.lease, lambda *_: True, self.publication)
        with patch.object(self.fence, "write", side_effect=OSError("metadata unavailable")):
            with self.assertRaisesRegex(OSError, "metadata unavailable"):
                self.cache.publish(self.lease, self.publication)
        self.assertTrue(self.source.exists())
        self.assertNotIn("localCheckpoint", self.fence.read())
        self.cache.publish(self.lease, self.publication)
        self.source.unlink()
        lease, importer = self.next()
        self.assertEqual(self.begin(lease, importer)["phase"], "extracting")
        self.assert_restored(lease, importer)

    def test_fifo_cache_is_a_bounded_miss_not_a_blocking_open(self):
        self.publish()
        path = self.archives / "cache/archive.tgz"
        path.unlink()
        os.mkfifo(path, 0o600)
        lease, importer = self.next()
        self.assertEqual(self.begin(lease, importer)["phase"], "receiving")
        self.assertFalse(importer.path(lease).exists())

    def test_identical_published_content_can_restore_another_root_id(self):
        self.publish()
        lease, importer = self.next()
        other_id = str(uuid.uuid4())
        receipt = importer.begin(lease, other_id, self.archive["sha256"], len(self.bytes))
        self.assertEqual(receipt["id"], other_id)
        self.assertEqual(receipt["phase"], "extracting")
        self.assert_restored(lease, importer)

    def test_foreign_owner_cannot_claim_cached_host(self):
        self.publish()
        with self.assertRaisesRegex(ValueError, "identity_conflict"):
            self.fence.claim(
                {**self.lease, "owner": "other", "generation": 2, "assignmentId": str(uuid.uuid4())}
            )


if __name__ == "__main__":
    unittest.main()
