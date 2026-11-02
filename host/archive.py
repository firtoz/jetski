"""Bounded filesystem checkpoints for quiesced, private persistent roots.

Copyright (c) 2026 firtoz and Jetski contributors. MIT licensed.
Adapted capture/validation/fsync principles from author-owned supervisor code.
No workload processes may run during capture or restoration. The supervisor owns
archive paths and destination parents; neither is mounted into a live workload.
"""

import gzip
import hashlib
import os
import pathlib
import shutil
import stat
import zlib
import tarfile
import tempfile
from frames import FrameWriter, FRAME_BYTES

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


def capture(roots, target, limits=None, frame_bytes=FRAME_BYTES):
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
            with FrameWriter(output, frame_bytes=frame_bytes, adaptive=True) as compressed:
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
        if os.path.getsize(temporary) != compressed.offset:
            raise ValueError("archive_write_extent")
        # Hash the exact encoded members while writing instead of rereading the
        # complete temporary archive. Transfer still verifies every source member
        # and stored pack; cache reuse independently rehashes its durable file.
        sha = compressed.compressed_hash.hexdigest()
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


def validated_members(archive, limits):
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
        yield member
    if any(root not in seen or not seen[root].isdir() for root in ROOT_NAMES):
        raise ValueError("missing_persistent_root")


def validate_members(archive, limits):
    return list(validated_members(archive, limits))


class _RestoreReader:
    """Forward-only, bounded reads; optionally hash the exact compressed bytes."""

    def __init__(self, source, limit, hashed=False):
        self.source = source
        self.limit = limit
        self.bytes = 0
        self.digest = hashlib.sha256() if hashed else None

    def read(self, size=-1):
        if size is None or size < 0:
            size = 1024 * 1024
        data = self.source.read(min(size, 1024 * 1024, self.limit - self.bytes + 1))
        self.bytes += len(data)
        if self.bytes > self.limit:
            raise ValueError("archive_limit")
        if self.digest is not None:
            self.digest.update(data)
        return data


def restore(source, destination, expected_sha256, limits=None, *, owner=None):
    """Verify and extract once into private staging; publish only verified roots.

    The caller owns destination.parent under its fence. No workload can access
    staging. Gzip concatenation remains supported for old independent members.
    """
    limits = limits_checked(limits)
    if owner is not None and (
        not isinstance(owner, tuple)
        or len(owner) != 2
        or any(type(value) is not int or value < 0 for value in owner)
    ):
        raise ValueError("invalid_restore_owner")
    source = pathlib.Path(source)
    destination = pathlib.Path(destination).absolute()
    if source.is_symlink():
        raise ValueError("archive_digest_mismatch")
    if os.path.lexists(destination):
        raise ValueError("restore_destination_exists")
    if not destination.parent.is_dir() or destination.parent.is_symlink():
        raise ValueError("invalid_destination_parent")
    fd = os.open(source, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(fd, "rb") as raw:
        before = os.fstat(raw.fileno())
        if not stat.S_ISREG(before.st_mode) or before.st_size > limits["bytes"]:
            raise ValueError("archive_digest_mismatch")
        compressed = _RestoreReader(raw, before.st_size, hashed=True)
        # Bound decompressed bytes as well as file contents, allowing the capture
        # format's two PAX paths and block padding per accepted member.
        expanded_bound = (
            limits["bytes"]
            + limits["entries"] * (2 * limits["pathBytes"] + 4096)
            + tarfile.RECORDSIZE
        )
        staging = pathlib.Path(tempfile.mkdtemp(prefix=".restore-", dir=destination.parent))
        published = False
        members = []
        try:
            try:
                # tarfile's r|gz stream does not cover every concatenated-gzip
                # case. GzipFile owns framing/CRC; tarfile consumes plain bytes.
                with gzip.GzipFile(fileobj=compressed, mode="rb") as inflated:
                    decoded = _RestoreReader(inflated, expanded_bound)
                    with tarfile.open(fileobj=decoded, mode="r|") as archive:
                        for member in validated_members(archive, limits):
                            members.append(member)
                            target = staging / member.name
                            if member.isdir():
                                target.mkdir(mode=0o700)
                            elif member.isfile():
                                stream = archive.extractfile(member)
                                if stream is None:
                                    raise ValueError("missing_file_stream")
                                with stream, open(target, "xb") as output:
                                    # Restrictive final modes/ownership are applied
                                    # only after all links and archive checks finish.
                                    os.fchmod(output.fileno(), 0o600)
                                    shutil.copyfileobj(stream, output, length=1024 * 1024)
                                    output.flush()
                                    if output.tell() != member.size:
                                        raise ValueError("short_archive_file")
                            elif member.islnk():
                                os.link(staging / member.linkname, target, follow_symlinks=False)
                            else:
                                os.symlink(member.linkname, target)
                    # Force every gzip trailer and compressed suffix through the
                    # verifier, even when the tar terminator appears earlier.
                    while decoded.read(1024 * 1024):
                        pass
            except (gzip.BadGzipFile, EOFError, zlib.error, tarfile.TarError) as error:
                raise ValueError("archive_digest_mismatch") from error
            after = os.fstat(raw.fileno())
            if (
                compressed.bytes != before.st_size
                or compressed.digest.hexdigest() != expected_sha256
                or (
                    before.st_dev,
                    before.st_ino,
                    before.st_size,
                    before.st_mode,
                    before.st_mtime_ns,
                    before.st_ctime_ns,
                )
                != (
                    after.st_dev,
                    after.st_ino,
                    after.st_size,
                    after.st_mode,
                    after.st_mtime_ns,
                    after.st_ctime_ns,
                )
            ):
                raise ValueError("archive_digest_mismatch")
            # All hardlinks now exist. Flush each primary inode once, including
            # final ownership/mode/link metadata, before publishing either root.
            for member in members:
                target = staging / member.name
                if member.isfile():
                    fd = os.open(target, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
                    try:
                        if owner is not None:
                            os.fchown(fd, *owner)
                        os.fchmod(fd, member.mode)
                        os.fsync(fd)
                    finally:
                        os.close(fd)
                elif member.issym() and owner is not None:
                    os.chown(target, *owner, follow_symlinks=False)
            for member in reversed(members):
                if member.isdir():
                    directory = staging / member.name
                    fd = os.open(directory, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
                    try:
                        if owner is not None:
                            os.fchown(fd, *owner)
                        os.fchmod(fd, member.mode)
                        os.fsync(fd)
                    finally:
                        os.close(fd)
            if owner is not None:
                os.chown(staging, *owner, follow_symlinks=False)
            sync_dir(staging)
            if os.path.lexists(destination):
                raise ValueError("restore_destination_exists")
            os.rename(staging, destination)
            published = True
            sync_dir(destination.parent)
            return dict(version=FORMAT, sha256=expected_sha256, entries=len(members))
        finally:
            if not published:
                for root, dirs, _files in os.walk(staging):
                    os.chmod(root, 0o700)
                    for name in dirs:
                        path = pathlib.Path(root) / name
                        if not path.is_symlink():
                            os.chmod(path, 0o700)
                shutil.rmtree(staging)
