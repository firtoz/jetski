"""One verified, owner-scoped archive cache per host, never a durability root."""

import hashlib
import os
import pathlib
import shutil
import stat
import tempfile

from archive import sync_dir
from fence import identity


class LocalCheckpoint:
    def __init__(self, fence, archives):
        self.fence = fence
        self.archives = pathlib.Path(archives)
        self.root = self.archives / "cache"

    def directory(self):
        self.root.mkdir(mode=0o700, exist_ok=True)
        meta = self.root.lstat()
        if not stat.S_ISDIR(meta.st_mode) or meta.st_uid != os.geteuid() or meta.st_mode & 0o077:
            raise ValueError("unsafe_checkpoint_cache")
        return self.root / "archive.tgz"

    def verified(self, path, expected):
        try:
            fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        except OSError:
            return False
        with os.fdopen(fd, "rb") as source:
            meta = os.fstat(source.fileno())
            if (
                not stat.S_ISREG(meta.st_mode)
                or meta.st_uid != os.geteuid()
                or meta.st_mode & 0o022
                or meta.st_size != expected["bytes"]
            ):
                return False
            digest = hashlib.file_digest(source, "sha256").hexdigest()
            return digest == expected["sha256"]

    def publish(self, raw, publication):
        lease = identity(raw)
        with self.fence.locked():
            state = self.fence.read()
            self.fence.match(state, lease)
            checkpoint = state.get("checkpoint")
            if (
                state["phase"] != "released"
                or state.get("releaseReceipt") != publication
                or not checkpoint
                or checkpoint["sha256"] != publication["sha256"]
                or state.get("runtime", {}).get("phase") != "removed"
            ):
                raise ValueError("cache_requires_durable_release")
            expected = dict(
                owner=lease["owner"],
                sandbox=lease["sandboxId"],
                id=publication["checkpointId"],
                sha256=checkpoint["sha256"],
                bytes=checkpoint["bytes"],
            )
            destination = self.directory()
            if state.get("localCheckpoint") == expected and self.verified(destination, expected):
                return expected
            source = self.archives / (lease["assignmentId"] + ".tgz")
            if not self.verified(source, expected):
                raise ValueError("cache_source_integrity")
            # A single cache slot bounds retained archives. Old metadata may
            # survive a crash after replace; a hash mismatch then causes a miss.
            for orphan in self.root.glob(".pending-*"):
                meta = orphan.lstat()
                if not stat.S_ISREG(meta.st_mode) or meta.st_uid != os.geteuid():
                    raise ValueError("unsafe_cache_staging")
                orphan.unlink()
            fd, pending = tempfile.mkstemp(prefix=".pending-", dir=self.root)
            try:
                with os.fdopen(fd, "wb") as output, source.open("rb") as input_file:
                    shutil.copyfileobj(input_file, output)
                    output.flush()
                    os.fsync(output.fileno())
                if not self.verified(pending, expected):
                    raise ValueError("cache_copy_integrity")
                os.replace(pending, destination)
                sync_dir(self.root)
                self.fence.write({**state, "localCheckpoint": expected})
            finally:
                if os.path.lexists(pending):
                    os.unlink(pending)
            return expected

    def seed_locked(self, lease, state, expected, destination):
        """Caller holds fence and has checked an unpublished fresh import target."""
        cached = state.get("localCheckpoint")
        if (
            not isinstance(cached, dict)
            or set(cached) != {"owner", "sandbox", "id", "sha256", "bytes"}
            or cached["owner"] != lease["owner"]
            or cached["sandbox"] != lease["sandboxId"]
            or cached["sha256"] != expected["sha256"]
            or cached["bytes"] != expected["bytes"]
        ):
            return False
        # Two retained roots may publish identical archive bytes under different
        # IDs. The controller has admitted the requested root; full content and
        # owner/sandbox identity, not the cache's earlier root ID, governs reuse.
        source = self.directory()
        if not self.verified(source, expected):
            return False
        if os.path.lexists(destination):
            return self.verified(destination, expected)
        # Keep import staging independent of the cache: a replayed partial upload
        # must never write into the cached inode. A full digest also recovers a
        # crash after copy/fsync but before the import offset is journaled.
        fd = os.open(destination, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        with os.fdopen(fd, "wb") as output, source.open("rb") as input_file:
            shutil.copyfileobj(input_file, output)
            output.flush()
            os.fsync(output.fileno())
        sync_dir(self.archives)
        if not self.verified(destination, expected):
            destination.unlink()
            sync_dir(self.archives)
            return False
        return True
