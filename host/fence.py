# Copyright (c) 2026 firtoz and Jetski contributors. MIT licensed.
# Adapted from author-owned supervisor fencing code; scope fields generalized.
# Host-only control state: never expose this module or its directory to workloads.
import contextlib
import fcntl
import json
import os
import pathlib
import tempfile
import uuid

FIELDS = {"owner", "poolId", "slotId", "machineId", "sandboxId", "assignmentId", "generation"}


def identity(value):
    if not isinstance(value, dict) or set(value) != FIELDS:
        raise ValueError("invalid_identity")
    for field in ("slotId", "sandboxId", "assignmentId"):
        if not isinstance(value[field], str) or str(uuid.UUID(value[field])) != value[field]:
            raise ValueError("invalid_id")
    for field in ("owner", "poolId", "machineId"):
        if not isinstance(value[field], str) or not 1 <= len(value[field]) <= 160:
            raise ValueError("invalid_scope")
    if type(value["generation"]) is not int or not 0 < value["generation"] < 2**53:
        raise ValueError("invalid_generation")
    return value


class Fence:
    def __init__(self, root):
        self.root = pathlib.Path(root)
        self.root.mkdir(mode=0o700, parents=True, exist_ok=True)
        st = self.root.lstat()
        if self.root.is_symlink() or st.st_uid != os.geteuid() or st.st_mode & 0o077:
            raise ValueError("unsafe_control_root")
        parent = os.open(self.root.parent, os.O_DIRECTORY)
        try:
            os.fsync(parent)
        finally:
            os.close(parent)

    @contextlib.contextmanager
    def locked(self):
        # Parent is private to the supervisor; O_NOFOLLOW also rejects replaced final paths.
        fd = os.open(self.root / "lock", os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
        try:
            fcntl.flock(fd, fcntl.LOCK_EX)
            yield
        finally:
            os.close(fd)

    def read(self):
        try:
            fd = os.open(self.root / "state.json", os.O_RDONLY | os.O_NOFOLLOW)
        except FileNotFoundError:
            return None
        with os.fdopen(fd) as source:
            return json.load(source)

    def write(self, state):
        fd, path = tempfile.mkstemp(prefix=".next-", dir=self.root)
        try:
            with os.fdopen(fd, "w") as output:
                json.dump(state, output)
                output.flush()
                os.fsync(output.fileno())
            os.replace(path, self.root / "state.json")
            directory = os.open(self.root, os.O_DIRECTORY)
            try:
                os.fsync(directory)
            finally:
                os.close(directory)
        finally:
            try:
                os.unlink(path)
            except FileNotFoundError:
                pass

    def match(self, state, lease):
        if state is None or state["lease"] != lease:
            raise ValueError("stale_lease")

    def claim(self, raw):
        lease = identity(raw)
        with self.locked():
            state = self.read()
            if state and state["lease"] == lease:
                if state["phase"] != "open":
                    raise ValueError("closed_lease")
                return state
            expected = 1
            if state:
                old = state["lease"]
                for field in ("owner", "poolId", "slotId", "machineId"):
                    if old[field] != lease[field]:
                        raise ValueError("physical_identity_conflict")
                if state["phase"] != "released":
                    raise ValueError("slot_not_released")
                expected = old["generation"] + 1
            if lease["generation"] != expected:
                raise ValueError("generation_gap_or_replay")
            cached = state.get("localCheckpoint") if state else None
            state = {"lease": lease, "phase": "open"}
            if cached:
                state["localCheckpoint"] = cached
            self.write(state)
            return state

    def close(self, raw):
        lease = identity(raw)
        with self.locked():
            state = self.read()
            # Persist close-before-first-claim. The delayed claim may never reopen it.
            if state is None:
                if lease["generation"] != 1:
                    raise ValueError("generation_gap_or_replay")
                state = {"lease": lease, "phase": "closed"}
                self.write(state)
                return state
            if (
                state["phase"] == "released"
                and lease["generation"] == state["lease"]["generation"] + 1
            ):
                if any(
                    state["lease"][field] != lease[field]
                    for field in ("owner", "poolId", "slotId", "machineId")
                ):
                    raise ValueError("physical_identity_conflict")
                state = {"lease": lease, "phase": "closed"}
                self.write(state)
                return state
            self.match(state, lease)
            if state["phase"] in ("closed", "released"):
                return state
            state = {**state, "phase": "closed"}
            self.write(state)
            return state

    def release(self, raw, verify, receipt):
        lease = identity(raw)
        if not isinstance(receipt, dict) or set(receipt) != {"checkpointId", "sha256"}:
            raise ValueError("invalid_release_receipt")
        if (
            not isinstance(receipt["checkpointId"], str)
            or str(uuid.UUID(receipt["checkpointId"])) != receipt["checkpointId"]
        ):
            raise ValueError("invalid_checkpoint_id")
        if (
            not isinstance(receipt["sha256"], str)
            or len(receipt["sha256"]) != 64
            or any(c not in "0123456789abcdef" for c in receipt["sha256"])
        ):
            raise ValueError("invalid_checkpoint_digest")
        with self.locked():
            state = self.read()
            self.match(state, lease)
            if state["phase"] == "released":
                if state.get("releaseReceipt") != receipt:
                    raise ValueError("release_receipt_conflict")
                return state
            if state["phase"] != "closed":
                raise ValueError("release_before_close")
            if any(
                command["phase"] not in ("succeeded", "failed", "cancelled")
                for command in state.get("commands", {}).values()
            ):
                raise ValueError("commands_unresolved")
            # Trusted supervisor verifies durable remote publication AND absence of
            # lingering processes, mounts, listeners and credentials. Never a client flag.
            if verify(lease, receipt) is not True:
                raise ValueError("cleanup_or_publication_unconfirmed")
            state = {**state, "phase": "released", "releaseReceipt": receipt}
            self.write(state)
            return state
