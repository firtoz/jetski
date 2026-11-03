//! Incremental bounded TCP relay frames. Output requires R before D/F.
use crate::checkpoint_cache::reject;
use std::io;
pub const MAX_DATA: usize = 16384;
pub const MAGIC: &[u8] = b"JETSKI-STREAM/1\n";
pub struct Frame {
    pub tag: u8,
    pub bytes: Vec<u8>,
}
pub struct Decoder {
    output: bool,
    ready: bool,
    ended: bool,
    pending: Vec<u8>,
}
impl Decoder {
    pub fn new(output: bool) -> Self {
        Self {
            output,
            ready: !output,
            ended: false,
            pending: Vec::new(),
        }
    }
    pub fn feed(&mut self, data: &[u8]) -> io::Result<Vec<Frame>> {
        if data.len() > 1024 * 1024 {
            return Err(reject("stream_chunk_bound"));
        }
        let mut frames = Vec::new();
        for block in data.chunks(MAX_DATA) {
            if self.ended && !block.is_empty() {
                return Err(reject("invalid_stream_frame"));
            }
            self.pending.extend_from_slice(block);
            while self.pending.len() >= 5 {
                let tag = self.pending[0];
                let length = u32::from_be_bytes(self.pending[1..5].try_into().unwrap()) as usize;
                if self.ended || length > MAX_DATA {
                    return Err(reject("invalid_stream_frame"));
                }
                match tag {
                    b'R' if self.output && !self.ready && length == 0 => {}
                    b'D' if self.ready && length > 0 => {}
                    b'F' if self.ready && length == 0 => {}
                    _ => return Err(reject("invalid_stream_frame")),
                }
                if self.pending.len() < length + 5 {
                    break;
                }
                let bytes = self.pending.drain(..length + 5).collect();
                if tag == b'R' {
                    self.ready = true;
                }
                if tag == b'F' {
                    self.ended = true;
                }
                frames.push(Frame { tag, bytes });
            }
            if self.ended && !self.pending.is_empty() {
                return Err(reject("invalid_stream_frame"));
            }
        }
        Ok(frames)
    }
    pub fn finish(&self) -> io::Result<()> {
        if !self.pending.is_empty() || !self.ended {
            return Err(reject("stream_completion_unknown"));
        }
        Ok(())
    }
}
