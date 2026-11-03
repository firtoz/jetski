"""Trusted host runtime composition; never selected by workload request data.

Adapters implement protocol-v1 lifecycle receipts and bounded execution streams.
The control plane and host journals retain lease, publication and replay authority.
Only Podman is installed and qualified by the supplied bootstrap.
"""

import json
import hashlib
import re
import os
import pathlib
import stat
import tempfile
from typing import Protocol


WORKLOAD_USER = "1000:1000"
DEFAULT_INIT_ARGV = (
    "/bin/sh",
    "-c",
    "trap 'exit 0' TERM INT; while :; do sleep 3600 & wait $!; done",
)


def workload_init(config):
    value = config.get("workloadInit")
    if value is None:
        return None
    if (
        not isinstance(value, list)
        or not 1 <= len(value) <= 256
        or any(not isinstance(arg, str) or "\0" in arg for arg in value)
        or not value[0]
        or len(json.dumps(value).encode()) > 65536
    ):
        raise ValueError("invalid_workload_init")
    return list(value)


WORKLOAD_USER_NAMESPACE = "keep-id:uid=1000,gid=1000"

PREPARED_USER_NAMESPACE = "rootless-map"
WORKLOAD_IDENTITY_PATH = pathlib.Path("/etc/jetski/workload.json")
IDENTITY_FIELDS = ("runtimeUid", "runtimeGid", "workloadUid", "workloadGid")
MAPPING_FIELDS = ("uidMappings", "gidMappings")


def mapped_identity(info):
    """Resolve the workload's non-root IDs from the observed rootless maps."""
    mappings = info.get("host", {}).get("idMappings", {})

    observed = {}

    def resolve(kind, identifier):
        ranges = mappings.get(kind)
        if not isinstance(ranges, list) or not 1 <= len(ranges) <= 16:
            raise ValueError("invalid_workload_mapping")
        checked = []
        for item in ranges:
            if not isinstance(item, dict) or set(item) != {"container_id", "host_id", "size"}:
                raise ValueError("invalid_workload_mapping")
            start, host, size = (item[key] for key in ("container_id", "host_id", "size"))
            if any(type(value) is not int for value in (start, host, size)) or (
                min(start, host) < 0 or size < 1 or max(start, host) + size > 2**32 - 1
            ):
                raise ValueError("invalid_workload_mapping")
            for previous, old_host, count in checked:
                if (start < previous + count and previous < start + size) or (
                    host < old_host + count and old_host < host + size
                ):
                    raise ValueError("overlapping_workload_mapping")
            checked.append((start, host, size))
        observed[kind] = [[start, start, size] for start, _host, size in sorted(checked)]
        result = [
            host + identifier - start
            for start, host, size in checked
            if start <= identifier < start + size
        ]
        if len(result) != 1:
            raise ValueError("unmapped_workload_identity")
        return result[0]

    result = dict(
        runtimeUid=resolve("uidmap", 0),
        runtimeGid=resolve("gidmap", 0),
        workloadUid=resolve("uidmap", 1000),
        workloadGid=resolve("gidmap", 1000),
    )
    if min(result["workloadUid"], result["workloadGid"]) < 65536:
        raise ValueError("subordinate_workload_identity_required")
    result.update(uidMappings=observed["uidmap"], gidMappings=observed["gidmap"])
    return result


def read_workload_identity(account, path=WORKLOAD_IDENTITY_PATH, owner_uid=0):
    path = pathlib.Path(path)
    parent = path.parent.lstat()
    if not stat.S_ISDIR(parent.st_mode) or parent.st_uid != owner_uid or parent.st_mode & 0o022:
        raise ValueError("unsafe_workload_identity_parent")
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    with os.fdopen(fd, "rb") as source:
        meta = os.fstat(source.fileno())
        if (
            not stat.S_ISREG(meta.st_mode)
            or meta.st_uid != owner_uid
            or (stat.S_IMODE(meta.st_mode) != 0o600 or meta.st_nlink != 1 or meta.st_size > 16384)
        ):
            raise ValueError("unsafe_workload_identity")
        record = json.loads(source.read(16385))
    return validate_workload_identity(account, record)


