"""One verified, owner-scoped archive cache per host, never a durability root."""

import errno
import hashlib
import os
import pathlib
import shutil
import stat
import tempfile

from archive import sync_dir
from fence import identity
from timing import stage


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
            if not self.metadata_matches(meta, expected):
                return False
            digest = hashlib.file_digest(source, "sha256").hexdigest()
            return digest == expected["sha256"]

    def metadata_matches(self, meta, expected):
        return (
            stat.S_ISREG(meta.st_mode)
            and meta.st_uid == os.geteuid()
            and not meta.st_mode & 0o022
            and meta.st_size == expected["bytes"]
        )

    def provisional_locked(self, lease, state, expected):
        """Eligibility only: bytes must still be verified in private staging."""
        source = self.candidate_locked(lease, state, expected)
        if source is None:
            return None
        try:
            fd = os.open(source, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        except OSError:
            return None
        try:
            return source if self.metadata_matches(os.fstat(fd), expected) else None
        finally:
            os.close(fd)

    @stage("cache.publish")
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
            # The released archive is immutable and private to the supervisor.
            # A rename avoids copying and hashing its full contents a second time.
            # Recovery also accepts the exact destination after a lost metadata ACK.
            if not os.path.lexists(source):
                if not self.verified(destination, expected):
                    raise ValueError("cache_source_integrity")
            else:
                if not self.verified(source, expected):
                    raise ValueError("cache_source_integrity")
                try:
                    os.replace(source, destination)
                except OSError as error:
                    if error.errno != errno.EXDEV:
                        raise
                    self.copy_verified(source, destination, expected)
            # Both directory entries must be durable before publishing metadata,
            # including replay after a rename or directory-sync interruption.
            sync_dir(self.root)
            sync_dir(self.archives)
            self.fence.write({**state, "localCheckpoint": expected})
            return expected

    def copy_verified(self, source, destination, expected):
        """Cross-filesystem fallback retains the source through verified copying."""
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
        finally:
            if os.path.lexists(pending):
                os.unlink(pending)

    def candidate_locked(self, lease, state, expected):
        """Scope lookup only; the caller must verify bytes before using the path."""
        cached = state.get("localCheckpoint")
        if (
            not isinstance(cached, dict)
            or set(cached) != {"owner", "sandbox", "id", "sha256", "bytes"}
            or cached["owner"] != lease["owner"]
            or cached["sandbox"] != lease["sandboxId"]
            or cached["sha256"] != expected["sha256"]
            or cached["bytes"] != expected["bytes"]
        ):
            return None
        return self.directory()

    def source_locked(self, lease, state, expected):
        """Select verified immutable bytes under a fresh import's fence lock.

        No writable import path aliases this inode. A persisted cache selection
        disables chunks before extraction; lost selection ACKs cannot mutate it.
        """
        source = self.candidate_locked(lease, state, expected)
        if source is None or not self.verified(source, expected):
            return None
        return source
