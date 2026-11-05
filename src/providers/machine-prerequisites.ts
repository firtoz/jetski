/** Owned Debian-based machine hosts only. Preserve already installed package versions. */
export const MACHINE_PREREQUISITES = `import shutil
import subprocess

base = ("runuser", "useradd", "loginctl", "systemctl", "dpkg-query", "apt-get")
if any(shutil.which(tool) is None for tool in base):
    raise RuntimeError("unsupported_boat_base_tools")

def compiler_ready():
    if shutil.which("cc") is None:
        return False
    return subprocess.run(
        ["cc", "-x", "c", "-fsyntax-only", "-"],
        input="#include <stdio.h>\\n#include <sys/socket.h>\\n#include <sys/prctl.h>\\nint main(void) { return 0; }\\n",
        capture_output=True, text=True,
    ).returncode == 0

wanted = ["podman", "uidmap", "slirp4netns", "fuse-overlayfs", "dbus-user-session"]
if not compiler_ready():
    wanted += ["gcc", "libc6-dev"]
query = subprocess.run(
    ["dpkg-query", "-W", "-f=\${Package}\\t\${db:Status-Status}\\n", *wanted],
    capture_output=True, text=True,
)
if query.returncode not in (0, 1):
    raise RuntimeError("prerequisite_package_query_failed")
installed = set()
for line in query.stdout.splitlines():
    name, status = line.split("\\t", 1)
    if name not in wanted:
        raise RuntimeError("unexpected_prerequisite_package")
    if status not in ("installed", "not-installed", "config-files", "unpacked", "half-configured", "half-installed", "triggers-awaited", "triggers-pending"):
        raise RuntimeError("ambiguous_prerequisite_package_status")
    if status == "installed":
        installed.add(name)
missing = [package for package in wanted if package not in installed]
if missing:
    subprocess.run(["apt-get", "update", "-qq"], check=True)
    subprocess.run(["apt-get", "install", "-y", "--no-install-recommends", *missing], check=True)
required = ("podman", "newuidmap", "newgidmap", "slirp4netns", "fuse-overlayfs", "dbus-run-session")
if any(shutil.which(tool) is None for tool in required) or not compiler_ready():
    raise RuntimeError("prerequisite_tools_unavailable")
`;

/** Optional packages only on newly allocated hosts using explicit public egress. */
export const MACHINE_PUBLIC_NETWORK_PREREQUISITES = `import shutil, subprocess
wanted = ["passt", "nftables", "iproute2"]
query = subprocess.run(["dpkg-query", "-W", "-f=\${Package}\\t\${db:Status-Status}\\n", *wanted], capture_output=True, text=True)
if query.returncode not in (0, 1): raise RuntimeError("network_package_query_failed")
installed = {line.split("\\t",1)[0] for line in query.stdout.splitlines() if line.endswith("\\tinstalled")}
missing = [name for name in wanted if name not in installed]
if missing:
 subprocess.run(["apt-get", "update", "-qq"], check=True)
 subprocess.run(["apt-get", "install", "-y", "--no-install-recommends", *missing], check=True)
if any(shutil.which(tool) is None for tool in ("pasta", "nft", "nsenter", "ip", "tc")): raise RuntimeError("public_network_prerequisite_unavailable")
`;
