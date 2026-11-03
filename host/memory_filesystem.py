"""Physical frozen-tree identity; supplements, never replaces archive byte proof."""

import hashlib
import json
import os
import stat

from archive import DEFAULT_LIMITS, roots_checked


def frozen_identity(roots):
    roots = roots_checked(roots)
    digest = hashlib.sha256()
    count = 0

    def token(meta):
        return [
            meta.st_dev,
            meta.st_ino,
            meta.st_mode,
            meta.st_uid,
            meta.st_gid,
            meta.st_size,
            meta.st_nlink,
            meta.st_mtime_ns,
            meta.st_ctime_ns,
        ]

    def record(path, meta, target=None):
        nonlocal count
        count += 1
        if count > DEFAULT_LIMITS["entries"] or len(path.encode()) > DEFAULT_LIMITS["pathBytes"]:
            raise ValueError("memory_filesystem_bound")
        digest.update(
            json.dumps(
                [path, token(meta), target], ensure_ascii=True, separators=(",", ":")
            ).encode()
            + b"\n"
        )

    def visit(directory, prefix, depth):
        if depth > 128:
            raise ValueError("memory_filesystem_depth")
        before = os.fstat(directory)
        names = []
        with os.scandir(directory) as entries:
            for entry in entries:
                if len(names) >= DEFAULT_LIMITS["entries"] - count:
                    raise ValueError("memory_filesystem_bound")
                names.append(entry.name)
        for name in sorted(names):
            relative = prefix + "/" + name
            meta = os.stat(name, dir_fd=directory, follow_symlinks=False)
            if stat.S_ISLNK(meta.st_mode):
                target = os.readlink(name, dir_fd=directory)
                if len(os.fsencode(target)) > DEFAULT_LIMITS["pathBytes"]:
                    raise ValueError("memory_filesystem_bound")
                record(relative, meta, target)
            elif stat.S_ISDIR(meta.st_mode):
                fd = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=directory)
                try:
                    if token(os.fstat(fd)) != token(meta):
                        raise ValueError("memory_filesystem_changed")
                    record(relative, meta)
                    visit(fd, relative, depth + 1)
                finally:
                    os.close(fd)
            elif stat.S_ISREG(meta.st_mode):
                record(relative, meta)
            else:
                raise ValueError("unsupported_memory_filesystem_member")
            if token(os.stat(name, dir_fd=directory, follow_symlinks=False)) != token(meta):
                raise ValueError("memory_filesystem_changed")
        if token(os.fstat(directory)) != token(before):
            raise ValueError("memory_filesystem_changed")

    for name, path in sorted(roots.items()):
        fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try:
            before = os.fstat(fd)
            record(name, before)
            visit(fd, name, 0)
            if token(os.stat(path, follow_symlinks=False)) != token(before):
                raise ValueError("memory_filesystem_changed")
        finally:
            os.close(fd)
    return digest.hexdigest()
