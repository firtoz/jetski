"""Trusted OCI configuration and runsc commands; no workload-selected host flags.

Caller-managed user namespaces and delegated cgroups are prerequisites. In
particular, this deliberately does not use runsc's restricted --rootless mode,
which does not implement memory checkpoint/restore. Host bootstrap must prove the
actual namespace/mapping/cgroup capabilities before exposing this composition.
"""

import hashlib
import json
import pathlib
import re

from fence import identity
from runtime_backend import DEFAULT_INIT_ARGV, workload_init

RELEASE = "release-20261102.0"
ARCHIVE_NAME = "gvisor-x86_64.tar.bz2"
ARCHIVE_SHA256 = "6f6b1a8f0f4665a403238135167d0d990bfaeaff5544abf68f5e0d822b35484a"
ARCHIVE_URL = f"https://github.com/google/gvisor/releases/download/{RELEASE}/{ARCHIVE_NAME}"
PROCESS_ENV = (
    "PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
    "HOME=/home/sandbox",
    "LANG=C.UTF-8",
)
CONTAINER_PATTERN = r"jetski-[a-f0-9-]{36}-g[1-9][0-9]{0,15}"


def absolute_path(value):
    if not isinstance(value, str) or not value.startswith("/") or "\0" in value:
        raise ValueError("invalid_runtime_path")
    path = pathlib.PurePosixPath(value)
    if ".." in path.parts or str(path) != value:
        raise ValueError("invalid_runtime_path")
    return value


def container_name(raw):
    lease = identity(raw)
    return f"jetski-{lease['assignmentId']}-g{lease['generation']}"


def process_spec(argv, cwd="/workspace", terminal=False):
    if (
        not isinstance(argv, list)
        or not 1 <= len(argv) <= 256
        or any(not isinstance(arg, str) or "\0" in arg or len(arg.encode()) > 65536 for arg in argv)
        or not argv[0]
        or sum(len(arg.encode()) + 1 for arg in argv) > 128 * 1024
        or type(terminal) is not bool
    ):
        raise ValueError("invalid_runtime_process")
    cwd = absolute_path(cwd)
    if not any(
        cwd == root or cwd.startswith(root + "/") for root in ("/workspace", "/home/sandbox")
    ):
        raise ValueError("unsupported_workload_directory")
    return dict(
        terminal=terminal,
        user=dict(uid=1000, gid=1000, additionalGids=[]),
        args=list(argv),
        env=list(PROCESS_ENV),
        cwd=cwd,
        noNewPrivileges=True,
        capabilities=dict(bounding=[], effective=[], inheritable=[], permitted=[], ambient=[]),
        rlimits=[dict(type="RLIMIT_NOFILE", hard=4096, soft=4096)],
    )


