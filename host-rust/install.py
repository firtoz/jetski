"""Opt-in native artifact installation; never converts an existing Python host."""

import fcntl
import hashlib
import json
import os
import pathlib
import stat
import sys
import tempfile


class Installer:
    def __init__(self, root=pathlib.Path("/"), owner=0):
        self.root, self.owner = pathlib.Path(root), owner

    def path(self, name):
        return self.root / name.lstrip("/")

    def directory(self, name):
        path = self.path(name)
        relative = path.relative_to(self.root)
        current = self.root
        for part in relative.parts:
            current = current / part
            if not os.path.lexists(current):
                current.mkdir(mode=0o700)
            meta = current.lstat()
            if not stat.S_ISDIR(meta.st_mode) or meta.st_uid != self.owner or meta.st_mode & 0o022:
                raise ValueError("unsafe_native_install_directory")
        return path

    def sync(self, path):
        fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try:
            os.fsync(fd)
        finally:
            os.close(fd)

    def read(self, path):
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        with os.fdopen(fd, "rb") as source:
            meta = os.fstat(source.fileno())
            if (
                not stat.S_ISREG(meta.st_mode)
                or meta.st_uid != self.owner
                or meta.st_mode & 0o077
                or meta.st_nlink != 1
            ):
                raise ValueError("unsafe_native_install_record")
            raw = source.read(16385)
        if len(raw) > 16384:
            raise ValueError("native_record_bound")
        return json.loads(raw)

    def publish(self, path, data, mode=0o600):
        fd, pending = tempfile.mkstemp(prefix=".native-", dir=path.parent)
        try:
            with os.fdopen(fd, "wb") as output:
                output.write(data)
                output.flush()
                os.fchmod(output.fileno(), mode)
                os.fsync(output.fileno())
            # Native directory and destination are supervisor-private. The held
            # installation flock excludes every publisher; each caller checked
            # destination absence. Rename leaves no extra hardlink on crash.
            if os.path.lexists(path):
                raise ValueError("native_publication_conflict")
            os.rename(pending, path)
            self.sync(path.parent)
        finally:
            if os.path.lexists(pending):
                os.unlink(pending)
                self.sync(path.parent)

    def run(self, request):
        if set(request) != {"action", "identity"} or request["action"] not in (
            "prepare",
            "install",
        ):
            raise ValueError("invalid_native_install_request")
        identity = request["identity"]
        if (
            not isinstance(identity, dict)
            or set(identity) != {"version", "backend", "sha256", "bytes", "machineId", "poolId"}
            or identity["version"] != 1
            or identity["backend"] != "rust"
            or not isinstance(identity["sha256"], str)
            or len(identity["sha256"]) != 64
            or any(c not in "0123456789abcdef" for c in identity["sha256"])
            or type(identity["bytes"]) is not int
            or not 64 <= identity["bytes"] <= 6 * 1024**2
            or any(
                not isinstance(identity[k], str) or not 1 <= len(identity[k]) <= 160
                for k in ("machineId", "poolId")
            )
        ):
            raise ValueError("invalid_native_install_identity")
        directory = self.directory("/var/lib/jetski-native")
        lock_fd = os.open(directory / "lock", os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
        try:
            meta = os.fstat(lock_fd)
            if (
                not stat.S_ISREG(meta.st_mode)
                or meta.st_uid != self.owner
                or meta.st_mode & 0o077
                or meta.st_nlink != 1
            ):
                raise ValueError("unsafe_native_install_lock")
            fcntl.flock(lock_fd, fcntl.LOCK_EX)
            intent = directory / "intent.json"
            if os.path.lexists(intent):
                if self.read(intent) != identity:
                    raise ValueError("native_backend_identity_changed")
            else:
                # Intent must predate every possible base installation/assignment.
                if any(
                    os.path.lexists(self.path(p))
                    for p in (
                        "/etc/jetski/host.json",
                        "/opt/jetski",
                        "/var/lib/jetski-bootstrap/receipt.json",
                        "/var/lib/jetski/control/slot/state.json",
                    )
                ):
                    raise ValueError("existing_host_requires_replacement")
                self.publish(intent, json.dumps(identity, sort_keys=True).encode())
            if request["action"] == "prepare":
                return {**identity, "prepared": True}
            config = self.read(self.path("/etc/jetski/host.json"))
            bootstrap = self.read(self.path("/var/lib/jetski-bootstrap/receipt.json"))
            if (
                config.get("machineId") != identity["machineId"]
                or config.get("poolId") != identity["poolId"]
                or bootstrap.get("version") != 1
                or not isinstance(bootstrap.get("digest"), str)
                or len(bootstrap["digest"]) != 64
            ):
                raise ValueError("native_base_bootstrap_mismatch")
            # Fence::open deliberately never creates incoming request paths.
            # Prepare its one fixed host slot before publishing native readiness.
            slot = self.directory("/var/lib/jetski/control/slot")
            if stat.S_IMODE(slot.lstat().st_mode) != 0o700:
                raise ValueError("unsafe_native_slot_directory")
            self.sync(slot)
            self.sync(slot.parent)
            installed = self.directory("/opt/jetski/native") / "jetski-host"
            receipt = {**identity, "bootstrapDigest": bootstrap["digest"]}
            marker = self.path("/etc/jetski/native-host.json")
            if os.path.lexists(marker) and self.read(marker) != receipt:
                raise ValueError("native_install_receipt_changed")
            if not os.path.lexists(installed):
                source = self.path("/tmp/jetski-native-" + identity["sha256"] + ".bin")
                source_fd = os.open(source, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
                with os.fdopen(source_fd, "rb") as input_file:
                    before = os.fstat(input_file.fileno())
                    if not stat.S_ISREG(before.st_mode) or before.st_size != identity["bytes"]:
                        raise ValueError("native_artifact_extent")
                    binary = input_file.read(identity["bytes"] + 1)
                    after = os.fstat(input_file.fileno())
                    if (
                        before.st_mtime_ns != after.st_mtime_ns
                        or before.st_ctime_ns != after.st_ctime_ns
                        or before.st_size != after.st_size
                    ):
                        raise ValueError("native_artifact_changed")
                if (
                    len(binary) != identity["bytes"]
                    or binary[:6] != b"\x7fELF\x02\x01"
                    or binary[18:20] != b"\x3e\x00"
                    or hashlib.sha256(binary).hexdigest() != identity["sha256"]
                ):
                    raise ValueError("native_artifact_integrity")
                self.publish(installed, binary, 0o555)
            fd = os.open(installed, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
            with os.fdopen(fd, "rb") as source:
                meta = os.fstat(source.fileno())
                if (
                    not stat.S_ISREG(meta.st_mode)
                    or meta.st_uid != self.owner
                    or stat.S_IMODE(meta.st_mode) != 0o555
                    or meta.st_nlink != 1
                    or meta.st_size != identity["bytes"]
                    or hashlib.file_digest(source, "sha256").hexdigest() != identity["sha256"]
                ):
                    raise ValueError("native_installed_artifact_changed")
            if not os.path.lexists(marker):
                self.publish(marker, json.dumps(receipt, sort_keys=True).encode())
            return {**receipt, "ready": True}
        finally:
            os.close(lock_fd)


if __name__ == "__main__":
    if os.geteuid() != 0:
        raise ValueError("root_required")
    raw = sys.stdin.buffer.read(16385)
    if len(raw) > 16384:
        raise ValueError("native_request_bound")
    print(json.dumps(Installer().run(json.loads(raw))))
