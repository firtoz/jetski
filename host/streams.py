"""Host-only at-most-once relay admission. No network or workload bytes here.

A dispatched receipt is historical evidence, not proof a broker is still alive.
Restart observes it; it never reopens a connection. Only trusted relay completion
or verified whole-runtime quiescence makes an unresolved stream safe to release.
"""

import uuid
from fence import identity
from podman_exec import session_id

MAX_ACTIVE_STREAMS = 64
MAX_STREAM_HISTORY = 4096
TERMINAL = ("closed", "cancelled")


def stream_id(value):
    if not isinstance(value, str) or str(uuid.UUID(value)) != value:
        raise ValueError("invalid_stream_id")
    return value


def stopped_streams(state):
    """Caller holds fence and has verified the bound container is stopped.

    No delivery success is inferred from killing a relay. Its native code never
    forks; pending exec identities remain bound to the stopped old container.
    """
    if state.get("runtime", {}).get("phase") != "stopped":
        raise ValueError("stream_runtime_not_stopped")
    return {
        key: value
        if value["phase"] in TERMINAL
        else {**value, "phase": "cancelled", "delivery": "unknown", "reason": "runtime_stopped"}
        for key, value in state.get("streams", {}).items()
    }


class Streams:
    def __init__(self, fence):
        self.fence = fence

    def load(self, lease):
        state = self.fence.read()
        self.fence.match(state, lease)
        return state

    def reserve(self, raw, identifier, port):
        lease, identifier = identity(raw), stream_id(identifier)
        if type(port) is not int or not 1 <= port <= 65535:
            raise ValueError("invalid_stream_port")
        with self.fence.locked():
            state = self.load(lease)
            records = state.get("streams", {})
            prior = records.get(identifier)
            if prior:
                if prior["port"] not in (None, port):
                    raise ValueError("stream_identity_conflict")
                return prior
            if state["phase"] != "open" or state.get("runtime", {}).get("phase") != "running":
                raise ValueError("stream_runtime_not_running")
            if len(records) >= MAX_STREAM_HISTORY:
                raise ValueError("stream_history_limit")
            if sum(row["phase"] not in TERMINAL for row in records.values()) >= MAX_ACTIVE_STREAMS:
                raise ValueError("stream_active_limit")
            row = dict(
                id=identifier,
                port=port,
                phase="reserved",
                session=None,
                delivery="unknown",
                reason=None,
            )
            self.fence.write({**state, "streams": {**records, identifier: row}})
            return row

    def prepare(self, raw, identifier, create):
        """Create an unstarted runtime exec at most once. create is supervisor-owned.

        Caller may start the returned session only when fresh is true. Persisted
        dispatch intent precedes even exec creation; losing this ACK is uncertainty.
        """
        lease, identifier = identity(raw), stream_id(identifier)
        with self.fence.locked():
            state = self.load(lease)
            records = state.get("streams", {})
            row = records.get(identifier)
            if not row:
                raise ValueError("stream_unavailable")
            if row["phase"] != "reserved":
                return dict(fresh=False, receipt=row)
            if state["phase"] != "open" or state.get("runtime", {}).get("phase") != "running":
                raise ValueError("stream_runtime_not_running")
            row = {**row, "phase": "dispatched"}
            self.fence.write({**state, "streams": {**records, identifier: row}})
            try:
                session = session_id(create(state["runtime"]["name"], row["port"]))
            except Exception:
                self.fence.write(
                    {
                        **state,
                        "streams": {
                            **records,
                            identifier: {
                                **row,
                                "phase": "uncertain",
                                "reason": "exec_creation_uncertain",
                            },
                        },
                    }
                )
                raise
            row = {**row, "session": session}
            self.fence.write({**state, "streams": {**records, identifier: row}})
            return dict(fresh=True, receipt=row)

    def connected(self, raw, identifier, session):
        lease, identifier, session = identity(raw), stream_id(identifier), session_id(session)
        with self.fence.locked():
            state = self.load(lease)
            row = state.get("streams", {}).get(identifier)
            if not row or row["session"] != session:
                raise ValueError("stream_session_conflict")
            if state["phase"] != "open" or row["phase"] not in ("dispatched", "connected"):
                return False
            self.fence.write(
                {
                    **state,
                    "streams": {**state["streams"], identifier: {**row, "phase": "connected"}},
                }
            )
            return True

    def cancel(self, raw, identifier):
        lease, identifier = identity(raw), stream_id(identifier)
        with self.fence.locked():
            state = self.load(lease)
            records = state.get("streams", {})
            row = records.get(identifier)
            if row and row["phase"] in TERMINAL:
                return row
            if not row:
                if len(records) >= MAX_STREAM_HISTORY:
                    raise ValueError("stream_history_limit")
                row = dict(
                    id=identifier,
                    port=None,
                    phase="reserved",
                    session=None,
                    delivery="unknown",
                    reason=None,
                )
            phase = "cancelled" if row["phase"] == "reserved" else "cancel_requested"
            row = {**row, "phase": phase, "reason": "cancel_requested"}
            self.fence.write({**state, "streams": {**records, identifier: row}})
            return row

    def finish(self, raw, identifier, session, verify):
        """verify is trusted host code, never a field from an external request.

        It verifies relay termination and returns complete/cancelled or None.
        Removal acknowledgement or transport EOF alone is not completion proof.
        """
        lease, identifier, session = identity(raw), stream_id(identifier), session_id(session)
        with self.fence.locked():
            state = self.load(lease)
            row = state.get("streams", {}).get(identifier)
            if not row or row["session"] != session:
                raise ValueError("stream_session_conflict")
            if row["phase"] in TERMINAL:
                return row
            outcome = verify(session)
            if outcome not in ("complete", "cancelled"):
                phase, delivery = "uncertain", "unknown"
            else:
                phase = "closed" if outcome == "complete" else "cancelled"
                delivery = "complete" if outcome == "complete" else "unknown"
            row = {**row, "phase": phase, "delivery": delivery}
            self.fence.write({**state, "streams": {**state["streams"], identifier: row}})
            return row

    def status(self, raw, identifier):
        lease, identifier = identity(raw), stream_id(identifier)
        with self.fence.locked():
            state = self.load(lease)
            row = state.get("streams", {}).get(identifier)
            if not row:
                raise ValueError("stream_unavailable")
            return row
