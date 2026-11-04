"""Install on an explicitly adopted disposable/dedicated Linux host, as root.

Requires Podman, uidmap, runuser, useradd, loginctl and a running systemd user
manager. Does not install system packages, change firewall policy or fetch scripts.
The JSON config is supplied by the operator; images must be approved OCI digests.
"""

import argparse
import json
import os
import pathlib
import pwd
import re
import shutil
import stat
import subprocess
from supervisor import (
    ACCOUNT,
    CONFIG_PATH,
    CONTROL_ROOT,
    DATA_ROOT,
    ARCHIVE_ROOT,
    runtime_account,
    runtime_argv,
    preflight,
    bounded_command,
)

from runtime_backend import (
    DEFAULT_BACKEND,
    PREPARED_USER_NAMESPACE,
    write_workload_identity,
    runtime_policy,
    workload_init,
)

MODULES = (
    "archive.py",
    "frames.py",
    "timing.py",
    "fence.py",
    "runtime.py",
    "runtime_backend.py",
    "network_namespace.py",
    "network_policy.py",
    "gvisor_environment.py",
    "gvisor_exec.py",
    "gvisor_install.py",
    "gvisor_lifecycle.py",
    "gvisor_memory.py",
    "memory_filesystem.py",
    "memory_control.py",
    "memory_chunks.py",
    "portable_memory_policy.py",
    "portable_memory_export.py",
    "portable_memory_files.py",
    "portable_memory_import.py",
    "portable_memory_format.py",
    "gvisor_native.py",
    "gvisor_oci.py",
    "gvisor_rootfs.py",
    "gvisor_cgroup.py",
    "gvisor_apparmor.py",
    "supervisor.py",
    "control.py",
    "commands.py",
    "terminal_input.py",
    "streams.py",
    "stream_protocol.py",
    "stream_broker.py",
    "podman_exec.py",
    "files.py",
    "file_upload.py",
    "import_checkpoint.py",
    "local_checkpoint.py",
    "checkpoint_export.py",
)


STORAGE_CONFIG = '[storage]\ndriver = "overlay"\n[storage.options.overlay]\nmount_program = "/usr/bin/fuse-overlayfs"\n'


