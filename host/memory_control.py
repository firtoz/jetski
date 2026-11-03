"""Private controller memory operations. Public clients cannot assert publication.

As with durable release, the authenticated controller must verify the committed
retained storage root before sending publication. The host binds that assertion
to its exact frozen archive and physical tree; it holds no storage credentials.
"""

import copy
import os
import stat
import pathlib
import re

from archive import capture, sync_dir
from fence import identity
from gvisor_lifecycle import MemoryLifecycle, checkpoint_id
from memory_filesystem import frozen_identity

MEMORY_ACTIONS = frozenset(("memory-freeze", "memory-seal", "memory-resume", "memory-status"))


def publication_checked(payload, identifier):
    value = payload.get("publication")
    if (
        not isinstance(value, dict)
        or set(value) != {"checkpointId", "sha256"}
        or value["checkpointId"] != identifier
        or not isinstance(value["sha256"], str)
        or not re.fullmatch("[a-f0-9]{64}", value["sha256"])
    ):
        raise ValueError("invalid_memory_publication")
    return copy.deepcopy(value)


def handle(action, payload, fence, backend, archives, data):
    if action not in MEMORY_ACTIONS or not hasattr(backend, "memory_driver"):
        raise ValueError("memory_runtime_not_available")
    lease = copy.deepcopy(identity(payload["lease"]))
    identifier = checkpoint_id(payload.get("checkpointId"))
    driver = backend.memory_driver()
    life = MemoryLifecycle(fence, driver)
    roots = {
        name: pathlib.Path(data) / lease["assignmentId"] / name for name in ("workspace", "home")
    }
    with fence.locked():
        state = fence.read()
        # Resume ACK replay must reach MemoryLifecycle under the original lease,
        # even after the successful successor became authoritative.
        if action != "memory-resume":
            fence.match(state, lease)
        if not state or state.get("runtime", {}).get("image") != payload.get("image"):
            raise ValueError("memory_image_conflict")
    if action == "memory-freeze":
        life.freeze(lease, identifier)
        with fence.locked():
            state = fence.read()
            fence.match(state, lease)
            memory = state["memory"]
            fingerprint = frozen_identity(roots)
            if memory.get("filesystemIdentitySha256", fingerprint) != fingerprint:
                raise ValueError("memory_filesystem_changed")
            memory = {**memory, "filesystemIdentitySha256": fingerprint}
            fence.write({**state, "memory": memory})
        return dict(checkpointId=identifier, phase="frozen", checkpointReadBytes=1280 * 1024)
    if action == "memory-status":
        memory = state.get("memory")
        if not memory or memory["id"] != identifier:
            return dict(checkpointId=identifier, phase="unavailable")
        return dict(checkpointId=identifier, phase=memory["phase"])
    publication = publication_checked(payload, identifier)
    with fence.locked():
        state = fence.read()
        memory = state.get("memory")
        if (
            not memory
            or memory["id"] != identifier
            or memory.get("filesystemIdentitySha256") is None
        ):
            raise ValueError("memory_binding_unavailable")
        if action == "memory-resume" and memory["phase"] == "resumed":
            binding = copy.deepcopy(memory["manifest"]["binding"])
            if binding["lease"] != lease or binding["filesystemSha256"] != publication["sha256"]:
                raise ValueError("memory_publication_mismatch")
        else:
            archived = state.get("checkpoint")
            if not archived or archived["sha256"] != publication["sha256"]:
                raise ValueError("memory_publication_mismatch")
            binding = dict(
                version=1,
                lease=lease,
                checkpointId=identifier,
                filesystemSha256=archived["sha256"],
                filesystemIdentitySha256=memory["filesystemIdentitySha256"],
                **memory["compatibility"],
            )
        # A resumed binding remains bound to its original physical generation.
        if memory.get("manifest") and memory["manifest"]["binding"] != binding:
            raise ValueError("memory_binding_mismatch")
        frame_bytes = memory.get("captureFrameBytes", 1024 * 1024)

    def published(candidate):
        # This assertion arrived through the private authenticated controller
        # protocol AFTER registry and stored-object verification, never through
        # an end-user boolean. Bind it to this exact archive/checkpoint identity.
        return (
            candidate["checkpointId"] == publication["checkpointId"]
            and candidate["filesystemSha256"] == publication["sha256"]
        )

    if action == "memory-seal":
        sealed = life.seal(lease, identifier, binding, published)
        return dict(
            checkpointId=identifier,
            phase="sealed",
            sha256=sealed["manifest"]["sha256"],
            memoryBytes=sealed["manifest"]["bytes"],
            filesystemSha256=binding["filesystemSha256"],
        )

    def unchanged(candidate):
        if frozen_identity(roots) != candidate["filesystemIdentitySha256"]:
            return False
        target = pathlib.Path(archives) / (".memory-check-" + identifier + ".tgz")
        try:
            observed = capture(roots, target, frame_bytes=frame_bytes)
            return (
                observed["sha256"] == candidate["filesystemSha256"]
                and frozen_identity(roots) == candidate["filesystemIdentitySha256"]
            )
        finally:
            if target.exists():
                if target.is_symlink() or not target.is_file():
                    raise ValueError("unsafe_memory_check_archive")
                target.unlink()
                sync_dir(target.parent)

    successor = copy.deepcopy(identity(payload.get("nextLease")))
    resumed = life.resume(lease, successor, identifier, binding, unchanged, published)
    with fence.locked():
        current = fence.read()
        fence.match(current, successor)
        if current["memory"]["id"] != identifier or current["memory"]["phase"] != "resumed":
            raise ValueError("memory_resume_identity_changed")
        # Successor generations retain persistent inodes, not the old tar path.
        # R2 publication was verified before restore. Retire only this private
        # derived archive so a subsequent save can capture changed bytes under
        # the same assignment ID. Lost ACKs repeat cleanup, never native restore.
        source = pathlib.Path(archives) / (lease["assignmentId"] + ".tgz")
        if os.path.lexists(source):
            meta = source.lstat()
            if not stat.S_ISREG(meta.st_mode) or meta.st_uid != os.geteuid():
                raise ValueError("unsafe_memory_source_archive")
            source.unlink()
            sync_dir(source.parent)
        current.pop("checkpoint", None)
        fence.write(current)
    return dict(
        checkpointId=identifier,
        phase=resumed["phase"],
        lease=successor,
        memoryPreserved=True,
        filesystemSha256=binding["filesystemSha256"],
    )
