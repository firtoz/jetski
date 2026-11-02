"""Trusted host runtime composition; never selected by workload request data.

Adapters implement protocol-v1 lifecycle receipts and bounded execution streams.
The control plane and host journals retain lease, publication and replay authority.
Only Podman is installed and qualified by the supplied bootstrap.
"""

import json
import hashlib
import re
from typing import Protocol


WORKLOAD_USER = "1000:1000"
WORKLOAD_USER_NAMESPACE = "keep-id:uid=1000,gid=1000"


class SandboxRuntime(Protocol):
    def container(self, lease): ...
    def create(self, lease, memory_mb=512, cpus=1): ...
    def quiesce(self, lease): ...
    def remove(self, lease): ...
    def absent(self, lease) -> bool: ...


class ExecutionRuntime(Protocol):
    def create(self, container, argv, cwd="/workspace", tty=False, stdin=False): ...
    def inspect(self, session): ...
    def remove(self, session): ...
    def output(
        self,
        session,
        timeout=150,
        initial_input=b"",
        on_started=None,
        input_ready=None,
        input_close_ready=None,
        abort_ready=None,
    ): ...


class RuntimeBackend(Protocol):
    def probe(self, run) -> dict: ...
    def prepare_image(self, run, image) -> None: ...
    def lifecycle(self, *args, **kwargs) -> SandboxRuntime: ...
    def execution(self, uid: int) -> ExecutionRuntime: ...


class PodmanBackend:
    def probe(self, run) -> dict:
        result = run(["info", "--format", "json"])
        if result["exitCode"]:
            raise ValueError("rootless_runtime_unavailable")
        info = json.loads(result["stdout"])
        if not info["host"]["security"]["rootless"] or info["host"]["cgroupVersion"] != "v2":
            raise ValueError("rootless_cgroup_v2_required")
        major = int(info["version"]["Version"].split(".")[0])
        if major < 4:
            raise ValueError("unsupported_podman_version")
        if info["store"]["graphDriverName"] not in ("overlay", "vfs"):
            raise ValueError("unsupported_storage_driver")
        details = dict(
            podmanVersion=info["version"]["Version"], storageDriver=info["store"]["graphDriverName"]
        )
        program = info["store"].get("graphOptions", {}).get("overlay.mount_program")
        if isinstance(program, dict):
            program = program.get("Executable")
        if isinstance(program, str):
            details["storageMountProgram"] = program
        return details

    def prepare_image(self, run, image):
        """Prepare the exact workload mapping before publishing host readiness.

        Native overlay can copy/chown a large image on its first mapped create.
        No container is started here. Only a verified bootstrap container may be
        removed on replay, and no source or workload paths are mounted.
        """
        if not isinstance(image, str) or not re.fullmatch(
            r"[a-zA-Z0-9][a-zA-Z0-9._:/-]*@sha256:[a-f0-9]{64}", image
        ):
            raise ValueError("digest_pinned_image_required")
        label = hashlib.sha256(image.encode()).hexdigest()
        name = "jetski-bootstrap-" + label[:32]

        def checked(args):
            result = run(args)
            if result["exitCode"] != 0:
                raise ValueError("image_preparation_failed")
            return result["stdout"]

        image_id = checked(["image", "inspect", image, "--format", "{{.Id}}"])
        image_id = image_id.strip().removeprefix("sha256:")
        if not re.fullmatch("[a-f0-9]{64}", image_id):
            raise ValueError("invalid_prepared_image_identity")
        exists = run(["container", "exists", name])["exitCode"]
        if exists not in (0, 1):
            raise ValueError("bootstrap_container_observation_failed")
        if exists == 1:
            checked(
                [
                    "create",
                    "--name",
                    name,
                    "--label",
                    "org.jetski.bootstrap-image=" + label,
                    "--read-only",
                    "--cap-drop=ALL",
                    "--security-opt=no-new-privileges",
                    "--user",
                    WORKLOAD_USER,
                    "--userns=" + WORKLOAD_USER_NAMESPACE,
                    "--network=none",
                    "--image-volume=ignore",
                    "--pull=never",
                    image,
                    "/bin/sh",
                    "-c",
                    ":",
                ]
            )
        observed = json.loads(checked(["inspect", name, "--format", "json"]))
        if not isinstance(observed, list) or len(observed) != 1:
            raise ValueError("bootstrap_container_identity_conflict")
        container = observed[0]
        state = container.get("State", {})
        config = container.get("Config", {})
        if (
            container.get("Name", "").lstrip("/") != name
            or container.get("Image", "").removeprefix("sha256:") != image_id
            or config.get("Labels", {}).get("org.jetski.bootstrap-image") != label
            or config.get("User") != WORKLOAD_USER
            or container.get("Mounts") != []
            or state.get("Status") not in ("created", "configured")
            or state.get("Running") is not False
            or state.get("Pid", 0) != 0
        ):
            raise ValueError("bootstrap_container_identity_conflict")
        checked(["rm", name])
        if run(["container", "exists", name])["exitCode"] != 1:
            raise ValueError("bootstrap_container_removal_unconfirmed")

    def lifecycle(self, *args, **kwargs) -> SandboxRuntime:
        from runtime import PodmanRuntime

        return PodmanRuntime(*args, **kwargs)

    def execution(self, uid: int) -> ExecutionRuntime:
        from podman_exec import ExecApi

        return ExecApi(uid)


DEFAULT_BACKEND: RuntimeBackend = PodmanBackend()
