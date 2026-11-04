"""Concrete caller-managed rootless environment for the optional native runtime.

Constructed only by privileged host control with immutable bootstrap policy.
Workload UID 1000 maps to a subordinate host ID, never the runtime account.
"""

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
from gvisor_install import INSTALL_ROOT
from gvisor_memory import normalize_permissions
from gvisor_lifecycle import checkpoint_id
from gvisor_oci import (
    RELEASE,
    ARCHIVE_SHA256,
    RunscCommands,
    container_name,
    sandbox_spec,
    specification_sha256,
)
from runtime_backend import read_workload_identity, workload_init
from supervisor import bounded_command, runtime_argv, CONTROL_ROOT, DATA_ROOT

IMAGE_PROOF = pathlib.Path("/etc/jetski/gvisor-images.json")
MAX_POLICY_BYTES = 128 * 1024


def private_directory(path, account, *, create=False):
    """Runtime-owned paths; every ancestor excludes subordinate workload writers."""
    path = pathlib.Path(path)
    for parent in [*reversed(path.parents), path]:
        if not os.path.lexists(parent) and create:
            parent.mkdir(mode=0o700)
            os.chown(parent, account.pw_uid, account.pw_gid)
        meta = parent.lstat()
        if (
            not stat.S_ISDIR(meta.st_mode)
            or meta.st_uid not in (0, account.pw_uid)
            or meta.st_mode & 0o022
        ):
            raise ValueError("unsafe_gvisor_control_directory")
    meta = path.lstat()
    if meta.st_uid != account.pw_uid or stat.S_IMODE(meta.st_mode) != 0o700:
        raise ValueError("unsafe_gvisor_private_directory")
    return path


def write_json(path, value, account):
    """Exclusive, durable receipt/config creation; interrupted effects are not retried."""
    data = json.dumps(value, sort_keys=True, separators=(",", ":")).encode()
    if len(data) > MAX_POLICY_BYTES:
        raise ValueError("gvisor_configuration_bound")
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, "wb") as output:
        os.fchown(output.fileno(), account.pw_uid, account.pw_gid)
        os.fchmod(output.fileno(), 0o600)
        output.write(data)
        output.flush()
        os.fsync(output.fileno())
    sync_dir(pathlib.Path(path).parent)


def read_json(path, owner_uid):
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(fd, "rb") as source:
        meta = os.fstat(source.fileno())
        if (
            not stat.S_ISREG(meta.st_mode)
            or meta.st_uid != owner_uid
            or meta.st_nlink != 1
            or meta.st_mode & 0o077
            or meta.st_size > MAX_POLICY_BYTES
        ):
            raise ValueError("unsafe_gvisor_configuration")
        return json.loads(source.read(MAX_POLICY_BYTES + 1))


def native_namespace_arguments(account, ownership):
    """Reproduce the approved subordinate maps without an engine moving cgroups."""
    args = ["unshare", "--user", "--map-user=0", "--map-group=0"]
    for filename, key, workload, flag in (
        ("/etc/subuid", "uidMappings", "workloadUid", "--map-users"),
        ("/etc/subgid", "gidMappings", "workloadGid", "--map-groups"),
    ):
        ranges = []
        with open(filename) as source:
            text = source.read(1024 * 1024 + 1)
        if len(text) > 1024 * 1024:
            raise ValueError("subordinate_mapping_bound")
        for line in text.splitlines():
            parts = line.split(":")
            if len(parts) == 3 and parts[0] in (account.pw_name, str(account.pw_uid)):
                start, count = int(parts[1]), int(parts[2])
                if start < 65536 or count <= 1000 or start + count >= 2**32:
                    raise ValueError("invalid_subordinate_mapping")
                ranges.append((start, count))
        if len(ranges) != 1:
            raise ValueError("native_runtime_requires_single_subordinate_range")
        start, count = ranges[0]
        if ownership[key] != [[0, 0, 1], [1, 1, count]] or ownership[workload] != start + 999:
            raise ValueError("native_namespace_mapping_conflict")
        args.append(f"{flag}=1:{start}:{count}")
    return args


