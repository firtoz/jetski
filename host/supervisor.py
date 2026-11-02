"""Privileged host plumbing. Keep outside containers and writable workload paths."""

import json
import math
import os
import pathlib
import platform
import pwd
import signal
import shutil
import stat
import subprocess
import tempfile
import time

CONFIG_PATH = pathlib.Path("/etc/jetski/host.json")
CONTROL_ROOT = pathlib.Path("/var/lib/jetski/control")
DATA_ROOT = pathlib.Path("/var/lib/jetski/data")
ARCHIVE_ROOT = pathlib.Path("/var/lib/jetski/archives")
ACCOUNT = "jetski-runtime"
MAX_OUTPUT = 2 * 1024 * 1024


def private_root(path, mode=0o700):
    path = pathlib.Path(path)
    for parent in [*reversed(path.parents), path]:
        info = parent.lstat()
        if not stat.S_ISDIR(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o022:
            raise ValueError("unsafe_supervisor_path")
    if stat.S_IMODE(path.stat().st_mode) != mode:
        raise ValueError("unsafe_supervisor_mode")
    return path


def configuration():
    if os.geteuid() != 0:
        raise ValueError("root_supervisor_required")
    private_root(CONFIG_PATH.parent)
    meta = CONFIG_PATH.lstat()
    if not stat.S_ISREG(meta.st_mode) or meta.st_uid != 0 or stat.S_IMODE(meta.st_mode) != 0o600:
        raise ValueError("unsafe_host_configuration")
    if meta.st_size > 65536:
        raise ValueError("host_configuration_limit")
    config = json.loads(CONFIG_PATH.read_text())
    if (
        set(config) - {"networkMode", "storageMode"} != {"version", "machineId", "poolId", "images"}
        or config["version"] != 1
    ):
        raise ValueError("unsupported_host_configuration")
    if config.get("storageMode", "default") not in ("default", "fuse-overlayfs"):
        raise ValueError("invalid_storage_policy")
    if config.get("networkMode", "none") not in ("none", "egress"):
        raise ValueError("invalid_network_policy")
    if not isinstance(config["images"], list) or not 1 <= len(config["images"]) <= 32:
        raise ValueError("invalid_image_policy")
    private_root(CONTROL_ROOT)
    private_root(ARCHIVE_ROOT)
    private_root(DATA_ROOT, 0o711)
    return config


def runtime_account():
    account = pwd.getpwnam(ACCOUNT)
    if (
        account.pw_uid < 1000
        or account.pw_gid <= 0
        or account.pw_dir != "/var/lib/jetski-runtime"
        or account.pw_shell != "/usr/sbin/nologin"
    ):
        raise ValueError("invalid_runtime_account")
    return account


def runtime_argv(account):
    runuser = shutil.which("runuser", path="/usr/sbin:/usr/bin:/sbin:/bin")
    if runuser is None:
        raise ValueError("runuser_unavailable")
    return [
        runuser,
        "-u",
        ACCOUNT,
        "--",
        "env",
        "-i",
        "HOME=" + account.pw_dir,
        "USER=" + ACCOUNT,
        "LOGNAME=" + ACCOUNT,
        "PATH=/usr/local/bin:/usr/bin:/bin",
        "XDG_RUNTIME_DIR=/run/user/" + str(account.pw_uid),
        "DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/" + str(account.pw_uid) + "/bus",
        "podman",
    ]


def runtime_control_argv(account):
    """Use the private running engine for lifecycle control after bootstrap.

    Local engine initialization can contend with a long-lived API service's
    storage state. Bootstrap still uses local commands before starting the
    service; assigned workloads share the same engine as execution sessions.
    Validate the private socket before handing it to the rootless client.
    """
    from podman_exec import ExecApi

    connection = ExecApi(account.pw_uid).connection()
    connection.close()
    return runtime_argv(account) + [
        "--remote",
        "--url=unix:///run/user/" + str(account.pw_uid) + "/podman/podman.sock",
    ]


def bounded_command(argv, root, timeout=120, max_output=MAX_OUTPUT):
    if not isinstance(timeout, (int, float)) or not math.isfinite(timeout) or timeout <= 0:
        raise ValueError("invalid_host_command_timeout")
    watchdog = shutil.which("timeout", path="/usr/bin:/bin")
    if watchdog is None:
        raise ValueError("host_command_watchdog_unavailable")
    # The control process may be killed by its transport before our finally block.
    # GNU timeout owns the same process group and enforces the deadline independently.
    # SIGKILL also removes descendants that ignore termination; never use --foreground.
    with tempfile.TemporaryFile(dir=root) as out, tempfile.TemporaryFile(dir=root) as err:
        proc = subprocess.Popen(
            [watchdog, "--signal=KILL", "--", str(timeout) + "s", *argv],
            stdin=subprocess.DEVNULL,
            stdout=out,
            stderr=err,
            start_new_session=True,
            cwd="/",
            env={"PATH": "/usr/bin:/bin", "LANG": "C.UTF-8"},
        )
        try:
            deadline = time.monotonic() + timeout
            while proc.poll() is None:
                if time.monotonic() > deadline:
                    raise TimeoutError("host_command_timeout")
                if (
                    os.fstat(out.fileno()).st_size > max_output
                    or os.fstat(err.fileno()).st_size > max_output
                ):
                    raise ValueError("host_command_output_limit")
                time.sleep(0.01)
        finally:
            if proc.poll() is None:
                try:
                    os.killpg(proc.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
                proc.wait(timeout=10)
        if proc.returncode == -signal.SIGKILL and time.monotonic() >= deadline:
            raise TimeoutError("host_command_timeout")
        out.seek(0)
        err.seek(0)
        stdout, stderr = out.read(max_output + 1), err.read(max_output + 1)
        if max(len(stdout), len(stderr)) > max_output:
            raise ValueError("host_command_output_limit")
        return dict(
            exitCode=proc.returncode,
            stdout=stdout.decode("utf8", errors="replace"),
            stderr=stderr.decode("utf8", errors="replace"),
        )


def preflight(config, account, run, backend=None):
    if platform.system() != "Linux" or platform.machine() != "x86_64":
        raise ValueError("unsupported_host_platform")
    if not pathlib.Path("/sys/fs/cgroup/cgroup.controllers").is_file():
        raise ValueError("cgroup_v2_required")
    for path in ("/etc/subuid", "/etc/subgid"):
        ranges = [line.split(":") for line in pathlib.Path(path).read_text().splitlines()]
        if not any(
            len(parts) == 3
            and parts[0] in (ACCOUNT, str(account.pw_uid))
            and int(parts[2]) >= 65536
            for parts in ranges
        ):
            raise ValueError("subordinate_ids_required")
    for namespace in ("user", "mnt", "pid", "net"):
        if not pathlib.Path("/proc/self/ns", namespace).exists():
            raise ValueError("required_namespace_unavailable")
    if backend is None:
        from runtime_backend import DEFAULT_BACKEND

        backend = DEFAULT_BACKEND
    details = backend.probe(run)
    if not isinstance(details, dict) or set(details) & {
        "ready",
        "version",
        "machineId",
        "poolId",
        "architecture",
        "rootless",
        "networkMode",
    }:
        raise ValueError("runtime_probe_authority_conflict")
    if config.get("storageMode", "default") == "fuse-overlayfs" and (
        details.get("storageDriver") != "overlay"
        or details.get("storageMountProgram") != "/usr/bin/fuse-overlayfs"
    ):
        raise ValueError("requested_storage_mode_unavailable")
    return dict(
        ready=True,
        version=1,
        machineId=config["machineId"],
        poolId=config["poolId"],
        architecture="x86_64",
        rootless=True,
        networkMode=config.get("networkMode", "none"),
        **details,
    )
