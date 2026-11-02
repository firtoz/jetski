"""Private staged uploads; an uncertain publication never replays an old write."""

import base64
import hashlib
import os
import pathlib
import re
import stat
import uuid
from archive import sync_dir
from files import Files, components

MAX_UPLOAD_BYTES = 64 * 1024 * 1024
MAX_UPLOADS = 64


class FileUpload:
    def __init__(self, fence, data, account, parent_uid=None):
        self.fence, self.data, self.account = fence, pathlib.Path(data), account
        self.files = Files(fence, data, account.pw_uid, parent_uid)

    def state(self, lease, writable=True):
        state = self.fence.read()
        self.fence.match(state, lease)
        if writable and (
            state["phase"] != "open" or state.get("runtime", {}).get("phase") != "running"
        ):
            raise ValueError("upload_requires_running_assignment")
        return state

    def staging(self):
        root = self.data / ".uploads"
        root.mkdir(mode=0o700, exist_ok=True)
        meta = root.lstat()
        if not stat.S_ISDIR(meta.st_mode) or meta.st_uid != os.geteuid() or meta.st_mode & 0o077:
            raise ValueError("unsafe_upload_staging")
        sync_dir(self.data)
        return root

    def path(self, receipt):
        return self.staging() / receipt["id"]

    def save(self, state, receipt):
        self.fence.write({**state, "uploads": {**state.get("uploads", {}), receipt["id"]: receipt}})
        return receipt

    def receipt(self, state, upload):
        if not isinstance(upload, str) or str(uuid.UUID(upload)) != upload:
            raise ValueError("invalid_upload_id")
        receipt = state.get("uploads", {}).get(upload)
        if not receipt:
            raise ValueError("upload_unavailable")
        return receipt

    def begin(self, lease, upload, path, size, sha256, mode=0o644):
        if not isinstance(upload, str) or str(uuid.UUID(upload)) != upload:
            raise ValueError("invalid_upload_id")
        parts = components(path)
        if len(parts) < 2:
            raise ValueError("upload_requires_file_path")
        if type(size) is not int or not 0 <= size <= MAX_UPLOAD_BYTES:
            raise ValueError("invalid_upload_size")
        if not isinstance(sha256, str) or not re.fullmatch("[a-f0-9]{64}", sha256):
            raise ValueError("invalid_upload_digest")
        if type(mode) is not int or not 0 <= mode <= 0o777:
            raise ValueError("invalid_upload_mode")
        spec = dict(id=upload, path=path, bytes=size, sha256=sha256, mode=mode)
        with self.fence.locked():
            state = self.state(lease, writable=False)
            existing = state.get("uploads", {}).get(upload)
            if existing:
                if any(existing[key] != value for key, value in spec.items()):
                    raise ValueError("upload_identity_conflict")
                return existing
            self.state(lease)
            if len(state.get("uploads", {})) >= MAX_UPLOADS:
                raise ValueError("upload_count_limit")
            # Persist identity before touching a staging file. Replays cannot rebind it.
            receipt = {**spec, "offset": 0, "phase": "receiving"}
            if os.path.lexists(self.path(receipt)):
                raise ValueError("upload_identity_already_used")
            return self.save(state, receipt)

    def status(self, lease, upload):
        with self.fence.locked():
            return self.receipt(self.state(lease, writable=False), upload)

    def chunk(self, lease, upload, offset, encoded, sha256):
        if (
            type(offset) is not int
            or offset < 0
            or not isinstance(encoded, str)
            or len(encoded) > 350000
        ):
            raise ValueError("invalid_upload_chunk")
        data = base64.b64decode(encoded, validate=True)
        if not 1 <= len(data) <= 256 * 1024 or hashlib.sha256(data).hexdigest() != sha256:
            raise ValueError("upload_chunk_integrity")
        with self.fence.locked():
            state = self.state(lease)
            receipt = self.receipt(state, upload)
            if (
                receipt["phase"] != "receiving"
                or offset > receipt["offset"]
                or offset + len(data) > receipt["bytes"]
            ):
                raise ValueError("upload_chunk_extent")
            fd = os.open(self.path(receipt), os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
            with os.fdopen(fd, "r+b") as output:
                size = os.fstat(output.fileno()).st_size
                if size < receipt["offset"] or size > receipt["bytes"]:
                    raise ValueError("upload_file_extent")
                output.seek(offset)
                existing = output.read(len(data))
                if existing != data[: len(existing)]:
                    raise ValueError("upload_replay_conflict")
                if offset < receipt["offset"]:
                    if offset + len(data) > receipt["offset"] or len(existing) != len(data):
                        raise ValueError("upload_replay_extent")
                    return receipt
                output.seek(offset)
                output.write(data)
                output.flush()
                os.fsync(output.fileno())
            sync_dir(self.staging())
            return self.save(state, {**receipt, "offset": offset + len(data)})

    def finish(self, lease, upload):
        with self.fence.locked():
            state = self.state(lease, writable=False)
            receipt = self.receipt(state, upload)
            if receipt["phase"] in ("committed", "uncertain"):
                return receipt
            self.state(lease)
            if receipt["offset"] != receipt["bytes"]:
                raise ValueError("upload_incomplete")
            parent, name = receipt["path"].rsplit("/", 1)
            with self.files.opened(lease, parent, directory=True, locked=False) as directory:
                parent_meta = os.fstat(directory)
                parent_id = [parent_meta.st_dev, parent_meta.st_ino]
                source = self.path(receipt)
                if receipt["phase"] == "receiving":
                    flags = os.O_RDWR | os.O_NOFOLLOW
                    if receipt["bytes"] == 0:
                        flags |= os.O_CREAT
                    fd = os.open(source, flags, 0o600)
                    with os.fdopen(fd, "r+b") as stream:
                        digest = hashlib.file_digest(stream, "sha256").hexdigest()
                        meta = os.fstat(stream.fileno())
                        if meta.st_size != receipt["bytes"] or digest != receipt["sha256"]:
                            raise ValueError("upload_integrity")
                        os.fchown(stream.fileno(), self.account.pw_uid, self.account.pw_gid)
                        os.fchmod(stream.fileno(), receipt["mode"])
                        os.fsync(stream.fileno())
                        inode = [meta.st_dev, meta.st_ino]
                    sync_dir(self.staging())
                    receipt = self.save(
                        state,
                        {**receipt, "phase": "publishing", "inode": inode, "parent": parent_id},
                    )
                if receipt["parent"] != parent_id:
                    return self.save(state, {**receipt, "phase": "uncertain"})
                if os.path.lexists(source):
                    meta = source.lstat()
                    if [meta.st_dev, meta.st_ino] != receipt["inode"] or not stat.S_ISREG(
                        meta.st_mode
                    ):
                        raise ValueError("upload_staging_changed")
                    # Private staging is outside workload mounts, on the same filesystem.
                    # A successful rename consumes it, so retry cannot overwrite later work.
                    os.replace(source, name, dst_dir_fd=directory)
                else:
                    try:
                        meta = os.stat(name, dir_fd=directory, follow_symlinks=False)
                    except FileNotFoundError:
                        return self.save(state, {**receipt, "phase": "uncertain"})
                    if [meta.st_dev, meta.st_ino] != receipt["inode"]:
                        return self.save(state, {**receipt, "phase": "uncertain"})
                os.fsync(directory)
                sync_dir(self.staging())
                return self.save(state, {**receipt, "phase": "committed"})
