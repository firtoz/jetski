//! Private provider transfer files; immutable bytes are verified before dispatch.
use crate::{
    checkpoint_cache::{reject, valid_hash},
    protocol::{Request, canonical_uuid},
};
use rustix::{
    fs::{self as sysfs, AtFlags, Dir, FileType, Mode, OFlags},
    process::{Gid, Uid},
};
use sha2::{Digest, Sha256};
use std::{
    fs::File,
    io::{self, Read},
    path::Path,
};
pub struct ControlFiles<'a> {
    pub tmp: &'a Path,
    pub uid: u32,
    pub gid: u32,
    pub parent_uid: u32,
}
impl ControlFiles<'_> {
    fn name<'a>(&self, directory: &'a Path) -> io::Result<&'a str> {
        if directory.parent() != Some(self.tmp) {
            return Err(reject("invalid_control_transfer_path"));
        }
        let name = directory
            .file_name()
            .and_then(|v| v.to_str())
            .ok_or_else(|| reject("invalid_control_transfer_path"))?;
        if !name
            .strip_prefix("jetski-control-")
            .is_some_and(canonical_uuid)
        {
            return Err(reject("invalid_control_transfer_path"));
        }
        Ok(name)
    }
    fn parent(&self) -> io::Result<File> {
        if self.uid == 0 || self.gid == 0 || self.uid == u32::MAX || self.gid == u32::MAX {
            return Err(reject("invalid_transfer_account"));
        }
        let file = File::from(sysfs::open(
            self.tmp,
            OFlags::RDONLY | OFlags::DIRECTORY | OFlags::NOFOLLOW | OFlags::CLOEXEC,
            Mode::empty(),
        )?);
        let meta = sysfs::fstat(&file)?;
        if meta.st_uid != self.parent_uid
            || (meta.st_mode & 0o022 != 0 && meta.st_mode & 0o1000 == 0)
        {
            return Err(reject("unsafe_control_transfer_parent"));
        }
        Ok(file)
    }
    fn open(&self, parent: &File, name: &str) -> io::Result<File> {
        let directory = File::from(sysfs::openat(
            parent,
            name,
            OFlags::RDONLY | OFlags::DIRECTORY | OFlags::NOFOLLOW | OFlags::CLOEXEC,
            Mode::empty(),
        )?);
        let meta = sysfs::fstat(&directory)?;
        if meta.st_uid != self.uid || meta.st_gid != self.gid || meta.st_mode & 0o7777 != 0o700 {
            return Err(reject("unsafe_control_transfer_directory"));
        }
        Ok(directory)
    }
    pub fn create(&self, path: &Path) -> io::Result<()> {
        let name = self.name(path)?;
        let parent = self.parent()?;
        // Never adopt an existing directory: an uncertain mkdir is observed by cleanup.
        sysfs::mkdirat(&parent, name, Mode::from_raw_mode(0o700))?;
        let directory = File::from(sysfs::openat(
            &parent,
            name,
            OFlags::RDONLY | OFlags::DIRECTORY | OFlags::NOFOLLOW | OFlags::CLOEXEC,
            Mode::empty(),
        )?);
        sysfs::fchown(
            &directory,
            Some(Uid::from_raw(self.uid)),
            Some(Gid::from_raw(self.gid)),
        )?;
        directory.sync_all()?;
        parent.sync_all()
    }
    pub fn read(&self, path: &Path, length: usize, sha256: &str) -> io::Result<Request> {
        if !(1..=crate::protocol::IMPORT_REQUEST_BYTES).contains(&length) || !valid_hash(sha256) {
            return Err(reject("invalid_control_transfer_extent"));
        }
        let name = self.name(path)?;
        let parent = self.parent()?;
        let directory = self.open(&parent, name)?;
        let mut file = File::from(sysfs::openat(
            &directory,
            "request.json",
            OFlags::RDONLY | OFlags::NOFOLLOW | OFlags::NONBLOCK | OFlags::CLOEXEC,
            Mode::empty(),
        )?);
        let before = sysfs::fstat(&file)?;
        if FileType::from_raw_mode(before.st_mode) != FileType::RegularFile
            || before.st_uid != self.uid
            || before.st_mode & 0o022 != 0
            || before.st_nlink != 1
            || before.st_size != length as i64
        {
            return Err(reject("unsafe_control_transfer_file"));
        }
        let mut bytes = Vec::with_capacity(length);
        file.by_ref()
            .take((length + 1) as u64)
            .read_to_end(&mut bytes)?;
        let after = sysfs::fstat(&file)?;
        if before.st_size != after.st_size
            || before.st_mtime != after.st_mtime
            || before.st_mtime_nsec != after.st_mtime_nsec
            || before.st_ctime != after.st_ctime
            || before.st_ctime_nsec != after.st_ctime_nsec
            || bytes.len() != length
            || format!("{:x}", Sha256::digest(&bytes)) != sha256
        {
            return Err(reject("control_transfer_integrity"));
        }
        // Decode the verified immutable buffer, not the still-provider-writable file.
        Request::decode(&bytes)
    }
    pub fn close(&self, path: &Path) -> io::Result<()> {
        let name = self.name(path)?;
        let parent = self.parent()?;
        let directory = match self.open(&parent, name) {
            Ok(v) => v,
            Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(()),
            Err(e) => return Err(e),
        };
        let mut entries = Dir::read_from(&directory)?;
        while let Some(entry) = entries.read() {
            let entry = entry?;
            let name = entry.file_name().to_bytes();
            if name != b"." && name != b".." && name != b"request.json" {
                return Err(reject("unexpected_control_transfer_file"));
            }
        }
        match sysfs::statat(&directory, "request.json", AtFlags::SYMLINK_NOFOLLOW) {
            Ok(meta) => {
                if FileType::from_raw_mode(meta.st_mode) != FileType::RegularFile
                    || meta.st_uid != self.uid
                {
                    return Err(reject("unsafe_control_transfer_file"));
                }
                sysfs::unlinkat(&directory, "request.json", AtFlags::empty())?;
                directory.sync_all()?;
            }
            Err(rustix::io::Errno::NOENT) => {}
            Err(e) => return Err(e.into()),
        }
        let held = sysfs::fstat(&directory)?;
        let current = sysfs::statat(&parent, name, AtFlags::SYMLINK_NOFOLLOW)?;
        if held.st_dev != current.st_dev || held.st_ino != current.st_ino {
            return Err(reject("control_transfer_directory_changed"));
        }
        sysfs::unlinkat(&parent, name, AtFlags::REMOVEDIR)?;
        parent.sync_all()
    }
}
pub fn entry(
    expected: &str,
    action: &str,
    path: &Path,
    extent: Option<(usize, &str)>,
) -> io::Result<()> {
    let config = crate::host_config::HostConfig::load()?;
    crate::installation::verify(&config, Some(expected))?;
    let name = config
        .archive_transfer_user
        .as_deref()
        .ok_or_else(|| reject("binary_transfer_not_configured"))?;
    let (uid, gid) = crate::control_io::transfer_account(name)?;
    let files = ControlFiles {
        tmp: Path::new("/tmp"),
        uid,
        gid,
        parent_uid: 0,
    };
    match action {
        "create" => files.create(path),
        "close" => files.close(path),
        "read" => {
            let (length, sha256) =
                extent.ok_or_else(|| reject("invalid_control_transfer_extent"))?;
            let request = files.read(path, length, sha256)?;
            let input = File::open("/dev/null")?;
            let output = File::from(rustix::io::fcntl_dupfd_cloexec(std::io::stdout(), 3)?);
            crate::control_io::dispatch_header(
                expected,
                crate::control_io::Header::Control(request),
                input,
                output,
            )
        }
        _ => Err(reject("invalid_control_transfer_action")),
    }
}
