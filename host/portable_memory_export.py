"""Fenced native-image capture and bounded source reads for portable publication.

No storage credentials or execution authority live here. The controller owns the
combined retained-root publication; the existing local seal follows verification.
"""

import base64
import copy
import hashlib
import os
import pathlib
import stat

from archive import sync_dir
from fence import identity
from gvisor_lifecycle import checkpoint_id
from gvisor_memory import image_manifest
from memory_chunks import capture_chunks
from memory_filesystem import frozen_identity


class PortableMemoryExport:
    def __init__(self, fence, driver, root, data):
        self.fence, self.driver = fence, driver
        self.root, self.data = pathlib.Path(root), pathlib.Path(data)

    def directory(self, path):
        if not os.path.lexists(path):
            path.mkdir(mode=0o700)
            sync_dir(path.parent)
        meta = path.lstat()
        if not stat.S_ISDIR(meta.st_mode) or meta.st_uid != os.geteuid() or meta.st_mode & 0o077:
            raise ValueError("unsafe_portable_memory_export")

    def path(self, lease, identifier):
        return (
            self.root
            / (lease["assignmentId"] + "-g" + str(lease["generation"]))
            / (identifier + ".pack")
        )

    def frozen(self, lease, identifier, filesystem_sha256):
        state = self.fence.read()
        self.fence.match(state, lease)
        memory, checkpoint = state.get("memory"), state.get("checkpoint")
        if (
            state["phase"] != "closed"
            or not memory
            or memory["id"] != identifier
            or memory["phase"] not in ("frozen", "sealed")
            or not checkpoint
            or checkpoint["sha256"] != filesystem_sha256
            or self.driver.stopped(lease) is not True
        ):
            raise ValueError("portable_memory_source_not_frozen")
        roots = {name: self.data / lease["assignmentId"] / name for name in ("workspace", "home")}
        if frozen_identity(roots) != memory.get("filesystemIdentitySha256"):
            raise ValueError("portable_memory_filesystem_changed")
        return state

    def prepare(self, raw, identifier, filesystem_sha256, *, codec="gzip", chunk_bytes=1024 * 1024):
        lease, identifier = copy.deepcopy(identity(raw)), checkpoint_id(identifier)
        if (
            codec not in ("identity", "gzip")
            or type(chunk_bytes) is not int
            or not 1024 <= chunk_bytes <= 4 * 1024**2
        ):
            raise ValueError("invalid_portable_export_policy")
        with self.fence.locked():
            state = self.frozen(lease, identifier, filesystem_sha256)
            memory = state["memory"]
            expected = dict(
                id=identifier,
                filesystemSha256=filesystem_sha256,
                codec=codec,
                chunkBytes=chunk_bytes,
            )
            prior = memory.get("portableExport")
            if prior and prior["input"] != expected:
                raise ValueError("portable_memory_export_identity_conflict")
            if prior and prior["phase"] == "ready":
                self.open_pack(lease, identifier, prior["capture"])[0].close()
                return copy.deepcopy(prior["capture"])
            binding = dict(
                version=1,
                lease=lease,
                checkpointId=identifier,
                filesystemSha256=filesystem_sha256,
                filesystemIdentitySha256=memory["filesystemIdentitySha256"],
                **memory["compatibility"],
            )
            native = image_manifest(
                self.driver.memory_path(lease, identifier),
                binding,
                owner_uid=self.driver.memory_owner(),
            )
            if prior and prior.get("nativeSha256") != native["sha256"]:
                raise ValueError("portable_memory_image_changed")
            compatibility = self.driver.portable_compatibility(lease, identifier)
            self.directory(self.root)
            path = self.path(lease, identifier)
            self.directory(path.parent)
            # A capturing receipt exposes no read/export handle. Holding the
            # fence proves any previous capture worker is gone; only its owned
            # unpublished temporary pack may be removed and reconstructed.
            if prior and prior["phase"] == "capturing" and os.path.lexists(path):
                meta = path.lstat()
                if (
                    not stat.S_ISREG(meta.st_mode)
                    or meta.st_uid != os.geteuid()
                    or meta.st_nlink != 1
                ):
                    raise ValueError("unsafe_partial_memory_export")
                path.unlink()
                sync_dir(path.parent)
            attempt = dict(input=expected, phase="capturing", nativeSha256=native["sha256"])
            self.fence.write({**state, "memory": {**memory, "portableExport": attempt}})
            capture = capture_chunks(
                self.driver.memory_path(lease, identifier),
                native["files"],
                path,
                codec=codec,
                chunk_bytes=chunk_bytes,
                owner_uid=self.driver.memory_owner(),
            )
            capture["compatibility"] = compatibility
            # Source identity is checked on both sides of the read-only capture.
            current = self.frozen(lease, identifier, filesystem_sha256)
            ready = {**attempt, "phase": "ready", "capture": capture}
            self.fence.write({**current, "memory": {**current["memory"], "portableExport": ready}})
            return copy.deepcopy(capture)

    def open_pack(self, lease, identifier, capture):
        path = self.path(lease, identifier)
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        source = os.fdopen(fd, "rb")
        meta = os.fstat(fd)
        if (
            not stat.S_ISREG(meta.st_mode)
            or meta.st_uid != os.geteuid()
            or meta.st_mode & 0o022
            or meta.st_size != capture["bytes"]
        ):
            source.close()
            raise ValueError("portable_memory_export_changed")
        return source, path

    def read(self, raw, identifier, offset, count):
        lease, identifier = copy.deepcopy(identity(raw)), checkpoint_id(identifier)
        if (
            type(offset) is not int
            or type(count) is not int
            or offset < 0
            or not 1 <= count <= 1280 * 1024
        ):
            raise ValueError("invalid_memory_export_range")
        with self.fence.locked():
            state = self.fence.read()
            self.fence.match(state, lease)
            memory = state.get("memory")
            exported = memory.get("portableExport") if memory else None
            if (
                state["phase"] != "closed"
                or not memory
                or memory["id"] != identifier
                or not exported
                or exported["phase"] != "ready"
                or offset + count > exported["capture"]["bytes"]
            ):
                raise ValueError("memory_export_range_unavailable")
            source, _ = self.open_pack(lease, identifier, exported["capture"])
            with source:
                source.seek(offset)
                data = source.read(count)
            if len(data) != count:
                raise ValueError("memory_export_short_read")
            return dict(
                offset=offset,
                bytes=count,
                sha256=hashlib.sha256(data).hexdigest(),
                base64=base64.b64encode(data).decode("ascii"),
            )

    def remove_pack(self, raw, identifier):
        """Internal derived-cache cleanup; caller must hold the lifecycle fence
        and prove durable publication plus resumed/released execution ownership.
        Never removes the native image or any durable object-store artifact.
        """
        lease, identifier = copy.deepcopy(identity(raw)), checkpoint_id(identifier)
        path = self.path(lease, identifier)
        if not os.path.lexists(path.parent):
            return
        self.directory(self.root)
        self.directory(path.parent)
        if os.path.lexists(path):
            meta = path.lstat()
            if not stat.S_ISREG(meta.st_mode) or meta.st_uid != os.geteuid() or meta.st_nlink != 1:
                raise ValueError("unsafe_portable_export_cleanup")
            path.unlink()
            sync_dir(path.parent)
        if not os.listdir(path.parent):
            path.parent.rmdir()
            sync_dir(self.root)
