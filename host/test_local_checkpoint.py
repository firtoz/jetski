import base64
import errno
import hashlib
import os
import pathlib
import shutil
import stat
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
        self.source.unlink(missing_ok=True)

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
        self.assertEqual(receipt["phase"], "ready")
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

    def test_crash_after_cache_selection_before_import_receipt_recovers(self):
        self.publish()
        lease, importer = self.next()
        write = self.fence.write
        lost = True

        def interrupted(state):
            nonlocal lost
            if lost and state.get("import", {}).get("phase") == "extracting":
                lost = False
                raise OSError("injected crash after cache selection")
            write(state)

        with patch.object(self.fence, "write", side_effect=interrupted):
            with self.assertRaisesRegex(OSError, "injected"):
                self.begin(lease, importer)
        self.assertFalse(importer.path(lease).exists())
        self.assertEqual((self.archives / "cache/archive.tgz").read_bytes(), self.bytes)
        self.assertEqual(self.begin(lease, importer)["phase"], "ready")
        self.assert_restored(lease, importer)

    def test_cache_publication_lost_metadata_ack_replays_after_source_rename(self):
        self.fence.close(self.lease)
        self.fence.release(self.lease, lambda *_: True, self.publication)
        with patch.object(self.fence, "write", side_effect=OSError("metadata unavailable")):
            with self.assertRaisesRegex(OSError, "metadata unavailable"):
                self.cache.publish(self.lease, self.publication)
        self.assertFalse(self.source.exists())
        self.assertEqual((self.archives / "cache/archive.tgz").read_bytes(), self.bytes)
        self.assertNotIn("localCheckpoint", self.fence.read())
        self.cache.publish(self.lease, self.publication)
        self.source.unlink(missing_ok=True)
        lease, importer = self.next()
        self.assertEqual(self.begin(lease, importer)["phase"], "ready")
        self.assert_restored(lease, importer)

    def test_cache_rename_preserves_inode_and_sync_failure_replays(self):
        self.fence.close(self.lease)
        self.fence.release(self.lease, lambda *_: True, self.publication)
        inode = self.source.stat().st_ino
        with patch("local_checkpoint.sync_dir", side_effect=OSError("sync unavailable")):
            with self.assertRaisesRegex(OSError, "sync unavailable"):
                self.cache.publish(self.lease, self.publication)
        destination = self.archives / "cache/archive.tgz"
        self.assertEqual(destination.stat().st_ino, inode)
        self.assertNotIn("localCheckpoint", self.fence.read())
        self.cache.publish(self.lease, self.publication)
        lease, importer = self.next()
        self.assertEqual(self.begin(lease, importer)["phase"], "ready")
        self.assert_restored(lease, importer)

    def test_cache_cross_filesystem_fallback_and_io_failure(self):
        self.fence.close(self.lease)
        self.fence.release(self.lease, lambda *_: True, self.publication)
        replace = os.replace

        def cross_device(source, destination):
            if pathlib.Path(source) == self.source:
                raise OSError(errno.EXDEV, "different filesystem")
            return replace(source, destination)

        with patch("local_checkpoint.os.replace", side_effect=OSError(errno.EIO, "disk error")):
            with self.assertRaises(OSError):
                self.cache.publish(self.lease, self.publication)
        self.assertTrue(self.source.exists())
        self.assertNotIn("localCheckpoint", self.fence.read())
        with patch("local_checkpoint.os.replace", side_effect=cross_device):
            self.cache.publish(self.lease, self.publication)
        self.assertTrue(self.source.exists())
        self.assertEqual((self.archives / "cache/archive.tgz").read_bytes(), self.bytes)

    def test_unjournaled_corrupt_destination_cannot_replace_missing_source(self):
        self.fence.close(self.lease)
        self.fence.release(self.lease, lambda *_: True, self.publication)
        with patch.object(self.fence, "write", side_effect=OSError("metadata unavailable")):
            with self.assertRaises(OSError):
                self.cache.publish(self.lease, self.publication)
        (self.archives / "cache/archive.tgz").write_bytes(b"bad")
        with self.assertRaisesRegex(ValueError, "source_integrity"):
            self.cache.publish(self.lease, self.publication)
        self.assertNotIn("localCheckpoint", self.fence.read())

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
        self.assertEqual(receipt["phase"], "ready")
        self.assert_restored(lease, importer)

    def test_borrowed_cache_cannot_be_written_by_chunk_replay(self):
        self.publish()
        path = self.archives / "cache/archive.tgz"
        inode = path.stat().st_ino
        lease, importer = self.next()
        self.assertEqual(self.begin(lease, importer)["phase"], "ready")
        self.assertFalse(importer.path(lease).exists())
        with self.assertRaisesRegex(ValueError, "import_chunk_extent"):
            importer.chunk(
                lease,
                0,
                base64.b64encode(self.bytes).decode(),
                hashlib.sha256(self.bytes).hexdigest(),
            )
        self.assertEqual(path.stat().st_ino, inode)
        self.assertEqual(path.read_bytes(), self.bytes)
        self.assert_restored(lease, importer)

    def test_borrowed_cache_corruption_or_scope_change_blocks_readiness(self):
        for changed in ("bytes", "owner"):
            case = LocalCheckpointTests()
            case.setUp()
            try:
                case.publish()
                lease, importer = case.next()
                with patch.object(
                    importer, "finish_locked", side_effect=OSError("paused cached restore")
                ):
                    with self.assertRaisesRegex(OSError, "paused cached restore"):
                        case.begin(lease, importer)
                if changed == "bytes":
                    path = case.archives / "cache/archive.tgz"
                    data = bytearray(path.read_bytes())
                    data[len(data) // 2] ^= 1
                    path.write_bytes(data)
                else:
                    with case.fence.locked():
                        state = case.fence.read()
                        case.fence.write(
                            {
                                **state,
                                "localCheckpoint": {**state["localCheckpoint"], "owner": "foreign"},
                            }
                        )
                with self.assertRaises(ValueError):
                    importer.finish(lease)
                self.assertEqual(case.fence.read()["import"]["phase"], "extracting")
                self.assertFalse((case.data / lease["assignmentId"]).exists())
            finally:
                case.doCleanups()

    def test_borrowed_cache_replays_lost_ready_receipt_without_losing_original(self):
        self.publish()
        lease, importer = self.next()
        write = self.fence.write

        def interrupted(state):
            if state.get("import", {}).get("phase") == "ready":
                raise OSError("ready ACK lost")
            write(state)

        with patch.object(self.fence, "write", side_effect=interrupted):
            with self.assertRaisesRegex(OSError, "ready ACK lost"):
                self.begin(lease, importer)
        self.assertEqual((self.archives / "cache/archive.tgz").read_bytes(), self.bytes)
        self.assertFalse(importer.path(lease).exists())
        self.assert_restored(lease, importer)

    def test_complete_legacy_import_staging_stays_independent_and_readable(self):
        self.publish()
        lease, importer = self.next()
        with patch.object(LocalCheckpoint, "provisional_locked", return_value=None):
            self.assertEqual(self.begin(lease, importer)["phase"], "receiving")
        importer.path(lease).write_bytes(self.bytes)
        receipt = self.begin(lease, importer)
        self.assertEqual(receipt["phase"], "extracting")
        self.assertNotIn("cacheSource", receipt)
        self.assert_restored(lease, importer)

    def test_partial_upload_after_lost_selection_cannot_alias_cached_bytes(self):
        self.publish()
        lease, importer = self.next()
        write = self.fence.write

        def interrupted(state):
            if state.get("import", {}).get("phase") == "extracting":
                raise OSError("selection journal lost")
            write(state)

        with patch.object(self.fence, "write", side_effect=interrupted):
            with self.assertRaisesRegex(OSError, "selection journal lost"):
                self.begin(lease, importer)
        midpoint = len(self.bytes) // 2
        for offset, part in [(0, self.bytes[:midpoint]), (midpoint, self.bytes[midpoint:])]:
            importer.chunk(
                lease, offset, base64.b64encode(part).decode(), hashlib.sha256(part).hexdigest()
            )
        cached = self.archives / "cache/archive.tgz"
        self.assertNotEqual(importer.path(lease).stat().st_ino, cached.stat().st_ino)
        self.assertEqual(cached.read_bytes(), self.bytes)
        self.assert_restored(lease, importer)

    def test_foreign_owner_cannot_claim_cached_host(self):
        self.publish()
        with self.assertRaisesRegex(ValueError, "identity_conflict"):
            self.fence.claim(
                {**self.lease, "owner": "other", "generation": 2, "assignmentId": str(uuid.uuid4())}
            )

    def test_cached_begin_flushes_each_primary_inode_with_final_ownership_and_links_once(self):
        self.publish()
        lease, importer = self.next()
        sync = os.fsync
        observed = []

        def record(fd):
            meta = os.fstat(fd)
            if stat.S_ISREG(meta.st_mode):
                observed.append(meta)
            return sync(fd)

        with patch("archive.os.fsync", side_effect=record):
            self.assertEqual(self.begin(lease, importer)["phase"], "ready")
        path = self.data / lease["assignmentId"] / "workspace/bytes"
        meta = path.stat()
        flushes = [
            item
            for item in observed
            if item.st_ino == meta.st_ino
            and item.st_dev == meta.st_dev
            and item.st_size == meta.st_size
        ]
        self.assertEqual(len(flushes), 1)
        self.assertEqual(flushes[0].st_nlink, 2)
        self.assertEqual(stat.S_IMODE(flushes[0].st_mode), 0o640)
        self.assertEqual((flushes[0].st_uid, flushes[0].st_gid), (os.getuid(), os.getgid()))
        self.assert_restored(lease, importer)

    def test_cached_owner_or_file_sync_failure_never_acknowledges_ready_and_can_recover(self):
        for failure in ("owner", "sync"):
            case = LocalCheckpointTests()
            case.setUp()
            try:
                case.publish()
                lease, importer = case.next()
                sync = os.fsync

                def fail_file(fd):
                    if os.fstat(fd).st_size == 76800:
                        raise OSError("file sync unavailable")
                    return sync(fd)

                target = "archive.os.fchown" if failure == "owner" else "archive.os.fsync"
                effect = OSError("owner unavailable") if failure == "owner" else fail_file
                with patch(target, side_effect=effect):
                    with self.assertRaises(OSError):
                        case.begin(lease, importer)
                self.assertEqual(case.fence.read()["import"]["phase"], "extracting")
                self.assertFalse((case.data / lease["assignmentId"]).exists())
                self.assertEqual((case.archives / "cache/archive.tgz").read_bytes(), case.bytes)
                case.assert_restored(lease, importer)
            finally:
                case.doCleanups()

    def test_same_size_corrupt_cache_is_discarded_before_ready_and_remote_fallback_is_replayable(
        self,
    ):
        self.publish()
        path = self.archives / "cache/archive.tgz"
        changed = bytearray(self.bytes)
        changed[len(changed) // 2] ^= 1
        path.write_bytes(changed)
        lease, importer = self.next()
        receipt = self.begin(lease, importer)
        self.assertEqual(receipt["phase"], "receiving")
        self.assertTrue(receipt["cacheRejected"])
        self.assertNotIn("cacheSource", receipt)
        self.assertFalse((self.data / lease["assignmentId"]).exists())
        self.assertFalse(importer.path(lease).exists())
        with patch(
            "import_checkpoint.restore", side_effect=AssertionError("replayed rejected cache")
        ):
            self.assertEqual(self.begin(lease, importer)["phase"], "receiving")
        importer.chunk(
            lease, 0, base64.b64encode(self.bytes).decode(), hashlib.sha256(self.bytes).hexdigest()
        )
        self.assert_restored(lease, importer)
        self.assertEqual(path.read_bytes(), bytes(changed))


if __name__ == "__main__":
    unittest.main()
