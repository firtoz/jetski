"""Fenced, resumable checkpoint import. Publication precedes workload admission."""

import base64
import hashlib
import os
import pathlib
import re
import shutil
import stat
import uuid
from archive import digest, restore, sync_dir
from fence import identity
from local_checkpoint import LocalCheckpoint


IMPORT_CHUNK_BYTES = 4 * 1024**2
IMPORT_REQUEST_BYTES = 6 * 1024**2


class CheckpointImport:
    def __init__(self, fence, archives, data, account):
        self.fence, self.archives, self.data, self.account = (
            fence,
            pathlib.Path(archives),
            pathlib.Path(data),
            account,
        )

    def state(self, lease):
        state = self.fence.read()
        self.fence.match(state, lease)
        if state["phase"] != "open" or state.get("runtime"):
            raise ValueError("import_requires_fresh_assignment")
        return state

    def path(self, lease):
        return self.archives / (lease["assignmentId"] + ".upload")

    def begin(self, raw, checkpoint, sha256, length):
        lease = identity(raw)
        if not isinstance(checkpoint, str) or str(uuid.UUID(checkpoint)) != checkpoint:
            raise ValueError("invalid_checkpoint_id")
        if (
            not isinstance(sha256, str)
            or not re.fullmatch("[a-f0-9]{64}", sha256)
            or type(length) is not int
            or not 0 < length <= 16 * 1024**3
        ):
            raise ValueError("invalid_import_metadata")
        expected = dict(id=checkpoint, sha256=sha256, bytes=length)
        with self.fence.locked():
            state = self.state(lease)
            previous = state.get("import")
            if previous:
                if any(previous[key] != value for key, value in expected.items()):
                    raise ValueError("import_identity_conflict")
                if previous["phase"] == "receiving" and previous["offset"] == 0:
                    return self.cached(lease, state, previous)
                return previous
            if os.path.lexists(self.data / lease["assignmentId"]) or os.path.lexists(
                self.path(lease)
            ):
                raise ValueError("import_destination_exists")
            receipt = {
                **expected,
                "offset": 0,
                "phase": "receiving",
                "chunkBytes": IMPORT_CHUNK_BYTES,
            }
            state = {**state, "import": receipt}
            self.fence.write(state)
            return self.cached(lease, state, receipt)

    def cached(self, lease, state, receipt):
        expected = {key: receipt[key] for key in ("id", "sha256", "bytes")}
        cache = LocalCheckpoint(self.fence, self.archives)
        selected = None
        if os.path.lexists(self.path(lease)):
            # Preserve complete staging left by an older host or a lost receipt.
            reusable = cache.verified(self.path(lease), expected)
        else:
            selected = cache.source_locked(lease, state, expected)
            reusable = selected is not None
        if reusable:
            receipt = {**receipt, "offset": receipt["bytes"], "phase": "extracting"}
            if selected is not None:
                receipt["cacheSource"] = state["localCheckpoint"]
            self.fence.write({**state, "import": receipt})
        return receipt

    def chunk(self, raw, offset, encoded, sha256):
        lease = identity(raw)
        if (
            type(offset) is not int
            or offset < 0
            or not isinstance(encoded, str)
            or len(encoded) > ((IMPORT_CHUNK_BYTES + 2) // 3) * 4
        ):
            raise ValueError("invalid_import_chunk")
        try:
            data = base64.b64decode(encoded, validate=True)
        except ValueError:
            raise ValueError("invalid_import_encoding") from None
        if not 1 <= len(data) <= IMPORT_CHUNK_BYTES or hashlib.sha256(data).hexdigest() != sha256:
            raise ValueError("import_chunk_integrity")
        with self.fence.locked():
            state = self.state(lease)
            receipt = state.get("import")
            if (
                not receipt
                or len(data) > receipt.get("chunkBytes", 256 * 1024)
                or receipt["phase"] != "receiving"
                or offset > receipt["offset"]
                or offset + len(data) > receipt["bytes"]
            ):
                raise ValueError("import_chunk_extent")
            flags = os.O_RDWR | os.O_NOFOLLOW
            if offset == 0:
                flags |= os.O_CREAT
            fd = os.open(self.path(lease), flags, 0o600)
            with os.fdopen(fd, "r+b") as output:
                size = os.fstat(output.fileno()).st_size
                if size < receipt["offset"] or size > receipt["bytes"]:
                    raise ValueError("import_file_extent")
                output.seek(offset)
                existing = output.read(len(data))
                if existing != data[: len(existing)]:
                    raise ValueError("import_replay_conflict")
                if offset < receipt["offset"]:
                    if offset + len(data) > receipt["offset"] or len(existing) != len(data):
                        raise ValueError("import_replay_extent")
                    return receipt
                output.seek(offset)
                output.write(data)
                output.flush()
                os.fsync(output.fileno())
            sync_dir(self.archives)
            receipt = {**receipt, "offset": offset + len(data)}
            self.fence.write({**state, "import": receipt})
            return receipt

    def finish(self, raw):
        lease = identity(raw)
        with self.fence.locked():
            state = self.state(lease)
            receipt = state.get("import")
            if not receipt or receipt["offset"] != receipt["bytes"]:
                raise ValueError("import_incomplete")
            if receipt["phase"] == "ready":
                return receipt
            source = self.path(lease)
            if "cacheSource" in receipt:
                expected = {key: receipt[key] for key in ("id", "sha256", "bytes")}
                source = LocalCheckpoint(self.fence, self.archives).candidate_locked(
                    lease, state, expected
                )
                if source is None or receipt["cacheSource"] != state.get("localCheckpoint"):
                    raise ValueError("import_cache_identity_changed")
                meta = source.lstat()
                if (
                    not stat.S_ISREG(meta.st_mode)
                    or meta.st_uid != os.geteuid()
                    or meta.st_mode & 0o022
                    or meta.st_size != receipt["bytes"]
                ):
                    raise ValueError("import_archive_integrity")
                # restore() independently verifies the whole SHA before extracting.
                # The fence prevents cache publication/eviction throughout this
                # unpublished restore. No copy, hardlink or writable alias exists.
            elif source.stat().st_size != receipt["bytes"] or digest(source) != receipt["sha256"]:
                raise ValueError("import_archive_integrity")
            destination = self.data / lease["assignmentId"]
            if receipt["phase"] == "receiving" and os.path.lexists(destination):
                raise ValueError("unexpected_import_destination")
            # A crash after rename but before the ready receipt may replay only
            # this unpublished restore. No workload is admitted in extracting.
            receipt = {**receipt, "phase": "extracting"}
            self.fence.write({**state, "import": receipt})
            if os.path.lexists(destination):
                if destination.is_symlink() or not destination.is_dir():
                    raise ValueError("unsafe_import_destination")
                shutil.rmtree(destination)
            restored = restore(source, destination, receipt["sha256"])
            for root, dirs, files in os.walk(destination, followlinks=False):
                for path in [
                    pathlib.Path(root),
                    *(pathlib.Path(root) / name for name in dirs + files),
                ]:
                    os.chown(path, self.account.pw_uid, self.account.pw_gid, follow_symlinks=False)
                    meta = path.lstat()
                    if not stat.S_ISLNK(meta.st_mode):
                        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
                        try:
                            os.fsync(fd)
                        finally:
                            os.close(fd)
            sync_dir(self.data)
            receipt = {**receipt, "phase": "ready", "entries": restored["entries"]}
            self.fence.write({**state, "import": receipt})
            return receipt
