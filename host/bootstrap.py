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

MODULES = ("archive.py", "frames.py", "fence.py", "runtime.py", "supervisor.py", "control.py")


def bootstrap(config):
    if os.geteuid() != 0:
        raise ValueError("root_required")
    if set(config) != {"version", "machineId", "poolId", "images"} or config["version"] != 1:
        raise ValueError("invalid_host_configuration")
    for name in ("machineId", "poolId"):
        if not isinstance(config[name], str) or not re.fullmatch(
            r"[a-zA-Z0-9_-]{1,128}", config[name]
        ):
            raise ValueError("invalid_host_identity")
    if not isinstance(config["images"], list) or not 1 <= len(config["images"]) <= 32:
        raise ValueError("invalid_image_policy")
    for image in config["images"]:
        if not isinstance(image, str) or not re.fullmatch(
            r"[a-zA-Z0-9][a-zA-Z0-9._:/-]*@sha256:[a-f0-9]{64}", image
        ):
            raise ValueError("digest_pinned_image_required")
    for tool in ("podman", "newuidmap", "newgidmap", "runuser", "useradd", "loginctl", "systemctl"):
        if shutil.which(tool) is None:
            raise ValueError("missing_prerequisite:" + tool)
    if (CONTROL_ROOT / "slot" / "state.json").exists():
        raise ValueError("existing_host_assignment_requires_managed_upgrade")
    for path in (
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
                raise ValueError("unsafe_install_path")
        path.mkdir(parents=True, exist_ok=True, mode=0o700)
        if path.stat().st_uid != 0:
            raise ValueError("unsafe_install_owner")
        mode = 0o700
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
    subprocess.run(["loginctl", "enable-linger", ACCOUNT], check=True)
    subprocess.run(["systemctl", "start", f"user@{account.pw_uid}.service"], check=True)

    def run(args):
        return bounded_command(runtime_argv(account) + args, CONTROL_ROOT, timeout=600)

    proof = preflight(config, account, run)
    for image in config["images"]:
        result = run(["pull", image])
        if result["exitCode"]:
            raise RuntimeError("approved_image_pull_failed")
    source = pathlib.Path(__file__).resolve().parent
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
