"""Host journal tests with a simulated native driver, not native/R2 proof."""

import base64
import copy
import os
import pathlib
import shutil
import unittest

from fence import Fence
from portable_memory_format import manifest_sha256, manifest_objects
from portable_memory_import import PortableMemoryImport
import test_memory_chunks as chunk_fixture


class PortableImportTests(unittest.TestCase):
    def setUp(self):
        chunk_fixture.MemoryChunkTests.setUp(self)
        self.lease = copy.deepcopy(self.binding["lease"])
        capture, files, self.objects = chunk_fixture.MemoryChunkTests.prepare(self)
        for file in files:
            for chunk in file["chunks"]:
                chunk["object"]["sandbox"] = self.lease["sandboxId"]
        self.compatibility = dict(
            runtimeSha256="a" * 64,
            hostAbiSha256="b" * 64,
            image=self.binding["image"],
            configurationSha256="c" * 64,
            platform="systrap",
            kernelVersion="6.14.0",
            cpuFeatures=["sse", "sse2"],
        )
        self.manifest = dict(
            owner=self.lease["owner"],
            sandbox=self.lease["sandboxId"],
            kind="portable-memory",
            version=1,
            generation=1,
            checkpointId=self.binding["checkpointId"],
            filesystemSha256=self.binding["filesystemSha256"],
            compatibility=self.compatibility,
            directories=capture["directories"],
            files=files,
        )
        self.sha = manifest_sha256(self.manifest)
        self.data = self.base / "data"
        self.data.mkdir(mode=0o700)
        self.assignment = self.data / self.lease["assignmentId"]
        self.assignment.mkdir(mode=0o700)
        for name in ("workspace", "home"):
            (self.assignment / name).mkdir(mode=0o700)
        self.fence = Fence(self.base / "fence")
        self.fence.claim(self.lease)
        self.fence.write(
            dict(
                lease=self.lease,
                phase="open",
                import_ignored=None,
                **{
                    "import": dict(
                        id=self.manifest["checkpointId"],
                        phase="ready",
                        sha256=self.manifest["filesystemSha256"],
                        portableMemoryRequired=True,
                    )
                },
            )
        )
        fixture = self

        class Driver:
            restores = 0
            active = False
            lost_ack = False
            unknown = False
            corrupt_handoff = False

            def container(self, lease):
                return "target-container"

            def absent(self, lease):
                return not self.active

            def prepare_imported(self, *args):
                pass

            def portable_compatibility(self, lease):
                return copy.deepcopy(fixture.compatibility)

            def memory_path(self, lease, identifier):
                return str(fixture.base / "images" / identifier)

            def prepare_imported_parent(self, lease, identifier):
                (fixture.base / "images").mkdir(mode=0o700, exist_ok=True)

            def accept_imported_image(self, lease, identifier):
                if self.corrupt_handoff:
                    (pathlib.Path(self.memory_path(lease, identifier)) / "pages.img").write_bytes(
                        b"x" * len(fixture.pages)
                    )

            def compatibility(self, lease):
                return {
                    key: fixture.binding[key]
                    for key in (
                        "runtimeSha256",
                        "image",
                        "configurationSha256",
                        "platform",
                        "kernelVersion",
                        "cpuFeaturesSha256",
                    )
                }

            def memory_owner(self):
                return os.geteuid()

            def restore_imported(self, lease, identifier, *args):
                self.restores += 1
                if self.unknown:
                    raise OSError("Native effect completion unknown")
                fixture.assertEqual(
                    (pathlib.Path(self.memory_path(lease, identifier)) / "pages.img").read_bytes(),
                    fixture.pages,
                )
                self.active = True
                if self.lost_ack:
                    raise OSError("Lost native restore ACK")

            def running(self, lease):
                return self.active

            def verify_resources(self, *args):
                return self.active

            def remove(self, lease):
                fixture.assertFalse(self.active)
                if (fixture.base / "images").exists():
                    shutil.rmtree(fixture.base / "images")

        self.driver = Driver()
        self.importer = PortableMemoryImport(
            self.fence, self.driver, self.base / "imports", self.data
        )

    def begin(self):
        return self.importer.begin(
            self.lease, self.manifest, self.sha, self.binding["image"], 512, 1
        )

    def upload(self):
        for obj in manifest_objects(self.manifest).values():
            data = self.objects[obj["id"]]
            receipt = self.importer.chunk(
                self.lease,
                self.manifest["checkpointId"],
                obj["id"],
                0,
                base64.b64encode(data).decode(),
                obj["sha256"],
            )
            self.assertTrue(receipt["complete"])

    def finish(self):
        return self.importer.finish(self.lease, self.manifest["checkpointId"], self.sha)

    def test_full_import_replay_and_lost_native_ack_do_not_repeat_restore(self):
        self.assertEqual(self.begin()["phase"], "receiving")
        self.assertEqual(self.fence.read()["phase"], "closed")
        self.assertEqual(self.begin()["phase"], "receiving")
        self.upload()
        self.upload()  # Byte-identical chunk ACK replay is accepted.
        self.driver.lost_ack = True
        self.assertEqual(self.finish()["phase"], "restored")
        self.assertEqual(self.finish()["phase"], "restored")
        self.assertEqual(self.begin()["phase"], "restored")
        self.assertEqual(self.driver.restores, 1)
        self.assertEqual(self.fence.read()["phase"], "open")

    def test_unknown_restore_stays_quarantined_and_cannot_fallback_or_replay(self):
        self.begin()
        self.upload()
        self.driver.unknown = True
        with self.assertRaises(OSError):
            self.finish()
        self.assertEqual(self.fence.read()["phase"], "quarantined")
        self.assertEqual(self.finish()["phase"], "restoring")
        with self.assertRaises(ValueError):
            self.importer.abort(self.lease, self.manifest["checkpointId"], self.sha)
        self.assertEqual(self.driver.restores, 1)

    def test_missing_objects_and_changed_filesystem_do_not_execute(self):
        self.begin()
        with self.assertRaises(ValueError):
            self.finish()
        self.upload()
        (self.assignment / "workspace/new").write_bytes(b"changed")
        with self.assertRaises(ValueError):
            self.finish()
        self.assertEqual(self.driver.restores, 0)

    def test_byte_changes_after_handoff_are_rejected_before_native_effect(self):
        self.begin()
        self.upload()
        self.driver.corrupt_handoff = True
        with self.assertRaisesRegex(ValueError, "image_integrity"):
            self.finish()
        self.assertEqual(self.driver.restores, 0)

    def test_manifest_scope_digest_and_resource_identity_cannot_change_on_replay(self):
        changed = copy.deepcopy(self.manifest)
        changed["owner"] = "other"
        with self.assertRaises(ValueError):
            self.importer.begin(
                self.lease, changed, manifest_sha256(changed), self.binding["image"], 512, 1
            )
        with self.assertRaises(ValueError):
            self.importer.begin(self.lease, self.manifest, "0" * 64, self.binding["image"], 512, 1)
        self.begin()
        with self.assertRaises(ValueError):
            self.importer.begin(self.lease, self.manifest, self.sha, self.binding["image"], 1024, 1)
        with self.assertRaises(ValueError):
            self.importer.status({**self.lease, "generation": 2}, self.manifest["checkpointId"])

    def test_known_incompatibility_requires_explicit_pre_effect_filesystem_fallback(self):
        self.driver.portable_compatibility = lambda lease: {
            **self.compatibility,
            "cpuFeatures": ["sse"],
        }
        self.assertEqual(self.begin()["phase"], "rejected")
        result = self.importer.abort(self.lease, self.manifest["checkpointId"], self.sha)
        self.assertEqual(result["phase"], "filesystem")
        self.assertFalse(result["memoryPreserved"])
        self.assertIsNone(self.fence.read()["runtime"])
        self.assertEqual(self.driver.restores, 0)

    def test_released_assignment_purges_only_derived_import_cache(self):
        self.begin()
        self.upload()
        self.finish()
        directory = self.importer.directory(self.lease, self.manifest["checkpointId"])
        self.assertTrue(directory.exists())
        state = self.fence.read()
        self.fence.write({**state, "phase": "released", "releaseReceipt": {"published": True}})
        with self.fence.locked():
            self.importer.purge_locked(self.lease)
        self.assertFalse(directory.exists())
        self.assertTrue(self.assignment.exists())
