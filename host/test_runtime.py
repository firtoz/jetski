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


if __name__ == "__main__":
    unittest.main()