def configure_storage(account, mode):
    """Fresh dedicated account only; never migrate or erase a runtime store."""
    if mode == "default":
        return
    if mode != "fuse-overlayfs":
        raise ValueError("invalid_storage_policy")
    home = pathlib.Path(account.pw_dir)
    directory = home / ".config" / "containers"
    for path in (home, home / ".config", directory):
        if not os.path.lexists(path):
            path.mkdir(mode=0o700)
            os.chown(path, account.pw_uid, account.pw_gid)
        meta = path.lstat()
        if (
            not stat.S_ISDIR(meta.st_mode)
            or meta.st_uid not in (0, account.pw_uid)
            or meta.st_mode & 0o022
        ):
            raise ValueError("unsafe_runtime_storage_path")
    target = directory / "storage.conf"
    if os.path.lexists(target):
        meta = target.lstat()
        if (
            not stat.S_ISREG(meta.st_mode)
            or meta.st_uid not in (0, account.pw_uid)
            or meta.st_mode & 0o022
        ):
            raise ValueError("unsafe_runtime_storage_config")
        if target.read_text() != STORAGE_CONFIG:
            raise ValueError("runtime_storage_configuration_conflict")
        return
    # Even an empty existing store may have selected another driver previously.
    if os.path.lexists(home / ".local/share/containers/storage"):
        raise ValueError("runtime_storage_requires_fresh_store")
    fd = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, "w") as output:
        output.write(STORAGE_CONFIG)
        os.fchown(output.fileno(), account.pw_uid, account.pw_gid)
        output.flush()
        os.fsync(output.fileno())
    fd = os.open(directory, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def bootstrap(config):
    if os.geteuid() != 0:
        raise ValueError("root_required")
    if (
        set(config)
        - {"networkMode", "storageMode", "archiveTransferUser", "runtime", "workloadInit"}
        != {"version", "machineId", "poolId", "images"}
        or config["version"] != 1
    ):
        raise ValueError("invalid_host_configuration")
    policy = runtime_policy(config)
    workload_init(config)
    if "archiveTransferUser" in config:
        name = config["archiveTransferUser"]
        if not isinstance(name, str) or not re.fullmatch(r"[a-z_][a-z0-9_-]{0,31}", name):
            raise ValueError("invalid_archive_reader")
        reader = pwd.getpwnam(name)
        if min(reader.pw_uid, reader.pw_gid) <= 0:
            raise ValueError("invalid_archive_reader")
    for name in ("machineId", "poolId"):
        if not isinstance(config[name], str) or not re.fullmatch(
            r"[a-zA-Z0-9_-]{1,128}", config[name]
        ):
            raise ValueError("invalid_host_identity")
    if config.get("storageMode", "default") not in ("default", "fuse-overlayfs"):
        raise ValueError("invalid_storage_policy")
    if config.get("networkMode", "none") not in ("none", "egress", "public-egress"):
        raise ValueError("invalid_network_policy")
    if not isinstance(config["images"], list) or not 1 <= len(config["images"]) <= 32:
        raise ValueError("invalid_image_policy")
    for image in config["images"]:
        if not isinstance(image, str) or not re.fullmatch(
            r"[a-zA-Z0-9][a-zA-Z0-9._:/-]*@sha256:[a-f0-9]{64}", image
        ):
            raise ValueError("digest_pinned_image_required")
    for tool in (
        "podman",
        "newuidmap",
        "newgidmap",
        "runuser",
        "useradd",
        "loginctl",
        "systemctl",
        "timeout",
    ):
        if shutil.which(tool) is None:
            raise ValueError("missing_prerequisite:" + tool)
    if config.get("networkMode", "none") == "egress" and shutil.which("slirp4netns") is None:
        raise ValueError("missing_prerequisite:slirp4netns")
    if (CONTROL_ROOT / "slot" / "state.json").exists():
        raise ValueError("existing_host_assignment_requires_managed_upgrade")
    for path in (
        pathlib.Path("/opt/jetski"),
        CONFIG_PATH.parent,
        pathlib.Path("/var/lib/jetski"),
        CONTROL_ROOT,
        ARCHIVE_ROOT,
        DATA_ROOT,
        pathlib.Path("/opt/jetski/host"),
    ):
        for parent in [*reversed(path.parents), path]:
            if not os.path.lexists(parent):
                continue
            meta = parent.lstat()
            if not stat.S_ISDIR(meta.st_mode) or meta.st_uid != 0 or meta.st_mode & 0o022:
                raise ValueError("unsafe_install_path:" + str(parent))
        path.mkdir(parents=True, exist_ok=True, mode=0o700)
        if path.stat().st_uid != 0:
            raise ValueError("unsafe_install_owner")
        mode = 0o700
        if path == pathlib.Path("/opt/jetski"):
            mode = 0o755
        if path in (DATA_ROOT, pathlib.Path("/var/lib/jetski")):
            mode = 0o711
        os.chmod(path, mode)
    try:
        pwd.getpwnam(ACCOUNT)
    except KeyError:
        subprocess.run(
            [
                "useradd",
                "--create-home",
                "--home-dir",
                "/var/lib/jetski-runtime",
                "--shell",
                "/usr/sbin/nologin",
                ACCOUNT,
            ],
            check=True,
        )
    account = runtime_account()
    if config.get("networkMode") == "public-egress":
        for tool in ("pasta", "nft", "nsenter", "ip"):
            if shutil.which(tool) is None:
                raise ValueError("missing_public_network_prerequisite:" + tool)
        if not pathlib.Path("/dev/net/tun").is_char_device():
            raise ValueError("network_tun_unavailable")
    if config.get("storageMode", "default") == "fuse-overlayfs":
        if (
            not os.access("/usr/bin/fuse-overlayfs", os.X_OK)
            or not pathlib.Path("/dev/fuse").is_char_device()
        ):
            raise ValueError("fuse_overlay_prerequisite_unavailable")
    configure_storage(account, config.get("storageMode", "default"))
    subprocess.run(["loginctl", "enable-linger", ACCOUNT], check=True)
    subprocess.run(["systemctl", "start", f"user@{account.pw_uid}.service"], check=True)

    def run(args):
        return bounded_command(runtime_argv(account) + args, CONTROL_ROOT, timeout=600)

    if policy["kind"] == "gvisor":
        from gvisor_install import install

        install()
    proof = preflight(config, account, run)
    write_workload_identity(account, proof)
    for image in config["images"]:
        result = run(["pull", image])
        if result["exitCode"]:
            raise RuntimeError("approved_image_pull_failed")
        DEFAULT_BACKEND.prepare_image(
            run, image, PREPARED_USER_NAMESPACE, proof["uidMappings"], proof["gidMappings"]
        )
    source = pathlib.Path(__file__).resolve().parent
    if policy["kind"] == "gvisor":
        from gvisor_environment import prepare_images

        for helper in ("gvisor_rootfs.py", "gvisor_cgroup.py"):
            entry = pathlib.Path("/opt/jetski") / helper
            if entry.is_symlink():
                raise ValueError("unsafe_gvisor_helper_entry")
            with open(source / helper, "rb") as input_file, open(entry, "wb") as output:
                shutil.copyfileobj(input_file, output)
                os.fchmod(output.fileno(), 0o755 if helper == "gvisor_cgroup.py" else 0o644)
                output.flush()
                os.fsync(output.fileno())
        from gvisor_apparmor import configure as configure_namespace_policy

        configure_namespace_policy()
        prepare_images(account, config["images"], run)
    binaries = ["command-supervisor", "tcp-relay"]
    if config.get("networkMode") == "public-egress":
        binaries.append("network-keeper")
    for name in binaries:
        native = source / "native" / f"{name}.c"
        if not native.exists():
            native = source / f"{name}.c"
        target_binary = pathlib.Path(f"/opt/jetski/{name}")
        pending_binary = pathlib.Path(f"/opt/jetski/{name}.pending")
        if target_binary.is_symlink() or pending_binary.is_symlink():
            raise ValueError("unsafe_supervisor_binary")
        compiled = bounded_command(
            [
                "/usr/bin/cc",
                "-static",
                "-O2",
                "-Wall",
                "-Wextra",
                "-Werror",
                str(native),
                "-o",
                str(pending_binary),
            ],
            CONTROL_ROOT,
            timeout=120,
        )
        if compiled["exitCode"]:
            raise ValueError("supervisor_build_failed")
        os.chmod(pending_binary, 0o755)
        with open(pending_binary, "rb") as binary:
            os.fsync(binary.fileno())
        os.replace(pending_binary, target_binary)
        fd = os.open(target_binary.parent, os.O_RDONLY | os.O_DIRECTORY)
        os.fsync(fd)
        os.close(fd)
    if config.get("networkMode") == "public-egress":
        from network_namespace import prepare_image

        prepare_image(
            account,
            run,
            lambda data: bounded_command(
                runtime_argv(account) + ["import", "-"],
                CONTROL_ROOT,
                timeout=60,
                max_output=4096,
                stdin_bytes=data,
            ),
        )
    # Dedicated account only: do not inherit another login's runtime directory
    # from the systemd user manager. Never change the host-wide Podman unit.
    dropin = pathlib.Path(account.pw_dir) / ".config/systemd/user/podman.service.d"
    for parent in [pathlib.Path(account.pw_dir), *list(dropin.parents)[:3][::-1], dropin]:
        if parent.exists():
            meta = parent.lstat()
            if not stat.S_ISDIR(meta.st_mode) or meta.st_uid not in (0, account.pw_uid):
                raise ValueError("unsafe_runtime_unit_path")
        else:
            parent.mkdir(mode=0o755)
            os.chown(parent, account.pw_uid, account.pw_gid)
    unit = dropin / "10-jetski.conf"
    if unit.is_symlink():
        raise ValueError("unsafe_runtime_unit")
    entry = pathlib.Path("/opt/jetski/runtime_service.py")
    if entry.is_symlink():
        raise ValueError("unsafe_runtime_entry")
    with open(source / "runtime_service.py", "rb") as input_file, open(entry, "wb") as output:
        shutil.copyfileobj(input_file, output)
        os.fchmod(output.fileno(), 0o644)
        output.flush()
        os.fsync(output.fileno())
    unit.write_text(
        "[Service]\nExecStart=\nExecStart=/usr/bin/python3 -I /opt/jetski/runtime_service.py\n"
    )
    os.chmod(unit, 0o644)
    reload = bounded_command(
        runtime_argv(account)[:-1] + ["systemctl", "--user", "daemon-reload"],
        CONTROL_ROOT,
        timeout=30,
    )
    if reload["exitCode"]:
        raise ValueError("runtime_unit_reload_failed")
    socket_started = bounded_command(
        runtime_argv(account)[:-1] + ["systemctl", "--user", "enable", "--now", "podman.socket"],
        CONTROL_ROOT,
        timeout=30,
    )
    if socket_started["exitCode"]:
        raise ValueError("runtime_socket_unavailable")
    from podman_exec import ExecApi

    _, api_info = ExecApi(account.pw_uid).request("GET", "/info")
    if not isinstance(api_info, dict):
        raise ValueError("runtime_api_unavailable")
    for name in MODULES:
        target = pathlib.Path("/opt/jetski/host") / name
        if target.is_symlink():
            raise ValueError("unsafe_module_path")
        with open(source / name, "rb") as input_file, open(target, "wb") as output:
            shutil.copyfileobj(input_file, output)
            os.fchmod(output.fileno(), 0o600)
            output.flush()
            os.fsync(output.fileno())
    flags = os.O_WRONLY | os.O_CREAT | os.O_TRUNC | os.O_NOFOLLOW
    fd = os.open(CONFIG_PATH, flags, 0o600)
    with os.fdopen(fd, "w") as output:
        json.dump(config, output)
        os.fchmod(output.fileno(), 0o600)
        output.flush()
        os.fsync(output.fileno())
    print(json.dumps(proof))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", required=True)
    args = parser.parse_args()
    bootstrap(json.loads(pathlib.Path(args.config).read_text()))
