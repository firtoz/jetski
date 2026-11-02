import base64
import os
import pathlib
import tempfile
import unittest
import uuid
from unittest.mock import patch
from fence import Fence
from files import Files


class FileTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        root = pathlib.Path(self.temp.name)
        self.lease = dict(
            owner="alice",
            poolId="pool",
            machineId="host",
            slotId=str(uuid.uuid4()),
            sandboxId=str(uuid.uuid4()),
            assignmentId=str(uuid.uuid4()),
            generation=1,
        )
        self.fence = Fence(root / "control")
        state = self.fence.claim(self.lease)
        self.fence.write({**state, "runtime": {"phase": "running"}})
        data = root / "data"
        self.workspace = data / self.lease["assignmentId"] / "workspace"
        self.workspace.mkdir(parents=True)
        (self.workspace.parent / "home").mkdir()
        self.files = Files(self.fence, data, os.getuid())

    def test_trusted_assignment_parent_is_distinct_from_workload_entries(self):
        import types

        path = self.workspace / "data"
        path.write_bytes(b"exact")
        parent_inode = self.workspace.parent.stat().st_ino
        actual = os.fstat
        parent_uid = os.getuid() + 17

        def inspect(fd):
            result = actual(fd)
            if result.st_ino == parent_inode:
                return types.SimpleNamespace(st_uid=parent_uid, st_mode=result.st_mode)
            return result

        with patch("files.os.fstat", side_effect=inspect):
            with self.assertRaisesRegex(ValueError, "file_owner_mismatch"):
                self.files.read(self.lease, "/workspace/data", 0, 5)
            distinct = Files(self.fence, self.files.data_root, os.getuid(), parent_uid)
            self.assertEqual(
                base64.b64decode(distinct.read(self.lease, "/workspace/data", 0, 5)["base64"]),
                b"exact",
            )
            with self.assertRaisesRegex(ValueError, "file_owner_mismatch"):
                Files(self.fence, self.files.data_root, parent_uid, parent_uid).read(
                    self.lease, "/workspace/data", 0, 5
                )

    def test_binary_chunks_empty_files_and_change_detection(self):
        data = bytes(range(256)) * 1025
        path = self.workspace / "雪.bin"
        path.write_bytes(data)
        first = self.files.read(self.lease, "/workspace/雪.bin", 0, 262144)
        second = self.files.read(
            self.lease, "/workspace/雪.bin", first["nextOffset"], 262144, first["version"]
        )
        self.assertEqual(
            base64.b64decode(first["base64"]) + base64.b64decode(second["base64"]), data
        )
        self.assertTrue(second["eof"])
        path.write_bytes(b"changed")
        with self.assertRaisesRegex(ValueError, "file_changed"):
            self.files.read(self.lease, "/workspace/雪.bin", 0, 1, first["version"])
        path.write_bytes(b"")
        self.assertTrue(self.files.read(self.lease, "/workspace/雪.bin", 0, 1)["eof"])
        for offset, count in [(-1, 1), (0, 262145), (True, 1), (1, 1)]:
            with self.assertRaises(ValueError):
                self.files.read(self.lease, "/workspace/雪.bin", offset, count)

    def test_traversal_links_special_files_and_stale_fences_rejected(self):
        (self.workspace / "outside").symlink_to("/etc")
        (self.workspace / "link").symlink_to("/etc/passwd")
        os.mkfifo(self.workspace / "pipe")
        for path in [
            "/etc/passwd",
            "/workspace/../home/a",
            "/workspace//a",
            "/workspace/outside/passwd",
            "/workspace/link",
            "/workspace/pipe",
            "/workspace",
        ]:
            with self.assertRaises((ValueError, OSError)):
                self.files.read(self.lease, path, 0, 100)
        (self.workspace / "regular").write_bytes(b"data")
        with self.assertRaisesRegex(ValueError, "file_owner_mismatch"):
            Files(self.fence, self.files.data_root, os.getuid() + 1).read(
                self.lease, "/workspace/regular", 0, 1
            )
        with self.assertRaisesRegex(ValueError, "stale_lease"):
            self.files.read({**self.lease, "generation": 2}, "/workspace/regular", 0, 1)
        self.fence.close(self.lease)
        with self.assertRaisesRegex(ValueError, "requires_running"):
            self.files.read(self.lease, "/workspace/regular", 0, 1)

    def test_listing_pages_change_detection_and_bound(self):
        for name in ["a", "b", "c"]:
            (self.workspace / name).write_bytes(b"x")
        (self.workspace / "z-link").symlink_to("/etc/passwd")
        first = self.files.listing(self.lease, "/workspace", "", 2)
        self.assertEqual([entry["name"] for entry in first["entries"]], ["a", "b"])
        second = self.files.listing(self.lease, "/workspace", first["next"], 2, first["version"])
        self.assertEqual(second["entries"][-1]["kind"], "symlink")
        self.assertIsNone(second["next"])
        (self.workspace / "d").touch()
        with self.assertRaisesRegex(ValueError, "directory_changed"):
            self.files.listing(self.lease, "/workspace", "b", 2, first["version"])
        with patch("files.MAX_ENTRIES", 2):
            with self.assertRaisesRegex(ValueError, "directory_entry_limit"):
                self.files.listing(self.lease, "/workspace", "", 2)

    def test_replacement_during_open_cannot_redirect_to_external_file(self):
        victim = self.workspace / "victim"
        victim.write_bytes(b"original")
        original = os.open
        replaced = False

        def race(path, flags, *args, **kwargs):
            nonlocal replaced
            fd = original(path, flags, *args, **kwargs)
            if path == "victim" and not replaced:
                replaced = True
                victim.unlink()
                victim.symlink_to("/etc/passwd")
            return fd

        with patch("files.os.open", side_effect=race):
            result = self.files.read(self.lease, "/workspace/victim", 0, 100)
        self.assertEqual(base64.b64decode(result["base64"]), b"original")
