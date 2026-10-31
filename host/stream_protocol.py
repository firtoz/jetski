"""Bounded v1 relay framing shared by authenticated host stream adapters."""

import struct

MAX_DATA = 16384
MAGIC = b"JETSKI-STREAM/1\n"


class Decoder:
    def __init__(self, output=False):
        self.output = output
        self.ready = not output
        self.ended = False
        self.pending = bytearray()

    def feed(self, data):
        if not isinstance(data, bytes) or len(data) > 1024 * 1024:
            raise ValueError("stream_chunk_bound")
        for at in range(0, len(data), MAX_DATA):
            self.pending.extend(data[at : at + MAX_DATA])
            while len(self.pending) >= 5:
                tag, length = self.pending[0:1], struct.unpack(">I", self.pending[1:5])[0]
                if self.ended or length > MAX_DATA:
                    raise ValueError("invalid_stream_frame")
                if tag == b"R":
                    if not self.output or self.ready or length:
                        raise ValueError("invalid_stream_ready")
                elif tag == b"D":
                    if not self.ready or not length:
                        raise ValueError("invalid_stream_data")
                elif tag == b"F":
                    if not self.ready or length:
                        raise ValueError("invalid_stream_fin")
                else:
                    raise ValueError("invalid_stream_tag")
                if len(self.pending) < length + 5:
                    break
                frame = bytes(self.pending[: length + 5])
                del self.pending[: length + 5]
                if tag == b"R":
                    self.ready = True
                if tag == b"F":
                    self.ended = True
                yield tag, frame

    def finish(self):
        if self.pending or not self.ended:
            raise ValueError("stream_completion_unknown")
