"""Disposable CI only: outbound networking and host-loopback denial."""

import http.server
import json
import os
import pathlib
import subprocess
import tempfile
import threading
import uuid
from fence import Fence
from runtime import PodmanRuntime


def main():
    image = os.environ["JETSKI_TEST_IMAGE"]

    def run(args):
        result = subprocess.run(["podman", *args], capture_output=True, text=True, timeout=45)
        return dict(exitCode=result.returncode, stdout=result.stdout, stderr=result.stderr)

    info = run(["info", "--format", "json"])
    if info["exitCode"] or not json.loads(info["stdout"])["host"]["security"]["rootless"]:
        raise RuntimeError("rootless_runtime_required")

    class Listener(http.server.BaseHTTPRequestHandler):
        def do_GET(self):
            self.send_response(200)
            self.end_headers()
            self.wfile.write(b"host-loopback-must-not-be-visible")

        def log_message(self, *_):
            pass

    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Listener)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        with tempfile.TemporaryDirectory(prefix="jetski-network-") as temporary:
            base = pathlib.Path(temporary)
            fence = Fence(base / "control")
            lease = dict(
                owner="qualification",
                poolId="ci",
                machineId="ci",
                slotId=str(uuid.uuid4()),
                sandboxId=str(uuid.uuid4()),
                assignmentId=str(uuid.uuid4()),
                generation=1,
            )
            fence.claim(lease)
            for root in ("home", "workspace"):
                (base / "data" / lease["assignmentId"] / root).mkdir(parents=True)
            runtime = PodmanRuntime(
                fence, run, image, base / "data", [image], network_mode="egress"
            )
            try:
                runtime.create(lease)
                name = runtime.container(lease)
                denied = run(
                    [
                        "exec",
                        name,
                        "wget",
                        "-T",
                        "2",
                        "-qO-",
                        f"http://10.0.2.2:{server.server_port}/",
                    ]
                )
                if (
                    denied["exitCode"] == 0
                    or "host-loopback-must-not-be-visible" in denied["stdout"]
                ):
                    raise RuntimeError("host_loopback_exposed")
                # Public nonsensitive fixture; HTTP intentionally avoids relying on image CA bundles.
                outbound = run(["exec", name, "wget", "-T", "15", "-qO-", "http://example.com/"])
                if outbound["exitCode"] or "Example Domain" not in outbound["stdout"]:
                    raise RuntimeError("external_egress_unverified:" + outbound["stderr"][-1000:])
                runtime.quiesce(lease)
                runtime.remove(lease)
                print(json.dumps(dict(egress=True, hostLoopbackDenied=True, cleanup=True)))
            finally:
                run(["rm", "--force", runtime.container(lease)])
                if run(["container", "exists", runtime.container(lease)])["exitCode"] != 1:
                    raise RuntimeError("owned_container_cleanup_unconfirmed")
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=5)


if __name__ == "__main__":
    main()
