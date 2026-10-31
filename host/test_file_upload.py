import base64
import hashlib
import os
import pathlib
import tempfile
import types
import unittest
import uuid
from unittest.mock import patch
from fence import Fence
from file_upload import FileUpload


class UploadTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = pathlib.Path(self.temp.name)
        self.lease = dict(
            owner="alice",
            poolId="pool",
            machineId="host",
            slotId=str(uuid.uuid4()),
            sandboxId=str(uuid.uuid4()),
            assignmentId=str(uuid.uuid4()),
            generation=1,
        )
        self.fence = Fence(self.root / "control")
        state = self.fence.claim(self.lease)
        self.fence.write({**state, "runtime": {"phase": "running"}})
        self.data = self.root / "data"
        self.workspace = self.data / self.lease["assignmentId"] / "workspace"
        self.workspace.mkdir(parents=True)
        self.account = types.SimpleNamespace(pw_uid=os.getuid(), pw_gid=os.getgid())
        self.upload = FileUpload(self.fence, self.data, self.account)
        self.id = str(uuid.uuid4())
        self.payload = bytes(range(256)) * 1025
        self.path = "/workspace/雪.bin"

    def begin(self, data=None, path=None):
        data = self.payload if data is None else data
        return self.upload.begin(
            self.lease,
            self.id,
            path or self.path,
            len(data),
            hashlib.sha256(data).hexdigest(),
            0o640,
        )

    def chunk(self, offset, data):
        return self.upload.chunk(
            self.lease,
            self.id,
            offset,
            base64.b64encode(data).decode("ascii"),
            hashlib.sha256(data).hexdigest(),
        )

    def complete_chunks(self):
        for offset in range(0, len(self.payload), 262144):
            self.chunk(offset, self.payload[offset : offset + 262144])

    def test_exact_binary_mode_replay_empty_and_final_symlink_replacement(self):
        self.begin()
        self.complete_chunks()
        target = self.workspace / "雪.bin"
        outside = self.root / "outside"
        outside.write_bytes(b"untouched")
        target.symlink_to(outside)
        result = self.upload.finish(self.lease, self.id)
        self.assertEqual(result["phase"], "committed")
        self.assertEqual(target.read_bytes(), self.payload)
        self.assertEqual(target.stat().st_mode & 0o777, 0o640)
        self.assertEqual(outside.read_bytes(), b"untouched")
        target.write_bytes(b"newer")
        self.assertEqual(self.upload.finish(self.lease, self.id), result)
        self.assertEqual(target.read_bytes(), b"newer")
        self.assertEqual(self.begin(), result)
        self.id = str(uuid.uuid4())
        self.begin(b"", "/workspace/empty")
        self.assertEqual(self.upload.finish(self.lease, self.id)["phase"], "committed")
        self.assertEqual((self.workspace / "empty").read_bytes(), b"")

    def test_chunk_crash_after_fsync_and_changed_replays(self):
        self.begin()
        write = self.fence.write

        def lose_receipt(state):
            if state.get("uploads", {}).get(self.id, {}).get("offset", 0):
                raise RuntimeError("lost chunk receipt")
            return write(state)

        with patch.object(self.fence, "write", side_effect=lose_receipt):
            with self.assertRaisesRegex(RuntimeError, "lost chunk"):
                self.chunk(0, self.payload[:262144])
        self.fence = Fence(self.root / "control")
        self.upload = FileUpload(self.fence, self.data, self.account)
        self.complete_chunks()
        with self.assertRaisesRegex(ValueError, "replay_conflict"):
            self.chunk(0, b"different")
        with self.assertRaisesRegex(ValueError, "identity_conflict"):
            self.begin(b"different")
        self.assertEqual(self.upload.finish(self.lease, self.id)["phase"], "committed")
        self.assertEqual((self.workspace / "雪.bin").read_bytes(), self.payload)

    def test_lost_publication_receipt_and_replaced_destination_never_replays(self):
        for replaced in (False, True):
            with self.subTest(replaced=replaced):
                self.id = str(uuid.uuid4())
                self.begin()
                self.complete_chunks()
                write = self.fence.write

                def lose_receipt(state):
                    if state.get("uploads", {}).get(self.id, {}).get("phase") == "committed":
                        raise RuntimeError("lost publish receipt")
                    return write(state)

                with patch.object(self.fence, "write", side_effect=lose_receipt):
                    with self.assertRaisesRegex(RuntimeError, "lost publish"):
                        self.upload.finish(self.lease, self.id)
                target = self.workspace / "雪.bin"
                if replaced:
                    replacement = self.workspace / "replacement"
                    replacement.write_bytes(b"newer")
                    os.replace(replacement, target)
                self.fence = Fence(self.root / "control")
                self.upload = FileUpload(self.fence, self.data, self.account)
                result = self.upload.finish(self.lease, self.id)
                self.assertEqual(result["phase"], "uncertain" if replaced else "committed")
                self.assertEqual(target.read_bytes(), b"newer" if replaced else self.payload)
                self.assertEqual(self.upload.finish(self.lease, self.id), result)

    def test_crash_before_rename_can_resume_but_stale_and_closed_writes_cannot(self):
        self.begin()
        self.complete_chunks()
        original = os.replace

        def fail_publish(src, dst, **kwargs):
            if kwargs.get("dst_dir_fd") is not None:
                raise RuntimeError("before rename")
            return original(src, dst, **kwargs)

        with patch("file_upload.os.replace", side_effect=fail_publish):
            with self.assertRaisesRegex(RuntimeError, "before rename"):
                self.upload.finish(self.lease, self.id)
        self.assertEqual(self.upload.status(self.lease, self.id)["phase"], "publishing")
        self.assertEqual(self.upload.finish(self.lease, self.id)["phase"], "committed")
        with self.assertRaisesRegex(ValueError, "stale_lease"):
            self.upload.status({**self.lease, "generation": 2}, self.id)
        self.fence.close(self.lease)
        self.assertEqual(self.upload.status(self.lease, self.id)["phase"], "committed")
        self.id = str(uuid.uuid4())
        with self.assertRaisesRegex(ValueError, "requires_running"):
            self.begin()

    def test_incomplete_digest_and_parent_symlink_fail_closed(self):
        self.begin()
        with self.assertRaisesRegex(ValueError, "incomplete"):
            self.upload.finish(self.lease, self.id)
        self.complete_chunks()
        (self.data / ".uploads" / self.id).write_bytes(b"corrupt")
        with self.assertRaisesRegex(ValueError, "integrity"):
            self.upload.finish(self.lease, self.id)
        (self.workspace / "outside").symlink_to(self.root, target_is_directory=True)
        self.id = str(uuid.uuid4())
        self.begin(b"", "/workspace/outside/not-created")
        with self.assertRaises(OSError):
            self.upload.finish(self.lease, self.id)
        self.assertFalse((self.root / "not-created").exists())
