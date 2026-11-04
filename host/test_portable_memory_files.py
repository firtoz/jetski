import hashlib
import os
import pathlib
import unittest
from types import SimpleNamespace

from portable_memory_files import PortableMemoryFiles
import test_portable_memory_export as export_fixture
import test_portable_memory_import as import_fixture
from portable_memory_format import manifest_objects


class BinaryExportTests(unittest.TestCase):
    setUp = export_fixture.PortableExportTests.setUp

    def test_generation_scoped_binary_export_exact_inode_cleanup_and_stale_rejection(self):
        capture = self.export.prepare(self.lease, self.checkpoint, self.binding["filesystemSha256"])
        account = SimpleNamespace(pw_uid=os.geteuid(), pw_gid=os.getegid())
        files = PortableMemoryFiles(
            self.fence, account, self.base / "binary-export", self.base / "binary-import"
        )
        receipt = files.export(
            self.lease, self.checkpoint, self.export, capture["sha256"], capture["bytes"]
        )
        path = pathlib.Path(receipt["path"])
        self.assertEqual(hashlib.sha256(path.read_bytes()).hexdigest(), capture["sha256"])
        self.assertEqual(
            path.stat().st_ino, self.export.path(self.lease, self.checkpoint).stat().st_ino
        )
        self.assertIn("-g" + str(self.lease["generation"]), receipt["path"])
        self.assertEqual(
            files.export(
                self.lease, self.checkpoint, self.export, capture["sha256"], capture["bytes"]
            ),
            receipt,
        )
        with self.assertRaises(ValueError):
            files.export(
                {**self.lease, "generation": self.lease["generation"] + 1},
                self.checkpoint,
                self.export,
                capture["sha256"],
                capture["bytes"],
            )
        files.close_export(self.lease, self.checkpoint, self.export)
        self.assertFalse(path.exists())
        self.assertEqual(self.export.path(self.lease, self.checkpoint).stat().st_nlink, 1)


class BinaryImportTests(unittest.TestCase):
    setUp = import_fixture.PortableImportTests.setUp

    def test_binary_input_is_verified_and_committed_by_existing_import_journal(self):
        import_fixture.PortableImportTests.begin(self)
        identifier = self.manifest["checkpointId"]
        account = SimpleNamespace(pw_uid=os.geteuid(), pw_gid=os.getegid())
        files = PortableMemoryFiles(
            self.fence, account, self.base / "binary-export", self.base / "binary-import"
        )
        receipt = files.import_begin(self.lease, identifier, self.importer)
        path = pathlib.Path(receipt["path"])
        obj = next(iter(manifest_objects(self.manifest).values()))
        data = self.objects[obj["id"]]
        path.write_bytes(data)
        with self.assertRaisesRegex(ValueError, "integrity"):
            files.import_chunk(
                self.lease, identifier, self.importer, obj["id"], 0, len(data), "f" * 64
            )
        self.assertEqual(
            self.importer.status(self.lease, identifier, obj["id"])["object"]["offset"], 0
        )
        result = files.import_chunk(
            self.lease, identifier, self.importer, obj["id"], 0, len(data), obj["sha256"]
        )
        self.assertTrue(result["complete"])
        self.assertEqual(
            files.import_chunk(
                self.lease, identifier, self.importer, obj["id"], 0, len(data), obj["sha256"]
            ),
            result,
        )
        path.unlink()
        path.symlink_to(self.base / "fence")
        with self.assertRaises(OSError):
            files.import_chunk(
                self.lease, identifier, self.importer, obj["id"], 0, len(data), obj["sha256"]
            )
        path.unlink()
        files.import_close(self.lease, identifier, self.importer)
        self.assertFalse(path.parent.exists())
