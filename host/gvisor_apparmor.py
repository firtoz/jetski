"""Scoped namespace permission for the trusted launcher on restricted hosts.

Never disables AppArmor or changes a kernel sysctl. Unix privilege checks, mapped
subordinate identities, namespaces, cgroups and gVisor continue to enforce isolation.
"""

import os
import pathlib
import shutil
import stat
import subprocess

from archive import sync_dir

POLICY = b"""abi <abi/4.0>,
include <tunables/global>
profile jetski-native-namespace /opt/jetski/gvisor_cgroup.py flags=(unconfined) {
  userns,
}
"""
RESTRICTION = pathlib.Path("/proc/sys/kernel/apparmor_restrict_unprivileged_userns")
PROFILE = pathlib.Path("/etc/apparmor.d/jetski-native-namespace")


def configure():
    if os.geteuid() != 0:
        raise ValueError("root_namespace_policy_required")
    if not RESTRICTION.exists() or RESTRICTION.read_text().strip() == "0":
        return "not-required"
    if RESTRICTION.read_text().strip() != "1":
        raise ValueError("unknown_namespace_restriction")
    parser = shutil.which("apparmor_parser", path="/usr/sbin:/usr/bin:/sbin:/bin")
    if parser is None:
        raise ValueError("scoped_namespace_policy_loader_unavailable")
    parent = PROFILE.parent.lstat()
    if not stat.S_ISDIR(parent.st_mode) or parent.st_uid != 0 or parent.st_mode & 0o022:
        raise ValueError("unsafe_namespace_policy_directory")
    if os.path.lexists(PROFILE):
        fd = os.open(PROFILE, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        with os.fdopen(fd, "rb") as source:
            meta = os.fstat(source.fileno())
            if (
                not stat.S_ISREG(meta.st_mode)
                or meta.st_uid != 0
                or meta.st_mode & 0o022
                or source.read(len(POLICY) + 1) != POLICY
            ):
                raise ValueError("namespace_policy_conflict")
    else:
        fd = os.open(PROFILE, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o644)
        with os.fdopen(fd, "wb") as output:
            os.fchmod(output.fileno(), 0o644)
            output.write(POLICY)
            output.flush()
            os.fsync(output.fileno())
        sync_dir(PROFILE.parent)
    result = subprocess.run([parser, "--replace", str(PROFILE)], capture_output=True, timeout=20)
    if result.returncode:
        raise ValueError("scoped_namespace_policy_load_failed")
    return "loaded"