def sandbox_spec(
    raw,
    image,
    rootfs,
    assignment,
    cgroup_path,
    *,
    memory_mb=512,
    cpus=1,
    supervisor="/opt/jetski/command-supervisor",
    relay="/opt/jetski/tcp-relay",
    init_argv=None,
):
    """Build a fixed policy. rootfs/assignment/cgroup come only from the host.

    No arbitrary annotations, OCI hooks, devices, environment, mounts, namespace
    paths, host networking or privileged options can enter from API requests.
    The caller must independently verify immutable prepared image identity,
    private writable roots, subordinate ownership and effective cgroup limits.
    """
    lease = identity(raw)
    if not isinstance(image, str) or not re.fullmatch(
        r"[a-zA-Z0-9][a-zA-Z0-9._:/-]*@sha256:[a-f0-9]{64}", image
    ):
        raise ValueError("digest_pinned_image_required")
    if type(memory_mb) is not int or not 128 <= memory_mb <= 65536:
        raise ValueError("invalid_memory_limit")
    if type(cpus) is not int or not 1 <= cpus <= 64:
        raise ValueError("invalid_cpu_limit")
    rootfs, assignment, cgroup_path = map(absolute_path, (rootfs, assignment, cgroup_path))
    mounts = [
        dict(
            destination="/proc", type="proc", source="proc", options=["nosuid", "noexec", "nodev"]
        ),
        dict(
            destination="/dev",
            type="tmpfs",
            source="tmpfs",
            options=["nosuid", "strictatime", "mode=755", "size=65536k"],
        ),
        dict(
            destination="/dev/pts",
            type="devpts",
            source="devpts",
            options=["nosuid", "noexec", "newinstance", "ptmxmode=0666", "mode=0620"],
        ),
        dict(
            destination="/sys",
            type="sysfs",
            source="sysfs",
            options=["nosuid", "noexec", "nodev", "ro"],
        ),
        dict(
            destination="/tmp",
            type="tmpfs",
            source="tmpfs",
            options=["nosuid", "nodev", "mode=1777", "size=128m"],
        ),
        dict(
            destination="/run",
            type="tmpfs",
            source="tmpfs",
            options=["nosuid", "nodev", "mode=755", "size=16m"],
        ),
    ]
    for source, destination in (("workspace", "/workspace"), ("home", "/home/sandbox")):
        mounts.append(
            dict(
                destination=destination,
                type="bind",
                source=f"{assignment}/{source}",
                options=["rbind", "rprivate", "nosuid", "nodev", "rw"],
            )
        )
    for source, destination in ((supervisor, "/jetski-supervisor"), (relay, "/jetski-tcp-relay")):
        mounts.append(
            dict(
                destination=destination,
                type="bind",
                source=absolute_path(source),
                options=["bind", "rprivate", "nosuid", "nodev", "ro"],
            )
        )
    devices = [
        dict(path="/dev/" + name, type="c", major=major, minor=minor, fileMode=0o666, uid=0, gid=0)
        for name, major, minor in (
            ("null", 1, 3),
            ("zero", 1, 5),
            ("full", 1, 7),
            ("random", 1, 8),
            ("urandom", 1, 9),
            ("tty", 5, 0),
        )
    ]
    return dict(
        ociVersion="1.0.2",
        hostname="sandbox",
        root=dict(path=rootfs, readonly=True),
        process=process_spec(workload_init({"workloadInit": init_argv}) or list(DEFAULT_INIT_ARGV)),
        mounts=mounts,
        annotations={
            "org.jetski.assignment": lease["assignmentId"],
            "org.jetski.generation": str(lease["generation"]),
            "org.jetski.image": image,
        },
        linux=dict(
            namespaces=[dict(type=kind) for kind in ("pid", "mount", "ipc", "uts", "network")],
            cgroupsPath=cgroup_path,
            devices=devices,
            resources=dict(
                memory=dict(limit=memory_mb * 1024**2),
                cpu=dict(quota=cpus * 100000, period=100000),
                pids=dict(limit=256),
            ),
            maskedPaths=[
                "/proc/acpi",
                "/proc/kcore",
                "/proc/keys",
                "/proc/timer_list",
                "/proc/scsi",
                "/sys/firmware",
            ],
            readonlyPaths=[
                "/proc/asound",
                "/proc/bus",
                "/proc/fs",
                "/proc/irq",
                "/proc/sys",
                "/proc/sysrq-trigger",
            ],
        ),
    )


def specification_sha256(spec):
    return hashlib.sha256(
        json.dumps(spec, sort_keys=True, separators=(",", ":")).encode()
    ).hexdigest()


class RunscCommands:
    """Argument construction only; the host supplies the rootless bounded runner.

    No shell strings. All flag operands precede a validated container identity;
    process argv travels in a separately persisted process.json, never as flags.
    """

    def __init__(self, binary, state_root):
        self.binary, self.root = absolute_path(binary), absolute_path(state_root)

    def prefix(self):
        return [
            self.binary,
            "--root=" + self.root,
            "--platform=systrap",
            "--rootless=false",
            "--network=sandbox",
            "--file-access=shared",
            "--overlay2=none",
            "--ignore-cgroups=true",
        ]

    def command(self, action, lease, *, bundle=None, image=None, process=None):
        name = container_name(lease)
        args = []
        if action == "run":
            args = ["run", "--detach", "--bundle=" + absolute_path(bundle), name]
        elif action in ("state", "delete"):
            args = [action, name]
        elif action == "kill":
            args = ["kill", "--all", name, "KILL"]
        elif action == "checkpoint":
            args = [
                "checkpoint",
                "--compression=none",
                "--image-path=" + absolute_path(image),
                name,
            ]
        elif action == "restore":
            args = [
                "restore",
                "--detach",
                "--background=false",
                "--bundle=" + absolute_path(bundle),
                "--image-path=" + absolute_path(image),
                name,
            ]
        elif action == "exec":
            args = ["exec", "--new-pidns", "--process=" + absolute_path(process), name]
        else:
            raise ValueError("unsupported_runsc_action")
        return self.prefix() + args
