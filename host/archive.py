"""Bounded filesystem checkpoints for quiesced, private persistent roots.

Copyright (c) 2026 firtoz and Jetski contributors. MIT licensed.
Adapted capture/validation/fsync principles from author-owned supervisor code.
No workload processes may run during capture or restoration. The supervisor owns
archive paths and destination parents; neither is mounted into a live workload.
"""

import hashlib
import os
import pathlib
import shutil
import tarfile
import tempfile
from frames import FrameWriter

FORMAT = 1
DEFAULT_LIMITS = {"entries": 100000, "bytes": 16 * 1024**3, "pathBytes": 4096}
ROOT_NAMES = ("workspace", "home")


def digest(path):
    result = hashlib.sha256()
    with open(path, "rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            result.update(chunk)
    return result.hexdigest()


def sync_dir(path):
    fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def roots_checked(roots):
    if set(roots) != set(ROOT_NAMES):
        raise ValueError("persistent_roots_mismatch")
    paths = {name: pathlib.Path(value).absolute() for name, value in roots.items()}
    values = list(paths.values())
    if any(
        a == b or a.is_relative_to(b) or b.is_relative_to(a)
        for i, a in enumerate(values)
        for b in values[i + 1 :]
    ):
        raise ValueError("overlapping_roots")
    return paths


def limits_checked(limits):
    values = dict(DEFAULT_LIMITS if limits is None else limits)
    if set(values) != set(DEFAULT_LIMITS) or any(
        type(v) is not int or v <= 0 for v in values.values()
    ):
        raise ValueError("invalid_limits")
    return values


def canonical_name(value, limits):
    if (
        not isinstance(value, str)
        or "\0" in value
        or len(value.encode("utf8")) > limits["pathBytes"]
    ):
        raise ValueError("invalid_path")
    path = pathlib.PurePosixPath(value)
    if (
        path.is_absolute()
        or ".." in path.parts
        or str(path) != value
        or not path.parts
        or path.parts[0] not in ROOT_NAMES
    ):
        raise ValueError("unsafe_archive_path")
    return path


def capture(roots, target, limits=None):
    roots = roots_checked(roots)
    limits = limits_checked(limits)
    target = pathlib.Path(target).absolute()
    for root in roots.values():
        if root.is_symlink() or not root.is_dir():
            raise ValueError("invalid_source_root")
        if target.resolve().is_relative_to(root.resolve()):
            raise ValueError("archive_inside_source")
    target.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(prefix=".capture-", dir=target.parent)
    count = total = 0
    try:
        with os.fdopen(fd, "wb") as output:
            with FrameWriter(output, adaptive=True) as compressed:
                with tarfile.open(
                    fileobj=compressed, mode="w|", dereference=False, format=tarfile.PAX_FORMAT
                ) as archive:

                    def add(source, name):
                        nonlocal count, total
                        canonical_name(name, limits)
                        before = source.lstat()
                        info = archive.gettarinfo(str(source), arcname=name)
                        if not (info.isfile() or info.isdir() or info.issym() or info.islnk()):
                            raise ValueError("unsupported_file_type")
                        if info.mode & 0o7000:
                            raise ValueError("unsupported_special_mode")
                        count += 1
                        total += info.size
                        if count > limits["entries"] or total > limits["bytes"]:
                            raise ValueError("archive_limit")
                        info.uid = info.gid = 0
                        info.uname = info.gname = ""
                        # Filesystem timestamps are not part of the checkpoint contract.
                        # Normalizing them makes identical byte/mode/link trees deterministic.
                        info.mtime = 0
                        info.pax_headers = {}
                        if info.isfile():
                            source_fd = os.open(source, os.O_RDONLY | os.O_NOFOLLOW)
                            with os.fdopen(source_fd, "rb") as stream:
                                observed = os.fstat(stream.fileno())
                                if (before.st_ino, before.st_dev, before.st_size) != (
                                    observed.st_ino,
                                    observed.st_dev,
                                    observed.st_size,
                                ):
                                    raise ValueError("source_changed")
                                archive.addfile(info, stream)
                        else:
                            archive.addfile(info)
                        if info.isdir():
                            for child in sorted(source.iterdir()):
                                add(child, name + "/" + child.name)
                        after = source.lstat()
                        if (
                            before.st_ino,
                            before.st_dev,
                            before.st_size,
                            before.st_mtime_ns,
                            before.st_ctime_ns,
                        ) != (
                            after.st_ino,
                            after.st_dev,
                            after.st_size,
                            after.st_mtime_ns,
                            after.st_ctime_ns,
                        ):
                            raise ValueError("source_changed")

                    for name in ROOT_NAMES:
                        add(roots[name], name)
            output.flush()
            os.fsync(output.fileno())
        if os.path.getsize(temporary) > limits["bytes"]:
            raise ValueError("compressed_archive_limit")
        sha = digest(temporary)
        # Create-only publication. A different result never overwrites an old ACK.
        try:
            os.link(temporary, target)
        except FileExistsError:
            if target.is_symlink() or digest(target) != sha:
                raise ValueError("archive_identity_conflict") from None
        sync_dir(target.parent)
        return dict(
            version=FORMAT,
            sha256=sha,
            bytes=target.stat().st_size,
            expandedBytes=total,
            entries=count,
            frames=compressed.frames,
        )
    finally:
        os.unlink(temporary)


def validate_members(archive, limits):
    members = []
    seen = {}
    total = 0
    for member in archive:
        path = canonical_name(member.name, limits)
        if member.name in seen:
            raise ValueError("duplicate_archive_path")
        if not (member.isfile() or member.isdir() or member.issym() or member.islnk()):
            raise ValueError("unsupported_file_type")
        if member.mode & ~0o777 or member.size < 0:
            raise ValueError("unsafe_archive_mode_or_size")
        if not member.isfile() and member.size != 0:
            raise ValueError("nonfile_payload")
        if len(path.parts) == 1 and not member.isdir():
            raise ValueError("invalid_root_type")
        for parent in path.parents:
            if str(parent) == ".":
                continue
            ancestor = seen.get(str(parent))
            if ancestor is None or not ancestor.isdir():
                raise ValueError("invalid_archive_parent")
        if member.islnk():
            target = seen.get(member.linkname)
            if target is None or not target.isfile() or member.mode != target.mode:
                raise ValueError("unsafe_hardlink")
        if member.issym() and (
            "\0" in member.linkname or len(member.linkname.encode("utf8")) > limits["pathBytes"]
        ):
            raise ValueError("invalid_symlink")
        seen[member.name] = member
        total += member.size
        if len(seen) > limits["entries"] or total > limits["bytes"]:
            raise ValueError("archive_limit")
        members.append(member)
    if any(root not in seen or not seen[root].isdir() for root in ROOT_NAMES):
        raise ValueError("missing_persistent_root")
    return members


def restore(source, destination, expected_sha256, limits=None):
    """Publish both roots with one directory rename. Destination must be absent.

    Caller's fenced restore operation owns destination.parent. Lost ACK recovery
    must inspect the durable operation receipt; this function never merges trees.
    Absolute/external symlink targets are preserved as data, never traversed.
    """
    limits = limits_checked(limits)
    source = pathlib.Path(source)
    destination = pathlib.Path(destination).absolute()
    if (
        source.is_symlink()
        or source.stat().st_size > limits["bytes"]
        or digest(source) != expected_sha256
    ):
        raise ValueError("archive_digest_mismatch")
    if os.path.lexists(destination):
        raise ValueError("restore_destination_exists")
    if not destination.parent.is_dir() or destination.parent.is_symlink():
        raise ValueError("invalid_destination_parent")
    staging = pathlib.Path(tempfile.mkdtemp(prefix=".restore-", dir=destination.parent))
    published = False
    try:
        with tarfile.open(source, "r:gz") as archive:
            members = validate_members(archive, limits)
            # The private staging tree cannot be reached by a running workload.
            # Symlinks cannot be parents (validation above); never dereference them.
            for member in members:
                target = staging / member.name
                if member.isdir():
                    target.mkdir(mode=0o700)
                elif member.isfile():
                    stream = archive.extractfile(member)
                    if stream is None:
                        raise ValueError("missing_file_stream")
                    with stream, open(target, "xb") as output:
                        shutil.copyfileobj(stream, output, length=1024 * 1024)
                        output.flush()
                        if output.tell() != member.size:
                            raise ValueError("short_archive_file")
                        os.fchmod(output.fileno(), member.mode)
                        os.fsync(output.fileno())
                elif member.islnk():
                    os.link(staging / member.linkname, target, follow_symlinks=False)
                else:
                    os.symlink(member.linkname, target)
            for member in reversed(members):
                if member.isdir():
                    directory = staging / member.name
                    # Open before restoring restrictive permissions.
                    fd = os.open(directory, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
                    try:
                        os.fchmod(fd, member.mode)
                        os.fsync(fd)
                    finally:
                        os.close(fd)
        sync_dir(staging)
        # Parent is supervisor-exclusive: no competing process may create this path.
        if os.path.lexists(destination):
            raise ValueError("restore_destination_exists")
        os.rename(staging, destination)
        published = True
        sync_dir(destination.parent)
        return dict(version=FORMAT, sha256=expected_sha256, entries=len(members))
    finally:
        if not published:
            # Read-only/zero-mode directories need permission recovery for cleanup.
            for root, dirs, _files in os.walk(staging):
                os.chmod(root, 0o700)
                for name in dirs:
                    path = pathlib.Path(root) / name
                    if not path.is_symlink():
                        os.chmod(path, 0o700)
            shutil.rmtree(staging)
