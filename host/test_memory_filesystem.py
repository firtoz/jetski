import os
import pathlib
import tempfile
import unittest

from memory_filesystem import frozen_identity


class FrozenIdentityTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = pathlib.Path(self.temp.name)
        self.roots = {name: self.root / name for name in ("workspace", "home")}
        for root in self.roots.values():
            root.mkdir()
        self.file = self.roots["workspace"] / "file"
        self.file.write_bytes(b"identical bytes")
        os.link(self.file, self.roots["workspace"] / "hard")
        (self.roots["home"] / "link").symlink_to("../workspace/file")

    def test_same_bytes_replacement_changes_physical_identity(self):
        before = frozen_identity(self.roots)
        self.assertEqual(before, frozen_identity(self.roots))
        replacement = self.roots["workspace"] / "new"
        replacement.write_bytes(self.file.read_bytes())
        replacement.chmod(self.file.stat().st_mode & 0o777)
        os.replace(replacement, self.file)
        self.assertNotEqual(before, frozen_identity(self.roots))

    def test_mode_symlink_and_special_changes_are_detected(self):
        before = frozen_identity(self.roots)
        self.file.chmod(0o600)
        self.assertNotEqual(before, frozen_identity(self.roots))
        before = frozen_identity(self.roots)
        link = self.roots["home"] / "link"
        link.unlink()
        link.symlink_to("/another-target")
        self.assertNotEqual(before, frozen_identity(self.roots))
        os.mkfifo(self.roots["workspace"] / "socket-like")
        with self.assertRaisesRegex(ValueError, "unsupported_memory_filesystem_member"):
            frozen_identity(self.roots)