def cgroup_parent(account):
    return pathlib.Path(
        f"/sys/fs/cgroup/user.slice/user-{account.pw_uid}.slice/user@{account.pw_uid}.service/jetski-gvisor"
    )


def prepare_delegation(account):
    """Bootstrap only, on an explicitly adopted execution host, never desktop."""
    if os.geteuid() != 0:
        raise ValueError("root_bootstrap_required")
    parent = cgroup_parent(account)
    service = parent.parent
    if not service.is_dir() or not {"cpu", "memory", "pids"}.issubset(
        (service / "cgroup.controllers").read_text().split()
    ):
        raise ValueError("gvisor_controllers_not_delegated")
    # systemd keeps its manager in init.scope, leaving this delegated parent empty.
    if (service / "cgroup.procs").read_text().strip():
        raise ValueError("gvisor_delegation_parent_populated")
    (service / "cgroup.subtree_control").write_text("+cpu +memory +pids")
    if not os.path.lexists(parent):
        parent.mkdir()
        os.chown(parent, account.pw_uid, account.pw_gid)
    meta = parent.lstat()
    if not stat.S_ISDIR(meta.st_mode) or meta.st_uid != account.pw_uid or meta.st_mode & 0o022:
        raise ValueError("unsafe_gvisor_cgroup_parent")
    if (parent / "cgroup.procs").read_text().strip():
        raise ValueError("gvisor_delegation_parent_populated")
    for name in ("cgroup.procs", "cgroup.subtree_control", "cgroup.threads"):
        os.chown(parent / name, account.pw_uid, account.pw_gid)
    (parent / "cgroup.subtree_control").write_text("+cpu +memory +pids")


