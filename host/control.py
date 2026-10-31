"""Protocol v1 over authenticated SSH stdin/stdout; installed root-owned."""

import base64
import hashlib
import json
import os
import stat
import shutil
import pathlib
import sys
import subprocess

# Python -I excludes the script directory. Installation makes this directory
# root-owned and not group/world writable before enabling the SSH command.
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))

from archive import capture, sync_dir  # noqa: E402
from terminal_input import TerminalInputs  # noqa: E402
from commands import Commands  # noqa: E402
from files import Files  # noqa: E402
from file_upload import FileUpload  # noqa: E402
from import_checkpoint import CheckpointImport  # noqa: E402
from fence import Fence, identity  # noqa: E402
from runtime import PodmanRuntime  # noqa: E402
from supervisor import (  # noqa: E402
    ARCHIVE_ROOT,
    CONTROL_ROOT,
    DATA_ROOT,
    bounded_command,
    configuration,
    preflight,
    runtime_account,
    runtime_argv,
)


def dispatch(request, config, account, run, launch=None):
    if (
        not isinstance(request, dict)
        or set(request) != {"version", "id", "action", "payload"}
        or request["version"] != 1
    ):
        raise ValueError("invalid_protocol_request")
    if not isinstance(request["id"], str) or not 1 <= len(request["id"]) <= 128:
        raise ValueError("invalid_request_id")
    action = request["action"]
    if action == "status":
        return preflight(config, account, run)
    payload = request["payload"]
    if not isinstance(payload, dict) or "lease" not in payload:
        raise ValueError("missing_lease")
    lease = identity(payload["lease"])
    if lease["machineId"] != config["machineId"] or lease["poolId"] != config["poolId"]:
        raise ValueError("physical_identity_conflict")
    # One fence per host: caller-selected slot IDs cannot create parallel assignments.
    fence = Fence(CONTROL_ROOT / "slot")
    if action == "claim":
        return fence.claim(lease)
    if action == "inspect":
        with fence.locked():
            state = fence.read()
            fence.match(state, lease)
            return state
    image = payload.get("image")
    runtime = PodmanRuntime(
        fence, run, image, DATA_ROOT, config["images"], "/opt/jetski/command-supervisor"
    )
    importer = CheckpointImport(fence, ARCHIVE_ROOT, DATA_ROOT, account)
    if action == "import-begin":
        return importer.begin(
            lease, payload.get("checkpointId"), payload.get("sha256"), payload.get("bytes")
        )
    if action == "import-chunk":
        return importer.chunk(
            lease, payload.get("offset"), payload.get("base64"), payload.get("sha256")
        )
    if action == "import-finish":
        return importer.finish(lease)
    upload = FileUpload(fence, DATA_ROOT, account)
    if action == "file-write-begin":
        return upload.begin(
            lease,
            payload.get("uploadId"),
            payload.get("path"),
            payload.get("bytes"),
            payload.get("sha256"),
            payload.get("mode", 0o644),
        )
    if action == "file-write-chunk":
        return upload.chunk(
            lease,
            payload.get("uploadId"),
            payload.get("offset"),
            payload.get("base64"),
            payload.get("sha256"),
        )
    if action == "file-write-finish":
        return upload.finish(lease, payload.get("uploadId"))
    if action == "file-write-status":
        return upload.status(lease, payload.get("uploadId"))
    files = Files(fence, DATA_ROOT, account.pw_uid)
    if action == "file-read":
        return files.read(
            lease,
            payload.get("path"),
            payload.get("offset"),
            payload.get("bytes"),
            payload.get("expectedVersion"),
        )
    if action == "file-list":
        return files.listing(
            lease,
            payload.get("path"),
            payload.get("after", ""),
            payload.get("limit", 256),
            payload.get("expectedVersion"),
        )
    commands = Commands(fence, CONTROL_ROOT / "commands", launch)
    if action in ("command-start", "terminal-start"):
        if launch is None:
            raise ValueError("command_launcher_unavailable")
        return commands.start(
            lease,
            payload.get("commandId"),
            payload.get("argv"),
            payload.get("cwd", "/workspace"),
            payload.get("timeout", 120),
            terminal=action == "terminal-start",
            rows=payload.get("rows", 24),
            columns=payload.get("columns", 80),
        )
    if action in ("terminal-input", "terminal-input-status"):
        inputs = TerminalInputs(fence, CONTROL_ROOT / "terminal-input")
        if action == "terminal-input":
            return inputs.admit(
                lease, payload.get("commandId"), payload.get("inputId"), payload.get("input")
            )
        return inputs.status(lease, payload.get("commandId"), payload.get("inputId"))
    if action == "command-status":
        return commands.status(lease, payload.get("commandId"))
    if action == "command-output":
        return commands.output(
            lease,
            payload.get("commandId"),
            payload.get("channel"),
            payload.get("offset"),
            payload.get("bytes"),
        )
    if action == "command-cancel":
        return commands.cancel(lease, payload.get("commandId"), runtime)
    if action == "create":
        with fence.locked():
            state = fence.read()
            fence.match(state, lease)
            if state["phase"] != "open":
                raise ValueError("closed_lease")
            if state.get("import") and state["import"]["phase"] != "ready":
                raise ValueError("checkpoint_import_incomplete")
            # Root-owned parent prevents a workload from replacing assignment roots.
            assignment = DATA_ROOT / lease["assignmentId"]
            assignment.mkdir(mode=0o700, exist_ok=True)
            for path in [assignment, assignment / "workspace", assignment / "home"]:
                path.mkdir(mode=0o700, exist_ok=True)
                meta = path.lstat()
                if not stat.S_ISDIR(meta.st_mode) or meta.st_uid not in (0, account.pw_uid):
                    raise ValueError("unsafe_persistent_root")
                os.chown(path, account.pw_uid, account.pw_gid, follow_symlinks=False)
        return runtime.create(lease, payload.get("memoryMb", 512), payload.get("cpus", 1))
    if action == "quiesce":
        return runtime.quiesce(lease)
    if action == "remove":
        return runtime.remove(lease)
    if action == "release":
        receipt = payload.get("publication")

        # This private SSH method is for the trusted controller only, after its
        # checkpoint registry has verified and committed remote/local publication.
        # Public callers must never be able to supply this assertion directly.
        def verified(_lease, publication):
            state = fence.read()
            checkpoint = state.get("checkpoint")
            if (
                not checkpoint
                or publication["sha256"] != checkpoint["sha256"]
                or state.get("runtime", {}).get("phase") != "removed"
            ):
                return False
            return run(["container", "exists", runtime.container(lease)])["exitCode"] == 1

        return fence.release(lease, verified, receipt)
    if action == "purge-source":
        with fence.locked():
            state = fence.read()
            fence.match(state, lease)
            if state["phase"] != "released" or not state.get("releaseReceipt"):
                raise ValueError("source_not_durably_released")
            # Only unpublished staging for this released assignment is disposable.
            # IDs came from validated immutable upload receipts, never workload input.
            for receipt in state.get("uploads", {}).values():
                upload.receipt(state, receipt["id"])
                staged = upload.path(receipt)
                if os.path.lexists(staged):
                    if staged.is_symlink() or not staged.is_file():
                        raise ValueError("unsafe_upload_staging")
                    staged.unlink()
            if state.get("uploads"):
                sync_dir(upload.staging())
            destination = DATA_ROOT / lease["assignmentId"]
            if os.path.lexists(destination):
                if destination.is_symlink() or not destination.is_dir():
                    raise ValueError("unsafe_source_path")
                shutil.rmtree(destination)
            for suffix in (".tgz", ".upload"):
                path = ARCHIVE_ROOT / (lease["assignmentId"] + suffix)
                if os.path.lexists(path):
                    if path.is_symlink() or not path.is_file():
                        raise ValueError("unsafe_source_archive")
                    path.unlink()
            return dict(purged=True)
    if action == "capture":
        with fence.locked():
            state = fence.read()
            fence.match(state, lease)
            if state["phase"] != "closed" or state.get("runtime", {}).get("phase") != "stopped":
                raise ValueError("capture_requires_quiescence")
            roots = {
                name: DATA_ROOT / lease["assignmentId"] / name for name in ("workspace", "home")
            }
            receipt = capture(roots, ARCHIVE_ROOT / (lease["assignmentId"] + ".tgz"))
            fence.write({**state, "checkpoint": receipt})
            return receipt
    if action == "read-checkpoint":
        offset, count = payload.get("offset"), payload.get("bytes")
        if (
            type(offset) is not int
            or type(count) is not int
            or offset < 0
            or not 1 <= count <= 256 * 1024
        ):
            raise ValueError("invalid_checkpoint_range")
        with fence.locked():
            state = fence.read()
            fence.match(state, lease)
            receipt = state.get("checkpoint")
            if state["phase"] != "closed" or not receipt or offset + count > receipt["bytes"]:
                raise ValueError("checkpoint_range_unavailable")
            path = ARCHIVE_ROOT / (lease["assignmentId"] + ".tgz")
            fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
            with os.fdopen(fd, "rb") as source:
                if os.fstat(source.fileno()).st_size != receipt["bytes"]:
                    raise ValueError("checkpoint_size_changed")
                source.seek(offset)
                data = source.read(count)
            if len(data) != count:
                raise ValueError("short_checkpoint_range")
            return dict(
                offset=offset,
                bytes=count,
                sha256=hashlib.sha256(data).hexdigest(),
                base64=base64.b64encode(data).decode("ascii"),
            )
    # restore/release require durable publication and ownership preparation;
    # unsupported requests fail closed until their handlers are installed.
    raise ValueError("unsupported_host_action")


def main():
    raw = sys.stdin.buffer.read(1024 * 1024 + 1)
    if len(raw) > 1024 * 1024:
        raise ValueError("host_request_limit")
    request = json.loads(raw)
    config = configuration()
    account = runtime_account()

    def run(args):
        return bounded_command(runtime_argv(account) + args, CONTROL_ROOT)

    def launch(command):
        subprocess.Popen(
            [sys.executable, "-I", "/opt/jetski/host/commands.py", command],
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            start_new_session=True,
            cwd="/",
            env={"PATH": "/usr/bin:/bin", "LANG": "C.UTF-8"},
        )

    result = dispatch(request, config, account, run, launch)
    output = json.dumps(dict(version=1, id=request["id"], result=result), separators=(",", ":"))
    if len(output.encode("utf8")) > 2 * 1024 * 1024:
        raise ValueError("host_response_limit")
    print(output)


if __name__ == "__main__":
    main()
