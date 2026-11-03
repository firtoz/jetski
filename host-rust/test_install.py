"""Disposable-prefix installation tests; never modify an execution host."""

import hashlib
import importlib.util
import json
import os
import pathlib
import tempfile
import unittest

spec = importlib.util.spec_from_file_location(
    "native_install", pathlib.Path(__file__).with_name("install.py")
)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class InstallationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = pathlib.Path(self.temp.name)
        self.installer = module.Installer(self.root, os.geteuid())
        self.binary = bytearray(64)
        self.binary[:6] = b"\x7fELF\x02\x01"
        self.binary[18:20] = b"\x3e\x00"
        self.identity = dict(
            version=1,
            backend="rust",
            sha256=hashlib.sha256(self.binary).hexdigest(),
            bytes=64,
            machineId="host",
            poolId="pool",
        )

    def run_install(self, action):
        return self.installer.run(dict(action=action, identity=self.identity))

    def base(self):
        for parent, name, data in (
            ("/etc/jetski", "host.json", dict(machineId="host", poolId="pool")),
            ("/var/lib/jetski-bootstrap", "receipt.json", dict(version=1, digest="a" * 64)),
        ):
            directory = self.installer.directory(parent)
            self.installer.publish(directory / name, json.dumps(data).encode())

    def upload(self, data=None):
        path = self.installer.directory("/tmp") / (
            "jetski-native-" + self.identity["sha256"] + ".bin"
        )
        path.write_bytes(self.binary if data is None else data)

    def test_intent_precedes_base_and_replay_cannot_convert_or_change_identity(self):
        self.base()
        with self.assertRaisesRegex(ValueError, "existing_host_requires_replacement"):
            self.run_install("prepare")
        self.assertFalse(self.installer.path("/var/lib/jetski-native/intent.json").exists())

    def test_verified_artifact_ready_and_lost_marker_ack_recovery(self):
        self.run_install("prepare")
        self.base()
        self.upload()
        receipt = self.run_install("install")
        self.assertTrue(receipt["ready"])
        binary = self.installer.path("/opt/jetski/native/jetski-host")
        self.assertEqual(binary.read_bytes(), self.binary)
        self.assertEqual(binary.stat().st_mode & 0o7777, 0o555)
        original = binary.stat().st_ino
        self.installer.path("/etc/jetski/native-host.json").unlink()
        self.assertEqual(self.run_install("install"), receipt)
        self.assertEqual(binary.stat().st_ino, original)
        self.identity["sha256"] = "f" * 64
        with self.assertRaisesRegex(ValueError, "native_backend_identity_changed"):
            self.run_install("prepare")

    def test_corruption_and_symlinks_fail_before_ready(self):
        self.run_install("prepare")
        self.base()
        self.upload(b"x" * 64)
        with self.assertRaisesRegex(ValueError, "native_artifact_integrity"):
            self.run_install("install")
        self.assertFalse(self.installer.path("/etc/jetski/native-host.json").exists())
        self.upload()
        self.run_install("install")
        binary = self.installer.path("/opt/jetski/native/jetski-host")
        binary.unlink()
        binary.symlink_to(
            self.installer.path("/tmp/jetski-native-" + self.identity["sha256"] + ".bin")
        )
        with self.assertRaises(OSError):
            self.run_install("install")


if __name__ == "__main__":
    unittest.main()
