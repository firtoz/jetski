import os
import types
import pathlib
import shutil
import subprocess
import sys
import tempfile
import unittest
from bootstrap import MODULES, STORAGE_CONFIG, configure_storage


class BootstrapTests(unittest.TestCase):
    def test_storage_choice_is_fresh_idempotent_and_does_not_reset_data(self):
        with tempfile.TemporaryDirectory() as root:
            account = types.SimpleNamespace(pw_dir=root, pw_uid=os.getuid(), pw_gid=os.getgid())
            configure_storage(account, "default")
            self.assertFalse((pathlib.Path(root) / ".config").exists())
            configure_storage(account, "fuse-overlayfs")
            config = pathlib.Path(root) / ".config/containers/storage.conf"
            self.assertEqual(config.read_text(), STORAGE_CONFIG)
            store = pathlib.Path(root) / ".local/share/containers/storage"
            store.mkdir(parents=True)
            (store / "retained").write_bytes(b"unchanged")
            configure_storage(account, "fuse-overlayfs")
            self.assertEqual((store / "retained").read_bytes(), b"unchanged")
            config.write_text('[storage]\ndriver="vfs"\n')
            with self.assertRaisesRegex(ValueError, "configuration_conflict"):
                configure_storage(account, "fuse-overlayfs")
            self.assertIn("vfs", config.read_text())

    def test_storage_choice_rejects_existing_store_and_unsafe_paths(self):
        with tempfile.TemporaryDirectory() as root:
            account = types.SimpleNamespace(pw_dir=root, pw_uid=os.getuid(), pw_gid=os.getgid())
            store = pathlib.Path(root) / ".local/share/containers/storage"
            store.mkdir(parents=True)
            with self.assertRaisesRegex(ValueError, "fresh_store"):
                configure_storage(account, "fuse-overlayfs")
            self.assertFalse((pathlib.Path(root) / ".config/containers/storage.conf").exists())
        with tempfile.TemporaryDirectory() as root, tempfile.TemporaryDirectory() as outside:
            account = types.SimpleNamespace(pw_dir=root, pw_uid=os.getuid(), pw_gid=os.getgid())
            (pathlib.Path(root) / ".config").symlink_to(outside)
            with self.assertRaisesRegex(ValueError, "unsafe_runtime_storage_path"):
                configure_storage(account, "fuse-overlayfs")
            self.assertEqual(list(pathlib.Path(outside).iterdir()), [])
        with self.assertRaisesRegex(ValueError, "invalid_storage_policy"):
            configure_storage(account, "unknown")

    def test_installed_bundle_imports_without_source_checkout(self):
        with tempfile.TemporaryDirectory(prefix="jetski-installed-") as temporary:
            installed = pathlib.Path(temporary)
            source = pathlib.Path(__file__).resolve().parent
            for module in MODULES:
                shutil.copyfile(source / module, installed / module)
            result = subprocess.run(
                [
                    sys.executable,
                    "-I",
                    "-c",
                    "import sys; sys.path.insert(0,sys.argv[1]); import control; import commands",
                    str(installed),
                ],
                cwd="/",
                capture_output=True,
                text=True,
                timeout=10,
            )
            self.assertEqual(result.returncode, 0, result.stderr)


if __name__ == "__main__":
    unittest.main()
