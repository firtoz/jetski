import pathlib
import tempfile
import unittest
import uuid
from fence import Fence
from runtime import PodmanRuntime

IMAGE = "registry.example/linux@sha256:" + "a" * 64


class RuntimeTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.base = pathlib.Path(self.temp.name)
        self.fence = Fence(self.base / "control")
        self.lease = dict(
            owner="alice",
            poolId="pool",
            machineId="machine",
            slotId=str(uuid.uuid4()),
            sandboxId=str(uuid.uuid4()),
            assignmentId=str(uuid.uuid4()),
            generation=1,
        )
        self.fence.claim(self.lease)
        for root in ("workspace", "home"):
            (self.base / "data" / self.lease["assignmentId"] / root).mkdir(parents=True)
        self.calls = []

    def fake_run(self, args):
        self.calls.append(args)
        if args[0] == "inspect":
            return dict(exitCode=0, stdout="false\n")
        if args[:2] == ["container", "exists"]:
            return dict(exitCode=1, stdout="")
        return dict(exitCode=0, stdout="")

    def adapter(self, run=None):
        return PodmanRuntime(self.fence, run or self.fake_run, IMAGE, self.base / "data", [IMAGE])

    def test_closed_or_stale_fence_cannot_start_workload(self):
        self.fence.close(self.lease)
        with self.assertRaisesRegex(ValueError, "closed_lease"):
            self.adapter().create(self.lease)
        with self.assertRaisesRegex(ValueError, "stale_lease"):
            self.adapter().create(dict(self.lease, generation=2))
        self.assertEqual(self.calls, [])

    def test_uncertain_creation_is_not_replayed(self):
        def lost_ack(args):
            self.calls.append(args)
            raise ConnectionError("lost acknowledgement")

        with self.assertRaises(ConnectionError):
            self.adapter(lost_ack).create(self.lease)
        self.assertEqual(self.fence.read()["phase"], "quarantined")
        self.assertEqual(self.fence.read()["runtime"]["phase"], "creating")
        with self.assertRaises(ValueError):
            self.adapter().create(self.lease)
        self.assertEqual(len(self.calls), 1)

    def test_stop_and_remove_require_observed_runtime_cleanup(self):
        adapter = self.adapter()
        adapter.create(self.lease)
        with self.assertRaisesRegex(ValueError, "not_quiesced"):
            adapter.remove(self.lease)
        adapter.quiesce(self.lease)
        self.assertEqual(self.fence.read()["runtime"]["phase"], "stopped")
        adapter.remove(self.lease)
        self.assertEqual(self.fence.read()["runtime"]["phase"], "removed")
        self.assertEqual(self.fence.read()["phase"], "closed")

    def test_lost_removal_ack_observes_absence_without_replaying_rm(self):
        self.adapter().create(self.lease)
        self.adapter().quiesce(self.lease)
        present = True
        removals = 0

        def lost_ack(args):
            nonlocal present, removals
            if args[:2] == ["container", "exists"]:
                return dict(exitCode=0 if present else 1, stdout="")
            if args[0] == "rm":
                present = False
                removals += 1
                raise ConnectionError("lost removal acknowledgement")
            raise AssertionError(args)

        with self.assertRaises(ConnectionError):
            self.adapter(lost_ack).remove(self.lease)
        self.assertEqual(self.fence.read()["runtime"]["phase"], "stopped")
        self.adapter(lost_ack).remove(self.lease)
        self.assertEqual(removals, 1)
        self.assertEqual(self.fence.read()["runtime"]["phase"], "removed")

    def test_unknown_runtime_inspection_cannot_authorize_release(self):
        self.adapter().create(self.lease)
        self.adapter().quiesce(self.lease)
        with self.assertRaisesRegex(RuntimeError, "unknown"):
            self.adapter(lambda args: dict(exitCode=125, stdout="")).remove(self.lease)
        self.assertEqual(self.fence.read()["runtime"]["phase"], "stopped")

    def test_runtime_isolation_configuration_and_image_policy(self):
        self.adapter().create(self.lease)
        argv = self.calls[0]
        for required in (
            "--read-only",
            "--cap-drop=ALL",
            "--security-opt=no-new-privileges",
            "--network=none",
            "--pull=never",
        ):
            self.assertIn(required, argv)
        self.assertEqual(argv[argv.index("--user") + 1], "1000:1000")
        with self.assertRaisesRegex(ValueError, "digest_pinned"):
            PodmanRuntime(self.fence, self.fake_run, "linux:latest", self.base / "data", [])
        with self.assertRaisesRegex(ValueError, "not_approved"):
            PodmanRuntime(self.fence, self.fake_run, IMAGE, self.base / "data", [])

    def test_egress_is_explicit_bounded_and_fenced_against_policy_change(self):
        runtime = PodmanRuntime(
            self.fence, self.fake_run, IMAGE, self.base / "data", [IMAGE], network_mode="egress"
        )
        runtime.create(self.lease)
        self.assertIn("--network=slirp4netns:allow_host_loopback=false", self.calls[0])
        self.assertNotIn("--network=host", self.calls[0])
        with self.assertRaisesRegex(ValueError, "configuration_conflict"):
            self.adapter().create(self.lease)
        for mode in ("host", "bridge", "egress:allow_host_loopback=true", True, None):
            with self.assertRaisesRegex(ValueError, "invalid_network_policy"):
                PodmanRuntime(
                    self.fence, self.fake_run, IMAGE, self.base / "data", [IMAGE], network_mode=mode
                )

    def test_failed_public_namespace_proof_quarantines_without_replaying_launch(self):
        from unittest.mock import Mock

        network = Mock()
        network.prepare.return_value = {"namespace": {"pid": 42}}
        network.verify_workload.side_effect = ValueError("network_workload_namespace_mismatch")
        runtime = PodmanRuntime(
            self.fence,
            self.fake_run,
            IMAGE,
            self.base / "data",
            [IMAGE],
            network_mode="public-egress",
            network=network,
        )
        with self.assertRaisesRegex(ValueError, "namespace_mismatch"):
            runtime.create(self.lease)
        self.assertEqual(self.fence.read()["phase"], "quarantined")
        self.assertEqual(self.fence.read()["runtime"]["phase"], "creating")
        with self.assertRaisesRegex(ValueError, "closed_lease"):
            runtime.create(self.lease)
        self.assertEqual(len(self.calls), 1)
        network.cleanup.assert_not_called()


if __name__ == "__main__":
    unittest.main()
