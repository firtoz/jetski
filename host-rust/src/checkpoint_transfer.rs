//! Bounded outer-host transfer apertures. Never mapped into a workload.
use crate::{
    checkpoint_cache::{regular, reject, sync_dir, valid_hash},
    fence::{Fence, Phase},
    protocol::Lease,
};
use rustix::{
    fs::{self as sysfs, FileType, Mode, OFlags},
    process::Gid,
};
use serde_json::{Value, json};
use std::{
    fs::{self, File},
    io,
    path::{Path, PathBuf},
};

#[derive(Clone, Copy)]
pub struct Transfer<'a> {
    pub root: &'a Path,
    pub uid: u32,
    pub gid: u32,
}
impl Transfer<'_> {
    pub fn validate(&self) -> io::Result<()> {
        if self.uid == 0 || self.gid == 0 || self.uid == u32::MAX || self.gid == u32::MAX {
            return Err(reject("invalid_transfer_account"));
        }
        Ok(())
    }
    pub(crate) fn directory(&self, path: &Path, mode: u32) -> io::Result<File> {
        self.validate()?;
        match sysfs::mkdir(path, Mode::from_raw_mode(0o700)) {
            Ok(()) | Err(rustix::io::Errno::EXIST) => {}
            Err(e) => return Err(e.into()),
        }
        let file = File::from(sysfs::open(
            path,
            OFlags::RDONLY | OFlags::DIRECTORY | OFlags::NOFOLLOW | OFlags::CLOEXEC,
            Mode::empty(),
        )?);
        let meta = sysfs::fstat(&file)?;
        if meta.st_uid != rustix::process::geteuid().as_raw() {
            return Err(reject("unsafe_transfer_directory"));
        }
        if meta.st_mode & 0o7777 == 0o700 && fs::read_dir(path)?.next().is_none() {
            sysfs::fchown(&file, None, Some(Gid::from_raw(self.gid)))?;
            sysfs::fchmod(&file, Mode::from_raw_mode(mode))?;
        }
        let meta = sysfs::fstat(&file)?;
        if meta.st_gid != self.gid || meta.st_mode & 0o7777 != mode {
            return Err(reject("unsafe_transfer_directory"));
        }
        file.sync_all()?;
        sync_dir(
            path.parent()
                .ok_or_else(|| reject("invalid_transfer_root"))?,
        )?;
        Ok(file)
    }
    pub(crate) fn assignment(&self, lease: &Lease, mode: u32) -> io::Result<PathBuf> {
        self.directory(self.root, 0o750)?;
        let directory = self.root.join(&lease.assignment_id);
        self.directory(&directory, mode)?;
        Ok(directory)
    }
    pub(crate) fn only(&self, directory: &Path, name: &str) -> io::Result<bool> {
        let mut found = false;
        for entry in fs::read_dir(directory)? {
            if entry?.file_name() != name {
                return Err(reject("unexpected_transfer_file"));
            }
            found = true;
        }
        Ok(found)
    }
    pub(crate) fn import_close(&self, lease: &Lease) -> io::Result<()> {
        if !exists(self.root)? {
            return Ok(());
        }
        self.directory(self.root, 0o750)?;
        let directory = self.root.join(&lease.assignment_id);
        if !exists(&directory)? {
            return Ok(());
        }
        self.directory(&directory, 0o730)?;
        if self.only(&directory, "chunk.bin")? {
            let path = directory.join("chunk.bin");
            let meta = fs::symlink_metadata(&path)?;
            use std::os::unix::fs::MetadataExt;
            if !meta.is_file()
                || (meta.uid() != self.uid && meta.uid() != rustix::process::geteuid().as_raw())
            {
                return Err(reject("unsafe_import_transfer_file"));
            }
            fs::remove_file(path)?;
            sync_dir(&directory)?;
        }
        fs::remove_dir(&directory)?;
        sync_dir(self.root)
    }
}
pub(crate) fn exists(path: &Path) -> io::Result<bool> {
    match fs::symlink_metadata(path) {
        Ok(_) => Ok(true),
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(false),
        Err(e) => Err(e),
    }
}

