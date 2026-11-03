//! Bounded reads of declared persistent files; workload symlinks are never followed.
use crate::fence::{Fence, LockedFence, Phase};
use crate::protocol::{Lease, MAX_GENERATION};
use base64::{Engine as _, engine::general_purpose::STANDARD};
use rustix::fs::{self as sysfs, AtFlags, Dir, FileType, Mode, OFlags, Stat};
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::fs::File;
use std::io;
use std::os::fd::AsRawFd;
use std::os::unix::fs::FileExt;
use std::path::Path;

pub const MAX_CHUNK: usize = 256 * 1024;
pub const MAX_ENTRIES: usize = 10_000;
fn reject(message: &'static str) -> io::Error {
    io::Error::other(message)
}

pub fn components(path: &str) -> io::Result<Vec<&str>> {
    if path.len() > 4096 || path.contains('\0') {
        return Err(reject("invalid_file_path"));
    }
    let parts = if path == "/workspace" {
        vec!["workspace"]
    } else if let Some(suffix) = path.strip_prefix("/workspace/") {
        std::iter::once("workspace")
            .chain(suffix.split('/'))
            .collect()
    } else if path == "/home/sandbox" {
        vec!["home"]
    } else if let Some(suffix) = path.strip_prefix("/home/sandbox/") {
        std::iter::once("home").chain(suffix.split('/')).collect()
    } else {
        return Err(reject("undeclared_persistent_path"));
    };
    if parts.iter().any(|part| ["", ".", ".."].contains(part)) {
        return Err(reject("invalid_file_component"));
    }
    Ok(parts)
}

