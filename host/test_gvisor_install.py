import hashlib
import io
import os
import pathlib
import tarfile
import tempfile
import unittest

from gvisor_install import extract_verified_archive


class InstallArchiveTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = pathlib.Path(self.temp.name)

    def archive(self, extras=()):
        path = self.root / "runtime.tar.bz2"
        with tarfile.open(path, "w:bz2") as stream:
            for name, kind in (("runsc", "file"), ("gvisor-bin/sentry", "file"), *extras):
                member = tarfile.TarInfo(name)
                member.mode = 0o755
                if kind == "file":
                    data = b"not executable fixture"
                    member.size = len(data)
                    stream.addfile(member, io.BytesIO(data))
                else:
                    member.type = tarfile.SYMTYPE if kind == "symlink" else tarfile.LNKTYPE
                    member.linkname = "/outside"
                    stream.addfile(member)
        return path, hashlib.sha256(path.read_bytes()).hexdigest()

    def test_complete_bundle_exact_bytes_and_executable_modes_under_private_umask(self):
        path, digest = self.archive()
        destination = self.root / "bundle"
        destination.mkdir(mode=0o700)
        before = os.umask(0o077)
        try:
            proof = extract_verified_archive(path, destination, digest)
        finally:
            os.umask(before)
        self.assertEqual(len(proof["files"]), 2)
        self.assertEqual((destination / "gvisor-bin").stat().st_mode & 0o777, 0o755)
        for row in proof["files"]:
            self.assertEqual(row["mode"], 0o755)
            self.assertEqual(
                row["sha256"], hashlib.sha256((destination / row["path"]).read_bytes()).hexdigest()
            )

    def test_checksum_failure_does_not_extract_anything(self):
        path, _digest = self.archive()
        destination = self.root / "bundle"
        destination.mkdir()
        with self.assertRaisesRegex(ValueError, "archive_integrity"):
            extract_verified_archive(path, destination, "0" * 64)
        self.assertEqual(list(destination.iterdir()), [])

    def test_paths_aliases_and_duplicates_refused(self):
        for index, extra in enumerate(
            (
                ("../escape", "file"),
                ("/absolute", "file"),
                ("alias", "symlink"),
                ("alias", "hardlink"),
                ("runsc", "file"),
            )
        ):
            path, digest = self.archive([extra])
            destination = self.root / str(index)
            destination.mkdir()
            with self.assertRaisesRegex(ValueError, "unsafe_gvisor_archive_member"):
                extract_verified_archive(path, destination, digest)
        self.assertFalse((self.root / "escape").exists())


if __name__ == "__main__":
    unittest.main()
