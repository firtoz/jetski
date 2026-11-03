"""Bounded memory-image proof bound to one exact durable filesystem generation.

This module does not freeze/resume a runtime or authorize publication. The trusted
coordinator supplies the binding after quiescence and verifies R2 separately.
Never treat an image-directory name or a runsc exit status as an integrity proof.
"""

import hashlib
import json
import os
import pathlib
import re
import stat
import uuid

from fence import identity

MAX_ENTRIES = 256
MAX_BYTES = 8 * 1024**3
HASH_BYTES = 1024 * 1024
BINDING_FIELDS = {
    "version",
    "lease",
    "runtimeSha256",
    "image",
    "checkpointId",
    "filesystemSha256",
    "filesystemIdentitySha256",
    "configurationSha256",
    "platform",
    "kernelVersion",
    "cpuFeaturesSha256",
}


def binding_checked(value):
    if (
        not isinstance(value, dict)
        or set(value) != BINDING_FIELDS
        or type(value["version"]) is not int
        or value["version"] != 1
    ):
        raise ValueError("invalid_memory_binding")
    identity(value["lease"])
    for key in (
        "runtimeSha256",
        "filesystemSha256",
        "filesystemIdentitySha256",
        "configurationSha256",
        "cpuFeaturesSha256",
    ):
        if not isinstance(value[key], str) or not re.fullmatch(r"[a-f0-9]{64}", value[key]):
            raise ValueError("invalid_memory_binding")
    if not isinstance(value["image"], str) or not re.fullmatch(
        r"[a-zA-Z0-9][a-zA-Z0-9._:/-]*@sha256:[a-f0-9]{64}", value["image"]
    ):
        raise ValueError("invalid_memory_binding")
    checkpoint = value["checkpointId"]
    if not isinstance(checkpoint, str) or str(uuid.UUID(checkpoint)) != checkpoint:
        raise ValueError("invalid_memory_binding")
    if (
        value["platform"] != "systrap"
        or not isinstance(value["kernelVersion"], str)
        or not 1 <= len(value["kernelVersion"]) <= 256
        or "\0" in value["kernelVersion"]
    ):
        raise ValueError("unsupported_memory_platform")
    # Snapshot the caller's expectations; subsequent mutation cannot change proof.
    return json.loads(json.dumps(value, sort_keys=True, separators=(",", ":")))


def _token(meta):
    return (
        meta.st_dev,
        meta.st_ino,
        meta.st_size,
        meta.st_mode,
        meta.st_uid,
        meta.st_gid,
        meta.st_nlink,
        meta.st_mtime_ns,
        meta.st_ctime_ns,
    )


def _directory(meta, owner):
    if not stat.S_ISDIR(meta.st_mode) or meta.st_uid != owner or meta.st_mode & 0o077:
        raise ValueError("unsafe_memory_directory")


