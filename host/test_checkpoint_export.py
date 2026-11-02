import os
import pathlib
import stat
import types
import unittest
from unittest.mock import patch
import test_local_checkpoint as fixtures
from checkpoint_export import CheckpointExport


class ExportTests(unittest.TestCase):
    def setUp(self):
        self.case = fixtures.LocalCheckpointTests()
        self.case.setUp()
        self.addCleanup(self.case.doCleanups)
        self.case.fence.close(self.case.lease)
        self.reader = types.SimpleNamespace(pw_uid=os.getuid() + 1, pw_gid=max(1, os.getgid()))
        self.root = self.case.root / "exports"
        self.exporter = CheckpointExport(
            self.case.fence, self.case.archives, self.root, self.reader
        )

    def prepare(self):
        return self.exporter.prepare(
            self.case.lease, self.case.archive["sha256"], len(self.case.bytes)
        )

    def test_immutable_link_replay_and_cleanup_preserve_source(self):
        result = self.prepare()
        self.assertEqual(self.prepare(), result)
        path = pathlib.Path(result["path"])
        self.assertEqual(path.read_bytes(), self.case.bytes)
        self.assertEqual(path.stat().st_ino, self.case.source.stat().st_ino)
        self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o640)
        self.assertEqual(path.stat().st_gid, self.reader.pw_gid)
        self.assertEqual(self.exporter.close(self.case.lease), {"closed": True})
        self.assertEqual(self.exporter.close(self.case.lease), {"closed": True})
        self.assertFalse(path.exists())
        self.assertEqual(self.case.source.read_bytes(), self.case.bytes)

    def test_scope_conflicts_and_unexpected_files_fail_closed(self):
        with self.assertRaises(ValueError):
            self.exporter.prepare(self.case.lease, "0" * 64, len(self.case.bytes))
        result = self.prepare()
        with self.assertRaises(ValueError):
            self.exporter.close({**self.case.lease, "generation": 2})
        directory = pathlib.Path(result["path"]).parent
        extra = directory / "unrecognized"
        extra.write_bytes(b"retain")
        with self.assertRaisesRegex(ValueError, "unexpected"):
            self.exporter.close(self.case.lease)
        self.assertEqual(extra.read_bytes(), b"retain")
        self.assertEqual(self.case.source.read_bytes(), self.case.bytes)

    def test_interrupted_directory_sync_replays_and_symlinks_are_rejected(self):
        self.root.mkdir(mode=0o700)
        with patch("checkpoint_export.sync_dir", side_effect=OSError("sync lost")):
            with self.assertRaises(OSError):
                self.prepare()
        result = self.prepare()
        self.exporter.close(self.case.lease)
        directory = pathlib.Path(result["path"]).parent
        directory.symlink_to(self.case.archives, target_is_directory=True)
        with self.assertRaises(ValueError):
            self.prepare()
        self.assertEqual(self.case.source.read_bytes(), self.case.bytes)
