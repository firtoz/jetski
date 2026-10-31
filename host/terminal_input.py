"""Host-only terminal input journal. Sent means accepted by the attach socket,
not consumed by the workload. Uncertain delivery is never automatically replayed.
"""

import base64
import hashlib
import pathlib
import struct
import uuid
from fence import Fence, identity


def operation_id(value):
    if not isinstance(value, str) or str(uuid.UUID(value)) != value:
        raise ValueError("invalid_terminal_input_id")
    return value


def frame(value):
    if not isinstance(value, dict) or "kind" not in value:
        raise ValueError("invalid_terminal_input")
    kind = value["kind"]
    if kind == "stdin" and set(value) == {"kind", "base64"}:
        encoded = value["base64"]
        if not isinstance(encoded, str) or len(encoded) > 21848:
            raise ValueError("terminal_input_bound")
        data = base64.b64decode(encoded, validate=True)
        if not 1 <= len(data) <= 16384 or base64.b64encode(data).decode() != encoded:
            raise ValueError("invalid_terminal_bytes")
        tag = b"I"
    elif kind == "resize" and set(value) == {"kind", "rows", "columns"}:
        if any(
            type(value[key]) is not int or not 1 <= value[key] <= 4096
            for key in ("rows", "columns")
        ):
            raise ValueError("invalid_terminal_dimensions")
        tag, data = b"R", struct.pack(">HH", value["rows"], value["columns"])
    elif kind == "signal" and set(value) == {"kind", "signal"}:
        signals = {"INT": 2, "QUIT": 3, "TSTP": 20}
        if value["signal"] not in signals:
            raise ValueError("unsupported_terminal_signal")
        tag, data = b"S", bytes([signals[value["signal"]]])
    elif kind == "close" and set(value) == {"kind"}:
        tag, data = b"C", b""
    else:
        raise ValueError("invalid_terminal_input")
    return tag + struct.pack(">I", len(data)) + data


class TerminalInputs:
    def __init__(self, fence, root):
        self.fence, self.root = fence, pathlib.Path(root)

    def context(self, lease, command):
        operation_id(command)
        state = self.fence.read()
        self.fence.match(state, lease)
        receipt = state.get("commands", {}).get(command)
        if receipt is None or not receipt["spec"].get("terminal"):
            raise ValueError("terminal_unavailable")
        ledger = Fence(self.root / lease["assignmentId"] / command)
        entries = ledger.read() or {"version": 1, "next": 0, "ops": {}}
        if set(entries) != {"version", "next", "ops"} or entries["version"] != 1:
            raise ValueError("terminal_journal_invalid")
        interrupted = False
        closed = state["phase"] != "open" or receipt["phase"] not in ("queued", "running")
        for item in entries["ops"].values():
            if item["phase"] == "dispatched":
                # A live sender holds this same fence until its final receipt.
                # Observing dispatched under the lock proves that sender exited
                # without publishing an outcome, not that the bytes were unsent.
                item["phase"] = "uncertain"
                interrupted = True
            elif item["phase"] == "queued" and closed:
                item["phase"] = "cancelled"
                del item["frame"]
                interrupted = True
        if interrupted:
            ledger.write(entries)
        return state, receipt, ledger, entries

    @staticmethod
    def public(receipt):
        return {key: value for key, value in receipt.items() if key != "frame"}

    def admit(self, raw, command, identifier, value):
        lease, identifier, data = identity(raw), operation_id(identifier), frame(value)
        digest = hashlib.sha256(data).hexdigest()
        with self.fence.locked():
            state, command_receipt, ledger, entries = self.context(lease, command)
            previous = entries["ops"].get(identifier)
            if previous is not None:
                if previous["sha256"] != digest:
                    raise ValueError("terminal_input_identity_conflict")
                return self.public(previous)
            if state["phase"] != "open" or command_receipt["phase"] not in ("queued", "running"):
                raise ValueError("terminal_closed")
            pending = [item for item in entries["ops"].values() if item["phase"] == "queued"]
            if len(entries["ops"]) >= 4096 or len(pending) >= 64:
                raise ValueError("terminal_input_history_bound")
            if any(
                item["phase"] in ("dispatched", "uncertain") for item in entries["ops"].values()
            ):
                raise ValueError("terminal_input_delivery_uncertain")
            receipt = dict(
                id=identifier,
                sequence=entries["next"],
                kind=value["kind"],
                bytes=len(data),
                sha256=digest,
                phase="queued",
                frame=base64.b64encode(data).decode(),
            )
            entries["next"] += 1
            entries["ops"][identifier] = receipt
            ledger.write(entries)
            return self.public(receipt)

    def status(self, raw, command, identifier):
        lease, identifier = identity(raw), operation_id(identifier)
        with self.fence.locked():
            state, terminal, _, entries = self.context(lease, command)
            receipt = entries["ops"].get(identifier)
            if receipt is None:
                closed = state["phase"] != "open" or terminal["phase"] not in ("queued", "running")
                return dict(id=identifier, phase="absent", closed=closed)
            return self.public(receipt)

    def dispatch_one(self, raw, command, send):
        lease = identity(raw)
        # Bounded attach send holds the fence: closing/reassigning cannot race
        # input delivery. Persist dispatched before crossing that boundary.
        with self.fence.locked():
            state, receipt, ledger, entries = self.context(lease, command)
            if state["phase"] != "open" or receipt["phase"] != "running":
                return False
            if any(
                item["phase"] in ("dispatched", "uncertain") for item in entries["ops"].values()
            ):
                raise ValueError("terminal_input_delivery_uncertain")
            pending = sorted(
                (item for item in entries["ops"].values() if item["phase"] == "queued"),
                key=lambda item: item["sequence"],
            )
            if not pending:
                return False
            current = pending[0]
            data = base64.b64decode(current["frame"], validate=True)
            if hashlib.sha256(data).hexdigest() != current["sha256"]:
                raise ValueError("terminal_input_corrupt")
            current["phase"] = "dispatched"
            ledger.write(entries)
            try:
                send(data)
            except BaseException:
                current["phase"] = "uncertain"
                ledger.write(entries)
                raise
            current["phase"] = "sent"
            del current["frame"]
            ledger.write(entries)
            return True
