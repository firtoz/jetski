"""Fenced portable-image import and one admitted native restore effect.

All files are private staging until full encoded/decoded/file verification and
compatibility checks succeed. A restoring intent never authorizes replay.
"""

import base64
import copy
import hashlib
import json
import os
import pathlib
import re
import shutil
import stat
import tempfile

from archive import sync_dir
from fence import identity
from gvisor_lifecycle import checkpoint_id, settled
from gvisor_memory import image_manifest
from memory_chunks import reconstruct_chunks
from memory_filesystem import frozen_identity
from portable_memory_format import parse_manifest, manifest_bytes, manifest_sha256, manifest_objects
from portable_memory_policy import verify_compatibility

CHUNK_BYTES = 4 * 1024**2


def private_directory(path):
    path = pathlib.Path(path)
    if not os.path.lexists(path):
        path.mkdir(mode=0o700)
        sync_dir(path.parent)
    meta = path.lstat()
    if (
        not stat.S_ISDIR(meta.st_mode)
        or meta.st_uid != os.geteuid()
        or stat.S_IMODE(meta.st_mode) != 0o700
    ):
        raise ValueError("unsafe_portable_import_directory")
    return path


def read_metadata(path, limit):
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(fd, "rb") as source:
        meta = os.fstat(fd)
        if (
            not stat.S_ISREG(meta.st_mode)
            or meta.st_uid != os.geteuid()
            or meta.st_mode & 0o077
            or not 1 <= meta.st_size <= limit
        ):
            raise ValueError("unsafe_portable_import_metadata")
        raw = source.read(limit + 1)
        if len(raw) != meta.st_size:
            raise ValueError("portable_import_metadata_changed")
    return json.loads(raw)


def write_metadata(path, value):
    raw = manifest_bytes(value)
    if os.path.lexists(path):
        if manifest_bytes(read_metadata(path, len(raw))) != raw:
            raise ValueError("portable_import_metadata_conflict")
        return
    fd, name = tempfile.mkstemp(prefix=".metadata-", dir=path.parent)
    try:
        with os.fdopen(fd, "wb") as target:
            target.write(raw)
            target.flush()
            os.fsync(target.fileno())
        os.link(name, path, follow_symlinks=False)
        sync_dir(path.parent)
    finally:
        os.unlink(name)
        sync_dir(path.parent)


