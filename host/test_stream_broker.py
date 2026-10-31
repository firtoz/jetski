import os
import pathlib
import struct
import tempfile
import threading
import types
import unittest
import uuid
from unittest.mock import patch
from fence import Fence
from streams import Streams
from stream_broker import serve
from stream_protocol import Decoder


def frame(tag, data=b""):
    return tag + struct.pack(">I", len(data)) + data


class ProtocolTests(unittest.TestCase):
    def test_binary_fragmentation_and_strict_direction(self):
        wire = frame(b"R") + frame(b"D", bytes(range(256))) + frame(b"F")
        decoder = Decoder(output=True)
        observed = []
        for byte in wire:
            observed.extend(decoder.feed(bytes([byte])))
        decoder.finish()
        self.assertEqual(b"".join(item[1] for item in observed), wire)
        for wire in (
            frame(b"R"),
            frame(b"D"),
            frame(b"F", b"bad"),
            frame(b"Q"),
            b"D" + struct.pack(">I", 16385),
            frame(b"F") + frame(b"D", b"extra"),
        ):
            with self.assertRaises(ValueError):
                list(Decoder().feed(wire))
        for wire in (b"", b"D\0", frame(b"D", b"partial")):
            decoder = Decoder()
            list(decoder.feed(wire))
            with self.assertRaises(ValueError):
                decoder.finish()
        with self.assertRaises(ValueError):
            list(Decoder(output=True).feed(frame(b"D", b"no-ready")))


class BrokerTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.base = pathlib.Path(self.temp.name)
        self.fence = Fence(self.base / "slot")
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
                {
                    **self.fence.read(),
                    "runtime": dict(
                        phase="running",
                        name="container",
                        image="image",
                        configuration={"relay": True},
                    ),
                }
            )
        self.id = str(uuid.uuid4())
        self.request = dict(
            version=1,
            id=self.id,
            action="stream-open",
            payload=dict(lease=self.lease, image="image", streamId=self.id, port=8080),
        )
        self.config = dict(machineId="host", poolId="pool", images=["image"])
        self.account = types.SimpleNamespace(pw_uid=1000)
        self.created = 0
        self.removed = []
        self.sent = []
        self.fin = threading.Event()
        self.aborted = threading.Event()
        self.session = "a" * 64
        self.bad_output = False

    def create(self, container, argv, **options):
        self.created += 1
        self.assertEqual(argv, ["/jetski-tcp-relay", "--jetski-tcp-v1", "8080"])
        self.assertEqual(options, {"stdin": True})
        return self.session

    def send(self, data):
        self.sent.append(data)
        if data == frame(b"F"):
            self.fin.set()

    def output(self, session, **options):
        self.assertEqual(session, self.session)
        options["abort_ready"](self.aborted.set)
        options["input_ready"](self.send)
        yield "stdout", frame(b"R")
        if self.bad_output:
            yield "stdout", frame(b"R")
            return
        self.assertTrue(self.fin.wait(2))
        yield "stdout", frame(b"D", b"binary\0\xff") + frame(b"F")

    def invoke(self):
        source, writer = os.pipe()
        reader, destination = os.pipe()
        os.write(writer, frame(b"D", b"hello\0") + frame(b"F"))
        os.close(writer)
        api = types.SimpleNamespace(
            create=self.create,
            output=self.output,
            inspect=lambda _: {"Running": False, "ExitCode": 0},
            remove=self.removed.append,
        )
        try:
            with (
                patch("stream_broker.CONTROL_ROOT", self.base),
                patch("stream_broker.ExecApi", return_value=api),
            ):
                serve(self.request, self.config, self.account, source, destination)
            os.close(destination)
            destination = None
            return os.read(reader, 1024)
        finally:
            os.close(source)
            os.close(reader)
            if destination is not None:
                os.close(destination)

    def test_verified_completion_and_duplicate_never_reconnects(self):
        self.assertEqual(self.invoke(), frame(b"R") + frame(b"D", b"binary\0\xff") + frame(b"F"))
        row = Streams(self.fence).status(self.lease, self.id)
        self.assertEqual((row["phase"], row["delivery"]), ("closed", "complete"))
        self.assertEqual(self.sent, [frame(b"D", b"hello\0"), frame(b"F")])
        with self.assertRaisesRegex(ValueError, "already_dispatched"):
            self.invoke()
        self.assertEqual(self.created, 1)

    def test_bad_output_removes_exact_session_but_does_not_claim_cleanup(self):
        self.bad_output = True
        with self.assertRaisesRegex(ValueError, "invalid_stream_ready"):
            self.invoke()
        self.assertTrue(self.aborted.is_set())
        self.assertEqual(self.removed, [self.session])
        self.assertEqual(Streams(self.fence).status(self.lease, self.id)["phase"], "uncertain")
        with self.assertRaisesRegex(ValueError, "already_dispatched"):
            self.invoke()
        self.assertEqual(self.created, 1)

    def test_cancelled_admission_and_foreign_scope_do_not_create(self):
        Streams(self.fence).cancel(self.lease, self.id)
        with self.assertRaisesRegex(ValueError, "already_dispatched"):
            self.invoke()
        self.request["payload"]["lease"] = {**self.lease, "owner": "foreign"}
        with self.assertRaisesRegex(ValueError, "stale_lease"):
            self.invoke()
        self.assertEqual(self.created, 0)
