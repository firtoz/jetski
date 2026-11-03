//! Independent gzip members compatible with the existing archive frame contract.
use flate2::{Compression, GzBuilder};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::io::{self, Write};

pub const FRAME_BYTES: usize = 1024 * 1024;
pub const MAX_FRAME_BYTES: usize = 4 * 1024 * 1024;
const FRAMES_PER_LEVEL: usize = 1024;
const SAMPLE_BYTES: usize = 8192;
const SAMPLE_WINDOWS: usize = 5;

fn gzip(raw: &[u8], level: u32) -> io::Result<Vec<u8>> {
    let mut encoder = GzBuilder::new()
        .mtime(0)
        .operating_system(3)
        .write(Vec::new(), Compression::new(level));
    encoder.write_all(raw)?;
    encoder.finish()
}

pub fn compress_frame(raw: &[u8], level: Option<u32>) -> io::Result<Vec<u8>> {
    if level.is_some_and(|level| level > 9) {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "invalid_compression_level",
        ));
    }
    let mut selected = level.unwrap_or(1);
    if level.is_none() && raw.len() > SAMPLE_BYTES * SAMPLE_WINDOWS {
        let mut sample = Vec::with_capacity(SAMPLE_BYTES * SAMPLE_WINDOWS);
        for index in 0..SAMPLE_WINDOWS {
            let position = (raw.len() - SAMPLE_BYTES) * index / (SAMPLE_WINDOWS - 1);
            sample.extend_from_slice(&raw[position..position + SAMPLE_BYTES]);
        }
        if gzip(&sample, 1)?.len() * 100 >= sample.len() * 99 {
            selected = 0;
        }
    }
    gzip(raw, selected)
}

fn digest(raw: &[u8]) -> String {
    format!("{:x}", Sha256::digest(raw))
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Frame {
    pub offset: u64,
    pub bytes: u64,
    pub expanded_bytes: u64,
    pub sha256: String,
    pub expanded_sha256: String,
}

pub struct FramedArchive<W> {
    pub output: W,
    pub frames: Vec<Frame>,
    pub sha256: String,
    pub bytes: u64,
}

/// `finish` is mandatory: drop never silently flushes or acknowledges a capture.
pub struct FrameWriter<W: Write> {
    output: W,
    pending: Vec<u8>,
    frame_bytes: usize,
    adaptive: bool,
    level: Option<u32>,
    frames: Vec<Frame>,
    offset: u64,
    compressed_hash: Sha256,
    poisoned: bool,
}

impl<W: Write> FrameWriter<W> {
    pub fn new(
        output: W,
        frame_bytes: usize,
        adaptive: bool,
        level: Option<u32>,
    ) -> io::Result<Self> {
        if !(1024..=MAX_FRAME_BYTES).contains(&frame_bytes) || level.is_some_and(|level| level > 9)
        {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "invalid_frame_policy",
            ));
        }
        Ok(Self {
            output,
            pending: Vec::with_capacity(frame_bytes),
            frame_bytes,
            adaptive,
            level,
            frames: Vec::new(),
            offset: 0,
            compressed_hash: Sha256::new(),
            poisoned: false,
        })
    }

    fn flush_frame(&mut self) -> io::Result<()> {
        if self.poisoned {
            return Err(io::Error::other("incomplete_capture"));
        }
        if self.pending.is_empty() {
            return Ok(());
        }
        let compressed = compress_frame(&self.pending, self.level)?;
        // A failed or zero-length underlying write never publishes frame metadata.
        if let Err(error) = self.output.write_all(&compressed) {
            self.poisoned = true;
            return Err(error);
        }
        self.compressed_hash.update(&compressed);
        self.frames.push(Frame {
            offset: self.offset,
            bytes: compressed.len() as u64,
            expanded_bytes: self.pending.len() as u64,
            sha256: digest(&compressed),
            expanded_sha256: digest(&self.pending),
        });
        self.offset += compressed.len() as u64;
        self.pending.clear();
        if self.adaptive && self.frames.len().is_multiple_of(FRAMES_PER_LEVEL) {
            self.frame_bytes = (self.frame_bytes * 2).min(MAX_FRAME_BYTES);
        }
        Ok(())
    }

    pub fn finish(mut self) -> io::Result<FramedArchive<W>> {
        self.flush_frame()?;
        self.output.flush()?;
        Ok(FramedArchive {
            output: self.output,
            frames: self.frames,
            sha256: format!("{:x}", self.compressed_hash.finalize()),
            bytes: self.offset,
        })
    }
}

