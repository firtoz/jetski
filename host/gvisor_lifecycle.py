"""Fenced native-runsc lifecycle, independent of image preparation and storage.

A trusted driver supplies bounded rootless OCI operations and confirms states.
No checkpoint image or command exit code alone authorizes opening a lease. The
controller must publish the frozen filesystem through its ordinary durable store
before sealing memory. This is a composition module, not a bootstrap entrypoint.
"""

import copy
import uuid
from typing import Protocol

from fence import identity
from gvisor_memory import binding_checked, image_manifest, verify_image
from timing import stage

TERMINAL_COMMANDS = frozenset(("succeeded", "failed", "cancelled"))
TERMINAL_STREAMS = frozenset(("closed", "cancelled"))


class MemoryRuntimeDriver(Protocol):
    """All effects bounded; unknown completion must raise, never retry internally."""

    def container(self, lease) -> str: ...
    def checkpoint(self, lease, checkpoint_id): ...
    def stopped(self, lease) -> bool: ...
    def memory_path(self, lease, checkpoint_id): ...
    def memory_owner(self) -> int: ...
    def restore(self, previous, successor, checkpoint_id): ...
    def running(self, lease) -> bool: ...
    def compatibility(self, lease) -> dict: ...


def checkpoint_id(value):
    if not isinstance(value, str) or str(uuid.UUID(value)) != value:
        raise ValueError("invalid_memory_checkpoint_id")
    return value


def settled(state):
    if any(row["phase"] not in TERMINAL_COMMANDS for row in state.get("commands", {}).values()):
        raise ValueError("memory_requires_settled_commands")
    if any(row["phase"] not in TERMINAL_STREAMS for row in state.get("streams", {}).values()):
        raise ValueError("memory_requires_closed_streams")
    if any(row["phase"] != "committed" for row in state.get("uploads", {}).values()):
        # File-write sessions must settle explicitly before freezing the tree.
        raise ValueError("memory_requires_settled_uploads")