pub fn version(meta: &Stat) -> String {
    // Match Python's integer tuple representation; atime is deliberately excluded.
    let mtime = meta.st_mtime as i128 * 1_000_000_000 + meta.st_mtime_nsec as i128;
    let ctime = meta.st_ctime as i128 * 1_000_000_000 + meta.st_ctime_nsec as i128;
    let value = format!(
        "({}, {}, {}, {}, {}, {})",
        meta.st_dev, meta.st_ino, meta.st_size, mtime, ctime, meta.st_mode
    );
    format!("{:x}", Sha256::digest(value.as_bytes()))
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileChunk {
    pub base64: String,
    pub offset: u64,
    pub next_offset: u64,
    pub size: u64,
    pub eof: bool,
    pub version: String,
    pub sha256: String,
}
#[derive(Debug, Serialize)]
pub struct DirectoryEntry {
    pub name: String,
    pub kind: &'static str,
    pub mode: u32,
    pub size: i64,
}
#[derive(Debug, Serialize)]
pub struct Listing {
    pub entries: Vec<DirectoryEntry>,
    pub next: Option<String>,
    pub version: String,
}

pub struct Files<'a> {
    fence: &'a Fence,
    data: &'a Path,
    uid: u32,
    parent_uid: u32,
}
impl<'a> Files<'a> {
    /// Installation/configuration validates trusted data-root ancestors. The
    /// assignment parent and every workload component are independently pinned.
    pub fn new(fence: &'a Fence, data: &'a Path, uid: u32, parent_uid: u32) -> Self {
        Self {
            fence,
            data,
            uid,
            parent_uid,
        }
    }
    pub(crate) fn open_locked(
        &self,
        guard: &LockedFence<'_>,
        lease: &Lease,
        path: &str,
        directory: bool,
    ) -> io::Result<File> {
        lease.validate()?;
        let parts = components(path)?;
        let state = guard.read()?.ok_or_else(|| reject("stale_lease"))?;
        state.matches(lease)?;
        if state.phase != Phase::Open
            || state
                .sections
                .get("runtime")
                .and_then(|v| v.get("phase"))
                .and_then(|v| v.as_str())
                != Some("running")
        {
            return Err(reject("file_access_requires_running_assignment"));
        }
        let mut file = File::from(sysfs::open(
            self.data,
            OFlags::RDONLY | OFlags::DIRECTORY | OFlags::NOFOLLOW | OFlags::CLOEXEC,
            Mode::empty(),
        )?);
        for (index, part) in std::iter::once(lease.assignment_id.as_str())
            .chain(parts.iter().copied())
            .enumerate()
        {
            let mut flags = OFlags::PATH | OFlags::NOFOLLOW | OFlags::CLOEXEC;
            if index < parts.len() || directory {
                flags |= OFlags::DIRECTORY;
            }
            file = File::from(sysfs::openat(&file, part, flags, Mode::empty())?);
            let meta = sysfs::fstat(&file)?;
            let expected = if index == 0 {
                self.parent_uid
            } else {
                self.uid
            };
            if meta.st_uid != expected {
                return Err(reject("file_owner_mismatch"));
            }
        }
        let pinned = sysfs::fstat(&file)?;
        if !directory && FileType::from_raw_mode(pinned.st_mode) != FileType::RegularFile {
            return Err(reject("regular_file_required"));
        }
        // This kernel magic link points to the validated inode, never a second
        // lookup of a workload-controlled path or an unchecked device/FIFO.
        let reopened = File::from(sysfs::open(
            format!("/proc/self/fd/{}", file.as_raw_fd()),
            OFlags::RDONLY | OFlags::NONBLOCK | OFlags::CLOEXEC,
            Mode::empty(),
        )?);
        let observed = sysfs::fstat(&reopened)?;
        if pinned.st_dev != observed.st_dev
            || pinned.st_ino != observed.st_ino
            || pinned.st_mode != observed.st_mode
        {
            return Err(reject("file_changed"));
        }
        Ok(reopened)
    }
    pub fn read(
        &self,
        lease: &Lease,
        path: &str,
        offset: u64,
        count: usize,
        expected: Option<&str>,
    ) -> io::Result<FileChunk> {
        if offset > MAX_GENERATION {
            return Err(reject("invalid_file_offset"));
        }
        if !(1..=MAX_CHUNK).contains(&count) {
            return Err(reject("invalid_file_range"));
        }
        if expected.is_some_and(|v| v.len() != 64) {
            return Err(reject("invalid_file_version"));
        }
        let guard = self.fence.locked()?;
        let file = self.open_locked(&guard, lease, path, false)?;
        let meta = sysfs::fstat(&file)?;
        let current = version(&meta);
        if expected.is_some_and(|value| value != current) {
            return Err(reject("file_changed"));
        }
        let size = u64::try_from(meta.st_size).map_err(|_| reject("invalid_file_size"))?;
        if offset > size {
            return Err(reject("file_offset_past_end"));
        }
        let mut bytes = vec![0; count];
        let n = file.read_at(&mut bytes, offset)?;
        bytes.truncate(n);
        if version(&sysfs::fstat(&file)?) != current {
            return Err(reject("file_changed"));
        }
        Ok(FileChunk {
            base64: STANDARD.encode(&bytes),
            offset,
            next_offset: offset + n as u64,
            size,
            eof: offset + n as u64 == size,
            version: current,
            sha256: format!("{:x}", Sha256::digest(&bytes)),
        })
    }
    pub fn list(
        &self,
        lease: &Lease,
        path: &str,
        after: &str,
        limit: usize,
        expected: Option<&str>,
    ) -> io::Result<Listing> {
        if after.contains('/') || after.contains('\0') || after.len() > 255 {
            return Err(reject("invalid_listing_cursor"));
        }
        if !(1..=256).contains(&limit) {
            return Err(reject("invalid_listing_limit"));
        }
        let guard = self.fence.locked()?;
        let file = self.open_locked(&guard, lease, path, true)?;
        let current = version(&sysfs::fstat(&file)?);
        if expected.is_some_and(|value| value != current) {
            return Err(reject("directory_changed"));
        }
        let mut names = Vec::new();
        let mut directory = Dir::read_from(&file)?;
        while let Some(entry) = directory.read() {
            let entry = entry?;
            let raw = entry.file_name().to_bytes();
            if raw == b"." || raw == b".." {
                continue;
            }
            let name = std::str::from_utf8(raw).map_err(|_| reject("invalid_filename_encoding"))?;
            names.push(name.to_owned());
            if names.len() > MAX_ENTRIES {
                return Err(reject("directory_entry_limit"));
            }
        }
        names.retain(|name| name.as_str() > after);
        names.sort();
        let mut entries = Vec::new();
        for name in names.iter().take(limit) {
            let meta = sysfs::statat(&file, name, AtFlags::SYMLINK_NOFOLLOW)?;
            let kind = match FileType::from_raw_mode(meta.st_mode) {
                FileType::RegularFile => "file",
                FileType::Directory => "directory",
                FileType::Symlink => "symlink",
                _ => "other",
            };
            entries.push(DirectoryEntry {
                name: name.clone(),
                kind,
                mode: meta.st_mode & 0o7777,
                size: meta.st_size,
            });
        }
        if version(&sysfs::fstat(&file)?) != current {
            return Err(reject("directory_changed"));
        }
        let next = if names.len() > limit {
            entries.last().map(|entry| entry.name.clone())
        } else {
            None
        };
        Ok(Listing {
            entries,
            next,
            version: current,
        })
    }
}
