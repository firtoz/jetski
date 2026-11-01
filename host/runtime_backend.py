"""Trusted host runtime composition; never selected by workload request data.

Adapters implement protocol-v1 lifecycle receipts and bounded execution streams.
The control plane and host journals retain lease, publication and replay authority.
Only Podman is installed and qualified by the supplied bootstrap.
"""

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
    def lifecycle(self, *args, **kwargs) -> SandboxRuntime: ...
    def execution(self, uid: int) -> ExecutionRuntime: ...


class PodmanBackend:
    def lifecycle(self, *args, **kwargs) -> SandboxRuntime:
        from runtime import PodmanRuntime

        return PodmanRuntime(*args, **kwargs)

    def execution(self, uid: int) -> ExecutionRuntime:
        from podman_exec import ExecApi

        return ExecApi(uid)


DEFAULT_BACKEND: RuntimeBackend = PodmanBackend()
