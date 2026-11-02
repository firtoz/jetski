"""Independent gzip members with bounded memory and verifiable frame metadata."""

import gzip
import hashlib

MAX_FRAME_BYTES = 4 * 1024 * 1024
FRAME_BYTES = 1024 * 1024
FRAMES_PER_LEVEL = 1024
COMPRESSION_SAMPLE_BYTES = 8192
COMPRESSION_SAMPLE_WINDOWS = 5
COMPRESSION_MIN_SAVINGS_PERCENT = 1


def compress_frame(raw, compression_level=None):
    """Content-deterministic gzip, including stored blocks for high entropy data.

    Sampling is only a compression choice. The complete original member still
    receives gzip CRC and both compressed/expanded SHA-256 verification.
    An explicit level lets host integrations select another encoding policy.
    """
    if compression_level is not None and (
        type(compression_level) is not int or not 0 <= compression_level <= 9
    ):
        raise ValueError("invalid_compression_level")
    level = compression_level
    if level is None:
        level = 1
        width = COMPRESSION_SAMPLE_BYTES
        if len(raw) > width * COMPRESSION_SAMPLE_WINDOWS:
            sample = b"".join(
                raw[position : position + width]
                for position in (
                    (len(raw) - width) * index // (COMPRESSION_SAMPLE_WINDOWS - 1)
                    for index in range(COMPRESSION_SAMPLE_WINDOWS)
                )
            )
            encoded = gzip.compress(sample, compresslevel=1, mtime=0)
            if len(encoded) * 100 >= len(sample) * (100 - COMPRESSION_MIN_SAVINGS_PERCENT):
                level = 0
    return gzip.compress(raw, compresslevel=level, mtime=0)


class FrameWriter:
    def __init__(self, output, frame_bytes=FRAME_BYTES, adaptive=False, compression_level=None):
        if type(frame_bytes) is not int or not 1024 <= frame_bytes <= MAX_FRAME_BYTES:
            raise ValueError("invalid_frame_bound")
        if type(adaptive) is not bool:
            raise ValueError("invalid_frame_policy")
        if compression_level is not None and (
            type(compression_level) is not int or not 0 <= compression_level <= 9
        ):
            raise ValueError("invalid_compression_level")
        self.compression_level = compression_level
        self.adaptive = adaptive
        self.output = output
        self.frame_bytes = frame_bytes
        self.pending = bytearray()
        self.frames = []
        self.offset = 0

    def __enter__(self):
        return self

    def __exit__(self, exc_type, _exc, _tb):
        if exc_type is None:
            self.flush_frame()

    def write(self, data):
        view = memoryview(data)
        total = len(view)
        while view:
            count = min(len(view), self.frame_bytes - len(self.pending))
            self.pending.extend(view[:count])
            view = view[count:]
            if len(self.pending) == self.frame_bytes:
                self.flush_frame()
        return total

    def flush_frame(self):
        if not self.pending:
            return
        raw = bytes(self.pending)
        compressed = compress_frame(raw, self.compression_level)
        self.output.write(compressed)
        self.frames.append(
            dict(
                offset=self.offset,
                bytes=len(compressed),
                expandedBytes=len(raw),
                sha256=hashlib.sha256(compressed).hexdigest(),
                expandedSha256=hashlib.sha256(raw).hexdigest(),
            )
        )
        self.offset += len(compressed)
        self.pending.clear()
        # Keep the manifest within the existing bounded control response even
        # for large archives. Geometry depends only on the archive byte stream.
        if self.adaptive and len(self.frames) % FRAMES_PER_LEVEL == 0:
            self.frame_bytes = min(MAX_FRAME_BYTES, 2 * self.frame_bytes)
