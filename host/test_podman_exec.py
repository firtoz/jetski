import io
import struct
import unittest
from podman_exec import ExecApi, CompletionDecoder, frames, session_id


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

    def test_completion_proof_is_required_and_not_output(self):
        nonce = bytes(range(32))
        marker = b"\0jetski-complete-v1:" + nonce.hex().encode() + b":1:143\0"
        output = b"binary\0\xff" * 100
        for split in range(1, len(marker) + 1):
            decoder = CompletionDecoder(nonce)
            result = b""
            data = output + marker
            for offset in range(0, len(data), split):
                result += decoder.feed(data[offset : offset + split])
            self.assertEqual(result, output)
            self.assertEqual(
                decoder.finish(), dict(cancelled=True, exitCode=143, descendantsReaped=True)
            )
        for tail in (
            b"",
            marker[:-1],
            marker.replace(b":143", b":000"),
            marker + b"unexpected",
            marker.replace(b"000102", b"ffffff"),
        ):
            decoder = CompletionDecoder(nonce)
            decoder.feed(tail)
            with self.assertRaises(ValueError):
                decoder.finish()
