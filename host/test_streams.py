import pathlib
import tempfile
import unittest
import uuid
from fence import Fence
from streams import Streams
from runtime import PodmanRuntime

IMAGE = "registry.example/linux@sha256:" + "a" * 64


class StreamTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.base = pathlib.Path(self.temp.name)
        self.fence = Fence(self.base / "control")
        self.lease = dict(
            owner="alice",
            machineId="host",
            poolId="pool",
            slotId=str(uuid.uuid4()),
            sandboxId=str(uuid.uuid4()),
            assignmentId=str(uuid.uuid4()),
            generation=1,
        )
        self.fence.claim(self.lease)
        with self.fence.locked():
            self.fence.write(
                {**self.fence.read(), "runtime": dict(phase="running", name="container")}
            )
        self.streams = Streams(self.fence)
        self.id = str(uuid.uuid4())
        self.session = "a" * 64
        self.created = 0

    def create(self, container, port):
        self.assertEqual(container, "container")
        self.assertEqual(port, 8080)
        self.assertEqual(self.fence.read()["streams"][self.id]["phase"], "dispatched")
        self.created += 1
        return self.session

    def test_dispatch_receipt_survives_lost_ack_and_reopen_without_second_create(self):
        self.streams.reserve(self.lease, self.id, 8080)
        result = self.streams.prepare(self.lease, self.id, self.create)
        self.assertTrue(result["fresh"])
        restarted = Streams(Fence(self.fence.root))
        replay = restarted.prepare(self.lease, self.id, self.create)
        self.assertFalse(replay["fresh"])
        self.assertEqual(replay["receipt"], result["receipt"])
        self.assertEqual(self.created, 1)
        with self.assertRaisesRegex(ValueError, "identity_conflict"):
            restarted.reserve(self.lease, self.id, 8081)
        self.assertTrue(restarted.connected(self.lease, self.id, self.session))
        self.assertEqual(restarted.status(self.lease, self.id)["phase"], "connected")
        self.assertEqual(
            restarted.finish(self.lease, self.id, self.session, lambda _: "complete")["delivery"],
            "complete",
        )
        self.assertFalse(restarted.prepare(self.lease, self.id, self.create)["fresh"])

    def test_cancel_before_admission_is_permanent_and_does_not_create(self):
        receipt = self.streams.cancel(self.lease, self.id)
        self.assertEqual(receipt["phase"], "cancelled")
        self.assertEqual(self.streams.reserve(self.lease, self.id, 8080), receipt)
        self.assertFalse(self.streams.prepare(self.lease, self.id, self.create)["fresh"])
        self.assertEqual(self.created, 0)

    def test_cancel_dispatched_requires_cleanup_proof_and_fences_late_connected(self):
        self.streams.reserve(self.lease, self.id, 8080)
        self.streams.prepare(self.lease, self.id, self.create)
        self.assertEqual(self.streams.cancel(self.lease, self.id)["phase"], "cancel_requested")
        self.assertFalse(self.streams.connected(self.lease, self.id, self.session))
        self.assertEqual(
            self.streams.finish(self.lease, self.id, self.session, lambda _: None)["phase"],
            "uncertain",
        )
        self.fence.close(self.lease)
        receipt = dict(checkpointId=str(uuid.uuid4()), sha256="a" * 64)
        with self.assertRaisesRegex(ValueError, "streams_unresolved"):
            self.fence.release(self.lease, lambda *_: True, receipt)
        finished = self.streams.finish(self.lease, self.id, self.session, lambda _: "cancelled")
        self.assertEqual(finished["delivery"], "unknown")
        self.fence.release(self.lease, lambda *_: True, receipt)
        with self.assertRaisesRegex(ValueError, "stale_lease"):
            self.streams.status({**self.lease, "generation": 2}, self.id)

    def test_uncertain_create_is_never_replayed(self):
        self.streams.reserve(self.lease, self.id, 8080)

        def lose(container, port):
            self.create(container, port)
            raise ConnectionError("lost create acknowledgement")

        with self.assertRaises(ConnectionError):
            self.streams.prepare(self.lease, self.id, lose)
        self.assertFalse(self.streams.prepare(self.lease, self.id, self.create)["fresh"])
        self.assertEqual(self.created, 1)
        self.assertEqual(self.streams.status(self.lease, self.id)["phase"], "uncertain")

    def test_runtime_stop_settles_cleanup_without_claiming_byte_delivery(self):
        self.streams.reserve(self.lease, self.id, 8080)
        self.streams.prepare(self.lease, self.id, self.create)

        def run(args):
            return dict(exitCode=0, stdout="false" if args[0] == "inspect" else "", stderr="")

        runtime = PodmanRuntime(self.fence, run, IMAGE, self.base / "data", [IMAGE])
        runtime.quiesce(self.lease)
        row = self.streams.status(self.lease, self.id)
        self.assertEqual(row["phase"], "cancelled")
        self.assertEqual(row["delivery"], "unknown")
        self.assertEqual(row["reason"], "runtime_stopped")
        self.assertFalse(self.streams.connected(self.lease, self.id, self.session))
        self.assertFalse(self.streams.prepare(self.lease, self.id, self.create)["fresh"])
        runtime.quiesce(self.lease)
        self.assertEqual(self.streams.status(self.lease, self.id), row)

    def test_failed_stop_keeps_stream_unresolved(self):
        self.streams.reserve(self.lease, self.id, 8080)
        self.streams.prepare(self.lease, self.id, self.create)
        runtime = PodmanRuntime(
            self.fence,
            lambda _: dict(exitCode=1, stdout="", stderr=""),
            IMAGE,
            self.base / "data",
            [IMAGE],
        )
        with self.assertRaises(RuntimeError):
            runtime.quiesce(self.lease)
        self.assertEqual(self.streams.status(self.lease, self.id)["phase"], "dispatched")

    def test_bounds_and_session_identity(self):
        for port in (True, 0, 65536, 1.5, "8080"):
            with self.assertRaises(ValueError):
                self.streams.reserve(self.lease, self.id, port)
        self.streams.reserve(self.lease, self.id, 8080)
        self.streams.prepare(self.lease, self.id, self.create)
        with self.assertRaisesRegex(ValueError, "session_conflict"):
            self.streams.connected(self.lease, self.id, "b" * 64)
        for _ in range(63):
            self.streams.reserve(self.lease, str(uuid.uuid4()), 8080)
        with self.assertRaisesRegex(ValueError, "active_limit"):
            self.streams.reserve(self.lease, str(uuid.uuid4()), 8080)
