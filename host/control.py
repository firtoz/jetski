"""Protocol v1 over authenticated SSH stdin/stdout; installed root-owned."""

import base64
import hashlib
import pwd
import json
import os
import stat
import shutil
import pathlib
import sys
import subprocess
import select
import struct
import time
from types import SimpleNamespace

# Python -I excludes the script directory. Installation makes this directory
# root-owned and not group/world writable before enabling the SSH command.
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))

from archive import capture, sync_dir  # noqa: E402
from streams import Streams  # noqa: E402
from terminal_input import TerminalInputs  # noqa: E402
from commands import Commands, reconcile_workers_locked, START_WAIT_MAX_MS  # noqa: E402
from files import Files  # noqa: E402
from file_upload import FileUpload  # noqa: E402
from import_checkpoint import CheckpointImport, IMPORT_REQUEST_BYTES  # noqa: E402
from local_checkpoint import LocalCheckpoint  # noqa: E402
from checkpoint_export import CheckpointExport  # noqa: E402
from fence import Fence, identity  # noqa: E402
from runtime_backend import selected_backend, WORKLOAD_USER_NAMESPACE, read_workload_identity  # noqa: E402
from supervisor import (  # noqa: E402
    ARCHIVE_ROOT,
    CONTROL_ROOT,
    DATA_ROOT,
    bounded_command,
    configuration,
    preflight,
    runtime_account,
    runtime_control_argv,
)


