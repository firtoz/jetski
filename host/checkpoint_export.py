"""Fenced read-only archive links for an explicitly trusted transfer account."""

import os
import pathlib
import stat
from archive import sync_dir
from fence import identity


class CheckpointExport:
    def __init__(self, fence, archives, root, reader):
        self.fence = fence
        self.archives, self.root, self.reader = pathlib.Path(archives), pathlib.Path(root), reader
        if (
            type(reader.pw_uid) is not int
            or type(reader.pw_gid) is not int
            or min(reader.pw_uid, reader.pw_gid) <= 0
        ):
            raise ValueError("invalid_archive_reader")

    def directory(self, path):
        if not os.path.lexists(path):
            path.mkdir(mode=0o700)
        meta = path.lstat()
        if not stat.S_ISDIR(meta.st_mode) or meta.st_uid != os.geteuid():
            raise ValueError("unsafe_checkpoint_export_directory")
        if (
            stat.S_IMODE(meta.st_mode) == 0o700
            and not os.listdir(path)
            and meta.st_gid in (os.getegid(), self.reader.pw_gid)
        ):
            # Recover interrupted creation only for an empty, supervisor-owned path.
            os.chown(path, os.geteuid(), self.reader.pw_gid)
            os.chmod(path, 0o750)
            meta = path.lstat()
        if meta.st_gid != self.reader.pw_gid or stat.S_IMODE(meta.st_mode) != 0o750:
            raise ValueError("unsafe_checkpoint_export_directory")
        sync_dir(path)
        sync_dir(path.parent)

    def prepare(self, raw, expected_sha, expected_bytes):
        lease = identity(raw)
        with self.fence.locked():
            state = self.fence.read()
            self.fence.match(state, lease)
            checkpoint = state.get("checkpoint")
            if (
                state["phase"] != "closed"
                or not checkpoint
                or checkpoint["sha256"] != expected_sha
                or checkpoint["bytes"] != expected_bytes
            ):
                raise ValueError("checkpoint_export_unavailable")
            source = self.archives / (lease["assignmentId"] + ".tgz")
            fd = os.open(source, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
            try:
                meta = os.fstat(fd)
                if (
                    not stat.S_ISREG(meta.st_mode)
                    or meta.st_uid != os.geteuid()
                    or meta.st_mode & 0o022
                    or meta.st_size != expected_bytes
                ):
                    raise ValueError("unsafe_checkpoint_export_source")
                self.directory(self.root)
                directory = self.root / lease["assignmentId"]
                self.directory(directory)
                destination = directory / "archive.tgz"
                if os.path.lexists(destination):
                    linked = destination.lstat()
                    if not stat.S_ISREG(linked.st_mode) or (linked.st_dev, linked.st_ino) != (
                        meta.st_dev,
                        meta.st_ino,
                    ):
                        raise ValueError("checkpoint_export_conflict")
                else:
                    os.link(source, destination, follow_symlinks=False)
                # Only the approved outer-host transfer account gains read access.
                # Workload namespaces and their persistent paths never include it.
                os.fchown(fd, os.geteuid(), self.reader.pw_gid)
                os.fchmod(fd, 0o640)
                os.fsync(fd)
                sync_dir(directory)
                return dict(path=str(destination), sha256=expected_sha, bytes=expected_bytes)
            finally:
                os.close(fd)

    def close(self, raw):
        lease = identity(raw)
        with self.fence.locked():
            state = self.fence.read()
            self.fence.match(state, lease)
            if state["phase"] != "closed" or not state.get("checkpoint"):
                raise ValueError("checkpoint_export_unavailable")
            if not os.path.lexists(self.root):
                return dict(closed=True)
            self.directory(self.root)
            directory = self.root / lease["assignmentId"]
            if not os.path.lexists(directory):
                return dict(closed=True)
            self.directory(directory)
            names = os.listdir(directory)
            if any(name != "archive.tgz" for name in names):
                raise ValueError("unexpected_checkpoint_export_file")
            path = directory / "archive.tgz"
            if names:
                source = self.archives / (lease["assignmentId"] + ".tgz")
                a, b = path.lstat(), source.lstat()
                if not stat.S_ISREG(a.st_mode) or (a.st_dev, a.st_ino) != (b.st_dev, b.st_ino):
                    raise ValueError("checkpoint_export_conflict")
                path.unlink()
                sync_dir(directory)
            directory.rmdir()
            sync_dir(self.root)
            return dict(closed=True)