class PortableMemoryImport:
    def __init__(self, fence, driver, root, data):
        self.fence, self.driver = fence, driver
        self.root, self.data = pathlib.Path(root), pathlib.Path(data)

    def directory(self, lease, identifier):
        return self.root / (lease["assignmentId"] + "-g" + str(lease["generation"])) / identifier

    def state(self, lease, identifier, sha256=None):
        state = self.fence.read()
        self.fence.match(state, lease)
        record = state.get("portableImport")
        if (
            not record
            or record["id"] != identifier
            or (sha256 is not None and record["sha256"] != sha256)
        ):
            raise ValueError("portable_import_identity_conflict")
        return state, record

    def receipt(self, lease, record):
        result = {key: record[key] for key in ("id", "sha256", "phase")}
        result.update(
            lease=lease,
            memoryPreserved=record["phase"] == "restored",
            chunkBytes=CHUNK_BYTES,
            filesystemSha256=record["filesystemSha256"],
        )
        if record.get("reason"):
            result["reason"] = record["reason"]
        return result

    def begin(self, raw, value, sha256, image, memory_mb, cpus):
        lease = copy.deepcopy(identity(raw))
        scope = dict(owner=lease["owner"], sandbox=lease["sandboxId"])
        manifest = parse_manifest(value, scope)
        if manifest_sha256(manifest) != sha256:
            raise ValueError("portable_import_manifest_integrity")
        identifier = manifest["checkpointId"]
        if (
            type(memory_mb) is not int
            or not 128 <= memory_mb <= 65536
            or type(cpus) is not int
            or not 1 <= cpus <= 64
        ):
            raise ValueError("portable_import_resource_policy")
        with self.fence.locked():
            state = self.fence.read()
            self.fence.match(state, lease)
            prior = state.get("portableImport")
            if prior:
                if (
                    prior["id"] != identifier
                    or prior["sha256"] != sha256
                    or prior["image"] != image
                    or prior["memoryMb"] != memory_mb
                    or prior["cpus"] != cpus
                ):
                    raise ValueError("portable_import_identity_conflict")
                if prior["phase"] != "preparing":
                    return self.status_locked(lease, identifier)
            else:
                imported = state.get("import")
                if (
                    state["phase"] != "open"
                    or state.get("runtime")
                    or not imported
                    or imported["phase"] != "ready"
                    or imported["id"] != identifier
                    or imported["sha256"] != manifest["filesystemSha256"]
                    or imported.get("portableMemoryRequired") is not True
                    or self.driver.absent(lease) is not True
                ):
                    raise ValueError("portable_import_requires_verified_filesystem")
                settled(state)
                roots = {
                    name: self.data / lease["assignmentId"] / name for name in ("workspace", "home")
                }
                prior = dict(
                    lease=lease,
                    id=identifier,
                    sha256=sha256,
                    phase="preparing",
                    image=image,
                    memoryMb=memory_mb,
                    cpus=cpus,
                    filesystemIdentitySha256=frozen_identity(roots),
                    filesystemSha256=manifest["filesystemSha256"],
                )
                configuration = dict(
                    backend="gvisor", image=image, memoryMb=memory_mb, cpus=cpus, relay=True
                )
                state = {
                    **state,
                    "phase": "closed",
                    "portableImport": prior,
                    "runtime": dict(
                        lease=lease,
                        name=self.driver.container(lease),
                        phase="importing-memory",
                        image=image,
                        configuration=configuration,
                    ),
                }
                self.fence.write(state)
            if state["phase"] != "closed" or self.driver.absent(lease) is not True:
                raise ValueError("portable_import_preparation_uncertain")
            private_directory(self.root)
            directory = self.directory(lease, identifier)
            private_directory(directory.parent)
            private_directory(directory)
            write_metadata(directory / "manifest.json", manifest)
            objects = private_directory(directory / "objects")
            for obj in manifest_objects(manifest).values():
                write_metadata(
                    objects / (obj["id"] + ".json"), dict(manifestSha256=sha256, object=obj)
                )
            self.driver.prepare_imported(lease, image, memory_mb, cpus)
            try:
                verify_compatibility(
                    manifest["compatibility"], self.driver.portable_compatibility(lease)
                )
            except ValueError as error:
                if str(error) != "portable_memory_runtime_incompatible":
                    raise
                prior = {**prior, "phase": "rejected", "reason": "runtime-incompatible"}
                self.fence.write({**state, "portableImport": prior})
                return self.receipt(lease, prior)
            ready = {**prior, "phase": "receiving"}
            self.fence.write({**state, "portableImport": ready})
            return self.receipt(lease, ready)

    def object(self, lease, record, identifier):
        if not isinstance(identifier, str) or not re.fullmatch(r"[a-zA-Z0-9_-]{1,128}", identifier):
            raise ValueError("invalid_portable_object_id")
        directory = self.directory(lease, record["id"]) / "objects"
        index = read_metadata(directory / (identifier + ".json"), 4096)
        if (
            set(index) != {"manifestSha256", "object"}
            or index["manifestSha256"] != record["sha256"]
            or index["object"]["id"] != identifier
            or index["object"]["owner"] != lease["owner"]
            or index["object"]["sandbox"] != lease["sandboxId"]
        ):
            raise ValueError("portable_object_index_conflict")
        return index["object"], directory / (identifier + ".chunk")

    def object_status_locked(self, lease, record, identifier):
        obj, path = self.object(lease, record, identifier)
        if not os.path.lexists(path):
            return dict(id=identifier, offset=0, complete=False)
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        with os.fdopen(fd, "rb") as source:
            meta = os.fstat(fd)
            if (
                not stat.S_ISREG(meta.st_mode)
                or meta.st_uid != os.geteuid()
                or meta.st_nlink != 1
                or meta.st_mode & 0o077
                or not 0 <= meta.st_size <= obj["bytes"]
            ):
                raise ValueError("unsafe_portable_object")
            complete = meta.st_size == obj["bytes"]
            if (
                complete
                and hashlib.sha256(source.read(obj["bytes"] + 1)).hexdigest() != obj["sha256"]
            ):
                raise ValueError("portable_object_integrity")
            os.fsync(fd)
            return dict(id=identifier, offset=meta.st_size, complete=complete)

    def chunk(self, raw, identifier, object_id, offset, encoded, sha256):
        lease, identifier = copy.deepcopy(identity(raw)), checkpoint_id(identifier)
        if (
            not isinstance(encoded, str)
            or len(encoded) > 6 * 1024**2
            or type(offset) is not int
            or offset < 0
        ):
            raise ValueError("invalid_portable_import_chunk")
        data = base64.b64decode(encoded, validate=True)
        if not 1 <= len(data) <= CHUNK_BYTES or hashlib.sha256(data).hexdigest() != sha256:
            raise ValueError("portable_import_chunk_integrity")
        with self.fence.locked():
            state, record = self.state(lease, identifier)
            if state["phase"] != "closed" or record["phase"] != "receiving":
                raise ValueError("portable_import_not_receiving")
            obj, path = self.object(lease, record, object_id)
            if offset + len(data) > obj["bytes"]:
                raise ValueError("portable_import_chunk_extent")
            before = self.object_status_locked(lease, record, object_id)
            if offset > before["offset"]:
                raise ValueError("portable_import_offset_gap")
            fd = os.open(path, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW | os.O_NONBLOCK, 0o600)
            try:
                existing = min(len(data), before["offset"] - offset)
                if existing and os.pread(fd, existing, offset) != data[:existing]:
                    raise ValueError("portable_import_replay_conflict")
                written = existing
                while written < len(data):
                    count = os.pwrite(fd, data[written:], offset + written)
                    if count <= 0:
                        raise OSError("portable_import_short_write")
                    written += count
                os.fsync(fd)
            finally:
                os.close(fd)
            sync_dir(path.parent)
            return self.object_status_locked(lease, record, object_id)

    def status_locked(self, lease, identifier, object_id=None):
        state, record = self.state(lease, identifier)
        if record["phase"] in ("restoring", "restored"):
            try:
                running = (
                    self.driver.running(lease) is True
                    and self.driver.verify_resources(lease, record["memoryMb"], record["cpus"])
                    is True
                )
            except Exception:
                running = False
            if running:
                record = {**record, "phase": "restored"}
                self.fence.write(
                    {
                        **state,
                        "phase": "open",
                        "runtime": {**state["runtime"], "phase": "running"},
                        "portableImport": record,
                    }
                )
            elif record["phase"] == "restored":
                self.fence.write({**state, "phase": "quarantined"})
                raise ValueError("portable_restore_unconfirmed")
        result = self.receipt(lease, record)
        if object_id is not None:
            if record["phase"] != "receiving":
                raise ValueError("portable_import_not_receiving")
            result["object"] = self.object_status_locked(lease, record, object_id)
        return result

    def status(self, raw, identifier, object_id=None):
        lease, identifier = copy.deepcopy(identity(raw)), checkpoint_id(identifier)
        with self.fence.locked():
            return self.status_locked(lease, identifier, object_id)

    def finish(self, raw, identifier, sha256):
        lease, identifier = copy.deepcopy(identity(raw)), checkpoint_id(identifier)
        with self.fence.locked():
            state, record = self.state(lease, identifier, sha256)
            if record["phase"] in ("restoring", "restored"):
                return self.status_locked(lease, identifier)
            if state["phase"] != "closed" or record["phase"] not in (
                "receiving",
                "assembling",
                "ready",
            ):
                raise ValueError("portable_import_not_ready")
            directory = self.directory(lease, identifier)
            manifest = parse_manifest(
                read_metadata(directory / "manifest.json", 4 * 1024**2),
                dict(owner=lease["owner"], sandbox=lease["sandboxId"]),
            )
            if manifest_sha256(manifest) != record["sha256"]:
                raise ValueError("portable_import_manifest_integrity")
            for obj in manifest_objects(manifest).values():
                if not self.object_status_locked(lease, record, obj["id"])["complete"]:
                    raise ValueError("portable_import_incomplete")
            roots = {
                name: self.data / lease["assignmentId"] / name for name in ("workspace", "home")
            }
            if frozen_identity(roots) != record["filesystemIdentitySha256"]:
                raise ValueError("portable_import_filesystem_changed")
            verify_compatibility(
                manifest["compatibility"], self.driver.portable_compatibility(lease)
            )
            if self.driver.absent(lease) is not True:
                raise ValueError("portable_import_runtime_present")
            record = {**record, "phase": "assembling"}
            state = {**state, "portableImport": record}
            self.fence.write(state)
            target = pathlib.Path(self.driver.memory_path(lease, identifier))
            self.driver.prepare_imported_parent(lease, identifier)
            if os.path.lexists(target):
                meta = target.lstat()
                if (
                    not stat.S_ISDIR(meta.st_mode)
                    or meta.st_uid not in (os.geteuid(), self.driver.memory_owner())
                    or meta.st_mode & 0o077
                ):
                    raise ValueError("unsafe_partial_portable_image")
                shutil.rmtree(target)
                sync_dir(target.parent)

            def read_object(obj):
                expected, path = self.object(lease, record, obj["id"])
                if expected != obj:
                    raise ValueError("portable_object_identity_conflict")
                fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
                with os.fdopen(fd, "rb") as source:
                    return source.read(obj["bytes"] + 1)

            reconstruct_chunks(
                manifest["files"],
                manifest["directories"],
                dict(owner=lease["owner"], sandbox=lease["sandboxId"]),
                target,
                read_object,
            )
            self.driver.accept_imported_image(lease, identifier)
            binding = dict(
                version=1,
                lease=lease,
                checkpointId=identifier,
                filesystemSha256=manifest["filesystemSha256"],
                filesystemIdentitySha256=record["filesystemIdentitySha256"],
                **self.driver.compatibility(lease),
            )
            proof = image_manifest(target, binding, owner_uid=self.driver.memory_owner())
            # Construction checked every native file digest; seal its exact tree
            # again before the persisted point of no blind native replay.
            expected_files = [(f["path"], f["bytes"], f["sha256"]) for f in manifest["files"]]
            actual_files = sorted(
                (f["path"], f["bytes"], f["sha256"]) for f in proof["files"] if f["type"] == "file"
            )
            actual_dirs = sorted(f["path"] for f in proof["files"] if f["type"] == "directory")
            if (
                actual_files != expected_files
                or actual_dirs != manifest["directories"]
                or any(
                    f["mode"] != (0o700 if f["type"] == "directory" else 0o600)
                    for f in proof["files"]
                )
            ):
                raise ValueError("portable_import_image_integrity")
            if frozen_identity(roots) != record["filesystemIdentitySha256"]:
                raise ValueError("portable_import_filesystem_changed")
            record = {**record, "phase": "restoring", "imageSha256": proof["sha256"]}
            self.fence.write(
                {
                    **state,
                    "portableImport": record,
                    "runtime": {**state["runtime"], "phase": "restoring-memory"},
                }
            )
            try:
                self.driver.restore_imported(lease, identifier, record["memoryMb"], record["cpus"])
            except BaseException:
                observed = self.status_locked(lease, identifier)
                if observed["phase"] == "restored":
                    return observed
                current = self.fence.read()
                self.fence.write({**current, "phase": "quarantined"})
                raise
            return self.status_locked(lease, identifier)

    def abort(self, raw, identifier, sha256):
        """Explicit FS fallback is possible only before any restore was admitted."""
        lease, identifier = copy.deepcopy(identity(raw)), checkpoint_id(identifier)
        with self.fence.locked():
            state, record = self.state(lease, identifier, sha256)
            if record["phase"] == "filesystem":
                return self.receipt(lease, record)
            if (
                record["phase"]
                not in ("preparing", "rejected", "receiving", "assembling", "ready", "aborting")
                or self.driver.absent(lease) is not True
            ):
                raise ValueError("portable_import_effect_uncertain")
            record = {**record, "phase": "aborting"}
            self.fence.write({**state, "portableImport": record})
            self.driver.remove(lease)
            if self.driver.absent(lease) is not True:
                raise ValueError("portable_import_cleanup_unconfirmed")
            current = self.fence.read()
            record = {
                **record,
                "phase": "filesystem",
                "reason": record.get("reason", "memory-unavailable"),
            }
            self.fence.write(
                {**current, "phase": "open", "runtime": None, "portableImport": record}
            )
            return self.receipt(lease, record)

    def purge_locked(self, raw):
        """Remove only derived import cache after the owning assignment release."""
        lease = copy.deepcopy(identity(raw))
        state = self.fence.read()
        self.fence.match(state, lease)
        record = state.get("portableImport")
        if not record:
            return
        if state["phase"] != "released" or not state.get("releaseReceipt"):
            raise ValueError("portable_import_not_released")
        origin = identity(record["lease"])
        if (
            any(origin[key] != lease[key] for key in lease if key != "generation")
            or origin["generation"] > lease["generation"]
        ):
            raise ValueError("portable_import_release_identity_conflict")
        path = self.directory(origin, checkpoint_id(record["id"]))
        if not os.path.lexists(path):
            return
        private_directory(self.root)
        private_directory(path.parent)
        private_directory(path)
        shutil.rmtree(path)
        sync_dir(path.parent)
        if not os.listdir(path.parent):
            path.parent.rmdir()
            sync_dir(self.root)
