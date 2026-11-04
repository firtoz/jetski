"""Bounded independent memory-image chunks; no storage or lifecycle authority.

The trusted caller supplies a verified frozen native manifest and private paths.
Returned extents can be transferred through any object store. Reconstruction
creates a private staging tree and cannot execute or publish it.
"""

import copy
import hashlib
import os
import pathlib
import re
import stat
import zlib

from frames import compress_frame

MAX_BYTES = 8 * 1024**3
MAX_ENTRIES = 256
MAX_CHUNKS = 8192
MAX_CHUNK_BYTES = 4 * 1024**2
MAX_STORED_BYTES = 8 * 1024**2


def _hash(value):
    return hashlib.sha256(value).hexdigest()


def _digest(value):
    return isinstance(value, str) and re.fullmatch(r"[a-f0-9]{64}", value) is not None


def _integer(value, low, high):
    return type(value) is int and low <= value <= high


def _path(value):
    if not isinstance(value, str):
        raise ValueError("invalid_memory_chunk_path")
    parts = value.split("/")
    if not 1 <= len(parts) <= 5 or any(
        part in (".", "..") or not re.fullmatch(r"[a-zA-Z0-9_.-]{1,128}", part) for part in parts
    ):
        raise ValueError("invalid_memory_chunk_path")
    return parts


def _token(meta):
    return (
        meta.st_dev,
        meta.st_ino,
        meta.st_mode,
        meta.st_uid,
        meta.st_gid,
        meta.st_nlink,
        meta.st_size,
        meta.st_mtime_ns,
        meta.st_ctime_ns,
    )


def _directory(meta, uid):
    if not stat.S_ISDIR(meta.st_mode) or meta.st_uid != uid or meta.st_mode & 0o077:
        raise ValueError("unsafe_memory_chunk_directory")


def decode_chunk(encoded, *, codec, size, sha256, stored_sha256):
    if (
        not isinstance(encoded, bytes)
        or not 1 <= len(encoded) <= MAX_STORED_BYTES
        or not _integer(size, 1, MAX_CHUNK_BYTES)
        or not _digest(sha256)
        or not _digest(stored_sha256)
        or _hash(encoded) != stored_sha256
    ):
        raise ValueError("memory_chunk_integrity")
    if codec == "identity":
        decoded = encoded
    elif codec == "gzip":
        decoder = zlib.decompressobj(wbits=31)
        decoded = decoder.decompress(encoded, size + 1)
        if len(decoded) > size or decoder.unconsumed_tail or decoder.unused_data or not decoder.eof:
            raise ValueError("memory_chunk_expansion")
        decoded += decoder.flush(size + 1 - len(decoded))
    else:
        raise ValueError("unsupported_memory_chunk_codec")
    if len(decoded) != size or _hash(decoded) != sha256:
        raise ValueError("memory_chunk_integrity")
    return decoded


