//! Staged file uploads. Publication consumes staging, so a retry cannot repeat a write.
use crate::fence::{Fence, LockedFence, Phase, State};
use crate::files::{Files, MAX_CHUNK, components};
use crate::protocol::{Lease, canonical_uuid};
use base64::{Engine as _, engine::general_purpose::STANDARD};
use rustix::fs::{self as sysfs, AtFlags, FileType, Mode, OFlags};
use rustix::process::{Gid, Uid};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::fs::File;
use std::io::{self, Read};
use std::os::unix::fs::FileExt;
use std::path::Path;

const MAX_BYTES: u64 = 64 * 1024 * 1024;
const MAX_UPLOADS: usize = 64;
fn reject(message: &'static str) -> io::Error {
    io::Error::other(message)
}
fn valid_hash(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}
fn default_mode() -> u32 {
    0o644
}
#[derive(Clone, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct UploadSpec {
    pub id: String,
    pub path: String,
    pub bytes: u64,
    pub sha256: String,
    #[serde(default = "default_mode")]
    pub mode: u32,
}
impl UploadSpec {
    fn validate(&self) -> io::Result<()> {
        if !canonical_uuid(&self.id) {
            return Err(reject("invalid_upload_id"));
        }
        if components(&self.path)?.len() < 2 {
            return Err(reject("upload_requires_file_path"));
        }
        if self.bytes > MAX_BYTES {
            return Err(reject("invalid_upload_size"));
        }
        if !valid_hash(&self.sha256) {
            return Err(reject("invalid_upload_digest"));
        }
        if self.mode > 0o777 {
            return Err(reject("invalid_upload_mode"));
        }
        Ok(())
    }
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum UploadPhase {
    Receiving,
    Publishing,
    Committed,
    Uncertain,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Receipt {
    pub id: String,
    pub path: String,
    pub bytes: u64,
    pub sha256: String,
    pub mode: u32,
    pub offset: u64,
    pub phase: UploadPhase,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub inode: Option<[u64; 2]>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parent: Option<[u64; 2]>,
}
impl Receipt {
    fn spec(&self) -> UploadSpec {
        UploadSpec {
            id: self.id.clone(),
            path: self.path.clone(),
            bytes: self.bytes,
            sha256: self.sha256.clone(),
            mode: self.mode,
        }
    }
}
pub struct Uploads<'a> {
    fence: &'a Fence,
    data: &'a Path,
    uid: u32,
    gid: u32,
    files: Files<'a>,
}
impl<'a> Uploads<'a> {
    /// Caller holds the released assignment fence; only validated private staging IDs.
    pub(crate) fn purge_locked(&self, state: &State) -> io::Result<()> {
        if state.phase != Phase::Released {
            return Err(reject("source_not_durably_released"));
        }
        let Some(rows) = state.sections.get("uploads") else {
            return Ok(());
        };
        let rows = rows
            .as_object()
            .ok_or_else(|| reject("invalid_upload_journal"))?;
        if rows.is_empty() {
            return Ok(());
        }
        let directory = self.staging()?;
        for id in rows.keys() {
            Self::receipt(state, id)?;
            match sysfs::statat(&directory, id, AtFlags::SYMLINK_NOFOLLOW) {
                Ok(meta) => {
                    if FileType::from_raw_mode(meta.st_mode) != FileType::RegularFile
                        || meta.st_uid != rustix::process::geteuid().as_raw()
                    {
                        return Err(reject("unsafe_upload_staging"));
                    }
                    sysfs::unlinkat(&directory, id, AtFlags::empty())?;
                }
                Err(rustix::io::Errno::NOENT) => {}
                Err(e) => return Err(e.into()),
            }
        }
        directory.sync_all()
    }
    pub fn new(
        fence: &'a Fence,
        data: &'a Path,
        uid: u32,
        gid: u32,
        parent_uid: u32,
    ) -> io::Result<Self> {
        if uid == u32::MAX || gid == u32::MAX {
            return Err(reject("invalid_upload_owner"));
        }
        Ok(Self {
            fence,
            data,
            uid,
            gid,
            files: Files::new(fence, data, uid, parent_uid),
        })
    }
    fn state(&self, guard: &LockedFence<'_>, lease: &Lease, writable: bool) -> io::Result<State> {
        lease.validate()?;
        let state = guard.read()?.ok_or_else(|| reject("stale_lease"))?;
        state.matches(lease)?;
        if writable
            && (state.phase != Phase::Open
                || state
                    .sections
                    .get("runtime")
                    .and_then(|v| v.get("phase"))
                    .and_then(Value::as_str)
                    != Some("running"))
        {
            return Err(reject("upload_requires_running_assignment"));
        }
        Ok(state)
    }
    fn staging(&self) -> io::Result<File> {
        let data = File::from(sysfs::open(
            self.data,
            OFlags::RDONLY | OFlags::DIRECTORY | OFlags::NOFOLLOW | OFlags::CLOEXEC,
            Mode::empty(),
        )?);
        match sysfs::mkdirat(&data, ".uploads", Mode::from_raw_mode(0o700)) {
            Ok(()) | Err(rustix::io::Errno::EXIST) => {}
            Err(error) => return Err(error.into()),
        }
        let directory = File::from(sysfs::openat(
            &data,
            ".uploads",
            OFlags::RDONLY | OFlags::DIRECTORY | OFlags::NOFOLLOW | OFlags::CLOEXEC,
            Mode::empty(),
        )?);
        let meta = sysfs::fstat(&directory)?;
        if meta.st_uid != rustix::process::geteuid().as_raw() || meta.st_mode & 0o077 != 0 {
            return Err(reject("unsafe_upload_staging"));
        }
        data.sync_all()?;
        Ok(directory)
    }
    fn receipt(state: &State, id: &str) -> io::Result<Receipt> {
        if !canonical_uuid(id) {
            return Err(reject("invalid_upload_id"));
        }
        let value = state
            .sections
            .get("uploads")
            .and_then(|v| v.get(id))
            .ok_or_else(|| reject("upload_unavailable"))?;
        let receipt: Receipt =
            serde_json::from_value(value.clone()).map_err(|_| reject("invalid_upload_journal"))?;
        receipt.spec().validate()?;
        if receipt.id != id
            || receipt.offset > receipt.bytes
            || (matches!(
                receipt.phase,
                UploadPhase::Publishing | UploadPhase::Committed
            ) && (receipt.inode.is_none() || receipt.parent.is_none()))
        {
            return Err(reject("invalid_upload_journal"));
        }
        Ok(receipt)
    }
    fn save(guard: &LockedFence<'_>, state: &mut State, receipt: Receipt) -> io::Result<Receipt> {
        let uploads = state
            .sections
            .entry("uploads".into())
            .or_insert_with(|| serde_json::json!({}))
            .as_object_mut()
            .ok_or_else(|| reject("invalid_upload_journal"))?;
        uploads.insert(
            receipt.id.clone(),
            serde_json::to_value(&receipt).map_err(io::Error::other)?,
        );
        guard.write(state)?;
        Ok(receipt)
    }
    pub fn begin(&self, lease: &Lease, spec: UploadSpec) -> io::Result<Receipt> {
        spec.validate()?;
        let guard = self.fence.locked()?;
        let mut state = self.state(&guard, lease, false)?;
        if state
            .sections
            .get("uploads")
            .and_then(|v| v.get(&spec.id))
            .is_some()
        {
            let receipt = Self::receipt(&state, &spec.id)?;
            if receipt.spec() != spec {
                return Err(reject("upload_identity_conflict"));
            }
            return Ok(receipt);
        }
        self.state(&guard, lease, true)?;
        if let Some(value) = state.sections.get("uploads")
            && value
                .as_object()
                .ok_or_else(|| reject("invalid_upload_journal"))?
                .len()
                >= MAX_UPLOADS
        {
            return Err(reject("upload_count_limit"));
        }
        let staging = self.staging()?;
        match sysfs::statat(&staging, &spec.id, AtFlags::SYMLINK_NOFOLLOW) {
            Err(rustix::io::Errno::NOENT) => {}
            Ok(_) => return Err(reject("upload_identity_already_used")),
            Err(error) => return Err(error.into()),
        }
        Self::save(
            &guard,
            &mut state,
            Receipt {
                id: spec.id,
                path: spec.path,
                bytes: spec.bytes,
                sha256: spec.sha256,
                mode: spec.mode,
                offset: 0,
                phase: UploadPhase::Receiving,
                inode: None,
                parent: None,
            },
        )
    }
    pub fn status(&self, lease: &Lease, id: &str) -> io::Result<Receipt> {
        let guard = self.fence.locked()?;
        Self::receipt(&self.state(&guard, lease, false)?, id)
    }
    pub fn chunk(
        &self,
        lease: &Lease,
        id: &str,
        offset: u64,
        encoded: &str,
        sha256: &str,
    ) -> io::Result<Receipt> {
        if encoded.len() > 350_000 {
            return Err(reject("invalid_upload_chunk"));
        }
        let bytes = STANDARD
            .decode(encoded)
            .map_err(|_| reject("invalid_upload_chunk"))?;
        if !(1..=MAX_CHUNK).contains(&bytes.len())
            || format!("{:x}", Sha256::digest(&bytes)) != sha256
        {
            return Err(reject("upload_chunk_integrity"));
        }
        let guard = self.fence.locked()?;
        let mut state = self.state(&guard, lease, true)?;
        let mut receipt = Self::receipt(&state, id)?;
        let end = offset
            .checked_add(bytes.len() as u64)
            .ok_or_else(|| reject("upload_chunk_extent"))?;
        if receipt.phase != UploadPhase::Receiving || offset > receipt.offset || end > receipt.bytes
        {
            return Err(reject("upload_chunk_extent"));
        }
        let staging = self.staging()?;
        let file = File::from(sysfs::openat(
            &staging,
            id,
            OFlags::RDWR | OFlags::CREATE | OFlags::NOFOLLOW | OFlags::NONBLOCK | OFlags::CLOEXEC,
            Mode::from_raw_mode(0o600),
        )?);
        let meta = sysfs::fstat(&file)?;
        if FileType::from_raw_mode(meta.st_mode) != FileType::RegularFile
            || meta.st_nlink != 1
            || meta.st_size < 0
            || (meta.st_size as u64) < receipt.offset
            || (meta.st_size as u64) > receipt.bytes
        {
            return Err(reject("upload_file_extent"));
        }
        let existing_len = (meta.st_size as u64)
            .saturating_sub(offset)
            .min(bytes.len() as u64) as usize;
        let mut existing = vec![0; existing_len];
        file.read_exact_at(&mut existing, offset)?;
        if existing != bytes[..existing_len] {
            return Err(reject("upload_replay_conflict"));
        }
        if offset < receipt.offset {
            if end > receipt.offset || existing_len != bytes.len() {
                return Err(reject("upload_replay_extent"));
            }
            return Ok(receipt);
        }
        file.write_all_at(&bytes, offset)?;
        file.sync_all()?;
        staging.sync_all()?;
        receipt.offset = end;
        Self::save(&guard, &mut state, receipt)
    }
    pub fn finish(&self, lease: &Lease, id: &str) -> io::Result<Receipt> {
        let guard = self.fence.locked()?;
        let mut state = self.state(&guard, lease, false)?;
        let mut receipt = Self::receipt(&state, id)?;
        if matches!(
            receipt.phase,
            UploadPhase::Committed | UploadPhase::Uncertain
        ) {
            return Ok(receipt);
        }
        self.state(&guard, lease, true)?;
        if receipt.offset != receipt.bytes {
            return Err(reject("upload_incomplete"));
        }
        let path = receipt.path.clone();
        let (parent, name) = path
            .rsplit_once('/')
            .ok_or_else(|| reject("invalid_file_path"))?;
        let destination = self.files.open_locked(&guard, lease, parent, true)?;
        let parent_meta = sysfs::fstat(&destination)?;
        let parent_id = [parent_meta.st_dev as u64, parent_meta.st_ino as u64];
        let staging = self.staging()?;
        if receipt.phase == UploadPhase::Receiving {
            let mut flags = OFlags::RDWR | OFlags::NOFOLLOW | OFlags::NONBLOCK | OFlags::CLOEXEC;
            if receipt.bytes == 0 {
                flags |= OFlags::CREATE;
            }
            let mut source = File::from(sysfs::openat(
                &staging,
                id,
                flags,
                Mode::from_raw_mode(0o600),
            )?);
            let meta = sysfs::fstat(&source)?;
            if FileType::from_raw_mode(meta.st_mode) != FileType::RegularFile
                || meta.st_nlink != 1
                || meta.st_size < 0
                || meta.st_size as u64 != receipt.bytes
            {
                return Err(reject("upload_integrity"));
            }
            let mut hasher = Sha256::new();
            let mut buffer = vec![0; MAX_CHUNK];
            loop {
                let n = source.read(&mut buffer)?;
                if n == 0 {
                    break;
                }
                hasher.update(&buffer[..n]);
            }
            if format!("{:x}", hasher.finalize()) != receipt.sha256 {
                return Err(reject("upload_integrity"));
            }
            sysfs::fchown(
                &source,
                Some(Uid::from_raw(self.uid)),
                Some(Gid::from_raw(self.gid)),
            )?;
            sysfs::fchmod(&source, Mode::from_raw_mode(receipt.mode))?;
            source.sync_all()?;
            staging.sync_all()?;
            receipt.inode = Some([meta.st_dev as u64, meta.st_ino as u64]);
            receipt.parent = Some(parent_id);
            receipt.phase = UploadPhase::Publishing;
            receipt = Self::save(&guard, &mut state, receipt)?;
        }
        if receipt.parent != Some(parent_id) {
            receipt.phase = UploadPhase::Uncertain;
            return Self::save(&guard, &mut state, receipt);
        }
        match sysfs::statat(&staging, id, AtFlags::SYMLINK_NOFOLLOW) {
            Ok(meta) => {
                if receipt.inode != Some([meta.st_dev, meta.st_ino])
                    || FileType::from_raw_mode(meta.st_mode) != FileType::RegularFile
                {
                    return Err(reject("upload_staging_changed"));
                }
                sysfs::renameat(&staging, id, &destination, name)?;
            }
            Err(rustix::io::Errno::NOENT) => {
                match sysfs::statat(&destination, name, AtFlags::SYMLINK_NOFOLLOW) {
                    Ok(meta) if receipt.inode == Some([meta.st_dev, meta.st_ino]) => {}
                    Ok(_) | Err(rustix::io::Errno::NOENT) => {
                        receipt.phase = UploadPhase::Uncertain;
                        return Self::save(&guard, &mut state, receipt);
                    }
                    Err(error) => return Err(error.into()),
                }
            }
            Err(error) => return Err(error.into()),
        }
        destination.sync_all()?;
        staging.sync_all()?;
        receipt.phase = UploadPhase::Committed;
        Self::save(&guard, &mut state, receipt)
    }
}
