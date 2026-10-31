import base64
import pathlib
import tempfile
import unittest
import uuid
from fence import Fence
from terminal_input import TerminalInputs, frame


class TerminalInputTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = pathlib.Path(temporary.name)
        self.fence = Fence(self.root / "fence")
        self.lease = dict(
            owner="owner",
            machineId="host",
            poolId="pool",
            slotId=str(uuid.uuid4()),
            sandboxId=str(uuid.uuid4()),
            assignmentId=str(uuid.uuid4()),
            generation=1,
        )
        self.command = str(uuid.uuid4())
        self.fence.claim(self.lease)
        with self.fence.locked():
            state = self.fence.read()
            state["commands"] = {self.command: dict(spec=dict(terminal=True), phase="running")}
            self.fence.write(state)
        self.inputs = TerminalInputs(self.fence, self.root / "inputs")
        with self.fence.locked():
            self.inputs.initialize_locked(self.lease, self.command)

    def test_reconnect_observes_order_and_never_resends(self):
        identifiers = [str(uuid.uuid4()) for _ in range(2)]
        value = dict(kind="stdin", base64=base64.b64encode(b"a\0\xff").decode())
        first = self.inputs.admit(self.lease, self.command, identifiers[0], value)
        self.assertNotIn("frame", first)
        self.inputs.admit(
            self.lease, self.command, identifiers[1], dict(kind="resize", rows=40, columns=100)
        )
        sent = []
        self.inputs.dispatch_one(self.lease, self.command, sent.append)
        restarted = TerminalInputs(Fence(self.root / "fence"), self.root / "inputs")
        self.assertEqual(
            restarted.admit(self.lease, self.command, identifiers[0], value)["phase"], "sent"
        )
        restarted.dispatch_one(self.lease, self.command, sent.append)
        self.assertFalse(restarted.dispatch_one(self.lease, self.command, sent.append))
        self.assertEqual(sent, [frame(value), frame(dict(kind="resize", rows=40, columns=100))])
        with self.assertRaisesRegex(ValueError, "identity_conflict"):
            restarted.admit(self.lease, self.command, identifiers[0], dict(kind="close"))
        with self.assertRaisesRegex(ValueError, "stale_lease"):
            restarted.status(dict(self.lease, owner="foreign"), self.command, identifiers[0])

    def test_uncertain_send_is_not_replayed_after_restart(self):
        identifier = str(uuid.uuid4())
        self.inputs.admit(self.lease, self.command, identifier, dict(kind="close"))
        sent = []

        def lost(data):
            sent.append(data)
            raise ConnectionError("lost acknowledgement")

        with self.assertRaises(ConnectionError):
            self.inputs.dispatch_one(self.lease, self.command, lost)
        restarted = TerminalInputs(Fence(self.root / "fence"), self.root / "inputs")
        self.assertEqual(
            restarted.status(self.lease, self.command, identifier)["phase"], "uncertain"
        )
        with self.assertRaisesRegex(ValueError, "delivery_uncertain"):
            restarted.dispatch_one(self.lease, self.command, sent.append)
        self.assertEqual(len(sent), 1)

    def test_abandoned_dispatch_is_observed_as_uncertain_without_send(self):
        identifier = str(uuid.uuid4())
        self.inputs.admit(self.lease, self.command, identifier, dict(kind="close"))
        ledger = Fence(self.root / "inputs" / self.lease["assignmentId"] / self.command)
        with self.fence.locked():
            entries = ledger.read()
            entries["ops"][identifier]["phase"] = "dispatched"
            ledger.write(entries)
        restarted = TerminalInputs(Fence(self.root / "fence"), self.root / "inputs")
        self.assertEqual(
            restarted.status(self.lease, self.command, identifier)["phase"], "uncertain"
        )
        self.assertEqual(ledger.read()["ops"][identifier]["phase"], "uncertain")
        sent = []
        with self.assertRaisesRegex(ValueError, "delivery_uncertain"):
            restarted.dispatch_one(self.lease, self.command, sent.append)
        self.assertEqual(sent, [])

    def test_closed_terminal_settles_unsent_inputs_without_delivery(self):
        identifier = str(uuid.uuid4())
        value = dict(kind="stdin", base64="YQ==")
        self.inputs.admit(self.lease, self.command, identifier, value)
        self.fence.close(self.lease)
        observed = self.inputs.status(self.lease, self.command, identifier)
        self.assertEqual(observed["phase"], "cancelled")
        self.assertEqual(self.inputs.admit(self.lease, self.command, identifier, value), observed)
        sent = []
        self.assertFalse(self.inputs.dispatch_one(self.lease, self.command, sent.append))
        self.assertEqual(sent, [])

    def test_lost_journal_cannot_prove_input_absence(self):
        identifier = str(uuid.uuid4())
        self.inputs.admit(self.lease, self.command, identifier, dict(kind="close"))
        path = self.root / "inputs" / self.lease["assignmentId"] / self.command / "state.json"
        path.unlink()
        self.fence.close(self.lease)
        with self.assertRaisesRegex(ValueError, "journal_unavailable"):
            self.inputs.status(self.lease, self.command, identifier)
        with self.assertRaisesRegex(ValueError, "journal_unavailable"):
            self.inputs.status(self.lease, self.command, str(uuid.uuid4()))

    def test_validation_and_closed_fence(self):
        for value in [
            dict(kind="stdin", base64=""),
            dict(kind="resize", rows=True, columns=80),
            dict(kind="signal", signal="KILL"),
            dict(kind="close", extra=True),
        ]:
            with self.assertRaises(ValueError):
                frame(value)
        self.fence.close(self.lease)
        with self.assertRaisesRegex(ValueError, "closed"):
            self.inputs.admit(self.lease, self.command, str(uuid.uuid4()), dict(kind="close"))
