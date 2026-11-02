import os
import base64
import json
import pathlib
import tempfile
import types
import unittest
import uuid
from unittest.mock import patch
import control
from archive import capture
from fence import Fence
from supervisor import bounded_command, runtime_argv


class ControlTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = pathlib.Path(self.temp.name)
        self.data = self.root / "data"
        self.data.mkdir()
        self.calls = []
        self.config = dict(
            version=1, machineId="host", poolId="pool", images=["example/linux@sha256:" + "a" * 64]
        )
        self.lease = dict(
            owner="alice",
            machineId="host",
            poolId="pool",
            slotId=str(uuid.uuid4()),
            sandboxId=str(uuid.uuid4()),
            assignmentId=str(uuid.uuid4()),
            generation=1,
        )
        self.account = types.SimpleNamespace(pw_uid=os.getuid(), pw_gid=os.getgid())
        for field, path in (
            ("CONTROL_ROOT", self.root / "control"),
            ("DATA_ROOT", self.data),
            ("ARCHIVE_ROOT", self.root / "archives"),
        ):
            patcher = patch.object(control, field, path)
            patcher.start()
            self.addCleanup(patcher.stop)

    def run_command(self, args):
        self.calls.append(args)
        return dict(exitCode=0, stdout="container", stderr="")

    def request(self, action, payload):
        return control.dispatch(
            dict(version=1, id=str(uuid.uuid4()), action=action, payload=payload),
            self.config,
            self.account,
            self.run_command,
        )

    def test_private_mapping_uses_distinct_storage_ownership_and_fenced_configuration(self):
        self.request("claim", dict(lease=self.lease))
        engine = types.SimpleNamespace(pw_uid=os.getuid() + 17, pw_gid=os.getgid() + 17)
        payload = dict(lease=self.lease, image=self.config["images"][0])
        from runtime_backend import PREPARED_USER_NAMESPACE

        request = dict(version=1, id=str(uuid.uuid4()), action="create", payload=payload)
        result = control.dispatch(
            request,
            self.config,
            engine,
            self.run_command,
            storage_owner=self.account,
            user_namespace=PREPARED_USER_NAMESPACE,
            uid_mappings=[[0, 0, 1], [1, 1, 65536]],
            gid_mappings=[[0, 0, 1], [1, 1, 65536]],
        )
        self.assertEqual(result["configuration"]["userNamespace"], PREPARED_USER_NAMESPACE)
        self.assertIn("--uidmap=0:0:1", self.calls[0])
        self.assertIn("--gidmap=1:1:65536", self.calls[0])
        self.assertFalse(any(arg.startswith("--userns") for arg in self.calls[0]))
        self.assertEqual(result["configuration"]["uidMappings"], [[0, 0, 1], [1, 1, 65536]])
        self.assertIn("1000:1000", self.calls[0])
        self.assertEqual(
            (self.data / self.lease["assignmentId"] / "workspace").stat().st_uid,
            self.account.pw_uid,
        )
        import hashlib

        upload = str(uuid.uuid4())
        raw = b"exact\x00bytes"
        sha = hashlib.sha256(raw).hexdigest()

        def files(action, **extra):
            return control.dispatch(
                dict(version=1, id=str(uuid.uuid4()), action=action, payload={**payload, **extra}),
                self.config,
                engine,
                self.run_command,
                storage_owner=self.account,
                user_namespace=PREPARED_USER_NAMESPACE,
                uid_mappings=[[0, 0, 1], [1, 1, 65536]],
                gid_mappings=[[0, 0, 1], [1, 1, 65536]],
            )

        files(
            "file-write-begin",
            uploadId=upload,
            path="/workspace/result",
            bytes=len(raw),
            sha256=sha,
            mode=0o640,
        )
        files(
            "file-write-chunk",
            uploadId=upload,
            offset=0,
            base64=base64.b64encode(raw).decode(),
            sha256=sha,
        )
        files("file-write-finish", uploadId=upload)
        result = files("file-read", path="/workspace/result", offset=0, bytes=len(raw))
        self.assertEqual(base64.b64decode(result["base64"]), raw)
        self.assertEqual(
            (self.data / self.lease["assignmentId"] / "workspace/result").stat().st_uid,
            self.account.pw_uid,
        )
        from runtime_backend import WORKLOAD_USER_NAMESPACE

        with self.assertRaisesRegex(ValueError, "configuration_conflict"):
            control.dispatch(
                request,
                self.config,
                engine,
                self.run_command,
                storage_owner=self.account,
                user_namespace=WORKLOAD_USER_NAMESPACE,
            )
        self.assertEqual(len(self.calls), 1)

    def test_finalize_replays_after_each_interruption_and_rejects_stale_lease(self):
        self.request("claim", dict(lease=self.lease))
        archives = self.root / "archives"
        source = self.data / self.lease["assignmentId"]
        (source / "workspace").mkdir(parents=True)
        (source / "home").mkdir()
        (source / "workspace/bytes").write_bytes(os.urandom(1500 * 1024))
        archive = archives / (self.lease["assignmentId"] + ".tgz")
        checkpoint = capture({name: source / name for name in ("workspace", "home")}, archive)
        fence = Fence(self.root / "control/slot")
        with fence.locked():
            fence.write(
                {
                    **fence.read(),
                    "checkpoint": checkpoint,
                    "runtime": {"phase": "stopped", "name": "container"},
                }
            )
        fence.close(self.lease)
        ranged = self.request(
            "read-checkpoint",
            dict(lease=self.lease, image=self.config["images"][0], offset=0, bytes=1280 * 1024),
        )
        self.assertEqual(base64.b64decode(ranged["base64"]), archive.read_bytes()[: 1280 * 1024])
        with self.assertRaisesRegex(ValueError, "invalid_checkpoint_range"):
            self.request(
                "read-checkpoint",
                dict(
                    lease=self.lease,
                    image=self.config["images"][0],
                    offset=0,
                    bytes=1280 * 1024 + 1,
                ),
            )
        publication = dict(checkpointId=str(uuid.uuid4()), sha256=checkpoint["sha256"])
        payload = dict(lease=self.lease, image=self.config["images"][0], publication=publication)
        dispatch = control.dispatch
        for failed_step in ("release", "purge-source"):

            def interrupted(request, *args, **kwargs):
                if request["action"] == failed_step:
                    raise OSError("interrupted " + failed_step)
                return dispatch(request, *args, **kwargs)

            with (
                patch.object(control, "dispatch", side_effect=interrupted),
                patch.object(
                    self, "run_command", return_value=dict(exitCode=1, stdout="", stderr="")
                ),
            ):
                with self.assertRaisesRegex(OSError, "interrupted"):
                    dispatch(
                        dict(version=1, id="test", action="finalize", payload=payload),
                        self.config,
                        self.account,
                        self.run_command,
                    )
            self.assertTrue(source.exists(), "source preserved until final purge")
        with patch.object(self, "run_command", return_value=dict(exitCode=1, stdout="", stderr="")):
            result = self.request("finalize", payload)
            self.assertEqual(result, dict(finalized=True, checkpointId=publication["checkpointId"]))
            self.assertEqual(self.request("finalize", payload), result)
        self.assertFalse(source.exists())
        self.assertFalse(archive.exists())
        self.assertTrue((archives / "cache/archive.tgz").exists())
        for invalid in (
            dict(payload, lease=dict(self.lease, generation=2)),
            dict(payload, publication={**publication, "checkpointId": str(uuid.uuid4())}),
        ):
            with self.assertRaises(ValueError):
                self.request("finalize", invalid)

    def test_invalid_start_wait_is_rejected_before_command_admission(self):
        self.request("claim", dict(lease=self.lease))
        launched = []
        for wait in (-1, True, 1001, 0.5):
            with self.assertRaisesRegex(ValueError, "invalid_command_wait"):
                control.dispatch(
                    dict(
                        version=1,
                        id="wait",
                        action="command-start",
                        payload=dict(
                            lease=self.lease,
                            image=self.config["images"][0],
                            commandId=str(uuid.uuid4()),
                            argv=["true"],
                            waitMs=wait,
                        ),
                    ),
                    self.config,
                    self.account,
                    self.run_command,
                    launch=launched.append,
                )
        self.assertEqual(launched, [])
        self.assertEqual(Fence(self.root / "control/slot").read().get("commands", {}), {})

    def test_bulk_envelope_is_import_only_and_bounded(self):
        raw = dict(version=1, id="large", action="import-chunk", payload="x" * (5 * 1024**2))
        encoded = json.dumps(raw).encode()
        self.assertEqual(control.decode_request(encoded), raw)
        raw["action"] = "create"
        with self.assertRaisesRegex(ValueError, "host_request_limit"):
            control.decode_request(json.dumps(raw).encode())
        with self.assertRaisesRegex(ValueError, "host_request_limit"):
            control.decode_request(b"x" * (control.IMPORT_REQUEST_BYTES + 1))

    def test_injected_runtime_still_requires_current_host_lease(self):
        self.request("claim", dict(lease=self.lease))
        calls = []
        runtime = types.SimpleNamespace(
            create=lambda lease, memory, cpus: (
                calls.append((lease, memory, cpus)) or {"phase": "running"}
            )
        )
        backend = types.SimpleNamespace(lifecycle=lambda *args, **kwargs: runtime)
        payload = dict(lease=self.lease, image=self.config["images"][0])
        request = dict(version=1, id="injected", action="create", payload=payload)
        result = control.dispatch(
            request, self.config, self.account, self.run_command, backend=backend
        )
        self.assertEqual(result, {"phase": "running"})
        self.assertEqual(calls, [(self.lease, 512, 1)])
        for foreign in [dict(self.lease, owner="other"), dict(self.lease, generation=2)]:
            with self.assertRaises(ValueError):
                control.dispatch(
                    {**request, "payload": {**payload, "lease": foreign}},
                    self.config,
                    self.account,
                    self.run_command,
                    backend=backend,
                )
        self.assertEqual(len(calls), 1)
        self.assertEqual(self.calls, [])

    def test_single_host_fence_and_physical_identity(self):
        self.request("claim", dict(lease=self.lease))
        with self.assertRaisesRegex(ValueError, "physical_identity_conflict"):
            self.request(
                "claim",
                dict(
                    lease=dict(self.lease, slotId=str(uuid.uuid4()), assignmentId=str(uuid.uuid4()))
                ),
            )
        with self.assertRaisesRegex(ValueError, "physical_identity_conflict"):
            self.request("claim", dict(lease=dict(self.lease, machineId="different")))
        self.assertEqual(self.calls, [])

    def test_create_receipt_replay_never_restarts_workload(self):
        self.request("claim", dict(lease=self.lease))
        payload = dict(lease=self.lease, image=self.config["images"][0])
        first = self.request("create", payload)
        self.assertEqual(self.request("create", payload), first)
        self.assertEqual(len(self.calls), 1)
        with self.assertRaisesRegex(ValueError, "configuration_conflict"):
            self.request("create", dict(payload, memoryMb=1024))
        self.assertEqual(len(self.calls), 1)

    def test_invalid_protocol_and_unknown_actions_fail_closed(self):
        with self.assertRaisesRegex(ValueError, "invalid_protocol"):
            control.dispatch(dict(version=2), self.config, self.account, self.run_command)
        self.request("claim", dict(lease=self.lease))
        with self.assertRaisesRegex(ValueError, "unsupported_host_action"):
            self.request("outer-shell", dict(lease=self.lease, image=self.config["images"][0]))
        self.assertEqual(self.calls, [])

    def test_runtime_runner_resolves_system_tool_without_ambient_path(self):
        account = types.SimpleNamespace(pw_uid=1002, pw_dir="/var/lib/jetski-runtime")
        with patch.dict(os.environ, {"PATH": "/nonexistent"}):
            argv = runtime_argv(account)
        self.assertTrue(pathlib.Path(argv[0]).is_absolute())
        self.assertIn("env", argv)
        self.assertIn("-i", argv)

    def test_bounded_runner_stops_excess_output_and_timeout(self):
        with self.assertRaisesRegex(ValueError, "output_limit"):
            bounded_command(["python3", "-c", 'print("x"*100000)'], self.root, max_output=100)
        with self.assertRaisesRegex(TimeoutError, "timeout"):
            bounded_command(
                ["python3", "-c", "import time; time.sleep(30)"], self.root, timeout=0.05
            )
        result = bounded_command(["python3", "-c", 'print("ok")'], self.root)
        self.assertEqual(result["stdout"], "ok\n")


if __name__ == "__main__":
    unittest.main()
