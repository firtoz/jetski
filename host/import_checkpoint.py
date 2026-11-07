"""Fenced, resumable checkpoint import. Publication precedes workload admission."""

import base64
import hashlib
import os
import pathlib
import re
import shutil
import stat
import uuid
from archive import restore, sync_dir
from fence import identity
from local_checkpoint import LocalCheckpoint


IMPORT_CHUNK_BYTES = 4 * 1024**2
IMPORT_FILE_BYTES = 16 * 1024**2
IMPORT_REQUEST_BYTES = 6 * 1024**2


class CheckpointImport:
    def __init__(self, fence, archives, data, account, transfer=None, transfer_root=None):
        self.fence, self.archives, self.data, self.account = (
            fence,
            pathlib.Path(archives),
            pathlib.Path(data),
            account,
        )

        self.transfer = transfer
        self.transfer_root = pathlib.Path(transfer_root or "/tmp/jetski-checkpoint-imports")
        if transfer is not None and (
            type(transfer.pw_uid) is not int
            or type(transfer.pw_gid) is not int
            or min(transfer.pw_uid, transfer.pw_gid) <= 0
        ):
            raise ValueError("invalid_import_transfer_account")

    def advertised(self, receipt):
        if self.transfer is not None:
            return {**receipt, "fileChunkBytes": IMPORT_FILE_BYTES}
        return receipt

    def directory(self, path, mode):
        if not os.path.lexists(path):
            path.mkdir(mode=0o700)
        meta = path.lstat()
        if not stat.S_ISDIR(meta.st_mode) or meta.st_uid != os.geteuid():
            raise ValueError("unsafe_import_transfer_directory")
        if stat.S_IMODE(meta.st_mode) == 0o700 and not os.listdir(path):
            os.chown(path, os.geteuid(), self.transfer.pw_gid)
            os.chmod(path, mode)
            meta = path.lstat()
            sync_dir(path)
            sync_dir(path.parent)
        if stat.S_IMODE(meta.st_mode) != mode or meta.st_gid != self.transfer.pw_gid:
            raise ValueError("unsafe_import_transfer_directory")

    def file_directory(self, lease):
        if self.transfer is None:
            raise ValueError("binary_import_not_configured")
        self.directory(self.transfer_root, 0o750)
        directory = self.transfer_root / lease["assignmentId"]
        self.directory(directory, 0o730)
        return directory

    def file_begin(self, raw):
        lease = identity(raw)
        with self.fence.locked():
            state = self.state(lease)
            receipt = state.get("import")
            if not receipt or receipt["phase"] != "receiving":
                raise ValueError("import_not_receiving")
            directory = self.file_directory(lease)
            if any(name not in ("chunk.bin", "chunk-next.bin") for name in os.listdir(directory)):
                raise ValueError("unexpected_import_transfer_file")
            return dict(path=str(directory / "chunk.bin"), chunkBytes=IMPORT_FILE_BYTES, paths=[str(directory / name) for name in ("chunk.bin", "chunk-next.bin")])

    def file_chunk(self, raw, offset, length, sha256, slot=0):
        lease = identity(raw)
        if type(slot) is not int or slot not in (0, 1):
            raise ValueError("invalid_import_file_slot")
        if type(length) is not int or not 1 <= length <= IMPORT_FILE_BYTES:
            raise ValueError("invalid_import_file_extent")
        with self.fence.locked():
            self.state(lease)
            path = self.file_directory(lease) / ("chunk.bin" if slot == 0 else "chunk-next.bin")
            fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
            with os.fdopen(fd, "rb") as source:
                meta = os.fstat(source.fileno())
                if (
                    not stat.S_ISREG(meta.st_mode)
                    or meta.st_size != length
                    or meta.st_uid not in (os.geteuid(), self.transfer.pw_uid)
                ):
                    raise ValueError("unsafe_import_transfer_file")
                data = source.read(length + 1)
                after = os.fstat(source.fileno())
                if (
                    len(data) != length
                    or meta.st_size != after.st_size
                    or meta.st_mtime_ns != after.st_mtime_ns
                    or hashlib.sha256(data).hexdigest() != sha256
                ):
                    raise ValueError("import_file_integrity")
        return self.commit(lease, offset, data, IMPORT_FILE_BYTES)

    def file_close(self, raw):
        lease = identity(raw)
        with self.fence.locked():
            self.state(lease)
            return self.file_close_locked(lease)

    def file_close_locked(self, lease):
        if self.transfer is None:
            raise ValueError("binary_import_not_configured")
        if not os.path.lexists(self.transfer_root):
            return dict(closed=True)
        self.directory(self.transfer_root, 0o750)
        directory = self.transfer_root / lease["assignmentId"]
        if not os.path.lexists(directory):
            return dict(closed=True)
        self.directory(directory, 0o730)
        if any(name not in ("chunk.bin", "chunk-next.bin") for name in os.listdir(directory)):
            raise ValueError("unexpected_import_transfer_file")
        for name in ("chunk.bin", "chunk-next.bin"):
            path = directory / name
            if os.path.lexists(path):
                meta = path.lstat()
                if not stat.S_ISREG(meta.st_mode) or meta.st_uid not in (
                    os.geteuid(),
                    self.transfer.pw_uid,
                ):
                    raise ValueError("unsafe_import_transfer_file")
                path.unlink()
                sync_dir(directory)
        directory.rmdir()
        sync_dir(self.transfer_root)
        return dict(closed=True)

    def state(self, lease):
        state = self.fence.read()
        self.fence.match(state, lease)
        if state["phase"] != "open" or state.get("runtime"):
            raise ValueError("import_requires_fresh_assignment")
        return state

    def path(self, lease):
        return self.archives / (lease["assignmentId"] + ".upload")

    def begin(self, raw, checkpoint, sha256, length, portable_memory_required=False):
        lease = identity(raw)
        if type(portable_memory_required) is not bool:
            raise ValueError("invalid_portable_import_policy")
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
                if (
                    any(previous[key] != value for key, value in expected.items())
                    or previous.get("portableMemoryRequired", False) != portable_memory_required
                ):
                    raise ValueError("import_identity_conflict")
                if previous["phase"] == "receiving" and previous["offset"] == 0:
                    return self.advertised(self.cached(lease, state, previous))
                return self.advertised(previous)
            if os.path.lexists(self.data / lease["assignmentId"]) or os.path.lexists(
                self.path(lease)
            ):
                raise ValueError("import_destination_exists")
            receipt = {
                **expected,
                **({"portableMemoryRequired": True} if portable_memory_required else {}),
                "offset": 0,
                "phase": "receiving",
                "chunkBytes": IMPORT_CHUNK_BYTES,
            }
            state = {**state, "import": receipt}
            self.fence.write(state)
            return self.advertised(self.cached(lease, state, receipt))

    def cached(self, lease, state, receipt):
        if receipt.get("cacheRejected"):
            return receipt
        expected = {key: receipt[key] for key in ("id", "sha256", "bytes")}
        cache = LocalCheckpoint(self.fence, self.archives)
        selected = None
        if os.path.lexists(self.path(lease)):
            # Preserve complete staging left by an older host or a lost receipt.
            reusable = cache.verified(self.path(lease), expected)
        else:
            selected = cache.provisional_locked(lease, state, expected)
            reusable = selected is not None
        if reusable:
            receipt = {**receipt, "offset": receipt["bytes"], "phase": "extracting"}
            if selected is not None:
                receipt["cacheSource"] = state["localCheckpoint"]
            self.fence.write({**state, "import": receipt})
            if selected is not None:
                # The core already accepts a ready begin receipt. Complete this
                # verified-cache restore under the existing fence, avoiding a
                # separate control process/RPC without admitting work early.
                try:
                    return self.finish_locked(lease)
                except (OSError, ValueError):
                    # A failed unpublished cache candidate may fall back only
                    # when authority is unchanged and its bytes fail verification.
                    # Valid-source I/O, ownership, fsync and lost-ready-ACK errors
                    # remain uncertain failures, never a successful release.
                    current = self.state(lease)
                    destination = self.data / lease["assignmentId"]
                    if (
                        os.path.lexists(destination)
                        or current.get("localCheckpoint") != receipt["cacheSource"]
                        or current.get("import") != receipt
                        or cache.verified(selected, expected)
                    ):
                        raise
                    receipt = {
                        **{key: value for key, value in receipt.items() if key != "cacheSource"},
                        "offset": 0,
                        "phase": "receiving",
                        "cacheRejected": True,
                    }
                    self.fence.write({**current, "import": receipt})
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
        return self.commit(lease, offset, data)

    def commit(self, lease, offset, data, file_limit=None):
        if type(offset) is not int or offset < 0:
            raise ValueError("invalid_import_offset")
        with self.fence.locked():
            state = self.state(lease)
            receipt = state.get("import")
            limit = file_limit or (receipt or {}).get("chunkBytes", 256 * 1024)
            if (
                not receipt
                or len(data) > limit
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
            return self.finish_locked(lease)

    def finish_locked(self, lease):
        state = self.state(lease)
        receipt = state.get("import")
        if not receipt or receipt["offset"] != receipt["bytes"]:
            raise ValueError("import_incomplete")
        # Even a controller using the fallback protocol must not admit a
        # workload while a prior binary attempt still owns staging files.
        if self.transfer is not None:
            self.file_close_locked(lease)
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
            # restore() verifies the whole SHA before publishing its private staging.
            # The fence prevents cache publication/eviction throughout this
            # unpublished restore. No copy, hardlink or writable alias exists.
        elif source.stat().st_size != receipt["bytes"]:
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
        try:
            restored = restore(
                source,
                destination,
                receipt["sha256"],
                owner=(self.account.pw_uid, self.account.pw_gid),
            )
        except ValueError as error:
            if str(error) == "archive_digest_mismatch":
                raise ValueError("import_archive_integrity") from error
            raise
        receipt = {**receipt, "phase": "ready", "entries": restored["entries"]}
        self.fence.write({**state, "import": receipt})
        return receipt
