import os
import pathlib
import tempfile
import unittest
import hashlib
from unittest.mock import patch
from types import SimpleNamespace

from gvisor_memory import normalize_permissions
from gvisor_rootfs import prepare, sync_tree
from runtime_backend import runtime_policy, selected_backend, DEFAULT_BACKEND
from gvisor_oci import RELEASE, ARCHIVE_SHA256
from gvisor_environment import prepare_images


class EnvironmentTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = pathlib.Path(self.temp.name)

    def test_mount_destinations_reject_image_symlink_escape(self):
        outside = self.root / "outside"
        outside.mkdir()
        rootfs = self.root / "image"
        rootfs.mkdir()
        (rootfs / "home").symlink_to(outside, target_is_directory=True)
        with self.assertRaises(OSError):
            prepare(rootfs)
        self.assertFalse((outside / "sandbox").exists())

    def test_rootfs_sync_preserves_links_and_rejects_special_files(self):
        prepare(self.root)
        (self.root / "link").symlink_to("/nonexistent-external-target")
        sync_tree(self.root)
        self.assertEqual(os.readlink(self.root / "link"), "/nonexistent-external-target")
        os.mkfifo(self.root / "fifo")
        with self.assertRaisesRegex(ValueError, "unsupported_gvisor_image_member"):
            sync_tree(self.root)

    def test_memory_normalization_cannot_chmod_an_external_symlink_target(self):
        memory = self.root / "memory"
        memory.mkdir(mode=0o700)
        external = self.root / "external"
        external.write_bytes(b"keep mode")
        external.chmod(0o644)
        (memory / "alias").symlink_to(external)
        with self.assertRaisesRegex(ValueError, "unsafe_memory_member"):
            normalize_permissions(memory, owner_uid=os.geteuid())
        self.assertEqual(external.stat().st_mode & 0o777, 0o644)
        (memory / "alias").unlink()
        pages = memory / "pages"
        pages.write_bytes(b"private pages")
        pages.chmod(0o644)
        normalize_permissions(memory, owner_uid=os.geteuid())
        self.assertEqual(pages.stat().st_mode & 0o777, 0o600)

    def test_verified_image_preparation_is_observed_after_a_lost_bootstrap_ack(self):
        # A private home-style ancestor is required; /tmp is intentionally unsafe
        # for production runtime control directories.
        with tempfile.TemporaryDirectory(
            prefix=".jetski-image-test-", dir=pathlib.Path.home()
        ) as temporary:
            home = pathlib.Path(temporary)
            account = SimpleNamespace(pw_uid=os.geteuid(), pw_gid=os.getegid(), pw_dir=str(home))
            image = "example/linux@sha256:" + "a" * 64
            image_root = (
                home / "gvisor/images" / hashlib.sha256(image.encode()).hexdigest() / "rootfs"
            )
            image_root.mkdir(parents=True)
            for directory in (home / "gvisor", home / "gvisor/images", image_root.parent):
                directory.chmod(0o700)
            proof = home / "proof.json"
            proof.write_text("verified by the root-owned receipt reader")
            expected = dict(
                version=1, archiveSha256=ARCHIVE_SHA256, images={image: str(image_root)}
            )
            with (
                patch("gvisor_environment.IMAGE_PROOF", proof),
                patch("gvisor_environment.read_json", return_value=expected),
                patch("gvisor_environment.prepare_delegation") as delegation,
            ):
                prepare_images(account, [image], lambda args: self.fail("Image copying replayed"))
                delegation.assert_called_once_with(account)

    def test_operator_policy_is_pinned_and_default_stays_podman(self):
        self.assertIs(selected_backend({}, None), DEFAULT_BACKEND)
        policy = dict(kind="gvisor", version=1, release=RELEASE, archiveSha256=ARCHIVE_SHA256)
        self.assertEqual(runtime_policy({"runtime": policy}), policy)
        for modified in (
            {**policy, "release": "latest"},
            {**policy, "rootless": True},
            {**policy, "archiveSha256": "0" * 64},
        ):
            with self.assertRaises(ValueError):
                runtime_policy({"runtime": modified})
        with self.assertRaisesRegex(ValueError, "egress_not_qualified"):
            runtime_policy({"runtime": policy, "networkMode": "egress"})
