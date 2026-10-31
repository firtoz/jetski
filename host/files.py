"""Bounded persistent-file reads. Never follow workload-controlled symlinks."""

import base64
import contextlib
import hashlib
import os
import stat

MAX_CHUNK = 256 * 1024
MAX_ENTRIES = 10000


def components(path):
    if not isinstance(path, str) or len(path.encode("utf8")) > 4096 or "\0" in path:
        raise ValueError("invalid_file_path")
    if path == "/workspace" or path.startswith("/workspace/"):
        parts = (
            ["workspace", *path[len("/workspace/") :].split("/")]
            if path != "/workspace"
            else ["workspace"]
        )
    elif path == "/home/sandbox" or path.startswith("/home/sandbox/"):
        parts = (
            ["home", *path[len("/home/sandbox/") :].split("/")]
            if path != "/home/sandbox"
            else ["home"]
        )
    else:
        raise ValueError("undeclared_persistent_path")
    if any(part in ("", ".", "..") for part in parts):
        raise ValueError("invalid_file_component")
    return parts


def version(meta):
    value = (
        meta.st_dev,
        meta.st_ino,
        meta.st_size,
        meta.st_mtime_ns,
        meta.st_ctime_ns,
        meta.st_mode,
    )
    return hashlib.sha256(repr(value).encode("ascii")).hexdigest()


class Files:
    def __init__(self, fence, data_root, uid):
        self.fence, self.data_root, self.uid = fence, data_root, uid

    @contextlib.contextmanager
    def opened(self, lease, path, directory=False, locked=True):
        parts = components(path)
        with self.fence.locked() if locked else contextlib.nullcontext():
            state = self.fence.read()
            self.fence.match(state, lease)
            if state["phase"] != "open" or state.get("runtime", {}).get("phase") != "running":
                raise ValueError("file_access_requires_running_assignment")
            fds = []
            try:
                # Data root and its parent are installed by the trusted bootstrap.
                fds.append(os.open(self.data_root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW))
                for index, part in enumerate([lease["assignmentId"], *parts]):
                    flags = os.O_PATH | os.O_NOFOLLOW
                    if index < len(parts) or directory:
                        flags |= os.O_DIRECTORY
                    fd = os.open(part, flags, dir_fd=fds[-1])
                    fds.append(fd)
                    meta = os.fstat(fd)
                    if meta.st_uid != self.uid:
                        raise ValueError("file_owner_mismatch")
                meta = os.fstat(fds[-1])
                if not directory and not stat.S_ISREG(meta.st_mode):
                    raise ValueError("regular_file_required")
                # Reopen the pinned inode only after rejecting devices/FIFOs/links.
                # No workload path is resolved by this second open.
                fds.append(os.open(f"/proc/self/fd/{fds[-1]}", os.O_RDONLY | os.O_NONBLOCK))
                yield fds[-1]
            finally:
                for fd in reversed(fds):
                    os.close(fd)

    def read(self, lease, path, offset, count, expected=None):
        if type(offset) is not int or offset < 0 or offset > 2**53 - 1:
            raise ValueError("invalid_file_offset")
        if type(count) is not int or not 1 <= count <= MAX_CHUNK:
            raise ValueError("invalid_file_range")
        if expected is not None and (not isinstance(expected, str) or len(expected) != 64):
            raise ValueError("invalid_file_version")
        with self.opened(lease, path) as fd:
            meta = os.fstat(fd)
            if not stat.S_ISREG(meta.st_mode):
                raise ValueError("regular_file_required")
            current = version(meta)
            if expected is not None and expected != current:
                raise ValueError("file_changed")
            if offset > meta.st_size:
                raise ValueError("file_offset_past_end")
            data = os.pread(fd, count, offset)
            if version(os.fstat(fd)) != current:
                raise ValueError("file_changed")
            return dict(
                base64=base64.b64encode(data).decode("ascii"),
                offset=offset,
                nextOffset=offset + len(data),
                size=meta.st_size,
                eof=offset + len(data) == meta.st_size,
                version=current,
                sha256=hashlib.sha256(data).hexdigest(),
            )

    def listing(self, lease, path, after, limit, expected=None):
        if (
            not isinstance(after, str)
            or "/" in after
            or "\0" in after
            or len(after.encode("utf8")) > 255
        ):
            raise ValueError("invalid_listing_cursor")
        if type(limit) is not int or not 1 <= limit <= 256:
            raise ValueError("invalid_listing_limit")
        with self.opened(lease, path, directory=True) as fd:
            current = version(os.fstat(fd))
            if expected is not None and expected != current:
                raise ValueError("directory_changed")
            names = []
            with os.scandir(fd) as iterator:
                for entry in iterator:
                    if len(names) >= MAX_ENTRIES:
                        raise ValueError("directory_entry_limit")
                    # JSON names must round-trip; never silently substitute invalid bytes.
                    entry.name.encode("utf8", "strict")
                    names.append(entry.name)
            names = sorted(name for name in names if name > after)
            entries = []
            for name in names[:limit]:
                meta = os.stat(name, dir_fd=fd, follow_symlinks=False)
                kind = "other"
                if stat.S_ISREG(meta.st_mode):
                    kind = "file"
                elif stat.S_ISDIR(meta.st_mode):
                    kind = "directory"
                elif stat.S_ISLNK(meta.st_mode):
                    kind = "symlink"
                entries.append(
                    dict(name=name, kind=kind, mode=stat.S_IMODE(meta.st_mode), size=meta.st_size)
                )
            if version(os.fstat(fd)) != current:
                raise ValueError("directory_changed")
            return dict(
                entries=entries,
                next=entries[-1]["name"] if len(names) > limit else None,
                version=current,
            )