def image_manifest(root, binding, *, owner_uid=None, max_bytes=MAX_BYTES):
    binding = binding_checked(binding)
    if type(max_bytes) is not int or not 1 <= max_bytes <= MAX_BYTES:
        raise ValueError("invalid_memory_bound")
    owner = os.geteuid() if owner_uid is None else owner_uid
    if type(owner) is not int or owner < 0:
        raise ValueError("invalid_memory_owner")
    root = pathlib.Path(root)
    # The caller owns/trusts ancestors. Pin every traversed directory and file;
    # a replaced descendant or symlink cannot redirect this walk outside root.
    fd = os.open(root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    records, total = [], 0
    try:
        _directory(os.fstat(fd), owner)

        def visit(directory, prefix, depth):
            nonlocal total
            if depth > 4:
                raise ValueError("memory_image_depth")
            before = os.fstat(directory)
            names = []
            with os.scandir(directory) as entries:
                for entry in entries:
                    if len(names) >= MAX_ENTRIES - len(records):
                        raise ValueError("memory_image_entries")
                    names.append(entry.name)
            for name in sorted(names):
                if not re.fullmatch(r"[a-zA-Z0-9_.-]{1,128}", name) or name in (".", ".."):
                    raise ValueError("invalid_memory_member")
                if len(records) >= MAX_ENTRIES:
                    raise ValueError("memory_image_entries")
                relative = prefix + name
                meta = os.stat(name, dir_fd=directory, follow_symlinks=False)
                if stat.S_ISDIR(meta.st_mode):
                    _directory(meta, owner)
                    child = os.open(
                        name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=directory
                    )
                    try:
                        if _token(os.fstat(child)) != _token(meta):
                            raise ValueError("memory_image_changed")
                        records.append(
                            dict(path=relative, type="directory", mode=stat.S_IMODE(meta.st_mode))
                        )
                        visit(child, relative + "/", depth + 1)
                        if _token(os.stat(name, dir_fd=directory, follow_symlinks=False)) != _token(
                            meta
                        ):
                            raise ValueError("memory_image_changed")
                    finally:
                        os.close(child)
                    continue
                if (
                    not stat.S_ISREG(meta.st_mode)
                    or meta.st_uid != owner
                    or meta.st_nlink != 1
                    or meta.st_mode & 0o177
                ):
                    raise ValueError("unsafe_memory_member")
                total += meta.st_size
                if total > max_bytes:
                    raise ValueError("memory_image_bytes")
                file = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=directory)
                try:
                    if _token(os.fstat(file)) != _token(meta):
                        raise ValueError("memory_image_changed")
                    digest = hashlib.sha256()
                    remaining = meta.st_size
                    while remaining:
                        part = os.read(file, min(HASH_BYTES, remaining))
                        if not part:
                            raise ValueError("memory_image_changed")
                        digest.update(part)
                        remaining -= len(part)
                    if os.read(file, 1):
                        raise ValueError("memory_image_changed")
                    os.fsync(file)
                    if _token(os.fstat(file)) != _token(meta) or _token(
                        os.stat(name, dir_fd=directory, follow_symlinks=False)
                    ) != _token(meta):
                        raise ValueError("memory_image_changed")
                    records.append(
                        dict(
                            path=relative,
                            type="file",
                            mode=stat.S_IMODE(meta.st_mode),
                            bytes=meta.st_size,
                            sha256=digest.hexdigest(),
                        )
                    )
                finally:
                    os.close(file)
            os.fsync(directory)
            if _token(os.fstat(directory)) != _token(before):
                raise ValueError("memory_image_changed")

        root_before = os.fstat(fd)
        visit(fd, "", 0)
        if _token(os.stat(root, follow_symlinks=False)) != _token(root_before):
            raise ValueError("memory_image_changed")
        if not any(record["type"] == "file" for record in records):
            raise ValueError("empty_memory_image")
        payload = dict(version=1, binding=binding, files=records, bytes=total)
        payload["sha256"] = hashlib.sha256(
            json.dumps(payload, sort_keys=True, separators=(",", ":")).encode()
        ).hexdigest()
        return payload
    finally:
        os.close(fd)


def verify_image(root, expected, binding, **bounds):
    # Re-hash all bytes before using memory, including when metadata is unchanged.
    # A future lazy verifier must provide independent page integrity proofs.
    if not isinstance(expected, dict) or expected.get("binding") != binding_checked(binding):
        raise ValueError("memory_binding_mismatch")
    actual = image_manifest(root, binding, **bounds)
    if actual != expected:
        raise ValueError("memory_image_integrity")
    return actual


def normalize_permissions(root, *, owner_uid):
    """Seal native output modes after stopped-runtime proof, without following links.

    This is not a content proof. image_manifest still re-reads every byte after
    normalization; neither routine alone establishes a durable publication.
    """
    root = pathlib.Path(root)
    fd = os.open(root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    count = 0
    try:
        _directory(os.fstat(fd), owner_uid)

        def visit(directory, depth):
            nonlocal count
            if depth > 4:
                raise ValueError("memory_image_depth")
            with os.scandir(directory) as entries:
                for entry in entries:
                    count += 1
                    if count > MAX_ENTRIES:
                        raise ValueError("memory_image_entries")
                    meta = entry.stat(follow_symlinks=False)
                    is_directory = stat.S_ISDIR(meta.st_mode)
                    if (
                        meta.st_uid != owner_uid
                        or not (is_directory or stat.S_ISREG(meta.st_mode))
                        or (not is_directory and meta.st_nlink != 1)
                    ):
                        raise ValueError("unsafe_memory_member")
                    child = os.open(
                        entry.name,
                        os.O_RDONLY
                        | os.O_NOFOLLOW
                        | os.O_NONBLOCK
                        | (os.O_DIRECTORY if is_directory else 0),
                        dir_fd=directory,
                    )
                    try:
                        if _token(os.fstat(child)) != _token(meta):
                            raise ValueError("memory_image_changed")
                        os.fchmod(child, 0o700 if is_directory else 0o600)
                        if is_directory:
                            visit(child, depth + 1)
                        os.fsync(child)
                    finally:
                        os.close(child)
            os.fsync(directory)

        visit(fd, 0)
    finally:
        os.close(fd)
