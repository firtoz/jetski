import base64
import hashlib
import os
import pathlib
import tempfile
import types
import unittest
import uuid
from archive import capture
from fence import Fence
from import_checkpoint import CheckpointImport
from test_archive import oracle


class ImportTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.base = pathlib.Path(self.temp.name)
        self.roots = {name: self.base / "source" / name for name in ("workspace", "home")}
        for root in self.roots.values():
            root.mkdir(parents=True)
        (self.roots["workspace"] / "bytes").write_bytes(bytes(range(256)) * 500)
        os.chmod(self.roots["workspace"] / "bytes", 0o640)
        os.link(self.roots["workspace"] / "bytes", self.roots["home"] / "link")
        (self.roots["home"] / "symlink").symlink_to("/workspace/bytes")
        self.receipt = capture(self.roots, self.base / "archive.tgz")
        self.raw = (self.base / "archive.tgz").read_bytes()
        self.archives, self.data = self.base / "archives", self.base / "data"
        self.archives.mkdir()
        self.data.mkdir()
        self.fence = Fence(self.base / "control")
        self.lease = dict(
            owner="alice",
            poolId="pool",
            machineId="host",
            slotId=str(uuid.uuid4()),
            sandboxId=str(uuid.uuid4()),
            assignmentId=str(uuid.uuid4()),
            generation=1,
        )
        self.fence.claim(self.lease)
        self.importer = CheckpointImport(
            self.fence,
            self.archives,
            self.data,
            types.SimpleNamespace(pw_uid=os.getuid(), pw_gid=os.getgid()),
        )
        self.importer.begin(self.lease, str(uuid.uuid4()), self.receipt["sha256"], len(self.raw))

    def send(self, offset, raw):
        return self.importer.chunk(
            self.lease, offset, base64.b64encode(raw).decode(), hashlib.sha256(raw).hexdigest()
        )

    def test_resume_duplicate_chunks_and_exact_restore(self):
        split = len(self.raw) // 2
        first = self.send(0, self.raw[:split])
        self.assertEqual(self.send(0, self.raw[:split]), first)
        with self.assertRaisesRegex(ValueError, "incomplete"):
            self.importer.finish(self.lease)
        self.send(split, self.raw[split:])
        result = self.importer.finish(self.lease)
        self.assertEqual(result["phase"], "ready")
        self.assertEqual(self.importer.finish(self.lease), result)
        self.assertEqual(
            oracle(self.base / "source"), oracle(self.data / self.lease["assignmentId"])
        )

    def test_replay_after_disk_write_before_offset_ack(self):
        # Simulated host crash: bytes reached disk but the durable offset did not.
        path = self.importer.path(self.lease)
        path.write_bytes(self.raw[:31])
        result = self.send(0, self.raw)
        self.assertEqual(result["offset"], len(self.raw))
        self.importer.finish(self.lease)
        self.assertEqual(
            oracle(self.base / "source"), oracle(self.data / self.lease["assignmentId"])
        )

    def test_digest_corruption_and_conflicting_replay_fail_closed(self):
        self.send(0, self.raw)
        changed = bytearray(self.raw)
        changed[0] ^= 1
        with self.assertRaisesRegex(ValueError, "replay_conflict"):
            self.send(0, changed)
        self.importer.path(self.lease).write_bytes(changed)
        with self.assertRaisesRegex(ValueError, "archive_integrity"):
            self.importer.finish(self.lease)
        self.assertFalse((self.data / self.lease["assignmentId"]).exists())


if __name__ == "__main__":
    unittest.main()