impl<W: Write> Write for FrameWriter<W> {
    fn write(&mut self, mut raw: &[u8]) -> io::Result<usize> {
        if self.poisoned {
            return Err(io::Error::other("incomplete_capture"));
        }
        let total = raw.len();
        while !raw.is_empty() {
            let count = raw.len().min(self.frame_bytes - self.pending.len());
            self.pending.extend_from_slice(&raw[..count]);
            raw = &raw[count..];
            if self.pending.len() == self.frame_bytes {
                self.flush_frame()?;
            }
        }
        Ok(total)
    }

    fn flush(&mut self) -> io::Result<()> {
        // Stream flushing must not change deterministic member geometry.
        self.output.flush()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use flate2::read::MultiGzDecoder;
    use std::io::Read;

    fn encode(raw: &[u8], stride: usize) -> FramedArchive<Vec<u8>> {
        let mut writer = FrameWriter::new(Vec::new(), 1024, false, None).unwrap();
        for part in raw.chunks(stride) {
            writer.write_all(part).unwrap();
        }
        writer.finish().unwrap()
    }

    #[test]
    fn fragmented_writes_keep_geometry_and_independent_content_proofs() {
        let raw: Vec<u8> = (0_u8..=255).cycle().take(25_600).collect();
        let archive = encode(&raw, 137);
        let one = encode(&raw, raw.len());
        assert_eq!(archive.output, one.output);
        assert_eq!(archive.frames, one.frames);
        assert_eq!(archive.sha256, digest(&archive.output));
        let mut restored = Vec::new();
        MultiGzDecoder::new(archive.output.as_slice())
            .read_to_end(&mut restored)
            .unwrap();
        assert_eq!(restored, raw);
        for frame in archive.frames {
            let compressed =
                &archive.output[frame.offset as usize..(frame.offset + frame.bytes) as usize];
            assert_eq!(digest(compressed), frame.sha256);
            let mut expanded = Vec::new();
            MultiGzDecoder::new(compressed)
                .read_to_end(&mut expanded)
                .unwrap();
            assert_eq!(expanded.len() as u64, frame.expanded_bytes);
            assert_eq!(digest(&expanded), frame.expanded_sha256);
        }
    }

    #[test]
    fn same_length_edit_invalidates_only_its_member() {
        let mut raw: Vec<u8> = (0_u8..=255).cycle().take(25_600).collect();
        let before = encode(&raw, 137);
        raw[1300..1304].copy_from_slice(b"edit");
        let after = encode(&raw, 137);
        let changed: Vec<_> = before
            .frames
            .iter()
            .zip(after.frames)
            .enumerate()
            .filter_map(|(index, (a, b))| (a.sha256 != b.sha256).then_some(index))
            .collect();
        assert_eq!(changed, vec![1]);
    }

    #[test]
    fn underlying_short_then_zero_write_cannot_finish() {
        struct Broken(bool);
        impl Write for Broken {
            fn write(&mut self, raw: &[u8]) -> io::Result<usize> {
                if self.0 {
                    return Ok(0);
                }
                self.0 = true;
                Ok(raw.len().saturating_sub(1))
            }
            fn flush(&mut self) -> io::Result<()> {
                Ok(())
            }
        }
        let mut writer = FrameWriter::new(Broken(false), 1024, false, None).unwrap();
        assert!(writer.write_all(&vec![7; 1024]).is_err());
        assert!(writer.finish().is_err());
    }
}