def capture_chunks(
    root, expected, output, *, codec="gzip", chunk_bytes=1024 * 1024, owner_uid=None
):
    """Read each frozen native file once, verifying its sealed whole-file hash.

    A failed capture leaves an unpublished output for the caller's effects journal;
    this function never overwrites an existing path on retry or deletes evidence.
    """
    if codec not in ("identity", "gzip") or not _integer(chunk_bytes, 1024, MAX_CHUNK_BYTES):
        raise ValueError("invalid_memory_chunk_policy")
    if not isinstance(expected, list) or not 1 <= len(expected) <= MAX_ENTRIES:
        raise ValueError("invalid_memory_chunk_files")
    records = {}
    for entry in expected:
        if not isinstance(entry, dict):
            raise ValueError("invalid_memory_chunk_files")
        _path(entry.get("path"))
        if entry["path"] in records or entry.get("type") not in ("file", "directory"):
            raise ValueError("invalid_memory_chunk_files")
        records[entry["path"]] = entry
    owner_uid = os.geteuid() if owner_uid is None else owner_uid
    if type(owner_uid) is not int or owner_uid < 0:
        raise ValueError("invalid_memory_chunk_owner")
    root = pathlib.Path(root)
    root_fd = os.open(root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    output_fd = None
    files, directories, seen = [], [], set()
    packed_hash = hashlib.sha256()
    packed_bytes, total, chunks = 0, 0, 0
    try:
        _directory(os.fstat(root_fd), owner_uid)
        output_fd = os.open(output, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)

        def visit(fd, prefix, depth):
            nonlocal packed_bytes, total, chunks
            if depth > 4:
                raise ValueError("memory_chunk_depth")
            before = os.fstat(fd)
            names = []
            with os.scandir(fd) as iterator:
                for entry in iterator:
                    if len(names) >= MAX_ENTRIES:
                        raise ValueError("memory_chunk_entries")
                    names.append(entry.name)
            for name in sorted(names):
                relative = prefix + name
                _path(relative)
                sealed = records.get(relative)
                if sealed is None or relative in seen:
                    raise ValueError("memory_chunk_source_changed")
                seen.add(relative)
                meta = os.stat(name, dir_fd=fd, follow_symlinks=False)
                if sealed.get("mode") != stat.S_IMODE(meta.st_mode):
                    raise ValueError("memory_chunk_source_changed")
                if sealed["type"] == "directory":
                    _directory(meta, owner_uid)
                    child = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
                    try:
                        if _token(os.fstat(child)) != _token(meta):
                            raise ValueError("memory_chunk_source_changed")
                        directories.append(relative)
                        visit(child, relative + "/", depth + 1)
                    finally:
                        os.close(child)
                else:
                    if (
                        not stat.S_ISREG(meta.st_mode)
                        or meta.st_uid != owner_uid
                        or meta.st_nlink != 1
                        or meta.st_mode & 0o177
                        or not _integer(sealed.get("bytes"), 0, MAX_BYTES)
                        or sealed["bytes"] != meta.st_size
                        or not _digest(sealed.get("sha256"))
                    ):
                        raise ValueError("unsafe_memory_chunk_file")
                    total += meta.st_size
                    if total > MAX_BYTES:
                        raise ValueError("memory_chunk_bytes")
                    file_fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=fd)
                    try:
                        if _token(os.fstat(file_fd)) != _token(meta):
                            raise ValueError("memory_chunk_source_changed")
                        digest, parts, offset = hashlib.sha256(), [], 0
                        while offset < meta.st_size:
                            raw = bytearray()
                            limit = min(chunk_bytes, meta.st_size - offset)
                            while len(raw) < limit:
                                part = os.read(file_fd, limit - len(raw))
                                if not part:
                                    raise ValueError("memory_chunk_source_changed")
                                raw.extend(part)
                            raw = bytes(raw)
                            digest.update(raw)
                            encoded = raw if codec == "identity" else compress_frame(raw)
                            raw_sha256, stored_sha256 = _hash(raw), _hash(encoded)
                            if codec != "identity":
                                decode_chunk(
                                    encoded,
                                    codec=codec,
                                    size=len(raw),
                                    sha256=raw_sha256,
                                    stored_sha256=stored_sha256,
                                )
                            if not 1 <= len(encoded) <= MAX_STORED_BYTES or chunks >= MAX_CHUNKS:
                                raise ValueError("memory_chunk_bound")
                            view = memoryview(encoded)
                            while view:
                                written = os.write(output_fd, view)
                                if written <= 0:
                                    raise OSError("memory_chunk_short_write")
                                view = view[written:]
                            parts.append(
                                dict(
                                    offset=offset,
                                    bytes=len(raw),
                                    sha256=raw_sha256,
                                    codec=codec,
                                    packedOffset=packed_bytes,
                                    storedBytes=len(encoded),
                                    storedSha256=stored_sha256,
                                )
                            )
                            packed_hash.update(encoded)
                            packed_bytes += len(encoded)
                            offset += len(raw)
                            chunks += 1
                        if (
                            os.read(file_fd, 1)
                            or digest.hexdigest() != sealed["sha256"]
                            or _token(os.fstat(file_fd)) != _token(meta)
                        ):
                            raise ValueError("memory_chunk_source_changed")
                        files.append(
                            dict(
                                path=relative,
                                bytes=meta.st_size,
                                sha256=digest.hexdigest(),
                                chunks=parts,
                            )
                        )
                    finally:
                        os.close(file_fd)
                if _token(os.stat(name, dir_fd=fd, follow_symlinks=False)) != _token(meta):
                    raise ValueError("memory_chunk_source_changed")
            if _token(os.fstat(fd)) != _token(before):
                raise ValueError("memory_chunk_source_changed")
            os.fsync(fd)

        before = os.fstat(root_fd)
        visit(root_fd, "", 0)
        if (
            seen != set(records)
            or not total
            or _token(os.stat(root, follow_symlinks=False)) != _token(before)
        ):
            raise ValueError("memory_chunk_source_changed")
        os.fsync(output_fd)
        parent = os.open(pathlib.Path(output).parent, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try:
            os.fsync(parent)
        finally:
            os.close(parent)
        return dict(
            version=1,
            files=sorted(files, key=lambda f: f["path"]),
            directories=sorted(directories),
            bytes=packed_bytes,
            sha256=packed_hash.hexdigest(),
            expandedBytes=total,
        )
    finally:
        if output_fd is not None:
            os.close(output_fd)
        os.close(root_fd)


def validate_memory_layout(files, directories, scope):
    """Detach and bound the complete image layout before any filesystem effect."""
    files, directories, scope = copy.deepcopy((files, directories, scope))
    if (
        not isinstance(files, list)
        or not files
        or not isinstance(directories, list)
        or len(files) + len(directories) > MAX_ENTRIES
        or not isinstance(scope, dict)
        or set(scope) != {"owner", "sandbox"}
        or any(
            not isinstance(v, str) or not re.fullmatch(r"[a-zA-Z0-9_-]{1,128}", v)
            for v in scope.values()
        )
    ):
        raise ValueError("invalid_memory_reconstruction")
    known_dirs = set()
    previous = ""
    for path in directories:
        parts = _path(path)
        if path <= previous or any(
            "/".join(parts[:i]) not in known_dirs for i in range(1, len(parts))
        ):
            raise ValueError("invalid_memory_directory_order")
        known_dirs.add(path)
        previous = path
    previous, total, count = "", 0, 0
    objects = {}
    for file in files:
        if not isinstance(file, dict) or set(file) != {"path", "bytes", "sha256", "chunks"}:
            raise ValueError("invalid_memory_reconstruction_file")
        parts = _path(file["path"])
        if (
            file["path"] <= previous
            or file["path"] in known_dirs
            or any("/".join(parts[:i]) not in known_dirs for i in range(1, len(parts)))
            or not _integer(file["bytes"], 0, MAX_BYTES)
            or not _digest(file["sha256"])
            or not isinstance(file["chunks"], list)
            or len(file["chunks"]) > MAX_CHUNKS
        ):
            raise ValueError("invalid_memory_reconstruction_file")
        previous = file["path"]
        total += file["bytes"]
        offset = 0
        for chunk in file["chunks"]:
            count += 1
            if (
                not isinstance(chunk, dict)
                or set(chunk) != {"offset", "bytes", "sha256", "codec", "object"}
                or not _integer(chunk["offset"], 0, MAX_BYTES)
                or chunk["offset"] != offset
                or not _integer(chunk["bytes"], 1, MAX_CHUNK_BYTES)
                or not _digest(chunk["sha256"])
                or chunk["codec"] not in ("identity", "gzip")
            ):
                raise ValueError("invalid_memory_reconstruction_chunk")
            obj = chunk["object"]
            if (
                not isinstance(obj, dict)
                or set(obj) != {"owner", "sandbox", "id", "bytes", "sha256"}
                or any(obj.get(key) != value for key, value in scope.items())
                or not isinstance(obj["id"], str)
                or not re.fullmatch(r"[a-zA-Z0-9_-]{1,128}", obj["id"])
                or not _integer(obj["bytes"], 1, MAX_STORED_BYTES)
                or not _digest(obj["sha256"])
            ):
                raise ValueError("invalid_memory_reconstruction_object")
            proof = (obj["bytes"], obj["sha256"], chunk["codec"], chunk["bytes"], chunk["sha256"])
            if obj["id"] in objects and objects[obj["id"]] != proof:
                raise ValueError("conflicting_memory_reconstruction_object")
            objects[obj["id"]] = proof
            offset += chunk["bytes"]
        if offset != file["bytes"] or (not offset and file["sha256"] != _hash(b"")):
            raise ValueError("invalid_memory_reconstruction_extent")
    if not 1 <= total <= MAX_BYTES or count > MAX_CHUNKS:
        raise ValueError("memory_reconstruction_bound")
    return files, directories, scope, total


def reconstruct_chunks(files, directories, scope, target, read_chunk):
    """Create a new private image tree; caller owns any later atomic admission.

    read_chunk receives one validated immutable object descriptor and must return
    its complete bounded stored bytes. Partial output remains unpublished on error.
    The root and all files stay mode0700/0600 until the trusted host hands them to
    the runtime. No existing directory or file is ever replaced on retry.
    """
    files, directories, scope, total = validate_memory_layout(files, directories, scope)
    target = pathlib.Path(target)
    os.mkdir(target, 0o700)
    root = os.open(target, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        for path in directories:
            # The freshly created private root is inaccessible to workloads. All
            # parent names were validated and created in this same invocation.
            os.mkdir(path, 0o700, dir_fd=root)
        for file in files:
            fd = os.open(
                file["path"],
                os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
                0o600,
                dir_fd=root,
            )
            digest = hashlib.sha256()
            try:
                for chunk in file["chunks"]:
                    encoded = read_chunk(dict(chunk["object"]))
                    if not isinstance(encoded, bytes) or len(encoded) != chunk["object"]["bytes"]:
                        raise ValueError("memory_reconstruction_short_read")
                    raw = decode_chunk(
                        encoded,
                        codec=chunk["codec"],
                        size=chunk["bytes"],
                        sha256=chunk["sha256"],
                        stored_sha256=chunk["object"]["sha256"],
                    )
                    digest.update(raw)
                    view = memoryview(raw)
                    while view:
                        written = os.write(fd, view)
                        if written <= 0:
                            raise OSError("memory_reconstruction_short_write")
                        view = view[written:]
                if digest.hexdigest() != file["sha256"]:
                    raise ValueError("memory_reconstruction_file_integrity")
                os.fsync(fd)
            finally:
                os.close(fd)
        for path in reversed(directories):
            fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=root)
            try:
                os.fsync(fd)
            finally:
                os.close(fd)
        os.fsync(root)
        parent = os.open(target.parent, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try:
            os.fsync(parent)
        finally:
            os.close(parent)
    finally:
        os.close(root)
    return dict(files=len(files), bytes=total)
