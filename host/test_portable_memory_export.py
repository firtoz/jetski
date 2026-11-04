import base64
import copy
import pathlib
import unittest
from types import SimpleNamespace

from fence import Fence
from memory_filesystem import frozen_identity
from portable_memory_export import PortableMemoryExport
import test_memory_chunks as chunk_fixture


class PortableExportTests(unittest.TestCase):
    def setUp(self):
        chunk_fixture.MemoryChunkTests.setUp(self)
        self.lease = copy.deepcopy(self.binding["lease"])
        self.data = self.base / "data"
        self.data.mkdir(mode=0o700)
        self.assignment = self.data / self.lease["assignmentId"]
        self.assignment.mkdir(mode=0o700)
        self.roots = {name: self.assignment / name for name in ("workspace", "home")}
        for root in self.roots.values():
            root.mkdir(mode=0o700)
        self.checkpoint = self.binding["checkpointId"]
        self.fence = Fence(self.base / "fence")
        self.fence.claim(self.lease)
        compatibility = {
            key: self.binding[key]
            for key in (
                "runtimeSha256",
                "image",
                "configurationSha256",
                "platform",
                "kernelVersion",
                "cpuFeaturesSha256",
            )
        }
        self.fence.write(
            dict(
                lease=self.lease,
                phase="closed",
                checkpoint=dict(sha256=self.binding["filesystemSha256"]),
                memory=dict(
                    id=self.checkpoint,
                    phase="frozen",
                    filesystemIdentitySha256=frozen_identity(self.roots),
                    compatibility=compatibility,
                ),
            )
        )
        self.driver = SimpleNamespace(
            memory_path=lambda lease, cp: str(self.root),
            memory_owner=lambda: self.root.stat().st_uid,
            stopped=lambda lease: True,
            portable_compatibility=lambda lease, cp: dict(
                runtimeSha256="a" * 64,
                hostAbiSha256="b" * 64,
                image=self.binding["image"],
                configurationSha256="c" * 64,
                platform="systrap",
                kernelVersion="6.14.0",
                cpuFeatures=["sse", "sse2"],
            ),
        )
        self.export = PortableMemoryExport(
            self.fence, self.driver, self.base / "exports", self.data
        )

    def test_fenced_export_replays_and_reads_exact_encoded_ranges(self):
        args = (self.lease, self.checkpoint, self.binding["filesystemSha256"])
        first = self.export.prepare(*args)
        self.assertEqual(first, self.export.prepare(*args))
        response = self.export.read(self.lease, self.checkpoint, 0, first["bytes"])
        encoded = base64.b64decode(response["base64"])
        self.assertEqual(first["bytes"], len(encoded))
        with self.assertRaises(ValueError):
            self.export.read({**self.lease, "generation": 2}, self.checkpoint, 0, 1)
        with self.assertRaises(ValueError):
            self.export.prepare(*args, codec="identity")

    def test_modified_filesystem_and_unconfirmed_native_stop_refuse_export(self):
        (self.roots["workspace"] / "new").write_bytes(b"different")
        with self.assertRaises(ValueError):
            self.export.prepare(self.lease, self.checkpoint, self.binding["filesystemSha256"])
        self.assertFalse((self.base / "exports").exists())

    def test_partial_capture_recovers_only_its_private_unpublished_pack(self):
        from unittest import mock

        real_prepare = self.export.prepare

        def partial(*args, **kwargs):
            pathlib.Path(args[2]).write_bytes(b"partial")
            raise OSError("interrupted capture")

        with mock.patch("portable_memory_export.capture_chunks", side_effect=partial):
            with self.assertRaises(OSError):
                real_prepare(self.lease, self.checkpoint, self.binding["filesystemSha256"])
        self.assertEqual(self.fence.read()["memory"]["portableExport"]["phase"], "capturing")
        result = real_prepare(self.lease, self.checkpoint, self.binding["filesystemSha256"])
        self.assertGreater(result["bytes"], 0)
