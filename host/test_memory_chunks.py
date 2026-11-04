import copy
import hashlib
import os
import pathlib
import tempfile
import unittest
import uuid
from unittest import mock

from gvisor_memory import image_manifest
from memory_chunks import capture_chunks, decode_chunk, reconstruct_chunks


class MemoryChunkTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.base = pathlib.Path(self.temp.name)
        self.root = self.base / "native"
        self.root.mkdir(mode=0o700)
        (self.root / "nested").mkdir(mode=0o700)
        (self.root / "nested/empty").write_bytes(b"")
        self.pages = bytes(range(256)) * 100
        (self.root / "pages.img").write_bytes(self.pages)
        for path in self.root.rglob("*"):
            path.chmod(0o700 if path.is_dir() else 0o600)
        lease = dict(
            owner="owner",
            poolId="pool",
            machineId="machine",
            slotId=str(uuid.uuid4()),
            sandboxId=str(uuid.uuid4()),
            assignmentId=str(uuid.uuid4()),
            generation=1,
        )
        self.binding = dict(
            version=1,
            lease=lease,
            checkpointId=str(uuid.uuid4()),
            runtimeSha256="a" * 64,
            image="example/linux@sha256:" + "a" * 64,
            filesystemSha256="b" * 64,
            filesystemIdentitySha256="c" * 64,
            configurationSha256="d" * 64,
            platform="systrap",
            kernelVersion="6.14.0",
            cpuFeaturesSha256="e" * 64,
        )
        self.scope = dict(owner="owner", sandbox="sandbox")
        self.sealed = image_manifest(self.root, self.binding)["files"]

    def prepare(self, codec="gzip"):
        pack = self.base / (codec + ".pack")
        captured = capture_chunks(self.root, self.sealed, pack, codec=codec, chunk_bytes=4096)
        data = pack.read_bytes()
        self.assertEqual(hashlib.sha256(data).hexdigest(), captured["sha256"])
        files, objects = [], {}
        for source in captured["files"]:
            file = {**source, "chunks": []}
            for part in source["chunks"]:
                key = part["storedSha256"]
                obj = dict(**self.scope, id="object-" + key, bytes=part["storedBytes"], sha256=key)
                objects[obj["id"]] = data[
                    part["packedOffset"] : part["packedOffset"] + part["storedBytes"]
                ]
                file["chunks"].append(
                    dict(
                        offset=part["offset"],
                        bytes=part["bytes"],
                        sha256=part["sha256"],
                        codec=part["codec"],
                        object=obj,
                    )
                )
            files.append(file)
        return captured, files, objects

    def test_identity_and_compressed_images_reconstruct_exactly(self):
        for codec in ("identity", "gzip"):
            with self.subTest(codec=codec):
                capture, files, objects = self.prepare(codec)
                target = self.base / (codec + "-restored")
                reconstruct_chunks(
                    files,
                    capture["directories"],
                    self.scope,
                    target,
                    lambda obj: objects[obj["id"]],
                )
                restored = image_manifest(target, self.binding)["files"]
                self.assertEqual(restored, self.sealed)
                with self.assertRaises(FileExistsError):
                    reconstruct_chunks(
                        files,
                        capture["directories"],
                        self.scope,
                        target,
                        lambda obj: objects[obj["id"]],
                    )

    def test_capture_refuses_changed_source_and_never_overwrites_a_partial_capture(self):
        (self.root / "pages.img").write_bytes(self.pages[:-1] + b"x")
        with self.assertRaises(ValueError):
            capture_chunks(self.root, self.sealed, self.base / "partial.pack")
        with self.assertRaises(FileExistsError):
            capture_chunks(self.root, self.sealed, self.base / "partial.pack")

    def test_native_symlink_or_hardlink_is_not_a_regular_private_image(self):
        (self.root / "pages.img").unlink()
        (self.root / "pages.img").symlink_to("nested/empty")
        with self.assertRaises(ValueError):
            capture_chunks(self.root, self.sealed, self.base / "symlink.pack")
        (self.root / "pages.img").unlink()
        os.link(self.root / "nested/empty", self.root / "pages.img")
        with self.assertRaises(ValueError):
            capture_chunks(self.root, self.sealed, self.base / "hardlink.pack")

    def test_reconstruction_rejects_bad_metadata_before_creating_any_output(self):
        capture, files, objects = self.prepare()
        for mutate in (
            lambda f: f[0].update(path="../outside"),
            lambda f: f[-1]["chunks"][0]["object"].update(owner="other"),
            lambda f: f[-1]["chunks"][0].update(offset=1),
            lambda f: f.append(copy.deepcopy(f[-1])),
        ):
            changed = copy.deepcopy(files)
            mutate(changed)
            target = self.base / "invalid"
            with self.assertRaises(ValueError):
                reconstruct_chunks(
                    changed,
                    capture["directories"],
                    self.scope,
                    target,
                    lambda obj: objects[obj["id"]],
                )
            self.assertFalse(target.exists())

    def test_corruption_short_reads_and_full_file_hash_mismatch_are_not_acknowledged(self):
        capture, files, objects = self.prepare()
        cases = [
            lambda obj: objects[obj["id"]][:-1],
            lambda obj: bytes([objects[obj["id"]][0] ^ 1]) + objects[obj["id"]][1:],
        ]
        for index, reader in enumerate(cases):
            with self.assertRaises(ValueError):
                reconstruct_chunks(
                    files, capture["directories"], self.scope, self.base / str(index), reader
                )
        changed = copy.deepcopy(files)
        changed[-1]["sha256"] = "f" * 64
        with self.assertRaises(ValueError):
            reconstruct_chunks(
                changed,
                capture["directories"],
                self.scope,
                self.base / "whole",
                lambda obj: objects[obj["id"]],
            )

    def test_expansion_and_trailing_compressed_data_fail_closed(self):
        import gzip

        encoded = gzip.compress(b"x" * 100000, mtime=0)
        for value in (encoded, encoded + encoded):
            with self.assertRaises(ValueError):
                decode_chunk(
                    value,
                    codec="gzip",
                    size=1,
                    sha256=hashlib.sha256(b"x").hexdigest(),
                    stored_sha256=hashlib.sha256(value).hexdigest(),
                )

    def test_capture_drains_short_regular_file_reads_without_losing_bytes(self):
        real_read = os.read
        with mock.patch(
            "memory_chunks.os.read", side_effect=lambda fd, count: real_read(fd, min(count, 37))
        ):
            capture, files, objects = self.prepare()
        reconstruct_chunks(
            files,
            capture["directories"],
            self.scope,
            self.base / "short",
            lambda obj: objects[obj["id"]],
        )
        self.assertEqual((self.base / "short/pages.img").read_bytes(), self.pages)


if __name__ == "__main__":
    unittest.main()
