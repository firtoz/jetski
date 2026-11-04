"""Native runsc effects behind a trusted, rootless host environment.

The environment owns pinned executable, prepared image/rootfs, namespace runner,
private bundles and delegated cgroups. It must not be constructed from workload
request data. No remote-storage credentials enter this adapter.
"""

import copy
import json
import time
from typing import Protocol

from fence import identity
from gvisor_lifecycle import checkpoint_id
from gvisor_oci import RunscCommands, container_name
from timing import stage
from streams import stopped_streams


class NativeEnvironment(Protocol):
    commands: RunscCommands

    def run(self, arguments: list[str]) -> dict: ...
    def bundle(self, lease) -> str: ...
    def prepare(self, lease, image, memory_mb, cpus) -> None: ...
    def verify_resources(self, lease, memory_mb, cpus) -> bool: ...
    def compatibility(self, lease) -> dict: ...
    def memory_path(self, lease, checkpoint) -> str: ...
    def prepare_memory_path(self, lease, checkpoint) -> None: ...
    def memory_owner(self) -> int: ...
    def seal_permissions(self, lease, checkpoint) -> None: ...
    def prepare_successor(self, previous, successor) -> None: ...
    def verify_successor(self, previous, successor) -> bool: ...
    def cleanup(self, lease) -> None: ...


class RunscDriver:
    def __init__(self, environment: NativeEnvironment):
        self.env = environment

    def container(self, lease):
        return container_name(lease)

    def _checked(self, arguments):
        result = self.env.run(arguments)
        if result.get("exitCode") != 0:
            # The bounded runner retains diagnostic output privately. Do not put
            # host paths, environment or untrusted runtime stderr in API errors.
            raise RuntimeError("gvisor_effect_unconfirmed")
        return result["stdout"]

    def state(self, raw):
        lease = identity(raw)
        result = json.loads(self._checked(self.env.commands.command("state", lease)))
        if (
            not isinstance(result, dict)
            or result.get("id") != self.container(lease)
            or result.get("bundle") != self.env.bundle(lease)
            or result.get("status") not in ("creating", "created", "running", "stopped", "paused")
        ):
            raise ValueError("gvisor_state_identity_conflict")
        return result

    def running(self, lease):
        return self.state(lease)["status"] == "running"

    def stopped(self, lease):
        return self.state(lease)["status"] == "stopped"

    def absent(self, raw):
        lease = identity(raw)
        # A nonzero state request is not evidence of absence. Enumerate the
        # private runtime root; malformed/failed/incomplete observation fails closed.
        rows = json.loads(self._checked(self.env.commands.prefix() + ["list", "--format=json"]))
        # Pinned runsc encodes an empty Go slice as JSON null. A successful
        # complete inventory with null is its documented empty representation.
        if rows is None:
            rows = []
        if not isinstance(rows, list) or len(rows) > 64:
            raise ValueError("gvisor_inventory_unavailable")
        identifiers = []
        for row in rows:
            if not isinstance(row, dict) or not isinstance(row.get("id"), str):
                raise ValueError("gvisor_inventory_unavailable")
            identifiers.append(row["id"])
        if len(set(identifiers)) != len(identifiers):
            raise ValueError("gvisor_inventory_unavailable")
        return self.container(lease) not in identifiers

    @stage("runtime.create")
    def create(self, raw, image, memory_mb, cpus):
        lease = identity(raw)
        self.env.prepare(lease, image, memory_mb, cpus)
        self._checked(self.env.commands.command("run", lease, bundle=self.env.bundle(lease)))
        if not self.running(lease) or self.env.verify_resources(lease, memory_mb, cpus) is not True:
            raise ValueError("gvisor_running_limits_unconfirmed")

    def stop(self, lease):
        if not self.stopped(lease):
            self._checked(self.env.commands.command("kill", lease))
        self.wait_stopped(lease)

    def wait_stopped(self, lease):
        deadline = time.monotonic() + 5
        while self.stopped(lease) is not True:
            if time.monotonic() >= deadline:
                raise ValueError("gvisor_stop_unconfirmed")
            time.sleep(0.05)

    def remove(self, lease):
        if not self.absent(lease):
            if not self.stopped(lease):
                raise ValueError("gvisor_remove_requires_stop")
            self._checked(self.env.commands.command("delete", lease))
        if self.absent(lease) is not True:
            raise ValueError("gvisor_removal_unconfirmed")
        self.env.cleanup(lease)

    def verify_resources(self, lease, memory_mb, cpus):
        return self.env.verify_resources(lease, memory_mb, cpus)

    def checkpoint(self, lease, identifier):
        checkpoint_id(identifier)
        self.env.prepare_memory_path(lease, identifier)
        self._checked(
            self.env.commands.command(
                "checkpoint", lease, image=self.memory_path(lease, identifier)
            )
        )
        self.wait_stopped(lease)
        # The sealed private image is still unacknowledged until both its full
        # integrity proof and the ordinary durable filesystem publication pass.
        self.env.seal_permissions(lease, identifier)

    def memory_path(self, lease, identifier):
        return self.env.memory_path(lease, checkpoint_id(identifier))

    def memory_owner(self):
        return self.env.memory_owner()

    def compatibility(self, lease):
        return self.env.compatibility(lease)

    def restore(self, previous, successor, identifier):
        # MemoryLifecycle persisted resuming before this multi-effect sequence.
        # Interrupted deletion/create/restore is uncertainty; never retry it here.
        if not self.stopped(previous):
            raise ValueError("gvisor_restore_requires_stop")
        self._checked(self.env.commands.command("delete", previous))
        if not self.absent(previous):
            raise ValueError("gvisor_previous_container_present")
        self.env.prepare_successor(previous, successor)
        self._checked(
            self.env.commands.command(
                "restore",
                successor,
                bundle=self.env.bundle(successor),
                image=self.memory_path(previous, identifier),
            )
        )
        if (
            not self.running(successor)
            or self.env.verify_successor(previous, successor) is not True
        ):
            raise ValueError("gvisor_restore_unconfirmed")
        self.env.cleanup(previous)

    def restore_imported(self, lease, identifier, memory_mb, cpus):
        """One native effect on a prepared, exclusively fenced target.

        The portable coordinator must persist its restoring intent and verify
        files, memory and policy before this call. An interrupted call is never
        retried: observe running/absent state under that same intent instead.
        """
        if not self.absent(lease):
            raise ValueError("gvisor_import_requires_absent_runtime")
        self._checked(
            self.env.commands.command(
                "restore",
                lease,
                bundle=self.env.bundle(lease),
                image=self.memory_path(lease, identifier),
            )
        )
        if not self.running(lease) or self.env.verify_resources(lease, memory_mb, cpus) is not True:
            raise ValueError("gvisor_import_restore_unconfirmed")


