import hashlib
import io
import os
import pathlib
import stat
import tarfile
import tempfile
import unittest
from archive import capture, restore, digest


def oracle(root):
    result = {}
    inodes = {}
    for directory, names, files in os.walk(root, followlinks=False):
        for name in sorted(set(names + files)):
            path = pathlib.Path(directory) / name
            relative = str(path.relative_to(root))
            meta = path.lstat()
            entry = dict(mode=stat.S_IMODE(meta.st_mode))
            if path.is_symlink():
                entry.update(kind="symlink", target=os.readlink(path))
            elif path.is_dir():
                entry.update(kind="directory")
            else:
                entry.update(
                    kind="file",
                    bytes=meta.st_size,
                    sha256=hashlib.sha256(path.read_bytes()).hexdigest(),
                )
                inodes.setdefault((meta.st_dev, meta.st_ino), []).append(relative)
            result[relative] = entry
    for paths in inodes.values():
        for path in paths:
            result[path]["links"] = sorted(paths)
    return result


class ArchiveTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.base = pathlib.Path(self.temp.name)
        self.source = self.base / "source"
        self.roots = {name: self.source / name for name in ("workspace", "home")}
        for root in self.roots.values():
            root.mkdir(parents=True)
        workspace, home = self.roots["workspace"], self.roots["home"]
        (workspace / "empty").touch()
        (workspace / "λ 日本語").write_bytes(bytes(range(256)) * 20000)
        os.chmod(workspace / "λ 日本語", 0o640)
        os.link(workspace / "λ 日本語", home / "hardlink")
        (home / "directory").mkdir(mode=0o751)
        (home / "directory" / "script").write_text("#!/bin/sh\nprintf hello\n")
        os.chmod(home / "directory" / "script", 0o755)
        (home / "relative").symlink_to("../workspace/λ 日本語")
        (home / "absolute").symlink_to("/workspace/λ 日本語")
        (home / "dangling").symlink_to("/does/not/exist")
        (workspace / ".git").mkdir()
        (workspace / ".git" / "config").write_text("[core]\nfilemode = true\n")
        self.archive = self.base / "checkpoint.tgz"

    def test_exact_recovery_and_deterministic_capture(self):
        original = oracle(self.source)
        receipt = capture(self.roots, self.archive)
        second = capture(self.roots, self.base / "same.tgz")
        self.assertEqual(receipt, second)
        destination = self.base / "restored"
        restored = restore(self.archive, destination, receipt["sha256"])
        self.assertEqual(restored["entries"], receipt["entries"])
        self.assertEqual(original, oracle(destination))
        with self.assertRaisesRegex(ValueError, "destination_exists"):
            restore(self.archive, destination, receipt["sha256"])

    def test_changed_bytes_rename_delete_and_modes(self):
        capture(self.roots, self.archive)
        (self.roots["workspace"] / "empty").unlink()
        (self.roots["workspace"] / "λ 日本語").rename(self.roots["workspace"] / "renamed")
        (self.roots["home"] / "hardlink").write_bytes(b"changed\0binary")
        os.chmod(self.roots["home"] / "directory", 0o750)
        with self.assertRaisesRegex(ValueError, "identity_conflict"):
            capture(self.roots, self.archive)
        path = self.base / "changed.tgz"
        receipt = capture(self.roots, path)
        restore(path, self.base / "changed", receipt["sha256"])
        self.assertEqual(oracle(self.source), oracle(self.base / "changed"))

    def test_partial_archive_and_digest_failure_never_publish(self):
        receipt = capture(self.roots, self.archive)
        self.archive.write_bytes(self.archive.read_bytes()[:-10])
        with self.assertRaisesRegex(ValueError, "digest_mismatch"):
            restore(self.archive, self.base / "target", receipt["sha256"])
        self.assertFalse((self.base / "target").exists())

    def test_devices_and_size_limit_fail_before_publication(self):
        os.mkfifo(self.roots["home"] / "pipe")
        with self.assertRaisesRegex(ValueError, "unsupported_file_type"):
            capture(self.roots, self.archive)
        self.assertFalse(self.archive.exists())
        (self.roots["home"] / "pipe").unlink()
        with self.assertRaisesRegex(ValueError, "archive_limit"):
            capture(self.roots, self.archive, dict(entries=2, bytes=1024**3, pathBytes=4096))
        self.assertFalse(self.archive.exists())

    def forged(self, members):
        path = self.base / "forged.tgz"
        with tarfile.open(path, "w:gz") as archive:
            for name, kind, content in members:
                info = tarfile.TarInfo(name)
                info.mode = 0o700
                info.type = kind
                if kind in (tarfile.SYMTYPE, tarfile.LNKTYPE):
                    info.linkname = content
                elif kind == tarfile.REGTYPE:
                    info.size = len(content)
                archive.addfile(info, io.BytesIO(content) if kind == tarfile.REGTYPE else None)
        return path

    def test_malformed_paths_links_and_duplicate_members(self):
        roots = [("workspace", tarfile.DIRTYPE, ""), ("home", tarfile.DIRTYPE, "")]
        cases = [
            [("workspace/../escape", tarfile.REGTYPE, b"x")],
            [("workspace/a", tarfile.SYMTYPE, "/tmp"), ("workspace/a/pwn", tarfile.REGTYPE, b"x")],
            [("home/link", tarfile.LNKTYPE, "../outside")],
            [("home/a", tarfile.REGTYPE, b"x"), ("home/a", tarfile.REGTYPE, b"y")],
        ]
        for members in cases:
            with self.subTest(members=members):
                path = self.forged(roots + members)
                with self.assertRaises(ValueError):
                    restore(path, self.base / "target", digest(path))
                self.assertFalse((self.base / "target").exists())
                self.assertEqual(list(self.base.glob(".restore-*")), [])


if __name__ == "__main__":
    unittest.main()