def validate_workload_identity(account, record):
    if not isinstance(record, dict) or set(record) != {
        "version",
        "namespace",
        "sha256",
        *IDENTITY_FIELDS,
        *MAPPING_FIELDS,
    }:
        raise ValueError("invalid_workload_identity")
    payload = {key: value for key, value in record.items() if key != "sha256"}
    expected = hashlib.sha256(
        json.dumps(payload, sort_keys=True, separators=(",", ":")).encode()
    ).hexdigest()
    if record["sha256"] != expected:
        raise ValueError("workload_identity_integrity")
    if (
        type(record["version"]) is not int
        or record["version"] != 2
        or record["namespace"] != PREPARED_USER_NAMESPACE
        or any(
            type(record[key]) is not int or not 0 < record[key] < 2**32 - 1
            for key in IDENTITY_FIELDS
        )
    ):
        raise ValueError("invalid_workload_identity")
    if (
        record["runtimeUid"] != account.pw_uid
        or record["runtimeGid"] != account.pw_gid
        or (
            min(record["workloadUid"], record["workloadGid"]) < 65536
            or record["workloadUid"] == account.pw_uid
            or record["workloadGid"] == account.pw_gid
        )
    ):
        raise ValueError("workload_identity_conflict")
    namespace_arguments(record["namespace"], record["uidMappings"], record["gidMappings"])
    return record


def write_workload_identity(account, proof, path=WORKLOAD_IDENTITY_PATH, owner_uid=0):
    from archive import sync_dir

    path = pathlib.Path(path)
    parent = path.parent.lstat()
    if not stat.S_ISDIR(parent.st_mode) or parent.st_uid != owner_uid or parent.st_mode & 0o022:
        raise ValueError("unsafe_workload_identity_parent")
    record = dict(
        version=2,
        namespace=PREPARED_USER_NAMESPACE,
        **{key: proof[key] for key in (*IDENTITY_FIELDS, *MAPPING_FIELDS)},
    )
    record["sha256"] = hashlib.sha256(
        json.dumps(record, sort_keys=True, separators=(",", ":")).encode()
    ).hexdigest()
    validate_workload_identity(account, record)
    if os.path.lexists(path):
        if read_workload_identity(account, path, owner_uid) != record:
            raise ValueError("workload_identity_conflict")
        sync_dir(path.parent)
        return
    fd, temporary = tempfile.mkstemp(prefix=".workload-", dir=path.parent)
    try:
        with os.fdopen(fd, "w") as target:
            json.dump(record, target)
            target.flush()
            os.fsync(target.fileno())
        # Never replace an existing identity, even after an acknowledgement loss.
        os.link(temporary, path, follow_symlinks=False)
    finally:
        os.unlink(temporary)
    sync_dir(path.parent)
    if read_workload_identity(account, path, owner_uid) != record:
        raise ValueError("workload_identity_conflict")


def namespace_arguments(mode, uid_mappings=None, gid_mappings=None):
    if mode == WORKLOAD_USER_NAMESPACE:
        if uid_mappings is not None or gid_mappings is not None:
            raise ValueError("unexpected_namespace_mappings")
        return ["--userns=" + mode]
    if mode != PREPARED_USER_NAMESPACE:
        raise ValueError("unsupported_workload_namespace")
    args = []
    for flag, mappings in (("--uidmap", uid_mappings), ("--gidmap", gid_mappings)):
        if not isinstance(mappings, list) or not 1 <= len(mappings) <= 16:
            raise ValueError("invalid_namespace_mappings")
        previous_end = 0
        for entry in mappings:
            if (
                not isinstance(entry, list)
                or len(entry) != 3
                or any(type(n) is not int for n in entry)
            ):
                raise ValueError("invalid_namespace_mappings")
            inside, parent, size = entry
            if inside != parent or inside != previous_end or size < 1 or inside + size > 2**32 - 1:
                raise ValueError("invalid_namespace_mappings")
            args.append(flag + "=" + ":".join(str(n) for n in entry))
            previous_end = inside + size
        if previous_end <= 1000:
            raise ValueError("unmapped_workload_identity")
    # Explicit mappings create a private namespace. Do not combine them with
    # --userns; preserve parent range boundaries rather than spanning holes in
    # the parent namespace's host mapping or emitting a zero-length segment.
    return args


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
    def prepare_image(
        self,
        run,
        image,
        user_namespace=WORKLOAD_USER_NAMESPACE,
        uid_mappings=None,
        gid_mappings=None,
    ) -> None: ...
    def lifecycle(self, *args, **kwargs) -> SandboxRuntime: ...
    def execution(self, uid: int) -> ExecutionRuntime: ...


