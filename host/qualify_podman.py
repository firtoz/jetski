"""Disposable CI qualification. Never run against an operator's persistent host."""

import json
import os
import pathlib
import shutil
import subprocess
import tempfile
import uuid
from archive import capture, restore, digest
from fence import Fence
from runtime import PodmanRuntime
from test_archive import oracle


def main():
    image = os.environ["JETSKI_TEST_IMAGE"]

    def run(args):
        completed = subprocess.run(["podman", *args], capture_output=True, text=True, timeout=120)
        if completed.returncode not in (0, 1):
            print(completed.stderr[-8000:], flush=True)
        return dict(exitCode=completed.returncode, stdout=completed.stdout, stderr=completed.stderr)

    info = run(["info", "--format", "json"])
    if info["exitCode"] != 0:
        raise RuntimeError(info["stderr"])
    host = json.loads(info["stdout"])["host"]
    if not host["security"]["rootless"] or host["cgroupVersion"] != "v2":
        raise RuntimeError("rootless_cgroup_v2_required")
    with tempfile.TemporaryDirectory(prefix="jetski-qualification-") as temporary:
        base = pathlib.Path(temporary)
        fence = Fence(base / "control")
        lease = dict(
            owner="qualification",
            poolId="test",
            machineId="ci",
            slotId=str(uuid.uuid4()),
            sandboxId=str(uuid.uuid4()),
            assignmentId=str(uuid.uuid4()),
            generation=1,
        )
        containers = []
        try:
            fence.claim(lease)
            data = base / "data"
            roots = {name: data / lease["assignmentId"] / name for name in ("workspace", "home")}
            for root in roots.values():
                root.mkdir(parents=True)
            runtime = PodmanRuntime(fence, run, image, data, [image])
            containers.append(runtime.container(lease))
            runtime.create(lease)
            result = run(
                [
                    "exec",
                    runtime.container(lease),
                    "/bin/sh",
                    "-ec",
                    "test $(id -u) = 1000; printf 'hello\\000world' > /workspace/file; chmod 640 /workspace/file; ln /workspace/file /workspace/hard; ln -s /workspace/file /home/sandbox/link; mkdir /workspace/dir; chmod 750 /workspace/dir",
                ]
            )
            if result["exitCode"]:
                raise RuntimeError(result["stderr"])
            runtime.quiesce(lease)
            before = oracle(data / lease["assignmentId"])
            receipt = capture(roots, base / "checkpoint.tgz")
            runtime.remove(lease)
            release = dict(checkpointId=str(uuid.uuid4()), sha256=receipt["sha256"])
            fence.release(
                lease,
                lambda *_: (
                    digest(base / "checkpoint.tgz") == receipt["sha256"]
                    and run(["container", "exists", runtime.container(lease)])["exitCode"] == 1
                ),
                release,
            )
            shutil.rmtree(data / lease["assignmentId"])
            replacement = dict(lease, assignmentId=str(uuid.uuid4()), generation=2)
            restore(base / "checkpoint.tgz", data / replacement["assignmentId"], receipt["sha256"])
            after = oracle(data / replacement["assignmentId"])
            if before != after:
                raise RuntimeError("independent_filesystem_comparison_failed")
            fence.claim(replacement)
            containers.append(runtime.container(replacement))
            runtime.create(replacement)
            result = run(
                [
                    "exec",
                    runtime.container(replacement),
                    "/bin/sh",
                    "-ec",
                    'test "$(cat /home/sandbox/link | wc -c)" = 11; test "$(stat -c %a /workspace/file)" = 640; test "$(stat -c %i /workspace/file)" = "$(stat -c %i /workspace/hard)"',
                ]
            )
            if result["exitCode"]:
                raise RuntimeError(result["stderr"])
            runtime.quiesce(replacement)
            runtime.remove(replacement)
            print(
                json.dumps(
                    dict(
                        rootless=True,
                        filesystemExact=True,
                        sourceDeleted=True,
                        replacementContainer=True,
                        replacementHost=False,
                        entries=len(before),
                        image=image,
                        cgroups=host["cgroupVersion"],
                    )
                )
            )
        finally:
            for name in containers:
                run(["rm", "--force", "--ignore", name])
                if run(["container", "exists", name])["exitCode"] != 1:
                    raise RuntimeError("qualification_cleanup_unconfirmed")


if __name__ == "__main__":
    main()
