//! Fenced checkpoint capture and bounded source reads.
use crate::{
    archive::{self, CaptureReceipt, Limits},
    checkpoint_cache::{regular, reject, valid_hash},
    fence::{Fence, Phase},
    protocol::Lease,
};
use base64::{Engine as _, engine::general_purpose::STANDARD};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    io::{self, Read, Seek, SeekFrom},
    path::Path,
};
pub const READ_BYTES: usize = 1280 * 1024;
// Freeze independently of the control protocol; changes require a new opt-in artifact.
pub const ENCODING: &str = "jetski-rust-tar-gzip-miniz-v1";
pub struct Checkpoints<'a> {
    pub fence: &'a Fence,
    pub archives: &'a Path,
    pub data: &'a Path,
}
impl Checkpoints<'_> {
    pub fn capture(&self, lease: &Lease, frame_bytes: usize) -> io::Result<CaptureReceipt> {
        lease.validate()?;
        if ![256 * 1024, 512 * 1024, 1024 * 1024].contains(&frame_bytes) {
            return Err(reject("invalid_capture_frame_size"));
        }
        let guard = self.fence.locked()?;
        let mut state = guard.read()?.ok_or_else(|| reject("stale_lease"))?;
        state.matches(lease)?;
        if state.phase != Phase::Closed
            || state
                .sections
                .get("runtime")
                .and_then(|v| v.get("phase"))
                .and_then(Value::as_str)
                != Some("stopped")
        {
            return Err(reject("capture_requires_quiescence"));
        }
        let intent = json!({"encoding":ENCODING,"frameBytes":frame_bytes});
        if let Some(old) = state.sections.get("captureEncoding") {
            if old != &intent {
                return Err(reject("capture_encoding_conflict"));
            }
        } else {
            // Once intent is durable, an interrupted save cannot change its encoder geometry.
            state.sections.insert("captureEncoding".into(), intent);
            guard.write(&state)?;
        }
        let target = self.archives.join(format!("{}.tgz", lease.assignment_id));
        if let Some(value) = state.sections.get("checkpoint") {
            let receipt: CaptureReceipt = serde_json::from_value(value.clone())
                .map_err(|_| reject("invalid_checkpoint_journal"))?;
            if !valid_hash(&receipt.sha256)
                || !crate::checkpoint_cache::CheckpointCache::verified(
                    &target,
                    &receipt.sha256,
                    receipt.bytes,
                )
            {
                return Err(reject("checkpoint_source_integrity"));
            }
            return Ok(receipt);
        }
        let source = self.data.join(&lease.assignment_id);
        let receipt = archive::capture(
            [&source.join("workspace"), &source.join("home")],
            &target,
            Limits::default(),
            frame_bytes,
        )?;
        state.sections.insert(
            "checkpoint".into(),
            serde_json::to_value(&receipt).map_err(io::Error::other)?,
        );
        guard.write(&state)?;
        Ok(receipt)
    }
    pub fn read(&self, lease: &Lease, offset: u64, bytes: usize) -> io::Result<Value> {
        lease.validate()?;
        if !(1..=READ_BYTES).contains(&bytes) {
            return Err(reject("invalid_checkpoint_range"));
        }
        let guard = self.fence.locked()?;
        let state = guard.read()?.ok_or_else(|| reject("stale_lease"))?;
        state.matches(lease)?;
        let total = state
            .sections
            .get("checkpoint")
            .and_then(|v| v.get("bytes"))
            .and_then(Value::as_u64)
            .ok_or_else(|| reject("checkpoint_range_unavailable"))?;
        if state.phase != Phase::Closed
            || offset
                .checked_add(bytes as u64)
                .is_none_or(|end| end > total)
        {
            return Err(reject("checkpoint_range_unavailable"));
        }
        let mut file = regular(&self.archives.join(format!("{}.tgz", lease.assignment_id)))?;
        if file.metadata()?.len() != total {
            return Err(reject("checkpoint_size_changed"));
        }
        file.seek(SeekFrom::Start(offset))?;
        let mut data = vec![0; bytes];
        file.read_exact(&mut data)?;
        Ok(
            json!({"offset":offset,"bytes":bytes,"sha256":format!("{:x}",Sha256::digest(&data)),"base64":STANDARD.encode(&data)}),
        )
    }
}
