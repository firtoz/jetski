"""Dedicated rootless API entry point with an allowlisted environment."""

import os
import pwd


def service_environment(account, inherited):
    if account.pw_uid < 1000 or account.pw_name != "jetski-runtime":
        raise ValueError("dedicated_runtime_account_required")
    if account.pw_dir != "/var/lib/jetski-runtime":
        raise ValueError("dedicated_runtime_home_required")
    result = {
        "HOME": account.pw_dir,
        "USER": account.pw_name,
        "LOGNAME": account.pw_name,
        "PATH": "/usr/bin:/bin",
        "LANG": "C.UTF-8",
        "XDG_RUNTIME_DIR": f"/run/user/{account.pw_uid}",
        "DBUS_SESSION_BUS_ADDRESS": f"unix:path=/run/user/{account.pw_uid}/bus",
    }
    # execve keeps the PID, so socket activation retains its original identity.
    for key in ("LISTEN_PID", "LISTEN_FDS", "LISTEN_FDNAMES", "NOTIFY_SOCKET"):
        if key in inherited:
            result[key] = inherited[key]
    return result


if __name__ == "__main__":
    environment = service_environment(pwd.getpwuid(os.getuid()), os.environ)
    os.execve("/usr/bin/podman", ["podman", "system", "service", "--time=0"], environment)
