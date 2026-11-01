"""Independent gzip members with bounded memory and verifiable frame metadata."""

import gzip
import hashlib

MAX_FRAME_BYTES = 4 * 1024 * 1024
FRAME_BYTES = 1024 * 1024
FRAMES_PER_LEVEL = 1024


class FrameWriter:
    def __init__(self, output, frame_bytes=FRAME_BYTES, adaptive=False):
        if type(frame_bytes) is not int or not 1024 <= frame_bytes <= MAX_FRAME_BYTES:
            raise ValueError("invalid_frame_bound")
        if type(adaptive) is not bool:
            raise ValueError("invalid_frame_policy")
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
        compressed = gzip.compress(raw, compresslevel=6, mtime=0)
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
        if self.adaptive and len(self.frames) in (FRAMES_PER_LEVEL, 2 * FRAMES_PER_LEVEL):
            self.frame_bytes = min(MAX_FRAME_BYTES, 2 * self.frame_bytes)
