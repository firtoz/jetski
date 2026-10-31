"""Disposable CI only: native relay bytes, half-close, corruption and isolation."""

import concurrent.futures
import io
import select
import os
import pathlib
import socket
import struct
import subprocess
import time
import uuid

LIMIT = 16384


def frame(tag, data=b""):
    return tag + struct.pack(">I", len(data)) + data


def exact(stream, count):
    data = bytearray()
    while len(data) < count:
        if isinstance(stream, io.BytesIO):
            part = stream.read(count - len(data))
        else:
            assert select.select([stream], [], [], 10)[0], "relay_output_deadline"
            part = os.read(stream.fileno(), count - len(data))
        if not part:
            raise AssertionError("truncated_relay_output")
        data.extend(part)
    return bytes(data)


def receive(stream):
    header = exact(stream, 5)
    size = struct.unpack(">I", header[1:])[0]
    assert size <= LIMIT and header[:1] in (b"R", b"D", b"F")
    assert header[:1] == b"D" or size == 0
    return header[:1], exact(stream, size)


def start(binary, port):
    return subprocess.Popen(
        [str(binary), "--jetski-tcp-v1", str(port)],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )


def cleanup(process):
    if process.poll() is None:
        process.terminate()
        try:
            process.wait(timeout=3)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait(timeout=3)
    for stream in (process.stdin, process.stdout, process.stderr):
        if stream:
            try:
                stream.close()
            except BrokenPipeError:
                pass


def listen():
    server = socket.socket()
    server.bind(("127.0.0.1", 0))
    server.listen(1)
    server.settimeout(10)
    return server


def local_checks(binary):
    data = bytes(range(256)) * 4096
    with listen() as server, concurrent.futures.ThreadPoolExecutor() as workers:

        def echo():
            with server.accept()[0] as connection:
                connection.settimeout(10)
                connection.setsockopt(socket.SOL_SOCKET, socket.SO_SNDBUF, 4096)
                while part := connection.recv(8192):
                    connection.sendall(part)

        echoed = workers.submit(echo)
        process = start(binary, server.getsockname()[1])
        try:
            assert receive(process.stdout) == (b"R", b"")

            def upload():
                for at in range(0, len(data), LIMIT):
                    process.stdin.write(frame(b"D", data[at : at + LIMIT]))
                process.stdin.write(frame(b"F"))
                process.stdin.flush()

            uploaded = workers.submit(upload)
            time.sleep(0.2)  # Allow stdout pressure while stdin remains active.
            observed = bytearray()
            while True:
                tag, part = receive(process.stdout)
                if tag == b"F":
                    break
                assert tag == b"D"
                observed.extend(part)
                assert len(observed) <= len(data)
            uploaded.result(timeout=10)
            echoed.result(timeout=10)
            assert bytes(observed) == data
            assert process.wait(timeout=5) == 0
        finally:
            cleanup(process)
    with listen() as server, concurrent.futures.ThreadPoolExecutor() as workers:

        def early_fin():
            with server.accept()[0] as connection:
                connection.settimeout(10)
                connection.sendall(b"read-half-closed")
                connection.shutdown(socket.SHUT_WR)
                observed = bytearray()
                while part := connection.recv(16384):
                    observed.extend(part)
                return bytes(observed)

        received = workers.submit(early_fin)
        process = start(binary, server.getsockname()[1])
        try:
            assert receive(process.stdout) == (b"R", b"")
            greeting = bytearray()
            while True:
                tag, part = receive(process.stdout)
                if tag == b"F":
                    break
                assert tag == b"D"
                greeting.extend(part)
                assert len(greeting) <= 16
            assert bytes(greeting) == b"read-half-closed"
            assert process.poll() is None
            for at in range(0, len(data), LIMIT):
                process.stdin.write(frame(b"D", data[at : at + LIMIT]))
            process.stdin.write(frame(b"F"))
            process.stdin.flush()
            assert received.result(timeout=10) == data
            assert process.wait(timeout=5) == 0
        finally:
            cleanup(process)
    for bad in (b"Q\0\0\0\0", b"D" + struct.pack(">I", LIMIT + 1), b"D\0"):
        with listen() as server:
            process = start(binary, server.getsockname()[1])
            try:
                with server.accept()[0] as connection:
                    connection.settimeout(5)
                    assert receive(process.stdout) == (b"R", b"")
                    process.stdin.write(bad)
                    process.stdin.close()
                    process.stdin = None
                    assert process.wait(timeout=5) == 125
                    assert connection.recv(1) == b""
            finally:
                cleanup(process)
    with socket.socket() as reserved:
        reserved.bind(("127.0.0.1", 0))
        process = start(binary, reserved.getsockname()[1])
        try:
            assert process.wait(timeout=6) == 125
            assert process.stdout.read() == b""
        finally:
            cleanup(process)
    for port in ("0", "65536", "localhost", "80;id", "-1"):
        process = start(binary, port)
        try:
            assert process.wait(timeout=5) == 125
        finally:
            cleanup(process)


def container_check(binary):
    image = os.environ["JETSKI_TEST_IMAGE"]
    name = "jetski-tcp-" + str(uuid.uuid4())
    subprocess.run(
        [
            "podman",
            "run",
            "--detach",
            "--name",
            name,
            "--network=none",
            "--cap-drop=ALL",
            "--security-opt=no-new-privileges",
            "--user",
            "1000:1000",
            "--mount",
            f"type=bind,src={binary},dst=/jetski-relay,ro",
            image,
            "/bin/sh",
            "-ec",
            "mkdir /tmp/web; printf relay-container > /tmp/web/index.html; exec busybox httpd -f -p 18080 -h /tmp/web",
        ],
        check=True,
        capture_output=True,
        timeout=30,
    )
    process = None
    try:
        for _ in range(50):
            ready = subprocess.run(
                [
                    "podman",
                    "exec",
                    name,
                    "/bin/sh",
                    "-c",
                    "grep -q ':46A0 .* 0A ' /proc/net/tcp /proc/net/tcp6",
                ],
                capture_output=True,
                timeout=5,
            )
            if ready.returncode == 0:
                break
            time.sleep(0.1)
        else:
            raise AssertionError("container_listener_unavailable")
        process = subprocess.Popen(
            ["podman", "exec", "-i", name, "/jetski-relay", "--jetski-tcp-v1", "18080"],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )
        output, errors = process.communicate(
            frame(b"D", b"GET / HTTP/1.0\r\nHost: localhost\r\n\r\n") + frame(b"F"), timeout=10
        )
        assert process.returncode == 0 and not errors
        stream = io.BytesIO(output)
        assert receive(stream) == (b"R", b"")
        response = bytearray()
        while True:
            tag, data = receive(stream)
            if tag == b"F":
                break
            assert tag == b"D"
            response.extend(data)
        assert stream.read() == b""
        assert bytes(response).startswith(b"HTTP/1.0 200")
        assert bytes(response).endswith(b"relay-container")
    finally:
        if process:
            cleanup(process)
        subprocess.run(
            ["podman", "rm", "--force", name], check=True, capture_output=True, timeout=30
        )


if __name__ == "__main__":
    if os.environ.get("GITHUB_ACTIONS") != "true":
        raise SystemExit("disposable_ci_required")
    binary = pathlib.Path(os.environ["JETSKI_TEST_TCP_RELAY"]).resolve()
    assert binary.is_file()
    local_checks(binary)
    container_check(binary)
    print(
        "TCP relay verified: exact binary bytes, both half-closes, malformed frames, isolated loopback, cleanup"
    )
