"""Pinned optional runtime bundle installation on explicitly approved hosts only.

Keep runsc and its gvisor-bin sidecars together. No package repository changes,
service reconfiguration, latest-release lookup or binary-only auto-download.
"""

import hashlib
import json
import os
import pathlib
import re
import shutil
import stat
import tarfile
import tempfile
import time
import urllib.request

from archive import sync_dir
from gvisor_oci import ARCHIVE_SHA256, ARCHIVE_URL, RELEASE

MAX_ARCHIVE = 128 * 1024**2
MAX_EXPANDED = 512 * 1024**2
INSTALL_ROOT = pathlib.Path("/opt/jetski/gvisor")


def extract_verified_archive(archive, destination, expected=ARCHIVE_SHA256):
    """No tar extractor: links, devices, traversal and duplicate paths rejected."""
    archive, destination = pathlib.Path(archive), pathlib.Path(destination)
    fd = os.open(archive, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(fd, "rb") as source:
        meta = os.fstat(source.fileno())
        if not stat.S_ISREG(meta.st_mode) or not 0 < meta.st_size <= MAX_ARCHIVE:
            raise ValueError("invalid_gvisor_archive")
        if hashlib.file_digest(source, "sha256").hexdigest() != expected:
            raise ValueError("gvisor_archive_integrity")
        source.seek(0)
        records, seen, total = [], set(), 0
        with tarfile.open(fileobj=source, mode="r|bz2") as stream:
            for member in stream:
                name = member.name.removeprefix("./").rstrip("/")
                if name in ("", ".") and member.isdir():
                    continue
                parts = name.split("/")
                if (
                    len(seen) >= 256
                    or len(parts) > 4
                    or name in seen
                    or any(
                        not re.fullmatch(r"[a-zA-Z0-9_.-]{1,128}", part) or part in (".", "..")
                        for part in parts
                    )
                    or not (member.isdir() or member.isfile())
                    or member.size < 0
                    or member.size > MAX_EXPANDED
                ):
                    raise ValueError("unsafe_gvisor_archive_member")
                seen.add(name)
                total += member.size
                if total > MAX_EXPANDED:
                    raise ValueError("gvisor_archive_expansion_bound")
                target = destination.joinpath(*parts)
                target.parent.mkdir(parents=True, exist_ok=True, mode=0o755)
                if member.isdir():
                    target.mkdir(exist_ok=True, mode=0o755)
                    target.chmod(0o755)
                    continue
                # All names are private fresh paths; O_EXCL also rejects an
                # implicit-directory/file conflict without following a link.
                output_fd = os.open(
                    target,
                    os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
                    0o755 if member.mode & 0o111 else 0o644,
                )
                with os.fdopen(output_fd, "wb") as output, stream.extractfile(member) as input_file:
                    os.fchmod(output.fileno(), 0o755 if member.mode & 0o111 else 0o644)
                    digest, remaining = hashlib.sha256(), member.size
                    while remaining:
                        data = input_file.read(min(1024 * 1024, remaining))
                        if not data:
                            raise ValueError("short_gvisor_member")
                        output.write(data)
                        digest.update(data)
                        remaining -= len(data)
                    output.flush()
                    os.fsync(output.fileno())
                records.append(
                    dict(
                        path=name,
                        bytes=member.size,
                        sha256=digest.hexdigest(),
                        mode=stat.S_IMODE(target.stat().st_mode),
                    )
                )
    if not any(row["path"] == "runsc" and row["mode"] & 0o111 for row in records) or not any(
        row["path"].startswith("gvisor-bin/") and row["mode"] & 0o111 for row in records
    ):
        raise ValueError("gvisor_sidecar_bundle_required")
    for root, _dirs, _files in os.walk(destination, topdown=False):
        pathlib.Path(root).chmod(0o755)
        sync_dir(pathlib.Path(root))
    return dict(
        version=1,
        release=RELEASE,
        archiveSha256=expected,
        files=sorted(records, key=lambda row: row["path"]),
    )


def _secure_directory(path):
    for parent in [*reversed(path.parents), path]:
        meta = parent.lstat()
        if not stat.S_ISDIR(meta.st_mode) or meta.st_uid != 0 or meta.st_mode & 0o022:
            raise ValueError(
                f"unsafe_gvisor_install_path:{parent}:{meta.st_uid}:{stat.S_IMODE(meta.st_mode):o}"
            )


def verify_installation(directory):
    directory = pathlib.Path(directory)
    _secure_directory(directory)
    manifest_path = directory / "manifest.json"
    fd = os.open(manifest_path, os.O_RDONLY | os.O_NOFOLLOW)
    with os.fdopen(fd, "rb") as source:
        meta = os.fstat(source.fileno())
        if (
            not stat.S_ISREG(meta.st_mode)
            or meta.st_uid != 0
            or meta.st_mode & 0o022
            or meta.st_size > 128 * 1024
        ):
            raise ValueError("unsafe_gvisor_manifest")
        manifest = json.loads(source.read(128 * 1024 + 1))
    if (
        set(manifest) != {"version", "release", "archiveSha256", "files"}
        or manifest["version"] != 1
        or manifest["release"] != RELEASE
        or manifest["archiveSha256"] != ARCHIVE_SHA256
        or not isinstance(manifest["files"], list)
        or not 2 <= len(manifest["files"]) <= 256
    ):
        raise ValueError("invalid_gvisor_manifest")
    seen = set()
    for row in manifest["files"]:
        if not isinstance(row, dict) or set(row) != {"path", "bytes", "sha256", "mode"}:
            raise ValueError("invalid_gvisor_manifest")
        path = pathlib.PurePosixPath(row["path"])
        if (
            path.is_absolute()
            or ".." in path.parts
            or str(path) != row["path"]
            or row["path"] in seen
        ):
            raise ValueError("invalid_gvisor_manifest")
        seen.add(row["path"])
        target = directory / path
        _secure_directory(target.parent)
        file_fd = os.open(target, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        with os.fdopen(file_fd, "rb") as source:
            meta = os.fstat(source.fileno())
            if (
                not stat.S_ISREG(meta.st_mode)
                or meta.st_uid != 0
                or meta.st_nlink != 1
                or meta.st_size != row["bytes"]
                or stat.S_IMODE(meta.st_mode) != row["mode"]
                or meta.st_mode & 0o022
            ):
                raise ValueError("unsafe_gvisor_binary")
            if hashlib.file_digest(source, "sha256").hexdigest() != row["sha256"]:
                raise ValueError("gvisor_binary_integrity")
    if "runsc" not in seen or not any(name.startswith("gvisor-bin/") for name in seen):
        raise ValueError("gvisor_sidecar_bundle_required")
    return manifest


def install():
    if os.geteuid() != 0:
        raise ValueError("root_installation_required")
    _secure_directory(INSTALL_ROOT.parent)
    if not os.path.lexists(INSTALL_ROOT):
        INSTALL_ROOT.mkdir(mode=0o755)
        INSTALL_ROOT.chmod(0o755)
        sync_dir(INSTALL_ROOT.parent)
    _secure_directory(INSTALL_ROOT)
    destination = INSTALL_ROOT / RELEASE
    if os.path.lexists(destination):
        return verify_installation(destination)
    # The bootstrap already serializes admission. Staging is private and never
    # executable until the entire pinned archive has verified and been synced.
    pending = pathlib.Path(tempfile.mkdtemp(prefix=".install-", dir=INSTALL_ROOT))
    archive = pending / "download.bz2"
    bundle = pending / "bundle"
    bundle.mkdir(mode=0o755)
    try:
        deadline, total = time.monotonic() + 180, 0
        with (
            urllib.request.urlopen(ARCHIVE_URL, timeout=20) as response,
            archive.open("xb") as output,
        ):
            if not response.url.startswith("https://"):
                raise ValueError("insecure_gvisor_download")
            while True:
                if time.monotonic() > deadline:
                    raise TimeoutError("gvisor_download_deadline")
                part = response.read(1024 * 1024)
                if not part:
                    break
                total += len(part)
                if total > MAX_ARCHIVE:
                    raise ValueError("gvisor_download_bound")
                output.write(part)
            output.flush()
            os.fsync(output.fileno())
        manifest = extract_verified_archive(archive, bundle)
        fd = os.open(bundle / "manifest.json", os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o644)
        with os.fdopen(fd, "w") as output:
            os.fchmod(output.fileno(), 0o644)
            json.dump(manifest, output, sort_keys=True)
            output.flush()
            os.fsync(output.fileno())
        sync_dir(bundle)
        verify_installation(bundle)
        os.rename(bundle, destination)
        sync_dir(INSTALL_ROOT)
        return manifest
    finally:
        shutil.rmtree(pending)
        sync_dir(INSTALL_ROOT)