class RootlessEnvironment:
    def __init__(self, account, images, network_mode="none", init_argv=None):
        if os.geteuid() != 0:
            raise ValueError("root_supervisor_required")
        if network_mode != "none":
            raise ValueError("gvisor_egress_not_qualified")
        self.account, self.images = account, tuple(images)
        self.init_argv = workload_init({"workloadInit": init_argv})
        self.ownership = read_workload_identity(account)
        self.namespace_argv = native_namespace_arguments(account, self.ownership)
        self.root = private_directory(pathlib.Path(account.pw_dir) / "gvisor", account)
        self.commands = RunscCommands(
            str(INSTALL_ROOT / RELEASE / "runsc"), str(self.root / "state")
        )
        for name in ("state", "bundles", "memory", "images", "exec"):
            private_directory(self.root / name, account)
        self.prepared = read_json(IMAGE_PROOF, 0)
        if (
            set(self.prepared) != {"version", "archiveSha256", "images"}
            or self.prepared["version"] != 1
            or self.prepared["archiveSha256"] != ARCHIVE_SHA256
            or set(self.prepared["images"]) != set(self.images)
        ):
            raise ValueError("gvisor_image_policy_conflict")

    def argv(self, arguments):
        if arguments[: len(self.commands.prefix())] != self.commands.prefix():
            raise ValueError("invalid_gvisor_native_command")
        # Only image preparation uses the container engine. Native execution uses
        # util-linux user namespaces so an engine cannot silently move cgroups.
        prefix = runtime_argv(self.account)[:-1] + self.namespace_argv
        action = arguments[len(self.commands.prefix())]
        if action in ("run", "restore", "exec"):
            name = arguments[-1]
            if not re.fullmatch(r"jetski-[a-f0-9-]{36}-g[1-9][0-9]{0,15}", name):
                raise ValueError("invalid_workload_cgroup_identity")
            # Root joins before dropping privileges: cgroupv2 migration requires
            # write permission at the common ancestor of source and target.
            # The workload runtime never receives that host-wide permission.
            return [
                "/opt/jetski/gvisor_cgroup.py",
                str(cgroup_parent(self.account) / name),
                *prefix,
                *arguments,
            ]
        return prefix + arguments

    def run(self, arguments):
        return bounded_command(self.argv(arguments), CONTROL_ROOT, timeout=120)

    def bundle(self, lease):
        return str(self.root / "bundles" / container_name(lease))

    def config(self, lease):
        private_directory(self.bundle(lease), self.account)
        return read_json(pathlib.Path(self.bundle(lease)) / "config.json", self.account.pw_uid)

    def limits_path(self, lease):
        return cgroup_parent(self.account) / container_name(lease)

    def prepare_limits(self, lease, memory_mb, cpus):
        path = self.limits_path(lease)
        if os.path.lexists(path):
            raise ValueError("workload_cgroup_already_admitted")
        path.mkdir(mode=0o755)
        path.chmod(0o755)
        (path / "memory.max").write_text(str(memory_mb * 1024**2))
        (path / "memory.swap.max").write_text("0")
        (path / "cpu.max").write_text(f"{cpus * 100000} 100000")
        (path / "pids.max").write_text("256")

    def prepare(self, lease, image, memory_mb, cpus):
        if image not in self.images:
            raise ValueError("image_not_approved")
        rootfs = self.prepared["images"][image]
        expected = self.root / "images" / hashlib.sha256(image.encode()).hexdigest() / "rootfs"
        if rootfs != str(expected):
            raise ValueError("gvisor_prepared_image_identity_conflict")
        assignment = DATA_ROOT / lease["assignmentId"]
        parent = assignment.lstat()
        if not stat.S_ISDIR(parent.st_mode) or parent.st_uid != 0 or parent.st_mode & 0o022:
            raise ValueError("unsafe_gvisor_persistent_parent")
        for name in ("workspace", "home"):
            meta = (assignment / name).lstat()
            if (
                not stat.S_ISDIR(meta.st_mode)
                or meta.st_uid != self.ownership["workloadUid"]
                or meta.st_gid != self.ownership["workloadGid"]
            ):
                raise ValueError("gvisor_persistent_mapping_conflict")
        self.prepare_limits(lease, memory_mb, cpus)
        spec = sandbox_spec(
            lease,
            image,
            rootfs,
            str(assignment),
            str(self.limits_path(lease)).removeprefix("/sys/fs/cgroup"),
            memory_mb=memory_mb,
            cpus=cpus,
            init_argv=self.init_argv,
        )
        directory = pathlib.Path(self.bundle(lease))
        if os.path.lexists(directory):
            raise ValueError("gvisor_bundle_already_admitted")
        private_directory(directory, self.account, create=True)
        write_json(directory / "config.json", spec, self.account)

    def prepare_imported_parent_policy(self, lease):
        # Archive extraction owns its staging parent as the workload identity.
        # Only this outer traversal parent is promoted; declared persistent root
        # modes/owners/content remain covered by their already verified proof.
        assignment = DATA_ROOT / lease["assignmentId"]
        before = assignment.lstat()
        if (
            not stat.S_ISDIR(before.st_mode)
            or before.st_uid not in (0, self.ownership["workloadUid"])
            or before.st_gid not in (0, self.ownership["workloadGid"])
        ):
            raise ValueError("unsafe_gvisor_persistent_parent")
        fd = os.open(assignment, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try:
            meta = os.fstat(fd)
            if (meta.st_dev, meta.st_ino, meta.st_uid, meta.st_gid) != (
                before.st_dev,
                before.st_ino,
                before.st_uid,
                before.st_gid,
            ):
                raise ValueError("gvisor_persistent_parent_changed")
            os.fchown(fd, 0, 0)
            os.fchmod(fd, 0o711)
            os.fsync(fd)
        finally:
            os.close(fd)
        sync_dir(assignment.parent)

    def prepare_imported(self, lease, image, memory_mb, cpus):
        # This is a replayable data-only preparation BEFORE native restore intent.
        # The caller proves native absence and holds the closed host fence.
        self.prepare_imported_parent_policy(lease)
        limits = self.limits_path(lease)
        if limits.exists():
            if (
                limits.is_symlink()
                or not limits.is_dir()
                or (limits / "cgroup.procs").read_text().strip()
            ):
                raise ValueError("portable_preparation_has_processes")
            # Before native effects, a previous data-only attempt may have left
            # its empty cgroup. Kernel rmdir rejects processes/child cgroups;
            # never recursively remove or reuse an occupied resource boundary.
            limits.rmdir()
        directory = pathlib.Path(self.bundle(lease))
        if os.path.lexists(directory):
            private_directory(directory, self.account)
            if any(name != "config.json" for name in os.listdir(directory)):
                raise ValueError("unexpected_imported_bundle_member")
            config = directory / "config.json"
            if os.path.lexists(config):
                meta = config.lstat()
                if (
                    not stat.S_ISREG(meta.st_mode)
                    or meta.st_uid != self.account.pw_uid
                    or meta.st_nlink != 1
                ):
                    raise ValueError("unsafe_imported_bundle")
                config.unlink()
            directory.rmdir()
            sync_dir(directory.parent)
        self.prepare(lease, image, memory_mb, cpus)

    def prepare_imported_parent(self, lease, identifier):
        private_directory(
            pathlib.Path(self.memory_path(lease, identifier)).parent, self.account, create=True
        )

    def accept_imported_image(self, lease, identifier):
        root = pathlib.Path(self.memory_path(lease, identifier))
        count = 0

        def adopt(path, depth):
            nonlocal count
            count += 1
            meta = path.lstat()
            if count > 257 or depth > 5 or meta.st_uid not in (0, self.account.pw_uid):
                raise ValueError("unsafe_imported_memory_image")
            directory = stat.S_ISDIR(meta.st_mode)
            if not directory and (not stat.S_ISREG(meta.st_mode) or meta.st_nlink != 1):
                raise ValueError("unsafe_imported_memory_image")
            fd = os.open(
                path,
                os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | (os.O_DIRECTORY if directory else 0),
            )
            try:
                if (os.fstat(fd).st_ino, os.fstat(fd).st_dev) != (meta.st_ino, meta.st_dev):
                    raise ValueError("imported_memory_image_changed")
                if directory:
                    for child in sorted(path.iterdir()):
                        adopt(child, depth + 1)
                os.fchown(fd, self.account.pw_uid, self.account.pw_gid)
                os.fchmod(fd, 0o700 if directory else 0o600)
                os.fsync(fd)
            finally:
                os.close(fd)

        adopt(root, 0)
        normalize_permissions(root, owner_uid=self.account.pw_uid)
        sync_dir(root.parent)

    def verify_resources(self, lease, memory_mb, cpus):
        path = self.limits_path(lease)
        if not path.is_dir() or path.is_symlink():
            return False
        expected = {
            "memory.max": str(memory_mb * 1024**2),
            "cpu.max": f"{cpus * 100000} 100000",
            "pids.max": "256",
        }
        if any((path / name).read_text().strip() != value for name, value in expected.items()):
            return False
        observed = self.run(self.commands.command("state", lease))
        if observed["exitCode"] != 0:
            return False
        state = json.loads(observed["stdout"])
        pid = state.get("pid")
        if type(pid) is not int or pid <= 1:
            return False
        actual = pathlib.Path("/proc", str(pid), "cgroup").read_text().strip()
        return actual == "0::" + str(path).removeprefix("/sys/fs/cgroup")

    def compatibility(self, lease):
        cpu_features = sorted(
            set(
                line.strip()
                for line in pathlib.Path("/proc/cpuinfo").read_text().splitlines()
                if line.startswith(("flags", "Features"))
            )
        )
        return dict(
            runtimeSha256=ARCHIVE_SHA256,
            image=self.config(lease)["annotations"]["org.jetski.image"],
            configurationSha256=specification_sha256(
                {"oci": self.config(lease), "runtime": self.commands.prefix()}
            ),
            platform="systrap",
            kernelVersion=pathlib.Path("/proc/sys/kernel/osrelease").read_text().strip(),
            cpuFeaturesSha256=hashlib.sha256(json.dumps(cpu_features).encode()).hexdigest(),
        )

    def portable_compatibility(self, lease, identifier=None):
        from portable_memory_policy import configuration_sha256, cpu_features, native_abi_sha256

        spec = self.config(lease)
        image = spec["annotations"]["org.jetski.image"]
        if image not in self.images:
            raise ValueError("image_not_approved")
        expected = self.root / "images" / hashlib.sha256(image.encode()).hexdigest() / "rootfs"
        if self.prepared["images"].get(image) != str(expected):
            raise ValueError("gvisor_prepared_image_identity_conflict")
        arguments = self.commands.prefix() + ["cpu-features"]
        if identifier is not None:
            arguments = self.commands.prefix() + [
                "statefile",
                "--get",
                "cpu_features",
                str(pathlib.Path(self.memory_path(lease, identifier)) / "checkpoint.img"),
            ]
        result = self.run(arguments)
        if result["exitCode"] != 0:
            raise ValueError("portable_cpu_features_unconfirmed")
        features = cpu_features(sorted(result["stdout"].strip().split(",")))
        return dict(
            runtimeSha256=ARCHIVE_SHA256,
            hostAbiSha256=native_abi_sha256(),
            image=image,
            configurationSha256=configuration_sha256(
                spec,
                lease,
                image_root=str(expected),
                assignment=str(DATA_ROOT / lease["assignmentId"]),
                cgroup_path=str(self.limits_path(lease)).removeprefix("/sys/fs/cgroup"),
                runtime=self.commands.prefix(),
            ),
            platform="systrap",
            kernelVersion=pathlib.Path("/proc/sys/kernel/osrelease").read_text().strip(),
            cpuFeatures=features,
        )

    def memory_path(self, lease, identifier):
        return str(self.root / "memory" / container_name(lease) / checkpoint_id(identifier))

    def prepare_memory_path(self, lease, identifier):
        path = pathlib.Path(self.memory_path(lease, identifier))
        if os.path.lexists(path):
            raise ValueError("gvisor_memory_already_admitted")
        private_directory(path, self.account, create=True)
        sync_dir(path.parent)

    def memory_owner(self):
        return self.account.pw_uid

    def seal_permissions(self, lease, identifier):
        root = private_directory(self.memory_path(lease, identifier), self.account)
        normalize_permissions(root, owner_uid=self.account.pw_uid)

    def prepare_successor(self, previous, successor):
        old = self.config(previous)
        spec = copy.deepcopy(old)
        spec["annotations"]["org.jetski.generation"] = str(successor["generation"])
        spec["linux"]["cgroupsPath"] = str(self.limits_path(successor)).removeprefix(
            "/sys/fs/cgroup"
        )
        resources = spec["linux"]["resources"]
        self.prepare_limits(
            successor,
            resources["memory"]["limit"] // 1024**2,
            resources["cpu"]["quota"] // resources["cpu"]["period"],
        )
        directory = private_directory(self.bundle(successor), self.account, create=True)
        write_json(directory / "config.json", spec, self.account)

    def verify_successor(self, previous, successor):
        expected = copy.deepcopy(self.config(previous))
        expected["annotations"]["org.jetski.generation"] = str(successor["generation"])
        expected["linux"]["cgroupsPath"] = str(self.limits_path(successor)).removeprefix(
            "/sys/fs/cgroup"
        )
        if self.config(successor) != expected:
            return False
        resources = expected["linux"]["resources"]
        return self.verify_resources(
            successor,
            resources["memory"]["limit"] // 1024**2,
            resources["cpu"]["quota"] // resources["cpu"]["period"],
        )

    def cleanup(self, lease):
        # Native absence is established by RunscDriver before this method.
        # The controller has settled streams/output before lifecycle removal.
        from gvisor_exec import ExecApi

        api = ExecApi(self)
        container = container_name(lease)
        for entry in api.root.iterdir():
            if not entry.is_dir() or entry.is_symlink():
                raise ValueError("unsafe_exec_journal")
            with api.locked(entry.name) as journal:
                state = api.read(journal)
                if state["container"] != container:
                    continue
                runtime_path = self.root / "exec" / entry.name
                if runtime_path.exists():
                    private_directory(runtime_path, self.account)
                    shutil.rmtree(runtime_path)
                    sync_dir(runtime_path.parent)
            shutil.rmtree(entry)
            sync_dir(api.root)
        memory = self.root / "memory" / container
        if memory.exists():
            private_directory(memory, self.account)
            shutil.rmtree(memory)
            sync_dir(memory.parent)
        path = self.limits_path(lease)
        if path.exists():
            if (path / "cgroup.procs").read_text().strip():
                raise ValueError("gvisor_process_cleanup_unconfirmed")
            path.rmdir()
        directory = pathlib.Path(self.bundle(lease))
        if directory.exists():
            private_directory(directory, self.account)
            shutil.rmtree(directory)
            sync_dir(directory.parent)


def prepare_images(account, images, run):
    """Bootstrap before starting the API engine; no assigned host upgrades."""
    root = private_directory(pathlib.Path(account.pw_dir) / "gvisor", account, create=True)
    for name in ("state", "bundles", "memory", "images", "exec"):
        private_directory(root / name, account, create=True)
    proof = dict(version=1, archiveSha256=ARCHIVE_SHA256, images={})
    if os.path.lexists(IMAGE_PROOF):
        expected = {
            **proof,
            "images": {
                image: str(root / "images" / hashlib.sha256(image.encode()).hexdigest() / "rootfs")
                for image in images
            },
        }
        if read_json(IMAGE_PROOF, 0) != expected:
            raise ValueError("gvisor_image_policy_conflict")
        for image_root in expected["images"].values():
            private_directory(pathlib.Path(image_root).parent, account)
            if not stat.S_ISDIR(pathlib.Path(image_root).lstat().st_mode):
                raise ValueError("gvisor_prepared_image_unavailable")
        # A lost final bootstrap ACK observes its verified preparation proof;
        # it does not recopy an image or allocate a second physical host.
        prepare_delegation(account)
        return
    for image in images:
        key = hashlib.sha256(image.encode()).hexdigest()
        directory = private_directory(root / "images" / key, account, create=True)
        destination = directory / "rootfs"
        if os.path.lexists(destination):
            raise ValueError("gvisor_image_preparation_uncertain")
        mounted = run(["unshare", "podman", "image", "mount", image])
        source = pathlib.Path(mounted["stdout"].strip())
        storage = pathlib.Path(account.pw_dir) / ".local/share/containers/storage"
        if (
            mounted["exitCode"] != 0
            or not source.is_absolute()
            or ".." in source.parts
            or not source.is_relative_to(storage)
        ):
            raise ValueError("gvisor_image_mount_unconfirmed")
        copied = run(
            ["unshare", "/bin/cp", "-a", "--reflink=auto", "--", str(source), str(destination)]
        )
        if copied["exitCode"] != 0:
            raise ValueError("gvisor_image_copy_unconfirmed")
        # Create mount destinations as namespace-root, without following any
        # image-provided symlink through the host filesystem.
        prepared = run(
            [
                "unshare",
                "/usr/bin/python3",
                "-I",
                "/opt/jetski/gvisor_rootfs.py",
                str(destination),
            ]
        )
        if prepared["exitCode"] != 0:
            raise ValueError("gvisor_mountpoint_preparation_failed")
        proof["images"][image] = str(destination)
    # Proof is root-owned and private, not workload data. Only bootstrap writes it.
    fd, temporary = tempfile.mkstemp(prefix=".gvisor-images-", dir=IMAGE_PROOF.parent)
    try:
        with os.fdopen(fd, "w") as output:
            json.dump(proof, output, sort_keys=True)
            output.flush()
            os.fsync(output.fileno())
        os.link(temporary, IMAGE_PROOF, follow_symlinks=False)
        sync_dir(IMAGE_PROOF.parent)
    finally:
        os.unlink(temporary)
    prepare_delegation(account)
