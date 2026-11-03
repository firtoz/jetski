import copy
import os
import pathlib
import tempfile
import unittest
import uuid

from gvisor_memory import image_manifest, verify_image


class MemoryProofTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = pathlib.Path(self.temp.name)
        self.pages = self.root / "pages.img"
        self.pages.write_bytes(b"memory\0pages" * 100)
        self.pages.chmod(0o600)
        self.binding = dict(
            version=1,
            lease=dict(
                owner="owner",
                poolId="pool",
                slotId=str(uuid.uuid4()),
                machineId="host",
                sandboxId=str(uuid.uuid4()),
                assignmentId=str(uuid.uuid4()),
                generation=1,
            ),
            runtimeSha256="a" * 64,
            image="example/linux@sha256:" + "b" * 64,
            checkpointId=str(uuid.uuid4()),
            filesystemSha256="c" * 64,
            filesystemIdentitySha256="f" * 64,
            configurationSha256="d" * 64,
            platform="systrap",
            kernelVersion="test-kernel",
            cpuFeaturesSha256="e" * 64,
        )

    def test_proof_covers_all_bytes_and_is_independent_of_caller_mutation(self):
        proof = image_manifest(self.root, self.binding)
        self.assertEqual(verify_image(self.root, proof, self.binding), proof)
        self.binding["lease"]["generation"] = 2
        self.assertEqual(proof["binding"]["lease"]["generation"], 1)
        with self.assertRaisesRegex(ValueError, "binding_mismatch"):
            verify_image(self.root, proof, self.binding)

    def test_same_size_corruption_is_detected(self):
        proof = image_manifest(self.root, self.binding)
        data = bytearray(self.pages.read_bytes())
        data[17] ^= 1
        self.pages.write_bytes(data)
        with self.assertRaisesRegex(ValueError, "image_integrity"):
            verify_image(self.root, proof, self.binding)

    def test_external_aliases_bounds_and_extra_files_fail_closed(self):
        with self.assertRaisesRegex(ValueError, "image_bytes"):
            image_manifest(self.root, self.binding, max_bytes=1)
        alias = self.root / "alias"
        alias.symlink_to(self.pages)
        with self.assertRaisesRegex(ValueError, "unsafe_memory_member"):
            image_manifest(self.root, self.binding)
        alias.unlink()
        os.link(self.pages, alias)
        with self.assertRaisesRegex(ValueError, "unsafe_memory_member"):
            image_manifest(self.root, self.binding)
        alias.unlink()
        proof = image_manifest(self.root, self.binding)
        (self.root / "extra").write_bytes(b"unexpected")
        (self.root / "extra").chmod(0o600)
        with self.assertRaisesRegex(ValueError, "image_integrity"):
            verify_image(self.root, proof, self.binding)

    def test_runtime_filesystem_host_and_configuration_cannot_be_substituted(self):
        proof = image_manifest(self.root, self.binding)
        for key in [
            "runtimeSha256",
            "filesystemSha256",
            "filesystemIdentitySha256",
            "configurationSha256",
            "cpuFeaturesSha256",
        ]:
            changed = copy.deepcopy(self.binding)
            changed[key] = "0" * 64
            with self.assertRaisesRegex(ValueError, "binding_mismatch"):
                verify_image(self.root, proof, changed)
        changed = copy.deepcopy(self.binding)
        changed["lease"]["machineId"] = "another-host"
        with self.assertRaisesRegex(ValueError, "binding_mismatch"):
            verify_image(self.root, proof, changed)


if __name__ == "__main__":
    unittest.main()
