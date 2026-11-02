"""Rootless Podman lifecycle; host command runner is supervisor-owned.

No SSH credentials or caller-selected host commands enter this module's workload
configuration. Commands passed to run() must execute as the dedicated rootless
runtime account, with a clean environment and bounded output/time.
"""

import pathlib
import re
from fence import identity
from streams import stopped_streams
from runtime_backend import (
    WORKLOAD_USER,
    WORKLOAD_USER_NAMESPACE,
    PREPARED_USER_NAMESPACE,
    namespace_arguments,
)


class PodmanRuntime:
    def __init__(
        self,
        fence,
        run,
        image,
        data_root,
        approved_images,
        supervisor=None,
        relay=None,
        network_mode="none",
        user_namespace=WORKLOAD_USER_NAMESPACE,
        uid_mappings=None,
        gid_mappings=None,
    ):
        if not isinstance(image, str) or not re.fullmatch(
            r"[a-zA-Z0-9][a-zA-Z0-9._:/-]*@sha256:[a-f0-9]{64}", image
        ):
            raise ValueError("digest_pinned_image_required")
        if image not in approved_images:
            raise ValueError("image_not_approved")
        if network_mode not in ("none", "egress"):
            raise ValueError("invalid_network_policy")
        if user_namespace not in (
            WORKLOAD_USER_NAMESPACE,
            PREPARED_USER_NAMESPACE,
        ):
            raise ValueError("unsupported_workload_namespace")
        self.mapping_args = namespace_arguments(user_namespace, uid_mappings, gid_mappings)
        self.uid_mappings, self.gid_mappings = uid_mappings, gid_mappings
        self.user_namespace = user_namespace
        self.network_mode = network_mode
        self.relay = relay
        self.supervisor = supervisor
        self.fence = fence
        self.run = run
        self.image = image
        self.data_root = pathlib.Path(data_root)
        if not self.data_root.is_absolute():
            raise ValueError("absolute_data_root_required")

    def container(self, lease):
        return "jetski-" + lease["assignmentId"]

    def absent(self, lease):
        return self.run(["container", "exists", self.container(lease)])["exitCode"] == 1

    def create(self, raw, memory_mb=512, cpus=1):
        lease = identity(raw)
        if type(memory_mb) is not int or not 128 <= memory_mb <= 65536:
            raise ValueError("invalid_memory_limit")
        if type(cpus) is not int or not 1 <= cpus <= 64:
            raise ValueError("invalid_cpu_limit")
        with self.fence.locked():
            state = self.fence.read()
            self.fence.match(state, lease)
            if state["phase"] != "open":
                raise ValueError("closed_lease")
            existing = state.get("runtime")
            requested = dict(
                image=self.image, memoryMb=memory_mb, cpus=cpus, relay=self.relay is not None
            )
            if self.user_namespace != WORKLOAD_USER_NAMESPACE:
                requested["userNamespace"] = self.user_namespace
                requested["uidMappings"], requested["gidMappings"] = (
                    self.uid_mappings,
                    self.gid_mappings,
                )
            if self.network_mode != "none":
                requested["networkMode"] = self.network_mode
            if existing:
                if existing.get("configuration") != requested:
                    raise ValueError("runtime_configuration_conflict")
                if existing["phase"] == "running":
                    return existing
                raise ValueError("runtime_already_admitted")
            name = self.container(lease)
            # No replay following a lost provider/runtime acknowledgement.
            self.fence.write(
                {
                    **state,
                    "runtime": dict(
                        name=name, phase="creating", image=self.image, configuration=requested
                    ),
                }
            )
            try:
                for root in ("workspace", "home"):
                    path = self.data_root / lease["assignmentId"] / root
                    if path.is_symlink() or not path.is_dir():
                        raise ValueError("persistent_root_unprepared")
                args = [
                    "run",
                    "--detach",
                    "--name",
                    name,
                    "--label",
                    "org.jetski.assignment=" + lease["assignmentId"],
                    "--label",
                    "org.jetski.generation=" + str(lease["generation"]),
                    "--read-only",
                    "--cap-drop=ALL",
                    "--security-opt=no-new-privileges",
                    "--user",
                    WORKLOAD_USER,
                    *self.mapping_args,
                    "--pids-limit",
                    "256",
                    "--memory",
                    str(memory_mb) + "m",
                    "--cpus",
                    str(cpus),
                    "--network="
                    + (
                        "none"
                        if self.network_mode == "none"
                        else "slirp4netns:allow_host_loopback=false"
                    ),
                    "--pull=never",
                    "--tmpfs",
                    "/tmp:rw,nosuid,nodev,size=128m",
                    "--tmpfs",
                    "/run:rw,nosuid,nodev,size=16m",
                    "--env",
                    "HOME=/home/sandbox",
                    "--workdir",
                    "/workspace",
                ]
                for source, target in (("workspace", "/workspace"), ("home", "/home/sandbox")):
                    args.extend(
                        [
                            "--mount",
                            "type=bind,src="
                            + str(self.data_root / lease["assignmentId"] / source)
                            + ",dst="
                            + target,
                        ]
                    )
                if self.supervisor is not None:
                    args.extend(
                        [
                            "--mount",
                            "type=bind,src=" + self.supervisor + ",dst=/jetski-supervisor,ro",
                        ]
                    )
                if self.relay is not None:
                    args.extend(
                        ["--mount", "type=bind,src=" + self.relay + ",dst=/jetski-tcp-relay,ro"]
                    )
                # PID 1 needs an explicit handler: an unhandled sleep would
                # consume the full stop grace before SIGKILL on every save.
                # Tracked commands are already settled before quiescence; the
                # namespace exit also removes any remaining idle descendants.
                args.extend(
                    [
                        self.image,
                        "/bin/sh",
                        "-c",
                        "trap 'exit 0' TERM INT; while :; do sleep 3600 & wait $!; done",
                    ]
                )
                result = self.run(args)
                if result["exitCode"] != 0:
                    raise RuntimeError("runtime_create_failed")
                next_state = {
                    **self.fence.read(),
                    "runtime": dict(
                        name=name, phase="running", image=self.image, configuration=requested
                    ),
                }
                self.fence.write(next_state)
                return next_state["runtime"]
            except BaseException:
                self.fence.write({**self.fence.read(), "phase": "quarantined"})
                raise

    def quiesce(self, raw):
        lease = identity(raw)
        # Persist close before waiting for stop: delayed commands cannot be admitted.
        self.fence.close(lease)
        with self.fence.locked():
            state = self.fence.read()
            self.fence.match(state, lease)
            runtime = state.get("runtime")
            if not runtime or runtime["phase"] not in ("running", "stopped"):
                raise ValueError("runtime_state_uncertain")
            if runtime["phase"] == "stopped":
                return runtime
            result = self.run(["stop", "--time", "10", runtime["name"]])
            if result["exitCode"] != 0:
                raise RuntimeError("runtime_stop_unconfirmed")
            inspected = self.run(["inspect", "--format", "{{.State.Running}}", runtime["name"]])
            if inspected["exitCode"] != 0 or inspected["stdout"].strip() != "false":
                raise RuntimeError("runtime_quiescence_unconfirmed")
            runtime = {**runtime, "phase": "stopped"}
            state = {**state, "runtime": runtime}
            self.fence.write({**state, "streams": stopped_streams(state)})
            return runtime

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
            if runtime["phase"] == "removed":
                return runtime
            # A previous rm may have succeeded before its acknowledgement or
            # receipt was persisted. Observe absence before replaying cleanup.
            result = self.run(["container", "exists", runtime["name"]])
            if result["exitCode"] == 0:
                removed = self.run(["rm", runtime["name"]])
                if removed["exitCode"] != 0:
                    raise RuntimeError("runtime_removal_unconfirmed")
                result = self.run(["container", "exists", runtime["name"]])
            if result["exitCode"] != 1:
                raise RuntimeError("runtime_still_present_or_unknown")
            runtime = {**runtime, "phase": "removed"}
            self.fence.write({**state, "runtime": runtime})
            return runtime
