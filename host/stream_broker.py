"""Authenticated host-control relay broker. Never replay a dispatched stream."""

import fcntl
import os
import select
import signal
import threading
import time
from fence import Fence, identity
from podman_exec import ExecApi
from stream_protocol import Decoder
from streams import Streams
from supervisor import CONTROL_ROOT


def write_frame(fd, data):
    deadline = time.monotonic() + 5
    at = 0
    while at < len(data):
        remaining = deadline - time.monotonic()
        if remaining <= 0 or not select.select([], [fd], [], remaining)[1]:
            raise TimeoutError("stream_output_backpressure")
        try:
            count = os.write(fd, data[at:])
        except BlockingIOError:
            continue
        if count <= 0:
            raise ValueError("stream_output_closed")
        at += count


def serve(request, config, account, source=0, destination=1):
    if (
        set(request) != {"version", "id", "action", "payload"}
        or request["version"] != 1
        or request["action"] != "stream-open"
    ):
        raise ValueError("invalid_stream_request")
    payload = request["payload"]
    if (
        not isinstance(payload, dict)
        or set(payload) != {"lease", "image", "streamId", "port"}
        or request["id"] != payload["streamId"]
    ):
        raise ValueError("invalid_stream_payload")
    lease = identity(payload["lease"])
    if (
        lease["machineId"] != config["machineId"]
        or lease["poolId"] != config["poolId"]
        or payload["image"] not in config["images"]
    ):
        raise ValueError("stream_scope_conflict")
    fence = Fence(CONTROL_ROOT / "slot")
    streams = Streams(fence)
    with fence.locked():
        state = fence.read()
        fence.match(state, lease)
        if (
            state.get("runtime", {}).get("image") != payload["image"]
            or state.get("runtime", {}).get("configuration", {}).get("relay") is not True
        ):
            raise ValueError("stream_image_conflict")
    identifier = payload["streamId"]
    streams.reserve(lease, identifier, payload["port"])
    api = ExecApi(account.pw_uid)
    admitted = streams.prepare(
        lease,
        identifier,
        lambda container, port: api.create(
            container, ["/jetski-tcp-relay", "--jetski-tcp-v1", str(port)], stdin=True
        ),
    )
    if not admitted["fresh"]:
        raise ValueError("stream_already_dispatched_observe_receipt")
    session = admitted["receipt"]["session"]
    halt, cancel, input_fin = threading.Event(), threading.Event(), threading.Event()
    aborters, readers = [], []
    output = Decoder(output=True)
    complete = False
    started = time.monotonic()
    previous = {}
    flags = fcntl.fcntl(destination, fcntl.F_GETFL)
    fcntl.fcntl(destination, fcntl.F_SETFL, flags | os.O_NONBLOCK)

    def input_ready(send):
        def consume():
            decoder = Decoder()
            try:
                while not halt.is_set():
                    if not select.select([source], [], [], 0.1)[0]:
                        continue
                    data = os.read(source, 16384)
                    if not data:
                        decoder.finish()
                        return
                    for tag, frame in decoder.feed(data):
                        send(frame)
                        if tag == b"F":
                            input_fin.set()
            except Exception:
                cancel.set()

        worker = threading.Thread(target=consume, daemon=True)
        readers.append(worker)
        worker.start()

    def watch():
        while not halt.wait(0.1):
            try:
                phase = streams.status(lease, identifier)["phase"]
                if (
                    phase in ("cancel_requested", "cancelled", "uncertain")
                    or time.monotonic() - started > 3600
                ):
                    cancel.set()
            except Exception:
                cancel.set()
            if cancel.is_set():
                try:
                    streams.cancel(lease, identifier)
                except Exception:
                    pass
                for abort in aborters:
                    abort()
                # Best-effort termination of this exact runtime identity. This
                # acknowledgement alone deliberately never settles cleanup.
                try:
                    api.remove(session)
                except Exception:
                    pass
                return

    monitor = threading.Thread(target=watch, daemon=True)
    for event in (signal.SIGINT, signal.SIGTERM):
        previous[event] = signal.signal(event, lambda *_: cancel.set())
    monitor.start()
    try:
        for channel, data in api.output(
            session, timeout=3630, input_ready=input_ready, abort_ready=aborters.append
        ):
            if cancel.is_set() or (channel == "stderr" and data):
                raise ValueError("stream_interrupted")
            if channel != "stdout":
                continue
            for tag, frame in output.feed(data):
                if tag == b"R" and not streams.connected(lease, identifier, session):
                    raise ValueError("stream_admission_cancelled")
                write_frame(destination, frame)
        output.finish()
        if not input_fin.is_set() or cancel.is_set():
            raise ValueError("stream_delivery_uncertain")
        for _ in range(20):
            observed = api.inspect(session)
            if not observed["Running"]:
                complete = observed.get("ExitCode") == 0
                break
            time.sleep(0.05)
        if not complete:
            raise ValueError("stream_completion_unconfirmed")
    finally:
        if not complete:
            cancel.set()
            monitor.join(timeout=65)
        halt.set()
        monitor.join(timeout=1)
        for worker in readers:
            worker.join(timeout=6)
        for event, handler in previous.items():
            signal.signal(event, handler)
        fcntl.fcntl(destination, fcntl.F_SETFL, flags)
        # A verified container stop may have settled the row concurrently. A
        # stale completion cannot overwrite a replacement assignment's receipt.
        streams.finish(lease, identifier, session, lambda _: "complete" if complete else None)
