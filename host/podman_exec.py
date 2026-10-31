"""Bounded rootless Podman exec API. The Unix socket never enters workloads.

Session IDs are runtime identities, not PIDs. Callers must persist the session ID
and start intent before dispatch, and never replay an uncertain start.
"""

import http.client
import json
import pathlib
import re
import socket
import stat
import struct

VERSION = "/v4.0.0/libpod"
MAX_JSON = 1024 * 1024
MAX_FRAME = 1024 * 1024


def session_id(value):
    if not isinstance(value, str) or not re.fullmatch("[a-f0-9]{64}", value):
        raise ValueError("invalid_exec_session")
    return value


class UnixConnection(http.client.HTTPConnection):
    def __init__(self, path, timeout=30):
        super().__init__("localhost", timeout=timeout)
        self.path = path

    def connect(self):
        self.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.sock.settimeout(self.timeout)
        self.sock.connect(self.path)


def exact(stream, size, allow_eof=False):
    chunks = []
    left = size
    while left:
        data = stream.read(left)
        if not data:
            if allow_eof and left == size:
                return None
            raise ValueError("truncated_exec_stream")
        chunks.append(data)
        left -= len(data)
    return b"".join(chunks)


def frames(stream):
    while True:
        header = exact(stream, 8, allow_eof=True)
        if header is None:
            return
        channel, zero, size = header[0], header[1:4], struct.unpack(">I", header[4:])[0]
        if channel not in (1, 2) or zero != b"\0\0\0" or size > MAX_FRAME:
            raise ValueError("invalid_exec_stream_frame")
        yield ("stdout" if channel == 1 else "stderr"), exact(stream, size)


class ExecApi:
    def __init__(self, uid):
        if type(uid) is not int or uid < 1000:
            raise ValueError("invalid_runtime_uid")
        self.uid = uid
        self.path = pathlib.Path(f"/run/user/{uid}/podman/podman.sock")

    def connection(self, timeout=30):
        # The caller is privileged host code. Reject redirected/public sockets.
        for path in (self.path.parent.parent, self.path.parent):
            meta = path.lstat()
            if not stat.S_ISDIR(meta.st_mode) or meta.st_uid != self.uid or meta.st_mode & 0o022:
                raise ValueError("unsafe_runtime_socket_parent")
        meta = self.path.lstat()
        if not stat.S_ISSOCK(meta.st_mode) or meta.st_uid != self.uid or meta.st_mode & 0o007:
            raise ValueError("unsafe_runtime_socket")
        return UnixConnection(str(self.path), timeout)

    def request(self, method, path, data=None, statuses=(200,)):
        connection = self.connection()
        try:
            body = None if data is None else json.dumps(data).encode()
            if body is not None and len(body) > MAX_JSON:
                raise ValueError("exec_request_bound")
            connection.request(method, VERSION + path, body, {"Content-Type": "application/json"})
            response = connection.getresponse()
            raw = response.read(MAX_JSON + 1)
            if len(raw) > MAX_JSON or response.status not in statuses:
                raise ValueError("exec_api_response_invalid")
            return response.status, json.loads(raw) if raw else None
        finally:
            connection.close()

    def create(self, container, argv, cwd="/workspace", tty=False):
        from commands import specification

        specification(argv, cwd, 120)
        if not isinstance(container, str) or not re.fullmatch("jetski-[a-f0-9-]{36}", container):
            raise ValueError("invalid_exec_container")
        if type(tty) is not bool:
            raise ValueError("invalid_exec_tty")
        _, result = self.request(
            "POST",
            f"/containers/{container}/exec",
            {
                "Cmd": argv,
                "WorkingDir": cwd,
                "User": "1000:1000",
                "Privileged": False,
                "AttachStdin": False,
                "AttachStdout": True,
                "AttachStderr": True,
                "Tty": tty,
            },
            statuses=(201,),
        )
        return session_id(result["Id"])

    def inspect(self, session):
        _, result = self.request("GET", f"/exec/{session_id(session)}/json")
        if not isinstance(result, dict) or type(result.get("Running")) is not bool:
            raise ValueError("invalid_exec_status")
        return result

    def remove(self, session):
        session_id(session)
        self.request("POST", f"/exec/{session}/remove", {"Force": True}, statuses=(200, 204, 404))
        # Accepted removal alone is not terminal evidence.
        status, _ = self.request("GET", f"/exec/{session}/json", statuses=(200, 404))
        if status != 404:
            raise ValueError("exec_removal_unconfirmed")

    def output(self, session, timeout=150):
        """Starts once; yields binary stdout/stderr frames until remote closure.

        Do not call again after an exception. EOF is not exit-status evidence;
        inspect the persisted session separately before declaring completion.
        """
        session_id(session)
        if type(timeout) is not int or not 1 <= timeout <= 3630:
            raise ValueError("invalid_exec_stream_deadline")
        connection = self.connection(timeout)
        response = None
        try:
            connection.request(
                "POST",
                VERSION + f"/exec/{session}/start",
                json.dumps({"Detach": False, "Tty": False}),
                {"Content-Type": "application/json", "Connection": "Upgrade", "Upgrade": "tcp"},
            )
            response = connection.getresponse()
            if response.status not in (101, 200) or response.fp is None:
                raise ValueError("exec_attach_failed")
            # HTTP upgrade's body has no Content-Length; use its buffered socket
            # stream directly rather than HTTPResponse's zero-length 101 body.
            yield from frames(response.fp)
        finally:
            if response is not None:
                response.close()
            connection.close()
