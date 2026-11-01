"""Trusted host runtime composition; never selected by workload request data.

Adapters implement protocol-v1 lifecycle receipts and bounded execution streams.
The control plane and host journals retain lease, publication and replay authority.
Only Podman is installed and qualified by the supplied bootstrap.
"""

import json
from typing import Protocol


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

    def lifecycle(self, *args, **kwargs) -> SandboxRuntime:
        from runtime import PodmanRuntime

        return PodmanRuntime(*args, **kwargs)

    def execution(self, uid: int) -> ExecutionRuntime:
        from podman_exec import ExecApi

        return ExecApi(uid)


DEFAULT_BACKEND: RuntimeBackend = PodmanBackend()