class GvisorRuntime:
    """Lifecycle journal; memory suspension uses MemoryLifecycle separately."""

    def __init__(self, fence, driver, image, approved_images):
        if image not in approved_images:
            raise ValueError("image_not_approved")
        self.fence, self.driver, self.image = fence, driver, image

    def container(self, lease):
        return self.driver.container(lease)

    def absent(self, lease):
        return self.driver.absent(lease)

    def create(self, raw, memory_mb=512, cpus=1):
        lease = copy.deepcopy(identity(raw))
        if type(memory_mb) is not int or not 128 <= memory_mb <= 65536:
            raise ValueError("invalid_memory_limit")
        if type(cpus) is not int or not 1 <= cpus <= 64:
            raise ValueError("invalid_cpu_limit")
        requested = dict(
            backend="gvisor", image=self.image, memoryMb=memory_mb, cpus=cpus, relay=True
        )
        with self.fence.locked():
            state = self.fence.read()
            self.fence.match(state, lease)
            if state["phase"] != "open":
                raise ValueError("closed_lease")
            existing = state.get("runtime")
            if existing:
                if existing.get("configuration") != requested:
                    raise ValueError("runtime_configuration_conflict")
                if existing["phase"] == "running":
                    try:
                        if (
                            self.driver.running(lease)
                            and self.driver.verify_resources(lease, memory_mb, cpus) is True
                        ):
                            return existing
                    except BaseException:
                        self.fence.write({**state, "phase": "quarantined"})
                        raise
                    self.fence.write({**state, "phase": "quarantined"})
                raise ValueError("runtime_state_uncertain")
            runtime = dict(
                lease=lease,
                name=self.container(lease),
                phase="creating",
                image=self.image,
                configuration=requested,
            )
            state = {**state, "runtime": runtime}
            self.fence.write(state)
            try:
                self.driver.create(lease, self.image, memory_mb, cpus)
                runtime = {**runtime, "phase": "running"}
                self.fence.write({**state, "runtime": runtime})
                return runtime
            except BaseException:
                self.fence.write({**state, "phase": "quarantined"})
                raise

    def quiesce(self, raw):
        lease = identity(raw)
        self.fence.close(lease)
        with self.fence.locked():
            state = self.fence.read()
            self.fence.match(state, lease)
            runtime = state.get("runtime")
            if not runtime or runtime["phase"] not in ("running", "frozen", "stopped"):
                raise ValueError("runtime_state_uncertain")
            try:
                self.driver.stop(lease)
                runtime = {**runtime, "phase": "stopped"}
                stopped = {**state, "runtime": runtime}
                self.fence.write({**stopped, "streams": stopped_streams(stopped)})
                return runtime
            except BaseException:
                self.fence.write({**state, "phase": "quarantined"})
                raise

    def remove(self, raw):
        lease = identity(raw)
        with self.fence.locked():
            state = self.fence.read()
            self.fence.match(state, lease)
            runtime = state.get("runtime")
            if (
                state["phase"] != "closed"
                or not runtime
                or runtime["phase"] not in ("stopped", "removed")
            ):
                raise ValueError("runtime_not_quiesced")
            self.driver.remove(lease)
            runtime = {**runtime, "phase": "removed"}
            self.fence.write({**state, "runtime": runtime})
            return runtime