class MemoryLifecycle:
    def __init__(self, fence, driver: MemoryRuntimeDriver):
        self.fence, self.driver = fence, driver

    def _state(self, lease):
        state = self.fence.read()
        self.fence.match(state, lease)
        return state

    def _memory(self, state, identifier):
        memory = state.get("memory")
        if not memory or memory["id"] != identifier:
            raise ValueError("memory_operation_conflict")
        return memory

    def _compatible(self, lease, binding):
        expected = {
            key: binding[key]
            for key in (
                "runtimeSha256",
                "image",
                "configurationSha256",
                "platform",
                "kernelVersion",
                "cpuFeaturesSha256",
            )
        }
        if self.driver.compatibility(lease) != expected:
            raise ValueError("memory_runtime_incompatible")

    def _quarantine(self, state):
        self.fence.write({**state, "phase": "quarantined"})

    @stage("memory.freeze")
    def freeze(self, raw, identifier):
        lease, identifier = copy.deepcopy(identity(raw)), checkpoint_id(identifier)
        with self.fence.locked():
            state = self._state(lease)
            previous = state.get("memory")
            if previous and previous["id"] == identifier:
                if previous["phase"] not in ("frozen", "sealed"):
                    raise ValueError("memory_effect_uncertain")
                if state["phase"] != "closed" or self.driver.stopped(lease) is not True:
                    self._quarantine(state)
                    raise ValueError("memory_quiescence_unconfirmed")
                return copy.deepcopy(previous)
            if state["phase"] != "open" or state.get("runtime", {}).get("phase") != "running":
                raise ValueError("memory_requires_running_runtime")
            settled(state)
            # Persist admission/close before the effect. A lost ACK never repeats
            # a checkpoint (which could otherwise capture a different process).
            memory = dict(id=identifier, phase="freezing")
            state = {**state, "phase": "closed", "memory": memory}
            self.fence.write(state)
            try:
                self.driver.checkpoint(lease, identifier)
                if self.driver.stopped(lease) is not True:
                    raise ValueError("memory_quiescence_unconfirmed")
                memory = {**memory, "phase": "frozen"}
                self.fence.write(
                    {
                        **state,
                        "memory": memory,
                        "runtime": {**state["runtime"], "phase": "frozen"},
                    }
                )
                return copy.deepcopy(memory)
            except BaseException:
                self._quarantine(state)
                raise

    @stage("memory.seal")
    def seal(self, raw, identifier, binding, verify_publication):
        """Trusted coordinator only, following verified durable FS publication.

        verify_publication must validate a committed retained root, not an upload
        ACK or a caller-supplied boolean. It runs again after a lost seal ACK.
        """
        lease, identifier = copy.deepcopy(identity(raw)), checkpoint_id(identifier)
        binding = binding_checked(binding)
        if binding["lease"] != lease or binding["checkpointId"] != identifier:
            raise ValueError("memory_binding_mismatch")
        with self.fence.locked():
            state = self._state(lease)
            self._compatible(lease, binding)
            memory = self._memory(state, identifier)
            if state["phase"] != "closed" or memory["phase"] not in ("frozen", "sealed"):
                raise ValueError("memory_not_frozen")
            if (
                state.get("runtime", {}).get("phase") != "frozen"
                or self.driver.stopped(lease) is not True
            ):
                self._quarantine(state)
                raise ValueError("memory_quiescence_unconfirmed")
            captured = state.get("checkpoint")
            if not captured or captured["sha256"] != binding["filesystemSha256"]:
                raise ValueError("memory_filesystem_mismatch")
            if verify_publication(copy.deepcopy(binding)) is not True:
                raise ValueError("memory_durable_publication_unconfirmed")
            path = self.driver.memory_path(lease, identifier)
            if memory["phase"] == "sealed":
                verify_image(
                    path, memory["manifest"], binding, owner_uid=self.driver.memory_owner()
                )
                return copy.deepcopy(memory)
            manifest = image_manifest(path, binding, owner_uid=self.driver.memory_owner())
            memory = {**memory, "phase": "sealed", "manifest": manifest}
            self.fence.write({**state, "memory": memory})
            return copy.deepcopy(memory)

    @stage("memory.resume")
    def resume(self, raw, next_raw, identifier, binding, verify_filesystem, verify_publication):
        """Only a fenced successor may use the same private frozen filesystem.

        Acknowledgement loss after restore is observed, never restored again.
        verify_filesystem must independently prove the unchanged writable tree
        and its frozen inode/link identity (filesystemIdentitySha256);
        hashing the old archive alone does not prove its current contents.
        """
        lease, successor = copy.deepcopy(identity(raw)), copy.deepcopy(identity(next_raw))
        identifier, binding = checkpoint_id(identifier), binding_checked(binding)
        if (
            any(lease[key] != successor[key] for key in lease if key != "generation")
            or successor["generation"] != lease["generation"] + 1
            or binding["lease"] != lease
            or binding["checkpointId"] != identifier
        ):
            raise ValueError("invalid_memory_successor")
        with self.fence.locked():
            state = self.fence.read()
            memory = self._memory(state, identifier)
            if state["lease"] == successor:
                if (
                    state["phase"] == "open"
                    and memory["phase"] == "resumed"
                    and memory.get("successor") == successor
                    and memory.get("manifest", {}).get("binding") == binding
                    and self.driver.running(successor) is True
                ):
                    return copy.deepcopy(memory)
                raise ValueError("memory_effect_uncertain")
            self.fence.match(state, lease)
            if state["phase"] != "closed" or memory["phase"] != "sealed":
                raise ValueError("memory_not_sealed")
            settled(state)
            self._compatible(lease, binding)
            if self.driver.stopped(lease) is not True:
                self._quarantine(state)
                raise ValueError("memory_quiescence_unconfirmed")
            verify_image(
                self.driver.memory_path(lease, identifier),
                memory["manifest"],
                binding,
                owner_uid=self.driver.memory_owner(),
            )
            if verify_publication(copy.deepcopy(binding)) is not True:
                raise ValueError("memory_durable_publication_unconfirmed")
            if verify_filesystem(copy.deepcopy(binding)) is not True:
                raise ValueError("memory_filesystem_mismatch")
            memory = {**memory, "phase": "resuming", "successor": successor}
            state = {**state, "memory": memory}
            self.fence.write(state)
            try:
                self.driver.restore(lease, successor, identifier)
                if self.driver.running(successor) is not True:
                    raise ValueError("memory_restore_unconfirmed")
                memory = {**memory, "phase": "resumed"}
                # Do not reopen the old generation. Its delayed commands remain
                # stale; successful command/output journals retain original IDs.
                self.fence.write(
                    {
                        **state,
                        "lease": successor,
                        "phase": "open",
                        "memory": memory,
                        "runtime": {
                            **state["runtime"],
                            "name": self.driver.container(successor),
                            "phase": "running",
                        },
                    }
                )
                return copy.deepcopy(memory)
            except BaseException:
                self._quarantine(state)
                raise
