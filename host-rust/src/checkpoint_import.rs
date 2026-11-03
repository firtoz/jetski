//! Resumable checkpoint receiver; no workload admission before verified publication.
use crate::{
    archive::{self, Limits, Owner},
    checkpoint_cache::{self as cache, CachedCheckpoint, CheckpointCache, reject, valid_hash},
    fence::{Fence, LockedFence, State},
    protocol::{Lease, canonical_uuid},
};
use base64::{Engine as _, engine::general_purpose::STANDARD};
use rustix::fs::{FileType, Mode, OFlags};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    fs::{self, File},
    io::{self, Read, Seek, SeekFrom, Write},
    path::{Path, PathBuf},
};
pub const CHUNK_BYTES: usize = 4 * 1024 * 1024;
pub const FILE_CHUNK_BYTES: usize = 16 * 1024 * 1024;
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ImportPhase {
    Receiving,
    Extracting,
    Ready,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Receipt {
    pub id: String,
    pub sha256: String,
    pub bytes: u64,
    pub offset: u64,
    pub phase: ImportPhase,
    pub chunk_bytes: usize,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub entries: Option<usize>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cache_source: Option<CachedCheckpoint>,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub cache_rejected: bool,
}
impl Receipt {
    fn validate(&self) -> io::Result<()> {
        if !canonical_uuid(&self.id)
            || !valid_hash(&self.sha256)
            || self.bytes == 0
            || self.bytes > 16 * 1024 * 1024 * 1024
            || self.offset > self.bytes
            || self.chunk_bytes != CHUNK_BYTES
            || (self.phase != ImportPhase::Receiving && self.offset != self.bytes)
            || (self.phase == ImportPhase::Ready && self.entries.is_none())
        {
            return Err(reject("invalid_import_metadata"));
        }
        Ok(())
    }
}
pub struct CheckpointImport<'a> {
    pub fence: &'a Fence,
    pub archives: &'a Path,
    pub data: &'a Path,
    pub owner: Option<Owner>,
    pub transfer: Option<crate::checkpoint_transfer::Transfer<'a>>,
}
impl CheckpointImport<'_> {
    pub fn advertised(&self, receipt: &Receipt) -> io::Result<serde_json::Value> {
        let mut value = serde_json::to_value(receipt).map_err(io::Error::other)?;
        if self.transfer.is_some() {
            value["fileChunkBytes"] = serde_json::json!(FILE_CHUNK_BYTES);
        }
        Ok(value)
    }
    pub fn file_begin(&self, lease: &Lease) -> io::Result<serde_json::Value> {
        let transfer = self
            .transfer
            .ok_or_else(|| reject("binary_import_not_configured"))?;
        let guard = self.fence.locked()?;
        let state = cache::fresh(&guard, lease)?;
        if Self::receipt(&state)?.phase != ImportPhase::Receiving {
            return Err(reject("import_not_receiving"));
        }
        let directory = transfer.assignment(lease, 0o730)?;
        transfer.only(&directory, "chunk.bin")?;
        Ok(serde_json::json!({"path":directory.join("chunk.bin"),"chunkBytes":FILE_CHUNK_BYTES}))
    }
    pub fn file_chunk(
        &self,
        lease: &Lease,
        offset: u64,
        length: usize,
        sha256: &str,
    ) -> io::Result<Receipt> {
        let transfer = self
            .transfer
            .ok_or_else(|| reject("binary_import_not_configured"))?;
        let data = {
            let guard = self.fence.locked()?;
            cache::fresh(&guard, lease)?;
            crate::checkpoint_transfer::import_file(transfer, lease, length, sha256)?
        };
        self.commit(lease, offset, &data, sha256, FILE_CHUNK_BYTES)
    }
    pub fn file_close(&self, lease: &Lease) -> io::Result<serde_json::Value> {
        let transfer = self
            .transfer
            .ok_or_else(|| reject("binary_import_not_configured"))?;
        let guard = self.fence.locked()?;
        cache::fresh(&guard, lease)?;
        transfer.import_close(lease)?;
        Ok(serde_json::json!({"closed":true}))
    }
    fn path(&self, lease: &Lease) -> PathBuf {
        self.archives
            .join(format!("{}.upload", lease.assignment_id))
    }
    fn receipt(state: &State) -> io::Result<Receipt> {
        let r: Receipt = serde_json::from_value(
            state
                .sections
                .get("import")
                .ok_or_else(|| reject("import_unavailable"))?
                .clone(),
        )
        .map_err(|_| reject("invalid_import_journal"))?;
        r.validate()?;
        Ok(r)
    }
    fn save(guard: &LockedFence<'_>, state: &mut State, r: Receipt) -> io::Result<Receipt> {
        r.validate()?;
        state.sections.insert(
            "import".into(),
            serde_json::to_value(&r).map_err(io::Error::other)?,
        );
        guard.write(state)?;
        Ok(r)
    }
    pub fn begin(&self, lease: &Lease, id: &str, sha256: &str, bytes: u64) -> io::Result<Receipt> {
        let receipt = Receipt {
            id: id.into(),
            sha256: sha256.into(),
            bytes,
            offset: 0,
            phase: ImportPhase::Receiving,
            chunk_bytes: CHUNK_BYTES,
            entries: None,
            cache_source: None,
            cache_rejected: false,
        };
        receipt.validate()?;
        let guard = self.fence.locked()?;
        let mut state = cache::fresh(&guard, lease)?;
        let receipt = if state.sections.contains_key("import") {
            let previous = Self::receipt(&state)?;
            if previous.id != id || previous.sha256 != sha256 || previous.bytes != bytes {
                return Err(reject("import_identity_conflict"));
            }
            previous
        } else {
            if crate::checkpoint_transfer::exists(&self.data.join(&lease.assignment_id))?
                || crate::checkpoint_transfer::exists(&self.path(lease))?
            {
                return Err(reject("import_destination_exists"));
            }
            Self::save(&guard, &mut state, receipt)?
        };
        if receipt.phase != ImportPhase::Receiving || receipt.offset != 0 || receipt.cache_rejected
        {
            return Ok(receipt);
        }
        self.cached(&guard, lease, &mut state, receipt)
    }
    fn cached(
        &self,
        guard: &LockedFence<'_>,
        lease: &Lease,
        state: &mut State,
        mut receipt: Receipt,
    ) -> io::Result<Receipt> {
        let upload = self.path(lease);
        if crate::checkpoint_transfer::exists(&upload)? {
            if CheckpointCache::verified(&upload, &receipt.sha256, receipt.bytes) {
                receipt.offset = receipt.bytes;
                receipt.phase = ImportPhase::Extracting;
                return Self::save(guard, state, receipt);
            }
            return Ok(receipt);
        }
        let cache = CheckpointCache {
            fence: self.fence,
            archives: self.archives,
        };
        let Some((source, cached)) =
            cache.candidate(lease, state, &receipt.sha256, receipt.bytes)?
        else {
            return Ok(receipt);
        };
        // Only metadata is checked here: restore verifies all bytes before publication.
        let Ok(file) = cache::regular(&source) else {
            return Ok(receipt);
        };
        if file.metadata()?.len() != receipt.bytes {
            return Ok(receipt);
        }
        receipt.offset = receipt.bytes;
        receipt.phase = ImportPhase::Extracting;
        receipt.cache_source = Some(cached);
        Self::save(guard, state, receipt.clone())?;
        match self.finish_locked(guard, lease, state) {
            Ok(r) => Ok(r),
            Err(error) => {
                if crate::checkpoint_transfer::exists(&self.data.join(&lease.assignment_id))?
                    || CheckpointCache::verify(&source, &receipt.sha256, receipt.bytes)?
                {
                    return Err(error);
                }
                // Only invalid unpublished cache bytes can fall back to transfer.
                receipt.offset = 0;
                receipt.phase = ImportPhase::Receiving;
                receipt.cache_source = None;
                receipt.cache_rejected = true;
                Self::save(guard, state, receipt)
            }
        }
    }
    pub fn chunk(
        &self,
        lease: &Lease,
        offset: u64,
        encoded: &str,
        sha256: &str,
    ) -> io::Result<Receipt> {
        if encoded.len() > CHUNK_BYTES.div_ceil(3) * 4 {
            return Err(reject("invalid_import_chunk"));
        }
        let data = STANDARD
            .decode(encoded)
            .map_err(|_| reject("invalid_import_encoding"))?;
        self.commit(lease, offset, &data, sha256, CHUNK_BYTES)
    }
    pub(crate) fn commit(
        &self,
        lease: &Lease,
        offset: u64,
        data: &[u8],
        sha256: &str,
        limit: usize,
    ) -> io::Result<Receipt> {
        if data.is_empty()
            || data.len() > limit
            || !valid_hash(sha256)
            || format!("{:x}", Sha256::digest(data)) != sha256
        {
            return Err(reject("import_chunk_integrity"));
        }
        let guard = self.fence.locked()?;
        let mut state = cache::fresh(&guard, lease)?;
        let mut receipt = Self::receipt(&state)?;
        let end = offset
            .checked_add(data.len() as u64)
            .ok_or_else(|| reject("import_chunk_extent"))?;
        if receipt.phase != ImportPhase::Receiving
            || receipt.cache_source.is_some()
            || offset > receipt.offset
            || end > receipt.bytes
        {
            return Err(reject("import_chunk_extent"));
        }
        let mut flags = OFlags::RDWR | OFlags::NOFOLLOW | OFlags::NONBLOCK | OFlags::CLOEXEC;
        if offset == 0 {
            flags |= OFlags::CREATE
        }
        let mut file = File::from(rustix::fs::open(
            self.path(lease),
            flags,
            Mode::from_raw_mode(0o600),
        )?);
        let meta = rustix::fs::fstat(&file)?;
        if FileType::from_raw_mode(meta.st_mode) != FileType::RegularFile
            || meta.st_uid != rustix::process::geteuid().as_raw()
            || meta.st_mode & 0o077 != 0
            || meta.st_nlink != 1
            || meta.st_size < 0
            || (meta.st_size as u64) < receipt.offset
            || meta.st_size as u64 > receipt.bytes
        {
            return Err(reject("import_file_extent"));
        }
        file.seek(SeekFrom::Start(offset))?;
        let mut existing = vec![0; data.len()];
        let n = file.read(&mut existing)?;
        // read_exact avoids treating a short read as an absent acknowledged prefix.
        let available = (meta.st_size as u64)
            .saturating_sub(offset)
            .min(data.len() as u64) as usize;
        if n < available {
            file.read_exact(&mut existing[n..available])?;
        }
        if existing[..available] != data[..available] {
            return Err(reject("import_replay_conflict"));
        }
        if offset < receipt.offset {
            if end > receipt.offset || available != data.len() {
                return Err(reject("import_replay_extent"));
            }
            return Ok(receipt);
        }
        file.seek(SeekFrom::Start(offset))?;
        file.write_all(data)?;
        file.sync_all()?;
        cache::sync_dir(self.archives)?;
        receipt.offset = end;
        Self::save(&guard, &mut state, receipt)
    }
    pub fn finish(&self, lease: &Lease) -> io::Result<Receipt> {
        let guard = self.fence.locked()?;
        let mut state = cache::fresh(&guard, lease)?;
        self.finish_locked(&guard, lease, &mut state)
    }
    fn finish_locked(
        &self,
        guard: &LockedFence<'_>,
        lease: &Lease,
        state: &mut State,
    ) -> io::Result<Receipt> {
        let mut receipt = Self::receipt(state)?;
        if receipt.offset != receipt.bytes {
            return Err(reject("import_incomplete"));
        }
        if let Some(transfer) = self.transfer {
            transfer.import_close(lease)?;
        }
        if receipt.phase == ImportPhase::Ready {
            return Ok(receipt);
        }
        let source = if let Some(selected) = &receipt.cache_source {
            let cache = CheckpointCache {
                fence: self.fence,
                archives: self.archives,
            };
            let (source, current) = cache
                .candidate(lease, state, &receipt.sha256, receipt.bytes)?
                .ok_or_else(|| reject("import_cache_identity_changed"))?;
            if selected != &current {
                return Err(reject("import_cache_identity_changed"));
            }
            source
        } else {
            self.path(lease)
        };
        if cache::regular(&source)?.metadata()?.len() != receipt.bytes {
            return Err(reject("import_archive_integrity"));
        }
        let destination = self.data.join(&lease.assignment_id);
        if receipt.phase == ImportPhase::Receiving
            && crate::checkpoint_transfer::exists(&destination)?
        {
            return Err(reject("unexpected_import_destination"));
        }
        receipt.phase = ImportPhase::Extracting;
        Self::save(guard, state, receipt.clone())?;
        match fs::symlink_metadata(&destination) {
            Ok(meta) => {
                if !meta.is_dir() || meta.is_symlink() {
                    return Err(reject("unsafe_import_destination"));
                }
                // Only extracting can own this unpublished root. The fence excludes admission.
                fs::remove_dir_all(&destination)?;
                cache::sync_dir(self.data)?;
            }
            Err(e) if e.kind() == io::ErrorKind::NotFound => {}
            Err(e) => return Err(e),
        }
        let restored = archive::restore(
            &source,
            &destination,
            &receipt.sha256,
            Limits::default(),
            self.owner,
        )?;
        receipt.phase = ImportPhase::Ready;
        receipt.entries = Some(restored.entries);
        Self::save(guard, state, receipt)
    }
}