def dispatch(
    request,
    config,
    account,
    run,
    launch=None,
    backend=None,
    storage_owner=None,
    user_namespace=WORKLOAD_USER_NAMESPACE,
    parent_uid=None,
    uid_mappings=None,
    gid_mappings=None,
):
    if (
        not isinstance(request, dict)
        or set(request) != {"version", "id", "action", "payload"}
        or request["version"] != 1
    ):
        raise ValueError("invalid_protocol_request")
    if not isinstance(request["id"], str) or not 1 <= len(request["id"]) <= 128:
        raise ValueError("invalid_request_id")
    if backend is None:
        backend = selected_backend(config, account)
    action = request["action"]
    if action == "status":
        proof = preflight(config, account, run, backend)
        if storage_owner is not None and (
            proof.get("workloadUid") != storage_owner.pw_uid
            or proof.get("workloadGid") != storage_owner.pw_gid
            or proof.get("runtimeUid") != account.pw_uid
            or proof.get("runtimeGid") != account.pw_gid
            or proof.get("uidMappings") != uid_mappings
            or proof.get("gidMappings") != gid_mappings
        ):
            raise ValueError("runtime_ownership_changed")
        return {
            **proof,
            "cachedResumeVersion": 1,
            **(
                {"memorySuspendVersion": 1, "portableMemoryVersion": 1}
                if hasattr(backend, "memory_driver")
                else {}
            ),
        }
    persistent = storage_owner if storage_owner is not None else account
    assignment_uid = persistent.pw_uid if parent_uid is None else parent_uid
    payload = request["payload"]
    if not isinstance(payload, dict) or "lease" not in payload:
        raise ValueError("missing_lease")
    lease = identity(payload["lease"])
    if lease["machineId"] != config["machineId"] or lease["poolId"] != config["poolId"]:
        raise ValueError("physical_identity_conflict")
    # One fence per host: caller-selected slot IDs cannot create parallel assignments.
    fence = Fence(CONTROL_ROOT / "slot")
    if action == "resume-cached":
        if payload.get("image") not in config["images"]:
            raise ValueError("unapproved_image")

        def step(action):
            return dispatch(
                {**request, "action": action},
                config,
                account,
                run,
                launch,
                backend,
                storage_owner=storage_owner,
                user_namespace=user_namespace,
                parent_uid=parent_uid,
                uid_mappings=uid_mappings,
                gid_mappings=gid_mappings,
            )

        step("claim")
        with fence.locked():
            state = fence.read()
            imported = state.get("import") if state.get("runtime") else None
            if state.get("runtime") and (
                not imported
                or imported["phase"] != "ready"
                or any(
                    imported[key] != payload.get(field)
                    for key, field in (
                        ("id", "checkpointId"),
                        ("sha256", "sha256"),
                        ("bytes", "bytes"),
                    )
                )
            ):
                raise ValueError("cached_resume_identity_conflict")
        if imported is None:
            imported = step("import-begin")
        ready = imported["phase"] == "ready"
        # The existing importer performs the complete SHA/CRC/tree proof before
        # ready. A miss leaves only unpublished receiving state, never execution.
        runtime = step("create") if ready else None
        return dict(
            lease=lease,
            checkpointId=imported["id"],
            sha256=imported["sha256"],
            bytes=imported["bytes"],
            ready=ready,
            runtime=runtime,
        )
    if action in ("memory-export", "memory-export-read", "memory-source", "memory-source-close"):
        if payload.get("image") not in config["images"] or not hasattr(backend, "memory_driver"):
            raise ValueError("portable_memory_runtime_unavailable")
        from portable_memory_export import PortableMemoryExport

        exporter = PortableMemoryExport(
            fence, backend.memory_driver(), CONTROL_ROOT / "portable-memory-exports", DATA_ROOT
        )
        if action in ("memory-source", "memory-source-close"):
            name = config.get("archiveTransferUser")
            if name is None:
                return dict(supported=False)
            from portable_memory_files import PortableMemoryFiles

            files = PortableMemoryFiles(fence, pwd.getpwnam(name))
            if action == "memory-source-close":
                return files.close_export(lease, payload.get("checkpointId"), exporter)
            return files.export(
                lease,
                payload.get("checkpointId"),
                exporter,
                payload.get("sha256"),
                payload.get("bytes"),
            )
        if action == "memory-export":
            return exporter.prepare(
                lease,
                payload.get("checkpointId"),
                payload.get("filesystemSha256"),
                codec=payload.get("codec", "gzip"),
                chunk_bytes=payload.get("chunkBytes", 1024 * 1024),
            )
        return exporter.read(
            lease, payload.get("checkpointId"), payload.get("offset"), payload.get("bytes")
        )
    if action in (
        "memory-import-begin",
        "memory-import-status",
        "memory-import-chunk",
        "memory-import-finish",
        "memory-import-abort",
        "memory-import-file-begin",
        "memory-import-file-chunk",
        "memory-import-file-close",
    ):
        if payload.get("image") not in config["images"] or not hasattr(backend, "memory_driver"):
            raise ValueError("portable_memory_runtime_unavailable")
        from portable_memory_import import PortableMemoryImport

        memory_import = PortableMemoryImport(
            fence, backend.memory_driver(), CONTROL_ROOT / "portable-memory-imports", DATA_ROOT
        )
        if action.startswith("memory-import-file-"):
            name = config.get("archiveTransferUser")
            if name is None:
                return dict(supported=False)
            from portable_memory_files import PortableMemoryFiles

            files = PortableMemoryFiles(fence, pwd.getpwnam(name))
            identifier = payload.get("checkpointId")
            if action == "memory-import-file-begin":
                return files.import_begin(lease, identifier, memory_import)
            if action == "memory-import-file-close":
                return files.import_close(lease, identifier, memory_import)
            return files.import_chunk(
                lease,
                identifier,
                memory_import,
                payload.get("objectId"),
                payload.get("offset"),
                payload.get("bytes"),
                payload.get("sha256"),
            )
        if action == "memory-import-begin":
            return memory_import.begin(
                lease,
                payload.get("manifest"),
                payload.get("manifestSha256"),
                payload["image"],
                payload.get("memoryMb", 512),
                payload.get("cpus", 1),
            )
        if action == "memory-import-status":
            return memory_import.status(lease, payload.get("checkpointId"), payload.get("objectId"))
        if action == "memory-import-chunk":
            return memory_import.chunk(
                lease,
                payload.get("checkpointId"),
                payload.get("objectId"),
                payload.get("offset"),
                payload.get("base64"),
                payload.get("sha256"),
            )
        if action == "memory-import-abort":
            return memory_import.abort(
                lease, payload.get("checkpointId"), payload.get("manifestSha256")
            )
        return memory_import.finish(
            lease, payload.get("checkpointId"), payload.get("manifestSha256")
        )
    from memory_control import MEMORY_ACTIONS, handle as memory_action

    if action in MEMORY_ACTIONS:
        if payload.get("image") not in config["images"]:
            raise ValueError("unapproved_image")
        return memory_action(action, payload, fence, backend, ARCHIVE_ROOT, DATA_ROOT)
    if action == "claim":
        return fence.claim(lease)
    if action == "inspect":
        with fence.locked():
            state = fence.read()
            fence.match(state, lease)
            return reconcile_workers_locked(fence, state)
    with fence.locked():
        state = fence.read()
        fence.match(state, lease)
        reconcile_workers_locked(fence, state)
    image = payload.get("image")
    runtime = backend.lifecycle(
        fence,
        run,
        image,
        DATA_ROOT,
        config["images"],
        "/opt/jetski/command-supervisor",
        "/opt/jetski/tcp-relay",
        network_mode=config.get("networkMode", "none"),
        user_namespace=user_namespace,
        uid_mappings=uid_mappings,
        gid_mappings=gid_mappings,
    )
    streams = Streams(fence)
    if action == "stream-reserve":
        return streams.reserve(lease, payload.get("streamId"), payload.get("port"))
    if action == "stream-status":
        return streams.status(lease, payload.get("streamId"))
    if action == "stream-cancel":
        return streams.cancel(lease, payload.get("streamId"))
    transfer_name = config.get("archiveTransferUser")
    importer = CheckpointImport(
        fence,
        ARCHIVE_ROOT,
        DATA_ROOT,
        persistent,
        pwd.getpwnam(transfer_name) if transfer_name is not None else None,
    )
    if action == "import-file-begin":
        return importer.file_begin(lease)
    if action == "import-file-chunk":
        return importer.file_chunk(
            lease, payload.get("offset"), payload.get("bytes"), payload.get("sha256")
        )
    if action == "import-file-close":
        return importer.file_close(lease)
    if action == "import-begin":
        return importer.begin(
            lease,
            payload.get("checkpointId"),
            payload.get("sha256"),
            payload.get("bytes"),
            payload.get("portableMemoryRequired", False),
        )
    if action == "import-chunk":
        return importer.chunk(
            lease, payload.get("offset"), payload.get("base64"), payload.get("sha256")
        )
    if action == "import-finish":
        return importer.finish(lease)
    upload = FileUpload(fence, DATA_ROOT, persistent, assignment_uid)
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
    files = Files(fence, DATA_ROOT, persistent.pw_uid, assignment_uid)
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
        wait_ms = payload.get("waitMs", 0)
        if type(wait_ms) is not int or not 0 <= wait_ms <= START_WAIT_MAX_MS:
            raise ValueError("invalid_command_wait")
        receipt = commands.start(
            lease,
            payload.get("commandId"),
            payload.get("argv"),
            payload.get("cwd", "/workspace"),
            payload.get("timeout", 120),
            terminal=action == "terminal-start",
            rows=payload.get("rows", 24),
            columns=payload.get("columns", 80),
        )
        if wait_ms:
            receipt = commands.wait(lease, payload.get("commandId"), wait_ms)
        snapshot = (
            commands.snapshot(lease, payload.get("commandId"))
            if receipt["phase"] in ("succeeded", "failed", "cancelled")
            else None
        )
        return {**receipt, "outputSnapshot": snapshot} if snapshot is not None else receipt
    if action in ("terminal-input", "terminal-input-status"):
        inputs = TerminalInputs(fence, CONTROL_ROOT / "terminal-input")
        if action == "terminal-input":
            return inputs.admit(
                lease, payload.get("commandId"), payload.get("inputId"), payload.get("input")
            )
        return inputs.status(lease, payload.get("commandId"), payload.get("inputId"))
    if action == "command-status":
        receipt = commands.status(lease, payload.get("commandId"))
        snapshot = (
            commands.snapshot(lease, payload.get("commandId"))
            if receipt["phase"] in ("succeeded", "failed", "cancelled")
            else None
        )
        return {**receipt, "outputSnapshot": snapshot} if snapshot is not None else receipt
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
                if not stat.S_ISDIR(meta.st_mode) or meta.st_uid not in (
                    0,
                    persistent.pw_uid,
                    assignment_uid,
                ):
                    raise ValueError("unsafe_persistent_root")
                if path == assignment:
                    gid = 0 if assignment_uid == 0 else persistent.pw_gid
                    os.chown(path, assignment_uid, gid, follow_symlinks=False)
                    # A root-owned traversal parent lets the rootless engine
                    # resolve bind sources without granting it workload contents.
                    os.chmod(path, 0o711 if assignment_uid == 0 else 0o700)
                    sync_dir(path)
                else:
                    os.chown(path, persistent.pw_uid, persistent.pw_gid, follow_symlinks=False)
        return runtime.create(lease, payload.get("memoryMb", 512), payload.get("cpus", 1))
    if action == "quiesce":
        frame_bytes = payload.get("captureFrameBytes")
        if "captureFrameBytes" in payload and (
            type(frame_bytes) is not int or frame_bytes not in (256 * 1024, 512 * 1024, 1024 * 1024)
        ):
            raise ValueError("invalid_capture_frame_size")
        commands.prepare_quiesce(lease)
        receipt = {
            **runtime.quiesce(lease),
            "finalizeVersion": 1,
            "checkpointReadBytes": 1280 * 1024,
        }
        if frame_bytes is not None:
            receipt["archive"] = dispatch(
                {**request, "action": "capture", "payload": {**payload, "frameBytes": frame_bytes}},
                config,
                account,
                run,
                launch,
                backend,
                storage_owner,
                user_namespace,
                parent_uid,
                uid_mappings,
                gid_mappings,
            )
        return receipt
    if action == "finalize":
        publication = payload.get("publication")
        with fence.locked():
            state = fence.read()
            fence.match(state, lease)
            checkpoint = state.get("checkpoint")
            if (
                not isinstance(publication, dict)
                or set(publication) != {"checkpointId", "sha256"}
                or not checkpoint
                or publication.get("sha256") != checkpoint.get("sha256")
                or state["phase"] not in ("closed", "released")
                or (state["phase"] == "released" and state.get("releaseReceipt") != publication)
            ):
                raise ValueError("invalid_finalize_publication")
            released = state["phase"] == "released"
        # The ordinary operations retain their durable receipts and fence checks.
        # An interrupted composite observes those receipts instead of replaying
        # execution or skipping the remaining verification/cleanup steps.
        for step in (
            ("release", "purge-source") if released else ("remove", "release", "purge-source")
        ):
            dispatch(
                {**request, "action": step},
                config,
                account,
                run,
                launch,
                backend,
                storage_owner=storage_owner,
                user_namespace=user_namespace,
                parent_uid=parent_uid,
                uid_mappings=uid_mappings,
                gid_mappings=gid_mappings,
            )
        return dict(finalized=True, checkpointId=publication["checkpointId"])
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
            return runtime.absent(lease)

        fence.release(lease, verified, receipt)
        LocalCheckpoint(fence, ARCHIVE_ROOT).publish(lease, receipt)
        return fence.read()
    if action == "purge-source":
        with fence.locked():
            state = fence.read()
            fence.match(state, lease)
            if state["phase"] != "released" or not state.get("releaseReceipt"):
                raise ValueError("source_not_durably_released")
            if state.get("portableImport"):
                from portable_memory_import import PortableMemoryImport

                PortableMemoryImport(
                    fence,
                    backend.memory_driver(),
                    CONTROL_ROOT / "portable-memory-imports",
                    DATA_ROOT,
                ).purge_locked(lease)
            memory = state.get("memory", {})
            if "portableExport" in memory:
                from portable_memory_export import PortableMemoryExport

                origin = identity(memory.get("manifest", {}).get("binding", {}).get("lease", lease))
                if (
                    any(origin[key] != lease[key] for key in lease if key != "generation")
                    or origin["generation"] > lease["generation"]
                ):
                    raise ValueError("portable_export_release_identity_conflict")
                PortableMemoryExport(
                    fence,
                    backend.memory_driver(),
                    CONTROL_ROOT / "portable-memory-exports",
                    DATA_ROOT,
                ).remove_pack(origin, memory["id"])
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
            sync_dir(DATA_ROOT)
            sync_dir(ARCHIVE_ROOT)
            return dict(purged=True)
    if action == "capture":
        with fence.locked():
            state = fence.read()
            fence.match(state, lease)
            if state["phase"] != "closed" or state.get("runtime", {}).get("phase") not in (
                "stopped",
                "frozen",
            ):
                raise ValueError("capture_requires_quiescence")
            roots = {
                name: DATA_ROOT / lease["assignmentId"] / name for name in ("workspace", "home")
            }
            frame_bytes = payload.get("frameBytes", 1024 * 1024)
            if type(frame_bytes) is not int or frame_bytes not in (
                256 * 1024,
                512 * 1024,
                1024 * 1024,
            ):
                raise ValueError("invalid_capture_frame_size")
            frozen = state.get("runtime", {}).get("phase") == "frozen"
            if frozen:
                from memory_filesystem import frozen_identity

                if frozen_identity(roots) != state.get("memory", {}).get(
                    "filesystemIdentitySha256"
                ):
                    raise ValueError("memory_filesystem_changed")
            receipt = capture(
                roots, ARCHIVE_ROOT / (lease["assignmentId"] + ".tgz"), frame_bytes=frame_bytes
            )
            if frozen:
                if frozen_identity(roots) != state["memory"]["filesystemIdentitySha256"]:
                    raise ValueError("memory_filesystem_changed")
                state = {**state, "memory": {**state["memory"], "captureFrameBytes": frame_bytes}}
            fence.write({**state, "checkpoint": receipt})
            return receipt
    if action in ("checkpoint-source", "checkpoint-source-close"):
        name = config.get("archiveTransferUser")
        if name is None:
            return dict(supported=False)
        exporter = CheckpointExport(
            fence, ARCHIVE_ROOT, pathlib.Path("/tmp/jetski-checkpoint-exports"), pwd.getpwnam(name)
        )
        if action == "checkpoint-source-close":
            return exporter.close(lease)
        return exporter.prepare(lease, payload.get("sha256"), payload.get("bytes"))
    if action == "read-checkpoint":
        offset, count = payload.get("offset"), payload.get("bytes")
        if (
            type(offset) is not int
            or type(count) is not int
            or offset < 0
            or not 1 <= count <= 1280 * 1024
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


def decode_request(raw):
    if len(raw) > IMPORT_REQUEST_BYTES:
        raise ValueError("host_request_limit")
    request = json.loads(raw)
    if not isinstance(request, dict):
        raise ValueError("invalid_protocol_request")
    if (
        request.get("action") not in ("import-chunk", "memory-import-begin", "memory-import-chunk")
        and len(raw) > 1024 * 1024
    ):
        raise ValueError("host_request_limit")
    return request


def main():
    if not select.select([0], [], [], 10)[0]:
        raise ValueError("host_header_deadline")
    first = os.read(0, 1)
    if first == b"J":
        from stream_protocol import MAGIC
        from stream_broker import serve

        deadline = time.monotonic() + 10

        def exact(count):
            data = bytearray()
            while len(data) < count:
                remaining = deadline - time.monotonic()
                if remaining <= 0 or not select.select([0], [], [], remaining)[0]:
                    raise ValueError("stream_header_deadline")
                chunk = os.read(0, count - len(data))
                if not chunk:
                    raise ValueError("truncated_stream_header")
                data.extend(chunk)
            return bytes(data)

        if first + exact(len(MAGIC) - 1) != MAGIC:
            raise ValueError("invalid_stream_protocol")
        length = struct.unpack(">I", exact(4))[0]
        if not 1 <= length <= 16384:
            raise ValueError("stream_header_bound")
        serve(json.loads(exact(length)), configuration(), runtime_account())
        return
    raw = first + sys.stdin.buffer.read(IMPORT_REQUEST_BYTES + 1)
    request = decode_request(raw)
    config = configuration()
    account = runtime_account()
    ownership = read_workload_identity(account)
    persistent = SimpleNamespace(pw_uid=ownership["workloadUid"], pw_gid=ownership["workloadGid"])

    def run(args):
        return bounded_command(runtime_control_argv(account) + args, CONTROL_ROOT)

    def launch(command):
        subprocess.Popen(
            [
                sys.executable,
                "-I",
                "/opt/jetski/host/commands.py",
                command,
                json.dumps(identity(request["payload"]["lease"])),
            ],
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            start_new_session=True,
            cwd="/",
            env={"PATH": "/usr/bin:/bin", "LANG": "C.UTF-8"},
        )

    result = dispatch(
        request,
        config,
        account,
        run,
        launch,
        storage_owner=persistent,
        user_namespace=ownership["namespace"],
        parent_uid=0,
        uid_mappings=ownership["uidMappings"],
        gid_mappings=ownership["gidMappings"],
    )
    output = json.dumps(dict(version=1, id=request["id"], result=result), separators=(",", ":"))
    output_limit = (8 if request["action"] == "memory-export" else 2) * 1024 * 1024
    if len(output.encode("utf8")) > output_limit:
        raise ValueError("host_response_limit")
    print(output)


if __name__ == "__main__":
    main()
