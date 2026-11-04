"""Bootstrap-only mount destinations inside a copied OCI rootfs.

Execute as UID0 inside the runtime account's subordinate user namespace. No host
credentials, caller shell strings or privileged modules are imported here.
"""

import os
import pathlib
import stat
import sys


def prepare(root):
    fd = os.open(root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        for parts in (("workspace",), ("home", "sandbox"), ("etc",)):
            current = os.dup(fd)
            try:
                for name in parts:
                    try:
                        os.mkdir(name, 0o755, dir_fd=current)
                    except FileExistsError:
                        pass
                    child = os.open(
                        name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=current
                    )
                    os.fsync(current)
                    os.close(current)
                    current = child
                os.fsync(current)
            finally:
                os.close(current)
        etc = os.open("etc", os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
        try:
            resolver = os.open(
                "resolv.conf", os.O_RDONLY | os.O_CREAT | os.O_NOFOLLOW, 0o644, dir_fd=etc
            )
            try:
                if not stat.S_ISREG(os.fstat(resolver).st_mode):
                    raise ValueError("unsafe_resolver_mount_destination")
                os.fsync(resolver)
            finally:
                os.close(resolver)
            os.fsync(etc)
        finally:
            os.close(etc)
        for name in ("jetski-supervisor", "jetski-tcp-relay"):
            target = os.open(
                name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o555, dir_fd=fd
            )
            os.fsync(target)
            os.close(target)
        os.fsync(fd)
    finally:
        os.close(fd)


def sync_tree(root, max_entries=100000, max_bytes=16 * 1024**3):
    """Sync the prepared image before publishing its bootstrap proof.

    OCI symlinks are preserved as links; no traversal through their targets.
    Device nodes and sockets in copied images are rejected explicitly.
    """
    count, total = 0, 0

    def visit(directory, depth):
        nonlocal count, total
        if depth > 128:
            raise ValueError("gvisor_image_depth")
        with os.scandir(directory) as entries:
            for entry in entries:
                count += 1
                if count > max_entries:
                    raise ValueError("gvisor_image_entries")
                meta = entry.stat(follow_symlinks=False)
                if stat.S_ISLNK(meta.st_mode):
                    continue
                if not stat.S_ISDIR(meta.st_mode) and not stat.S_ISREG(meta.st_mode):
                    raise ValueError("unsupported_gvisor_image_member")
                total += meta.st_size if stat.S_ISREG(meta.st_mode) else 0
                if total > max_bytes:
                    raise ValueError("gvisor_image_bytes")
                flags = os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK
                if stat.S_ISDIR(meta.st_mode):
                    flags |= os.O_DIRECTORY
                child = os.open(entry.name, flags, dir_fd=directory)
                try:
                    opened = os.fstat(child)
                    if (opened.st_dev, opened.st_ino) != (meta.st_dev, meta.st_ino):
                        raise ValueError("gvisor_image_changed")
                    if stat.S_ISDIR(meta.st_mode):
                        visit(child, depth + 1)
                    os.fsync(child)
                finally:
                    os.close(child)
        os.fsync(directory)

    fd = os.open(root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        visit(fd, 0)
    finally:
        os.close(fd)


if __name__ == "__main__":
    if len(sys.argv) != 2 or os.geteuid() != 0 or not pathlib.Path(sys.argv[1]).is_absolute():
        raise ValueError("rootless_namespace_preparation_required")
    prepare(sys.argv[1])
    sync_tree(sys.argv[1])
