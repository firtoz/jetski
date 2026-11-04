"""Optional bounded binary transfer paths, outside every workload namespace.

The transfer account can read sealed exports and write only disposable input.
The importer independently checks bytes before admitting them to its journal.
"""

import copy
import hashlib
import os
import pathlib
import stat

from archive import sync_dir
from fence import identity
from gvisor_lifecycle import checkpoint_id

EXPORT_ROOT = pathlib.Path("/tmp/jetski-memory-exports")
IMPORT_ROOT = pathlib.Path("/tmp/jetski-memory-imports")
PART_BYTES = 4 * 1024**2


def directory(path, account, mode):
    if not os.path.lexists(path):
        path.mkdir(mode=0o700)
        sync_dir(path.parent)
    meta = path.lstat()
    if not stat.S_ISDIR(meta.st_mode) or meta.st_uid != os.geteuid():
        raise ValueError("unsafe_memory_transfer_directory")
    if stat.S_IMODE(meta.st_mode) == 0o700 and not os.listdir(path):
        os.chown(path, os.geteuid(), account.pw_gid)
        os.chmod(path, mode)
        sync_dir(path)
        sync_dir(path.parent)
        meta = path.lstat()
    if stat.S_IMODE(meta.st_mode) != mode or meta.st_gid != account.pw_gid:
        raise ValueError("unsafe_memory_transfer_directory")


class PortableMemoryFiles:
    def __init__(self, fence, account, exports=EXPORT_ROOT, imports=IMPORT_ROOT):
        if min(account.pw_uid, account.pw_gid) <= 0:
            raise ValueError("invalid_memory_transfer_account")
        self.fence, self.account = fence, account
        self.exports, self.imports = pathlib.Path(exports), pathlib.Path(imports)

    def location(self, root, lease, identifier, writable=False):
        directory(root, self.account, 0o750)
        target = root / (lease["assignmentId"] + "-g" + str(lease["generation"]))
        directory(target, self.account, 0o750)
        target = target / identifier
        directory(target, self.account, 0o730 if writable else 0o750)
        return target / ("chunk.bin" if writable else "memory.pack")

    def export(self, raw, identifier, exporter, sha256, length):
        lease, identifier = copy.deepcopy(identity(raw)), checkpoint_id(identifier)
        with self.fence.locked():
            state = self.fence.read()
            self.fence.match(state, lease)
            memory = state.get("memory") or {}
            captured = memory.get("portableExport") or {}
            capture = captured.get("capture") or {}
            if (
                state["phase"] != "closed"
                or memory.get("id") != identifier
                or captured.get("phase") != "ready"
                or capture.get("sha256") != sha256
                or capture.get("bytes") != length
            ):
                raise ValueError("binary_memory_export_unavailable")
            source, original = exporter.open_pack(lease, identifier, capture)
            with source:
                path = self.location(self.exports, lease, identifier)
                meta = os.fstat(source.fileno())
                if os.path.lexists(path):
                    linked = path.lstat()
                    if not stat.S_ISREG(linked.st_mode) or (linked.st_dev, linked.st_ino) != (
                        meta.st_dev,
                        meta.st_ino,
                    ):
                        raise ValueError("binary_memory_export_conflict")
                else:
                    os.link(original, path, follow_symlinks=False)
                os.fchown(source.fileno(), os.geteuid(), self.account.pw_gid)
                os.fchmod(source.fileno(), 0o640)
                os.fsync(source.fileno())
                sync_dir(path.parent)
                return dict(path=str(path), sha256=sha256, bytes=length)

    def close_export(self, raw, identifier, exporter):
        lease, identifier = copy.deepcopy(identity(raw)), checkpoint_id(identifier)
        with self.fence.locked():
            state = self.fence.read()
            self.fence.match(state, lease)
            if state["phase"] != "closed":
                raise ValueError("binary_memory_export_unavailable")
            path = self.location(self.exports, lease, identifier)
            if os.path.lexists(path):
                a, b = path.lstat(), exporter.path(lease, identifier).lstat()
                if (
                    not stat.S_ISREG(a.st_mode)
                    or a.st_uid != os.geteuid()
                    or (a.st_dev, a.st_ino) != (b.st_dev, b.st_ino)
                ):
                    raise ValueError("binary_memory_export_conflict")
                path.unlink()
                sync_dir(path.parent)
            self.remove_directories(path)
            return dict(closed=True)

    def import_begin(self, raw, identifier, importer):
        lease, identifier = copy.deepcopy(identity(raw)), checkpoint_id(identifier)
        with self.fence.locked():
            _, record = importer.state(lease, identifier)
            if record["phase"] != "receiving":
                raise ValueError("portable_import_not_receiving")
            path = self.location(self.imports, lease, identifier, True)
            if any(name != "chunk.bin" for name in os.listdir(path.parent)):
                raise ValueError("unexpected_memory_transfer_file")
            return dict(path=str(path), chunkBytes=PART_BYTES)

    def import_chunk(self, raw, identifier, importer, object_id, offset, length, sha256):
        lease, identifier = copy.deepcopy(identity(raw)), checkpoint_id(identifier)
        if type(length) is not int or not 1 <= length <= PART_BYTES:
            raise ValueError("invalid_memory_transfer_extent")
        with self.fence.locked():
            _, record = importer.state(lease, identifier)
            if record["phase"] != "receiving":
                raise ValueError("portable_import_not_receiving")
            path = self.location(self.imports, lease, identifier, True)
            fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
            with os.fdopen(fd, "rb") as source:
                before = os.fstat(fd)
                if (
                    not stat.S_ISREG(before.st_mode)
                    or before.st_size != length
                    or before.st_nlink != 1
                    or before.st_uid not in (os.geteuid(), self.account.pw_uid)
                ):
                    raise ValueError("unsafe_memory_transfer_file")
                data = source.read(length + 1)
                after = os.fstat(fd)
                if (
                    len(data) != length
                    or before.st_size != after.st_size
                    or before.st_mtime_ns != after.st_mtime_ns
                    or hashlib.sha256(data).hexdigest() != sha256
                ):
                    raise ValueError("memory_transfer_integrity")
        # Reacquire and verify the exact fence and journal before durable mutation.
        return importer.commit(lease, identifier, object_id, offset, data, sha256)

    def import_close(self, raw, identifier, importer):
        lease, identifier = copy.deepcopy(identity(raw)), checkpoint_id(identifier)
        with self.fence.locked():
            importer.state(lease, identifier)
            path = self.location(self.imports, lease, identifier, True)
            if any(name != "chunk.bin" for name in os.listdir(path.parent)):
                raise ValueError("unexpected_memory_transfer_file")
            if os.path.lexists(path):
                meta = path.lstat()
                if not stat.S_ISREG(meta.st_mode) or meta.st_uid not in (
                    os.geteuid(),
                    self.account.pw_uid,
                ):
                    raise ValueError("unsafe_memory_transfer_file")
                path.unlink()
                sync_dir(path.parent)
            self.remove_directories(path)
            return dict(closed=True)

    def remove_directories(self, path):
        path.parent.rmdir()
        sync_dir(path.parent.parent)
        if not os.listdir(path.parent.parent):
            path.parent.parent.rmdir()
            sync_dir(path.parent.parent.parent)
