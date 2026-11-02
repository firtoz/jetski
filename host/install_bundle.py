"""Root-only, repeatable bootstrap from a bounded, controller-verified bundle.

Never upgrades an assigned host. The immutable receipt binds code and policy;
replaying it only checks readiness. No provider credentials enter this bundle.
"""

import base64
import fcntl
import hashlib
import json
import os
import pathlib
import stat
import sys

ROOT = pathlib.Path("/var/lib/jetski-bootstrap")
MAX_BUNDLE = 1024 * 1024
MODULES = {
    "archive.py",
    "bootstrap.py",
    "commands.py",
    "terminal_input.py",
    "streams.py",
    "stream_protocol.py",
    "stream_broker.py",
    "podman_exec.py",
    "command-supervisor.c",
    "tcp-relay.c",
    "control.py",
    "fence.py",
    "file_upload.py",
    "files.py",
    "frames.py",
    "import_checkpoint.py",
    "local_checkpoint.py",
    "runtime.py",
    "runtime_backend.py",
    "runtime_service.py",
    "supervisor.py",
}


def private_directory(path):
    for parent in [*reversed(path.parents), path]:
        if not os.path.lexists(parent):
            parent.mkdir(mode=0o700)
        meta = parent.lstat()
        if not stat.S_ISDIR(meta.st_mode) or meta.st_uid != 0 or meta.st_mode & 0o022:
            raise ValueError("unsafe_bootstrap_path")


def write_file(path, data):
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, "wb") as output:
        os.fchmod(output.fileno(), 0o600)
        output.write(data)
        output.flush()
        os.fsync(output.fileno())


def install(data):
    if os.geteuid() != 0:
        raise ValueError("root_required")
    if len(data) > MAX_BUNDLE:
        raise ValueError("bundle_bound")
    bundle = json.loads(data)
    if set(bundle) != {"version", "config", "files"} or bundle["version"] != 1:
        raise ValueError("invalid_bundle")
    if not isinstance(bundle["files"], dict) or set(bundle["files"]) != MODULES:
        raise ValueError("invalid_bundle_modules")
    decoded = {}
    for name, encoded in bundle["files"].items():
        decoded[name] = base64.b64decode(encoded, validate=True)
        if not 0 < len(decoded[name]) <= 256 * 1024:
            raise ValueError("module_bound")
    digest = hashlib.sha256(data).hexdigest()
    private_directory(ROOT)
    lock = os.open(ROOT / "lock", os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    try:
        meta = os.fstat(lock)
        if not stat.S_ISREG(meta.st_mode) or meta.st_uid != 0 or meta.st_mode & 0o077:
            raise ValueError("unsafe_bootstrap_lock")
        fcntl.flock(lock, fcntl.LOCK_EX)
        receipt = ROOT / "receipt.json"
        prior = None
        if os.path.lexists(receipt):
            meta = receipt.lstat()
            if not stat.S_ISREG(meta.st_mode) or meta.st_uid != 0 or meta.st_mode & 0o077:
                raise ValueError("unsafe_bootstrap_receipt")
            prior = json.loads(receipt.read_text())
            if (
                set(prior) != {"version", "digest", "nativeSha256", "relaySha256"}
                or prior["version"] != 1
                or prior["digest"] != digest
            ):
                raise ValueError("bootstrap_identity_conflict")
        if prior is None and pathlib.Path("/etc/jetski/host.json").exists():
            if json.loads(pathlib.Path("/etc/jetski/host.json").read_text()) != bundle["config"]:
                raise ValueError("existing_host_configuration_conflict")
        source = ROOT / digest
        private_directory(source)
        if prior is None:
            # A failed installation may be retried only while unassigned.
            if pathlib.Path("/var/lib/jetski/control/slot/state.json").exists():
                raise ValueError("existing_assignment_requires_managed_upgrade")
            for name, content in decoded.items():
                write_file(source / name, content)
        else:
            for name, content in decoded.items():
                path = source / name
                meta = path.lstat()
                if not stat.S_ISREG(meta.st_mode) or meta.st_uid != 0 or meta.st_mode & 0o077:
                    raise ValueError("unsafe_bootstrap_module")
                if path.read_bytes() != content:
                    raise ValueError("bootstrap_source_corrupt")
        sys.path.insert(0, str(source))
        from bootstrap import bootstrap
        from supervisor import (
            configuration,
            preflight,
            runtime_account,
            runtime_control_argv,
            bounded_command,
            CONTROL_ROOT,
        )

        if prior is None:
            bootstrap(bundle["config"])
            write_file(
                ROOT / "receipt.pending",
                json.dumps(
                    {
                        "version": 1,
                        "digest": digest,
                        "relaySha256": hashlib.sha256(
                            pathlib.Path("/opt/jetski/tcp-relay").read_bytes()
                        ).hexdigest(),
                        "nativeSha256": hashlib.sha256(
                            pathlib.Path("/opt/jetski/command-supervisor").read_bytes()
                        ).hexdigest(),
                    }
                ).encode(),
            )
            os.replace(ROOT / "receipt.pending", receipt)
            directory = os.open(ROOT, os.O_RDONLY | os.O_DIRECTORY)
            try:
                os.fsync(directory)
            finally:
                os.close(directory)
        proof_receipt = json.loads(receipt.read_text())
        if (
            hashlib.sha256(pathlib.Path("/opt/jetski/command-supervisor").read_bytes()).hexdigest()
            != proof_receipt["nativeSha256"]
        ):
            raise ValueError("installed_supervisor_corrupt")
        if (
            hashlib.sha256(pathlib.Path("/opt/jetski/tcp-relay").read_bytes()).hexdigest()
            != proof_receipt["relaySha256"]
        ):
            raise ValueError("installed_relay_corrupt")
        config = configuration()
        if config != bundle["config"]:
            raise ValueError("bootstrap_configuration_conflict")
        # Validate installed bytes too: a receipt is not readiness evidence.
        for name in MODULES - {"bootstrap.py", "command-supervisor.c", "tcp-relay.c"}:
            path = pathlib.Path("/opt/jetski/host") / name
            if name == "runtime_service.py":
                path = pathlib.Path("/opt/jetski/runtime_service.py")
            meta = path.lstat()
            forbidden = 0o022 if name == "runtime_service.py" else 0o077
            if not stat.S_ISREG(meta.st_mode) or meta.st_uid != 0 or meta.st_mode & forbidden:
                raise ValueError("unsafe_installed_module")
            if path.read_bytes() != decoded[name]:
                raise ValueError("installed_module_corrupt")
        account = runtime_account()
        from runtime_backend import read_workload_identity

        ownership = read_workload_identity(account)
        proof = preflight(
            config,
            account,
            lambda args: bounded_command(
                runtime_control_argv(account) + args, CONTROL_ROOT, timeout=60
            ),
        )
        if any(
            proof.get(key) != ownership[key]
            for key in (
                "runtimeUid",
                "runtimeGid",
                "workloadUid",
                "workloadGid",
                "uidMappings",
                "gidMappings",
            )
        ):
            raise ValueError("runtime_ownership_changed")
        return {
            "version": 1,
            "digest": digest,
            "ready": proof["ready"],
            "machineId": config["machineId"],
        }
    finally:
        os.close(lock)


if __name__ == "__main__":
    # bootstrap emits diagnostics before this final receipt; consumers use last line.
    print(json.dumps(install(sys.stdin.buffer.read(MAX_BUNDLE + 1))))
