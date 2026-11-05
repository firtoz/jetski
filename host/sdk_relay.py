"""Credit-limited stdio bridge for SDKs without duplex backpressure.

Private host control only. Four 16 KiB output frames can be outstanding; input is
acknowledged only after the child consumes its pipe write. No replay or persistence.
"""

import os
import queue
import struct
import subprocess
import sys
import threading
from pathlib import Path

MAGIC = b"JSKIIO1\n"
CHUNK = 16384
WINDOW = 4 * CHUNK
DATA, ACK, FIN, EXIT = range(4)


def run(program):
    child = subprocess.Popen(program, stdin=subprocess.PIPE, stdout=subprocess.PIPE)
    writes = queue.Queue(maxsize=4)
    lock = threading.Lock()
    credit = threading.Condition()
    outstanding = 0
    stopped = False
    failures = []

    def emit(kind, body=b""):
        with lock:
            sys.stdout.buffer.write(struct.pack(">BI", kind, len(body)) + body)
            sys.stdout.buffer.flush()

    def fail(error):
        nonlocal stopped
        failures.append(error)
        stopped = True
        with credit:
            credit.notify_all()
        child.terminate()

    def output():
        nonlocal outstanding
        try:
            while True:
                with credit:
                    credit.wait_for(lambda: stopped or outstanding + CHUNK <= WINDOW)
                    if stopped:
                        return
                body = os.read(child.stdout.fileno(), CHUNK)
                if not body:
                    break
                with credit:
                    outstanding += len(body)
                emit(DATA, body)
            code = child.wait()
            emit(EXIT, struct.pack(">i", code))
        except (OSError, ValueError) as error:
            fail(error)

    def input_writer():
        try:
            while True:
                body = writes.get()
                if body is None:
                    child.stdin.close()
                    return
                child.stdin.write(body)
                child.stdin.flush()
                emit(ACK, struct.pack(">I", len(body)))
        except (OSError, ValueError) as error:
            fail(error)

    def exact(size):
        value = bytearray()
        while len(value) < size:
            body = sys.stdin.buffer.read(size - len(value))
            if not body:
                raise EOFError("SDK relay input closed")
            value.extend(body)
        return bytes(value)

    try:
        sys.stdout.buffer.write(MAGIC)
        sys.stdout.buffer.flush()
        threading.Thread(target=output, daemon=True).start()
        threading.Thread(target=input_writer, daemon=True).start()
        ended = False
        while not stopped:
            kind, size = struct.unpack(">BI", exact(5))
            if kind == DATA and 0 < size <= CHUNK and not ended:
                # A sender exceeding its credit window fails rather than blocking
                # the reader that must also receive output acknowledgements.
                writes.put_nowait(exact(size))
            elif kind == ACK and size == 4:
                count = struct.unpack(">I", exact(4))[0]
                with credit:
                    if count == 0 or count > outstanding:
                        raise ValueError("Invalid SDK output credit")
                    outstanding -= count
                    credit.notify_all()
            elif kind == FIN and size == 0 and not ended:
                ended = True
                writes.put_nowait(None)
            else:
                raise ValueError("Invalid SDK relay frame")
    except EOFError:
        pass
    finally:
        stopped = True
        with credit:
            credit.notify_all()
        if child.poll() is None:
            child.terminate()
            try:
                child.wait(timeout=2)
            except subprocess.TimeoutExpired:
                child.kill()
                child.wait(timeout=2)
        child.stdin.close()
        child.stdout.close()
    if failures:
        raise RuntimeError("SDK relay failed") from failures[0]


if __name__ == "__main__":
    run([sys.executable, "-I", str(Path(__file__).with_name("control.py"))])
