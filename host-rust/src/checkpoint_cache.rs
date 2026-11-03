//! Owner-scoped local acceleration, published only after verified durable release.
use crate::{
    fence::{Fence, LockedFence, Phase, State},
    protocol::Lease,
};
use rustix::fs::{FileType, Mode, OFlags};
use serde::{Deserialize, Serialize};
use std::{
    fs::{self, File},
    io,
    os::unix::fs::MetadataExt,
    path::{Path, PathBuf},
};

pub(crate) fn reject(message: &'static str) -> io::Error {
    io::Error::other(message)
}
pub(crate) fn valid_hash(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}
pub(crate) fn sync_dir(path: &Path) -> io::Result<()> {
    File::from(rustix::fs::open(
        path,
        OFlags::RDONLY | OFlags::DIRECTORY | OFlags::NOFOLLOW | OFlags::CLOEXEC,
        Mode::empty(),
    )?)
    .sync_all()
}
pub(crate) fn private_dir(path: &Path) -> io::Result<()> {
    crate::terminal_input::ensure_private_directory(path)
}
pub(crate) fn regular(path: &Path) -> io::Result<File> {
    let file = File::from(rustix::fs::open(
        path,
        OFlags::RDONLY | OFlags::NOFOLLOW | OFlags::NONBLOCK | OFlags::CLOEXEC,
        Mode::empty(),
    )?);
    let meta = rustix::fs::fstat(&file)?;
    if FileType::from_raw_mode(meta.st_mode) != FileType::RegularFile
        || meta.st_uid != rustix::process::geteuid().as_raw()
        || meta.st_mode & 0o022 != 0
    {
        return Err(reject("unsafe_checkpoint_source"));
    }
    Ok(file)
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CachedCheckpoint {
    pub owner: String,
    pub sandbox: String,
    pub id: String,
    pub sha256: String,
    pub bytes: u64,
}
pub struct CheckpointCache<'a> {
    pub fence: &'a Fence,
    pub archives: &'a Path,
}
impl CheckpointCache<'_> {
    fn path(&self) -> io::Result<PathBuf> {
        let root = self.archives.join("cache");
        private_dir(&root)?;
        Ok(root.join("archive.tgz"))
    }
    pub fn candidate(
        &self,
        lease: &Lease,
        state: &State,
        sha256: &str,
        bytes: u64,
    ) -> io::Result<Option<(PathBuf, CachedCheckpoint)>> {
        let Some(value) = state.sections.get("localCheckpoint") else {
            return Ok(None);
        };
        let cached: CachedCheckpoint =
            serde_json::from_value(value.clone()).map_err(|_| reject("invalid_cache_journal"))?;
        if cached.owner != lease.owner
            || cached.sandbox != lease.sandbox_id
            || cached.sha256 != sha256
            || cached.bytes != bytes
        {
            return Ok(None);
        }
        if !crate::protocol::canonical_uuid(&cached.id) || !valid_hash(&cached.sha256) {
            return Err(reject("invalid_cache_journal"));
        }
        Ok(Some((self.path()?, cached)))
    }
    pub fn verified(path: &Path, sha256: &str, bytes: u64) -> bool {
        Self::verify(path, sha256, bytes).unwrap_or(false)
    }
    pub fn verify(path: &Path, sha256: &str, bytes: u64) -> io::Result<bool> {
        use sha2::{Digest, Sha256};
        use std::io::Read;
        let mut file = regular(path)?;
        let before = file.metadata()?;
        if before.len() != bytes {
            return Ok(false);
        }
        let mut hash = Sha256::new();
        let mut buffer = [0u8; 65536];
        loop {
            let n = file.read(&mut buffer)?;
            if n == 0 {
                break;
            }
            hash.update(&buffer[..n]);
        }
        let after = file.metadata()?;
        if before.len() != after.len()
            || before.mtime() != after.mtime()
            || before.mtime_nsec() != after.mtime_nsec()
            || before.ctime() != after.ctime()
            || before.ctime_nsec() != after.ctime_nsec()
        {
            return Err(reject("checkpoint_source_changed"));
        }
        Ok(format!("{:x}", hash.finalize()) == sha256)
    }
    pub fn publish(
        &self,
        lease: &Lease,
        publication: &serde_json::Value,
    ) -> io::Result<CachedCheckpoint> {
        let _timing = crate::timing::Stage::new("cache.publish");
        lease.validate()?;
        let guard = self.fence.locked()?;
        let mut state = guard.read()?.ok_or_else(|| reject("stale_lease"))?;
        state.matches(lease)?;
        let checkpoint = state
            .sections
            .get("checkpoint")
            .ok_or_else(|| reject("cache_requires_durable_release"))?;
        if state.phase != Phase::Released
            || state.sections.get("releaseReceipt") != Some(publication)
            || state
                .sections
                .get("runtime")
                .and_then(|v| v.get("phase"))
                .and_then(|v| v.as_str())
                != Some("removed")
            || checkpoint.get("sha256") != publication.get("sha256")
        {
            return Err(reject("cache_requires_durable_release"));
        }
        let expected = CachedCheckpoint {
            owner: lease.owner.clone(),
            sandbox: lease.sandbox_id.clone(),
            id: publication
                .get("checkpointId")
                .and_then(|v| v.as_str())
                .ok_or_else(|| reject("invalid_publication"))?
                .into(),
            sha256: checkpoint
                .get("sha256")
                .and_then(|v| v.as_str())
                .ok_or_else(|| reject("invalid_checkpoint"))?
                .into(),
            bytes: checkpoint
                .get("bytes")
                .and_then(|v| v.as_u64())
                .ok_or_else(|| reject("invalid_checkpoint"))?,
        };
        if !crate::protocol::canonical_uuid(&expected.id)
            || !valid_hash(&expected.sha256)
            || expected.bytes == 0
            || expected.bytes > 16 * 1024 * 1024 * 1024
        {
            return Err(reject("invalid_checkpoint"));
        }
        let destination = self.path()?;
        let source = self.archives.join(format!("{}.tgz", lease.assignment_id));
        match fs::symlink_metadata(&source) {
            Ok(_) => {
                if !Self::verified(&source, &expected.sha256, expected.bytes) {
                    return Err(reject("cache_source_integrity"));
                }
                match fs::rename(&source, &destination) {
                    Ok(()) => {}
                    Err(e) if e.raw_os_error() == Some(rustix::io::Errno::XDEV.raw_os_error()) => {
                        let mut pending =
                            tempfile::NamedTempFile::new_in(destination.parent().unwrap())?;
                        io::copy(&mut regular(&source)?, pending.as_file_mut())?;
                        pending.as_file().sync_all()?;
                        if !Self::verified(pending.path(), &expected.sha256, expected.bytes) {
                            return Err(reject("cache_copy_integrity"));
                        }
                        pending.persist(&destination).map_err(|e| e.error)?;
                    }
                    Err(e) => return Err(e),
                }
            }
            Err(e) if e.kind() == io::ErrorKind::NotFound => {
                if !Self::verified(&destination, &expected.sha256, expected.bytes) {
                    return Err(reject("cache_source_integrity"));
                }
            }
            Err(e) => return Err(e),
        }
        sync_dir(destination.parent().unwrap())?;
        sync_dir(self.archives)?;
        state.sections.insert(
            "localCheckpoint".into(),
            serde_json::to_value(&expected).map_err(io::Error::other)?,
        );
        guard.write(&state)?;
        Ok(expected)
    }
}
pub(crate) fn fresh(guard: &LockedFence<'_>, lease: &Lease) -> io::Result<State> {
    lease.validate()?;
    let state = guard.read()?.ok_or_else(|| reject("stale_lease"))?;
    state.matches(lease)?;
    if state.phase != Phase::Open || state.sections.contains_key("runtime") {
        return Err(reject("import_requires_fresh_assignment"));
    }
    Ok(state)
}
