import io
import struct
import unittest
from podman_exec import ExecApi, frames, session_id


class ExecProtocolTests(unittest.TestCase):
    def test_binary_frames_and_empty_stream(self):
        def frame(channel, data):
            return bytes([channel, 0, 0, 0]) + struct.pack(">I", len(data)) + data

        stream = io.BytesIO(frame(1, b"a\0\xff") + frame(2, b"error") + frame(1, b""))
        self.assertEqual(
            list(frames(stream)), [("stdout", b"a\0\xff"), ("stderr", b"error"), ("stdout", b"")]
        )
        self.assertEqual(list(frames(io.BytesIO())), [])

    def test_truncation_and_invalid_headers_fail_closed(self):
        for data in (
            b"\1",
            b"\1\0\0\0\0\0\0\2x",
            b"\3\0\0\0\0\0\0\0",
            b"\1\1\0\0\0\0\0\0",
            b"\1\0\0\0\0\x20\0\0",
        ):
            with self.assertRaises(ValueError):
                list(frames(io.BytesIO(data)))

    def test_runtime_identity_validation(self):
        for value in ("../other", "", "a" * 65, "g" * 64, None):
            with self.assertRaises(ValueError):
                session_id(value)
        for value in (0, True, "1000"):
            with self.assertRaises(ValueError):
                ExecApi(value)