pub struct CheckpointExport<'a> {
    pub fence: &'a Fence,
    pub archives: &'a Path,
    pub transfer: Transfer<'a>,
}
impl CheckpointExport<'_> {
    pub fn prepare(&self, lease: &Lease, sha256: &str, bytes: u64) -> io::Result<Value> {
        lease.validate()?;
        self.transfer.validate()?;
        let guard = self.fence.locked()?;
        let state = guard.read()?.ok_or_else(|| reject("stale_lease"))?;
        state.matches(lease)?;
        let checkpoint = state
            .sections
            .get("checkpoint")
            .ok_or_else(|| reject("checkpoint_export_unavailable"))?;
        if state.phase != Phase::Closed
            || !valid_hash(sha256)
            || checkpoint.get("sha256").and_then(Value::as_str) != Some(sha256)
            || checkpoint.get("bytes").and_then(Value::as_u64) != Some(bytes)
        {
            return Err(reject("checkpoint_export_unavailable"));
        }
        let source = self.archives.join(format!("{}.tgz", lease.assignment_id));
        let file = regular(&source)?;
        let meta = sysfs::fstat(&file)?;
        if meta.st_size < 0 || meta.st_size as u64 != bytes {
            return Err(reject("unsafe_checkpoint_export_source"));
        }
        let directory = self.transfer.assignment(lease, 0o750)?;
        self.transfer.only(&directory, "archive.tgz")?;
        let destination = directory.join("archive.tgz");
        if exists(&destination)? {
            use std::os::unix::fs::MetadataExt;
            let linked = fs::symlink_metadata(&destination)?;
            if !linked.is_file() || linked.dev() != meta.st_dev || linked.ino() != meta.st_ino {
                return Err(reject("checkpoint_export_conflict"));
            }
        } else {
            fs::hard_link(&source, &destination)?;
        }
        sysfs::fchown(&file, None, Some(Gid::from_raw(self.transfer.gid)))?;
        sysfs::fchmod(&file, Mode::from_raw_mode(0o640))?;
        file.sync_all()?;
        sync_dir(&directory)?;
        Ok(json!({"path":destination,"sha256":sha256,"bytes":bytes}))
    }
    pub fn close(&self, lease: &Lease) -> io::Result<Value> {
        lease.validate()?;
        self.transfer.validate()?;
        let guard = self.fence.locked()?;
        let state = guard.read()?.ok_or_else(|| reject("stale_lease"))?;
        state.matches(lease)?;
        if state.phase != Phase::Closed || !state.sections.contains_key("checkpoint") {
            return Err(reject("checkpoint_export_unavailable"));
        }
        if !exists(self.transfer.root)? {
            return Ok(json!({"closed":true}));
        }
        self.transfer.directory(self.transfer.root, 0o750)?;
        let directory = self.transfer.root.join(&lease.assignment_id);
        if !exists(&directory)? {
            return Ok(json!({"closed":true}));
        }
        self.transfer.directory(&directory, 0o750)?;
        if self.transfer.only(&directory, "archive.tgz")? {
            let source = regular(&self.archives.join(format!("{}.tgz", lease.assignment_id)))?;
            let meta = sysfs::fstat(&source)?;
            let path = directory.join("archive.tgz");
            let linked = fs::symlink_metadata(&path)?;
            use std::os::unix::fs::MetadataExt;
            if !linked.is_file() || linked.dev() != meta.st_dev || linked.ino() != meta.st_ino {
                return Err(reject("checkpoint_export_conflict"));
            }
            fs::remove_file(path)?;
            sync_dir(&directory)?;
        }
        fs::remove_dir(&directory)?;
        sync_dir(self.transfer.root)?;
        Ok(json!({"closed":true}))
    }
}

pub(crate) fn import_file(
    transfer: Transfer<'_>,
    lease: &Lease,
    length: usize,
    sha256: &str,
) -> io::Result<Vec<u8>> {
    use std::io::Read;
    if length == 0 || length > crate::checkpoint_import::FILE_CHUNK_BYTES || !valid_hash(sha256) {
        return Err(reject("invalid_import_file_extent"));
    }
    let directory = transfer.assignment(lease, 0o730)?;
    transfer.only(&directory, "chunk.bin")?;
    let path = directory.join("chunk.bin");
    let mut file = File::from(sysfs::open(
        path,
        OFlags::RDONLY | OFlags::NOFOLLOW | OFlags::NONBLOCK | OFlags::CLOEXEC,
        Mode::empty(),
    )?);
    let before = sysfs::fstat(&file)?;
    if FileType::from_raw_mode(before.st_mode) != FileType::RegularFile
        || before.st_size != length as i64
        || (before.st_uid != transfer.uid && before.st_uid != rustix::process::geteuid().as_raw())
    {
        return Err(reject("unsafe_import_transfer_file"));
    }
    let mut data = Vec::with_capacity(length);
    file.by_ref()
        .take((length + 1) as u64)
        .read_to_end(&mut data)?;
    let after = sysfs::fstat(&file)?;
    use sha2::{Digest, Sha256};
    if data.len() != length
        || before.st_size != after.st_size
        || before.st_mtime != after.st_mtime
        || before.st_mtime_nsec != after.st_mtime_nsec
        || before.st_ctime != after.st_ctime
        || before.st_ctime_nsec != after.st_ctime_nsec
        || format!("{:x}", Sha256::digest(&data)) != sha256
    {
        return Err(reject("import_file_integrity"));
    }
    Ok(data)
}
