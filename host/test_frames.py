import gzip
import hashlib
import io
import unittest
from frames import FrameWriter


class FrameTests(unittest.TestCase):
    def encode(self, value):
        output = io.BytesIO()
        with FrameWriter(output, 1024) as writer:
            # Fragmented input exercises frame boundaries independently of writes.
            for index in range(0, len(value), 137):
                writer.write(value[index : index + 137])
        return output.getvalue(), writer.frames

    def test_independent_frames_and_concatenated_recovery(self):
        original = bytes(range(256)) * 100
        archive, frames = self.encode(original)
        self.assertEqual(gzip.decompress(archive), original)
        recovered = bytearray()
        for frame in frames:
            compressed = archive[frame["offset"] : frame["offset"] + frame["bytes"]]
            self.assertEqual(hashlib.sha256(compressed).hexdigest(), frame["sha256"])
            raw = gzip.decompress(compressed)
            self.assertEqual(hashlib.sha256(raw).hexdigest(), frame["expandedSha256"])
            self.assertEqual(len(raw), frame["expandedBytes"])
            recovered.extend(raw)
        self.assertEqual(recovered, original)

    def test_same_length_edit_changes_only_one_frame(self):
        data = bytearray(bytes(range(256)) * 100)
        _, before = self.encode(data)
        data[1300:1304] = b"edit"
        _, after = self.encode(data)
        changed = [
            i for i, pair in enumerate(zip(before, after)) if pair[0]["sha256"] != pair[1]["sha256"]
        ]
        self.assertEqual(changed, [1])
        self.assertEqual(len(before), len(after))

    def test_failed_capture_does_not_flush_partial_frame(self):
        output = io.BytesIO()
        with self.assertRaises(RuntimeError):
            with FrameWriter(output, 1024) as writer:
                writer.write(b"partial")
                raise RuntimeError("interrupted")
        self.assertEqual(output.getvalue(), b"")


if __name__ == "__main__":
    unittest.main()
