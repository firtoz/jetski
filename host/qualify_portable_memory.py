"""Disposable native mechanism proof: fresh filesystem inodes, not a new host.

This tests actual runsc restore before integrating the portable controller path.
It is not R2, source-host deletion or lifecycle-publication qualification.
"""

import hashlib
import base64
import json
import os
import pathlib
import shutil
import struct
import time
import uuid

from archive import capture, restore
from fence import Fence
from gvisor_environment import RootlessEnvironment
from gvisor_exec import ExecApi
from gvisor_memory import image_manifest
from gvisor_native import GvisorRuntime, RunscDriver
from memory_chunks import capture_chunks
from memory_filesystem import frozen_identity
from portable_memory_import import PortableMemoryImport
from portable_memory_format import manifest_sha256, manifest_objects
from stream_protocol import Decoder
from supervisor import CONTROL_ROOT, DATA_ROOT, configuration, runtime_account
from test_archive import oracle


def main():
    if os.environ.get("GITHUB_ACTIONS") != "true" or os.geteuid() != 0:
        raise ValueError("disposable_root_ci_required")
    config, account = configuration(), runtime_account()
    image = config["images"][0]
    env = RootlessEnvironment(account, [image], init_argv=config["workloadInit"])
    native_run = env.run

    def diagnostic(arguments):
        result = native_run(arguments)
        if result["exitCode"]:
            print(json.dumps(dict(portableNativeFailure=result)), flush=True)
        return result

    env.run = diagnostic
    driver = RunscDriver(env)
    lease = dict(
        owner="portable-qualification",
        poolId=config["poolId"],
        machineId=config["machineId"],
        sandboxId=str(uuid.uuid4()),
        slotId=str(uuid.uuid4()),
        assignmentId=str(uuid.uuid4()),
        generation=1,
    )
    target = {**lease, "assignmentId": str(uuid.uuid4()), "slotId": str(uuid.uuid4())}
    fence = Fence(CONTROL_ROOT / "portable-qualification")
    fence.claim(lease)
    runtime = GvisorRuntime(fence, driver, image, [image])
    source = DATA_ROOT / lease["assignmentId"]
    destination = DATA_ROOT / target["assignmentId"]
    source.mkdir(mode=0o711)
    ownership = env.ownership
    for name in ("workspace", "home"):
        path = source / name
        path.mkdir(mode=0o700)
        os.chown(path, ownership["workloadUid"], ownership["workloadGid"])
    app = source / "workspace/application"
    shutil.copyfile(os.environ["JETSKI_TEST_MEMORY_SERVER"], app)
    app.chmod(0o755)
    os.chown(app, ownership["workloadUid"], ownership["workloadGid"])
    file = source / "workspace/bytes"
    file.write_bytes(b"portable\0filesystem\xff" * 4096)
    file.chmod(0o751)
    os.chown(file, ownership["workloadUid"], ownership["workloadGid"])
    os.link(file, source / "home/hard")
    (source / "home/link").symlink_to("../workspace/bytes")
    api = ExecApi(env)

    def query(candidate):
        session = api.create(
            driver.container(candidate),
            ["/jetski-tcp-relay", "--jetski-tcp-v1", "8080"],
            stdin=True,
        )
        request = b"GET / HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n"
        parser, response = Decoder(output=True), bytearray()
        initial = b"D" + struct.pack(">I", len(request)) + request + b"F" + struct.pack(">I", 0)
        for channel, data in api.output(session, initial_input=initial, timeout=40):
            assert channel == "stdout" or not data, data
            if channel == "stdout":
                for tag, payload in parser.feed(data):
                    if tag == b"D":
                        response.extend(payload[5:])
        parser.finish()
        assert api.inspect(session)["ExitCode"] == 0
        return json.loads(bytes(response).split(b"\r\n\r\n", 1)[1])

    def owned_cleanup(candidate):
        if not driver.absent(candidate):
            driver.stop(candidate)
            driver.remove(candidate)
        assert driver.absent(candidate)

    try:
        runtime.create(lease, 512, 1)
        deadline = time.monotonic() + 30
        while True:
            try:
                before = query(lease)
                break
            except (AssertionError, ValueError):
                if time.monotonic() >= deadline:
                    raise
                time.sleep(0.1)
        checkpoint = str(uuid.uuid4())
        driver.checkpoint(lease, checkpoint)
        native_path = pathlib.Path(driver.memory_path(lease, checkpoint))
        portable_compatibility = driver.portable_compatibility(lease, checkpoint)
        exposed = portable_compatibility["cpuFeatures"]
        filesystem = CONTROL_ROOT / ("portable-fs-" + checkpoint + ".tgz")
        roots = {name: source / name for name in ("workspace", "home")}
        receipt = capture(roots, filesystem)
        exact, physical = oracle(source), frozen_identity(roots)
        binding = dict(
            version=1,
            lease=lease,
            checkpointId=checkpoint,
            filesystemSha256=receipt["sha256"],
            filesystemIdentitySha256=physical,
            **driver.compatibility(lease),
        )
        native = image_manifest(native_path, binding, owner_uid=account.pw_uid)
        pack = CONTROL_ROOT / ("portable-memory-" + checkpoint + ".pack")
        exported = capture_chunks(native_path, native["files"], pack, owner_uid=account.pw_uid)
        encoded = pack.read_bytes()
        assert hashlib.sha256(encoded).hexdigest() == exported["sha256"]
        # Positive native absence and deletion of both original FS/image trees.
        owned_cleanup(lease)
        assert not native_path.exists()
        shutil.rmtree(source)
        assert not source.exists()
        restore(
            filesystem,
            destination,
            receipt["sha256"],
            owner=(ownership["workloadUid"], ownership["workloadGid"]),
        )
        os.chown(destination, 0, 0)
        destination.chmod(0o711)
        assert exact == oracle(destination)
        assert physical != frozen_identity(
            {name: destination / name for name in ("workspace", "home")}
        )
        parts, objects = [], {}
        for file in exported["files"]:
            item = {**file, "chunks": []}
            for chunk in file["chunks"]:
                key = chunk["storedSha256"]
                obj = dict(
                    owner=lease["owner"],
                    sandbox=lease["sandboxId"],
                    id="chunk-" + key,
                    bytes=chunk["storedBytes"],
                    sha256=key,
                )
                objects[obj["id"]] = encoded[
                    chunk["packedOffset"] : chunk["packedOffset"] + chunk["storedBytes"]
                ]
                item["chunks"].append(
                    dict(
                        offset=chunk["offset"],
                        bytes=chunk["bytes"],
                        sha256=chunk["sha256"],
                        codec=chunk["codec"],
                        object=obj,
                    )
                )
            parts.append(item)
        manifest = dict(
            kind="portable-memory",
            version=1,
            owner=lease["owner"],
            sandbox=lease["sandboxId"],
            checkpointId=checkpoint,
            generation=1,
            filesystemSha256=receipt["sha256"],
            compatibility=portable_compatibility,
            directories=exported["directories"],
            files=parts,
        )
        target_fence = Fence(CONTROL_ROOT / "portable-target-qualification")
        target_fence.claim(target)
        target_fence.write(
            dict(
                lease=target,
                phase="open",
                **{
                    "import": dict(
                        id=checkpoint,
                        phase="ready",
                        sha256=receipt["sha256"],
                        portableMemoryRequired=True,
                    )
                },
            )
        )
        importer = PortableMemoryImport(
            target_fence, driver, CONTROL_ROOT / "portable-target-imports", DATA_ROOT
        )
        checksum = manifest_sha256(manifest)
        assert importer.begin(target, manifest, checksum, image, 512, 1)["phase"] == "receiving"
        for obj in manifest_objects(manifest).values():
            assert importer.chunk(
                target,
                checkpoint,
                obj["id"],
                0,
                base64.b64encode(objects[obj["id"]]).decode(),
                obj["sha256"],
            )["complete"]
        imported = importer.finish(target, checkpoint, checksum)
        assert imported["phase"] == "restored" and imported["memoryPreserved"] is True
        assert importer.finish(target, checkpoint, checksum)["phase"] == "restored"
        after = query(target)
        assert before["token"] == after["token"] and after["counter"] == before["counter"] + 1, (
            before,
            after,
        )
        assert before["checksum"] == after["beforeChecksum"], (before, after)
        assert after["fileOffsetBefore"] == before["fileOffsetAfter"], (before, after)
        file_bytes = bytes(
            (i * 29 + 7) & 255 for i in range(after["fileOffsetBefore"], after["fileOffsetAfter"])
        )
        fnv = 1469598103934665603
        for byte in file_bytes:
            fnv = ((fnv ^ byte) * 1099511628211) & ((1 << 64) - 1)
        assert after["fileChecksum"] == f"{fnv:016x}", (before, after)
        assert exact == oracle(destination)
        print(
            json.dumps(
                dict(
                    nativePortableMechanism=True,
                    fencedTargetImport=True,
                    freshFilesystemInodes=True,
                    memoryContinuity=True,
                    fullHeapChecksum=True,
                    openFileOffsetContent=True,
                    filesystemExact=True,
                    replacementHost=False,
                    r2=False,
                    exposedCpuFeatures=len(exposed),
                )
            ),
            flush=True,
        )
    finally:
        for candidate in (lease, target):
            owned_cleanup(candidate)
        for path in (source, destination):
            if path.exists():
                shutil.rmtree(path)


if __name__ == "__main__":
    main()