class PodmanBackend:
    def __init__(self, init_argv=None):
        self.init_argv = workload_init({"workloadInit": init_argv})

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
            podmanVersion=info["version"]["Version"],
            storageDriver=info["store"]["graphDriverName"],
            runtimeKind="podman",
        )
        program = info["store"].get("graphOptions", {}).get("overlay.mount_program")
        if isinstance(program, dict):
            program = program.get("Executable")
        if isinstance(program, str):
            details["storageMountProgram"] = program
        details.update(mapped_identity(info))
        return details

    def prepare_image(
        self,
        run,
        image,
        user_namespace=WORKLOAD_USER_NAMESPACE,
        uid_mappings=None,
        gid_mappings=None,
    ):
        """Prepare the exact workload mapping before publishing host readiness.

        Native overlay can copy/chown a large image on its first mapped create.
        No container is started here. Only a verified bootstrap container may be
        removed on replay, and no source or workload paths are mounted.
        """
        if not isinstance(image, str) or not re.fullmatch(
            r"[a-zA-Z0-9][a-zA-Z0-9._:/-]*@sha256:[a-f0-9]{64}", image
        ):
            raise ValueError("digest_pinned_image_required")
        mapping_args = namespace_arguments(user_namespace, uid_mappings, gid_mappings)
        label = hashlib.sha256(
            json.dumps(
                [image, user_namespace, uid_mappings, gid_mappings], separators=(",", ":")
            ).encode()
        ).hexdigest()
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
                    *mapping_args,
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

        return PodmanRuntime(*args, init_argv=self.init_argv, **kwargs)

    def execution(self, uid: int) -> ExecutionRuntime:
        from podman_exec import ExecApi

        return ExecApi(uid)


DEFAULT_BACKEND: RuntimeBackend = PodmanBackend()


def runtime_policy(config):
    """Immutable operator policy, never derived from a workload request."""
    policy = config.get("runtime", {"kind": "podman"})
    if not isinstance(policy, dict):
        raise ValueError("invalid_runtime_policy")
    if policy == {"kind": "podman"}:
        return dict(policy)
    from gvisor_oci import RELEASE, ARCHIVE_SHA256

    if (
        set(policy) != {"kind", "version", "release", "archiveSha256"}
        or policy["kind"] != "gvisor"
        or type(policy["version"]) is not int
        or policy["version"] != 1
        or policy["release"] != RELEASE
        or policy["archiveSha256"] != ARCHIVE_SHA256
    ):
        raise ValueError("unsupported_runtime_policy")
    if config.get("networkMode", "none") != "none":
        raise ValueError("gvisor_egress_not_qualified")
    return dict(policy)


class GvisorBackend(PodmanBackend):
    """Native effects; Podman is used only for approved OCI image preparation."""

    def __init__(self, account, config):
        if runtime_policy(config)["kind"] != "gvisor":
            raise ValueError("gvisor_operator_policy_required")
        self.account, self.config = account, json.loads(json.dumps(config))

    def environment(self):
        from gvisor_environment import RootlessEnvironment

        return RootlessEnvironment(
            self.account,
            self.config["images"],
            self.config.get("networkMode", "none"),
            init_argv=workload_init(self.config),
        )

    def probe(self, run):
        from gvisor_install import INSTALL_ROOT
        from gvisor_oci import RELEASE
        from supervisor import bounded_command, runtime_argv, CONTROL_ROOT

        details = super().probe(run)
        observed = bounded_command(
            runtime_argv(self.account)
            + ["unshare", str(INSTALL_ROOT / RELEASE / "runsc"), "--version"],
            CONTROL_ROOT,
            timeout=30,
            max_output=4096,
        )
        if observed["exitCode"] != 0 or RELEASE.removeprefix("release-") not in observed["stdout"]:
            raise ValueError("gvisor_version_unconfirmed")
        return {
            **details,
            "runtimeKind": "gvisor",
            "runtimeRelease": RELEASE,
            "runtimePlatform": "systrap",
        }

    def lifecycle(
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
        from gvisor_native import GvisorRuntime, RunscDriver
        from supervisor import DATA_ROOT

        environment = self.environment()
        if (
            pathlib.Path(data_root) != DATA_ROOT
            or tuple(approved_images) != tuple(self.config["images"])
            or network_mode != "none"
            or user_namespace != PREPARED_USER_NAMESPACE
            or uid_mappings != environment.ownership["uidMappings"]
            or gid_mappings != environment.ownership["gidMappings"]
            or supervisor not in (None, "/opt/jetski/command-supervisor")
            or relay not in (None, "/opt/jetski/tcp-relay")
        ):
            raise ValueError("gvisor_host_policy_conflict")
        return GvisorRuntime(fence, RunscDriver(environment), image, approved_images)

    def memory_driver(self):
        from gvisor_native import RunscDriver

        return RunscDriver(self.environment())

    def execution(self, uid):
        if uid != self.account.pw_uid:
            raise ValueError("gvisor_runtime_identity_conflict")
        from gvisor_exec import ExecApi

        return ExecApi(self.environment())


def selected_backend(config, account):
    init = workload_init(config)
    if runtime_policy(config)["kind"] == "podman":
        return DEFAULT_BACKEND if init is None else PodmanBackend(init)
    return GvisorBackend(account, config)
