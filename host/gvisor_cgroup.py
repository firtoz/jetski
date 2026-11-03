"""Enter a preconfigured delegated cgroup before executing trusted runtime argv.

Installed root-owned outside workloads; invoked by the root supervisor before
dropping to the runtime account and entering its user namespace. The supervisor creates and verifies limits independently.
"""

import os
import pathlib
import pwd
import re
import stat
import sys


def enter(path, argv):
    account = pwd.getpwnam("jetski-runtime")
    if (
        os.geteuid() != 0
        or account.pw_uid <= 0
        or len(argv) < 4
        or argv[0] not in ("/usr/sbin/runuser", "/usr/bin/runuser", "/sbin/runuser", "/bin/runuser")
        or argv[1:4] != ["-u", "jetski-runtime", "--"]
    ):
        raise ValueError("invalid_cgroup_launcher")
    path = pathlib.Path(path)
    parent = pathlib.Path(
        f"/sys/fs/cgroup/user.slice/user-{account.pw_uid}.slice/user@{account.pw_uid}.service/jetski-gvisor"
    )
    if path.parent != parent or not re.fullmatch(
        r"jetski-[a-f0-9-]{36}-g[1-9][0-9]{0,15}", path.name
    ):
        raise ValueError("invalid_cgroup_path")
    meta = path.lstat()
    if not stat.S_ISDIR(meta.st_mode) or meta.st_uid != 0 or meta.st_mode & 0o022:
        raise ValueError("unsafe_workload_cgroup")
    fd = os.open(path / "cgroup.procs", os.O_WRONLY | os.O_NOFOLLOW)
    try:
        os.write(fd, str(os.getpid()).encode())
    finally:
        os.close(fd)
    expected = "0::" + str(path).removeprefix("/sys/fs/cgroup")
    if pathlib.Path("/proc/self/cgroup").read_text().strip() != expected:
        raise ValueError("workload_cgroup_membership_unconfirmed")
    os.execvp(argv[0], argv)


if __name__ == "__main__":
    enter(sys.argv[1], sys.argv[2:])
