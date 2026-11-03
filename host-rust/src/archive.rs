//! Quiesced filesystem archives: private staging, complete proof, then publication.
//! Caller owns/trusts source and destination ancestors and holds the lease fence.
use crate::frames::{FRAME_BYTES, Frame, FrameWriter};
use flate2::read::MultiGzDecoder;
use rustix::fs::{self as sysfs, AtFlags, Dir, FileType, Mode, OFlags, RenameFlags, Stat};
use rustix::process::{Gid, Uid};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::fs::{self, File};
use std::io::{self, Read, Write};
use std::os::unix::fs::{PermissionsExt, symlink};
use std::path::{Path, PathBuf};
use tar::{Builder, EntryType, Header};

const ROOT_NAMES: [&str; 2] = ["workspace", "home"];
const BLOCK: usize = 512;
const RECORD: usize = 10240;
const COPY_BYTES: usize = 1024 * 1024;

fn reject(message: &'static str) -> io::Error {
    io::Error::other(message)
}
// One bounded scratch buffer is shared by all files; no allocation scales with
// member size. Short reads are normal, but premature EOF cannot publish staging.
fn copy_exact<R: Read, W: Write>(
    source: &mut R,
    target: &mut W,
    mut bytes: u64,
    scratch: &mut [u8],
) -> io::Result<()> {
    while bytes != 0 {
        let count = scratch.len().min(bytes.min(usize::MAX as u64) as usize);
        let read = source.read(&mut scratch[..count])?;
        if read == 0 {
            return Err(reject("short_archive_file"));
        }
        target.write_all(&scratch[..read])?;
        bytes -= read as u64;
    }
    Ok(())
}

fn nofollow(path: &Path, directory: bool) -> io::Result<File> {
    let mut flags = OFlags::RDONLY | OFlags::NOFOLLOW | OFlags::NONBLOCK | OFlags::CLOEXEC;
    if directory {
        flags |= OFlags::DIRECTORY;
    }
    Ok(File::from(sysfs::open(path, flags, Mode::empty())?))
}
fn same(a: &Stat, b: &Stat) -> bool {
    (
        a.st_dev,
        a.st_ino,
        a.st_size,
        a.st_mode,
        a.st_mtime,
        a.st_mtime_nsec,
        a.st_ctime,
        a.st_ctime_nsec,
    ) == (
        b.st_dev,
        b.st_ino,
        b.st_size,
        b.st_mode,
        b.st_mtime,
        b.st_mtime_nsec,
        b.st_ctime,
        b.st_ctime_nsec,
    )
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Limits {
    pub entries: usize,
    pub bytes: u64,
    pub path_bytes: usize,
}
impl Default for Limits {
    fn default() -> Self {
        Self {
            entries: 100_000,
            bytes: 16 * 1024_u64.pow(3),
            path_bytes: 4096,
        }
    }
}
impl Limits {
    fn validate(self) -> io::Result<Self> {
        if self.entries == 0 || self.bytes == 0 || self.path_bytes == 0 {
            return Err(reject("invalid_limits"));
        }
        self.expanded_bound()?;
        Ok(self)
    }
    fn expanded_bound(self) -> io::Result<u64> {
        let per = (self.path_bytes as u64)
            .checked_mul(2)
            .and_then(|n| n.checked_add(4096));
        per.and_then(|per| per.checked_mul(self.entries as u64))
            .and_then(|n| n.checked_add(self.bytes))
            .and_then(|n| n.checked_add(RECORD as u64))
            .ok_or_else(|| reject("invalid_limits"))
    }
}
fn canonical_name(name: &str, limits: Limits) -> io::Result<&str> {
    if name.is_empty()
        || name.len() > limits.path_bytes
        || name.contains('\0')
        || name.starts_with('/')
        || name
            .split('/')
            .any(|part| part.is_empty() || part == "." || part == "..")
        || !ROOT_NAMES.contains(&name.split('/').next().unwrap_or(""))
    {
        return Err(reject("unsafe_archive_path"));
    }
    Ok(name)
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptureReceipt {
    pub version: u8,
    pub sha256: String,
    pub bytes: u64,
    pub expanded_bytes: u64,
    pub entries: usize,
    pub frames: Vec<Frame>,
}
#[derive(Debug, Serialize, Deserialize)]
pub struct RestoreReceipt {
    pub version: u8,
    pub sha256: String,
    pub entries: usize,
}
#[derive(Clone, Copy)]
pub struct Owner {
    pub uid: u32,
    pub gid: u32,
}
impl Owner {
    fn validate(self) -> io::Result<Self> {
        if self.uid == u32::MAX || self.gid == u32::MAX {
            return Err(reject("invalid_restore_owner"));
        }
        Ok(self)
    }
}

pub fn digest(path: &Path) -> io::Result<String> {
    let mut file = nofollow(path, false)?;
    let before = sysfs::fstat(&file)?;
    if FileType::from_raw_mode(before.st_mode) != FileType::RegularFile {
        return Err(reject("invalid_archive_type"));
    }
    let mut hash = Sha256::new();
    let mut buffer = vec![0; COPY_BYTES];
    loop {
        let n = file.read(&mut buffer)?;
        if n == 0 {
            break;
        }
        hash.update(&buffer[..n]);
    }
    if !same(&before, &sysfs::fstat(&file)?) {
        return Err(reject("source_changed"));
    }
    Ok(format!("{:x}", hash.finalize()))
}

struct Capture<W: Write> {
    tar: Builder<W>,
    limits: Limits,
    count: usize,
    bytes: u64,
    inodes: BTreeMap<(u64, u64), String>,
}
impl<W: Write> Capture<W> {
    fn add(&mut self, parent: &File, child: &str, name: &str) -> io::Result<()> {
        canonical_name(name, self.limits)?;
        let before = sysfs::statat(parent, child, AtFlags::SYMLINK_NOFOLLOW)?;
        let kind = FileType::from_raw_mode(before.st_mode);
        if ROOT_NAMES.contains(&name) && kind != FileType::Directory {
            return Err(reject("invalid_source_root"));
        }
        if ![
            FileType::RegularFile,
            FileType::Directory,
            FileType::Symlink,
        ]
        .contains(&kind)
        {
            return Err(reject("unsupported_file_type"));
        }
        if before.st_mode & 0o7000 != 0 {
            return Err(reject("unsupported_special_mode"));
        }
        self.count += 1;
        if self.count > self.limits.entries {
            return Err(reject("archive_limit"));
        }
        let mut header = Header::new_ustar();
        header.set_mode(before.st_mode & 0o777);
        header.set_uid(0);
        header.set_gid(0);
        header.set_mtime(0);
        header.set_size(0);
        let inode = (before.st_dev as u64, before.st_ino as u64);
        let link = if kind == FileType::Symlink {
            let target = sysfs::readlinkat(parent, child, Vec::new())?;
            Some(String::from_utf8(target.into_bytes()).map_err(|_| reject("invalid_symlink"))?)
        } else if kind == FileType::RegularFile && before.st_nlink > 1 {
            self.inodes.get(&inode).cloned()
        } else {
            None
        };
        if let Some(target) = &link
            && (target.len() > self.limits.path_bytes || target.contains('\0'))
        {
            return Err(reject("invalid_symlink"));
        }
        let is_primary = kind == FileType::RegularFile && link.is_none();
        if is_primary {
            let size = u64::try_from(before.st_size).map_err(|_| reject("archive_limit"))?;
            self.bytes = self
                .bytes
                .checked_add(size)
                .ok_or_else(|| reject("archive_limit"))?;
            if self.bytes > self.limits.bytes {
                return Err(reject("archive_limit"));
            }
            header.set_size(size);
            header.set_entry_type(EntryType::Regular);
            self.inodes.insert(inode, name.into());
        } else if kind == FileType::Directory {
            header.set_entry_type(EntryType::Directory);
        } else if kind == FileType::Symlink {
            header.set_entry_type(EntryType::Symlink);
        } else {
            header.set_entry_type(EntryType::Link);
        }
        // PAX is bounded to the actual path/link, not generated from host metadata.
        let path_extension = name.len() > 100 || !name.is_ascii();
        let link_extension = link
            .as_ref()
            .is_some_and(|value| value.len() > 100 || !value.is_ascii());
        let mut extensions = Vec::new();
        if path_extension {
            extensions.push(("path", name.as_bytes()));
        }
        if link_extension {
            extensions.push(("linkpath", link.as_ref().unwrap().as_bytes()));
        }
        self.tar.append_pax_extensions(extensions)?;
        header.set_path(if path_extension { "entry" } else { name })?;
        if let Some(target) = &link {
            header.set_link_name_literal(if link_extension {
                b"link"
            } else {
                target.as_bytes()
            })?;
        }
        header.set_cksum();
        if is_primary || kind == FileType::Directory {
            let mut flags = OFlags::RDONLY | OFlags::NOFOLLOW | OFlags::NONBLOCK | OFlags::CLOEXEC;
            if kind == FileType::Directory {
                flags |= OFlags::DIRECTORY;
            }
            let mut file = File::from(sysfs::openat(parent, child, flags, Mode::empty())?);
            if !same(&before, &sysfs::fstat(&file)?) {
                return Err(reject("source_changed"));
            }
            if is_primary {
                let mut reader = Counted::new(
                    (&mut file).take(before.st_size as u64),
                    before.st_size as u64,
                    false,
                );
                self.tar.append(&header, &mut reader)?;
                if reader.bytes != before.st_size as u64 {
                    return Err(reject("source_changed"));
                }
            } else {
                self.tar.append(&header, io::empty())?;
                let mut names = Vec::new();
                let mut directory = Dir::read_from(&file)?;
                while let Some(entry) = directory.read() {
                    let entry = entry?;
                    let bytes = entry.file_name().to_bytes();
                    if bytes == b"." || bytes == b".." {
                        continue;
                    }
                    let child = std::str::from_utf8(bytes)
                        .map_err(|_| reject("invalid_path"))?
                        .to_owned();
                    names.push(child);
                    if names.len() > self.limits.entries - self.count {
                        return Err(reject("archive_limit"));
                    }
                }
                names.sort();
                for child in names {
                    self.add(&file, &child, &format!("{name}/{child}"))?;
                }
            }
            if !same(&before, &sysfs::fstat(&file)?) {
                return Err(reject("source_changed"));
            }
        } else {
            self.tar.append(&header, io::empty())?;
        }
        if !same(
            &before,
            &sysfs::statat(parent, child, AtFlags::SYMLINK_NOFOLLOW)?,
        ) {
            return Err(reject("source_changed"));
        }
        Ok(())
    }
}

pub fn capture(
    roots: [&Path; 2],
    target: &Path,
    limits: Limits,
    frame_bytes: usize,
) -> io::Result<CaptureReceipt> {
    let _timing = crate::timing::Stage::new("archive.capture");
    let limits = limits.validate()?;
    let canonical = [fs::canonicalize(roots[0])?, fs::canonicalize(roots[1])?];
    if canonical[0].starts_with(&canonical[1]) || canonical[1].starts_with(&canonical[0]) {
        return Err(reject("overlapping_roots"));
    }
    let parent = target
        .parent()
        .ok_or_else(|| reject("invalid_archive_parent"))?;
    let parent_path = fs::canonicalize(parent)?;
    if canonical.iter().any(|root| parent_path.starts_with(root)) {
        return Err(reject("archive_inside_source"));
    }
    let parent_fd = nofollow(parent, true)?;
    let temporary = tempfile::Builder::new()
        .prefix(".capture-")
        .tempfile_in(parent)?;
    let writer = FrameWriter::new(temporary.as_file().try_clone()?, frame_bytes, true, None)?;
    let mut work = Capture {
        tar: Builder::new(writer),
        limits,
        count: 0,
        bytes: 0,
        inodes: BTreeMap::new(),
    };
    for (root, name) in roots.into_iter().zip(ROOT_NAMES) {
        // Opening each final component with NOFOLLOW rejects aliased source roots.
        let root_parent = nofollow(
            root.parent().ok_or_else(|| reject("invalid_source_root"))?,
            true,
        )?;
        let child = root
            .file_name()
            .and_then(|s| s.to_str())
            .ok_or_else(|| reject("invalid_source_root"))?;
        work.add(&root_parent, child, name)?;
    }
    let count = work.count;
    let bytes = work.bytes;
    let framed = work.tar.into_inner()?.finish()?;
    let sha256 = framed.sha256;
    let frames = framed.frames;
    let encoded_bytes = framed.bytes;
    temporary.as_file().sync_all()?;
    if encoded_bytes > limits.bytes {
        return Err(reject("compressed_archive_limit"));
    }
    if temporary.as_file().metadata()?.len() != encoded_bytes {
        return Err(reject("archive_write_extent"));
    }
    let name = target
        .file_name()
        .ok_or_else(|| reject("invalid_archive_target"))?;
    match sysfs::linkat(
        &parent_fd,
        temporary.path().file_name().unwrap(),
        &parent_fd,
        name,
        AtFlags::empty(),
    ) {
        Ok(()) => {}
        Err(rustix::io::Errno::EXIST) => {
            if digest(target)? != sha256 {
                return Err(reject("archive_identity_conflict"));
            }
        }
        Err(error) => return Err(error.into()),
    }
    parent_fd.sync_all()?;
    Ok(CaptureReceipt {
        version: 1,
        sha256,
        bytes: encoded_bytes,
        expanded_bytes: bytes,
        entries: count,
        frames,
    })
}

struct Counted<R> {
    source: R,
    limit: u64,
    bytes: u64,
    hash: Option<Sha256>,
}
impl<R: Read> Counted<R> {
    fn new(source: R, limit: u64, hashed: bool) -> Self {
        Self {
            source,
            limit,
            bytes: 0,
            hash: hashed.then(Sha256::new),
        }
    }
}
impl<R: Read> Read for Counted<R> {
    fn read(&mut self, output: &mut [u8]) -> io::Result<usize> {
        let count = output
            .len()
            .min(COPY_BYTES)
            .min(self.limit.saturating_sub(self.bytes).saturating_add(1) as usize);
        let n = self.source.read(&mut output[..count])?;
        self.bytes = self
            .bytes
            .checked_add(n as u64)
            .ok_or_else(|| reject("archive_limit"))?;
        if self.bytes > self.limit {
            return Err(reject("archive_limit"));
        }
        if let Some(hash) = &mut self.hash {
            hash.update(&output[..n]);
        }
        Ok(n)
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Kind {
    Directory,
    File,
    Symlink,
    Hardlink,
}
struct Member {
    name: String,
    kind: Kind,
    mode: u32,
}
struct Staging {
    path: PathBuf,
    published: bool,
}
impl Drop for Staging {
    fn drop(&mut self) {
        if !self.published {
            accessible(&self.path);
            let _ = fs::remove_dir_all(&self.path);
        }
    }
}
fn accessible(path: &Path) {
    if fs::symlink_metadata(path).is_ok_and(|m| m.is_dir() && !m.file_type().is_symlink()) {
        if fs::set_permissions(path, fs::Permissions::from_mode(0o700)).is_err() {
            return;
        }
        if let Ok(entries) = fs::read_dir(path) {
            for entry in entries.flatten() {
                accessible(&entry.path());
            }
        }
    }
}

fn parse_extensions(raw: &[u8]) -> io::Result<BTreeMap<String, String>> {
    let mut fields = BTreeMap::new();
    let mut offset = 0;
    while offset < raw.len() {
        let space = raw[offset..]
            .iter()
            .position(|b| *b == b' ')
            .ok_or_else(|| reject("invalid_pax"))?;
        let digits = &raw[offset..offset + space];
        if digits.is_empty() || !digits.iter().all(u8::is_ascii_digit) {
            return Err(reject("invalid_pax"));
        }
        let length: usize = std::str::from_utf8(digits)
            .map_err(|_| reject("invalid_pax"))?
            .parse()
            .map_err(|_| reject("invalid_pax"))?;
        if length <= space + 2 || length > raw.len() - offset || raw[offset + length - 1] != b'\n' {
            return Err(reject("invalid_pax"));
        }
        let field = &raw[offset + space + 1..offset + length - 1];
        let equals = field
            .iter()
            .position(|b| *b == b'=')
            .ok_or_else(|| reject("invalid_pax"))?;
        let key = std::str::from_utf8(&field[..equals]).map_err(|_| reject("invalid_pax"))?;
        let value = std::str::from_utf8(&field[equals + 1..]).map_err(|_| reject("invalid_pax"))?;
        if key.is_empty()
            || key.starts_with("GNU.sparse")
            || fields.insert(key.into(), value.into()).is_some()
        {
            return Err(reject("invalid_pax"));
        }
        offset += length;
    }
    Ok(fields)
}
fn text(raw: &[u8]) -> io::Result<String> {
    String::from_utf8(raw.to_vec()).map_err(|_| reject("invalid_path"))
}
fn padded_body(reader: &mut impl Read, size: u64, max: usize) -> io::Result<Vec<u8>> {
    if size > max as u64 {
        return Err(reject("archive_extension_limit"));
    }
    let mut value = vec![0; size as usize];
    reader.read_exact(&mut value)?;
    padding(reader, size)?;
    Ok(value)
}
fn padding(reader: &mut impl Read, size: u64) -> io::Result<()> {
    let mut block = [0; BLOCK];
    let pad = (BLOCK as u64 - size % BLOCK as u64) % BLOCK as u64;
    reader.read_exact(&mut block[..pad as usize])
}

pub fn restore(
    source: &Path,
    destination: &Path,
    expected_sha256: &str,
    limits: Limits,
    owner: Option<Owner>,
) -> io::Result<RestoreReceipt> {
    let _timing = crate::timing::Stage::new("archive.restore");
    let limits = limits.validate()?;
    let owner = owner.map(Owner::validate).transpose()?;
    if expected_sha256.len() != 64
        || !expected_sha256
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    {
        return Err(reject("archive_digest_mismatch"));
    }
    if fs::symlink_metadata(destination).is_ok() {
        return Err(reject("restore_destination_exists"));
    }
    let parent = destination
        .parent()
        .ok_or_else(|| reject("invalid_destination_parent"))?;
    let parent_fd = nofollow(parent, true)?;
    let source_file = nofollow(source, false)?;
    let before = sysfs::fstat(&source_file)?;
    if FileType::from_raw_mode(before.st_mode) != FileType::RegularFile
        || before.st_size < 0
        || before.st_size as u64 > limits.bytes
    {
        return Err(reject("archive_digest_mismatch"));
    }
    let compressed = Counted::new(&source_file, before.st_size as u64, true);
    let mut decoded = Counted::new(
        MultiGzDecoder::new(compressed),
        limits.expanded_bound()?,
        false,
    );
    let staging_path = tempfile::Builder::new()
        .prefix(".restore-")
        .permissions(fs::Permissions::from_mode(0o700))
        .tempdir_in(parent)?
        .keep();
    let mut staging = Staging {
        path: staging_path,
        published: false,
    };
    fs::set_permissions(&staging.path, fs::Permissions::from_mode(0o700))?;
    let extraction = crate::timing::Stage::new("archive.extract");
    let mut copy_buffer = vec![0; COPY_BYTES];
    let mut members: Vec<Member> = Vec::new();
    let mut seen: BTreeMap<String, (Kind, u32)> = BTreeMap::new();
    let mut total = 0_u64;
    let mut extensions = BTreeMap::new();
    let mut globals = BTreeMap::new();
    let mut long_name: Option<String> = None;
    let mut long_link: Option<String> = None;
    let mut headers = 0_usize;
    loop {
        let mut block = [0; BLOCK];
        decoded.read_exact(&mut block)?;
        if block.iter().all(|b| *b == 0) {
            decoded.read_exact(&mut block)?;
            if !block.iter().all(|b| *b == 0) {
                return Err(reject("invalid_tar_end"));
            }
            if !extensions.is_empty() || long_name.is_some() || long_link.is_some() {
                return Err(reject("orphan_archive_extension"));
            }
            break;
        }
        headers += 1;
        if headers > limits.entries.saturating_add(1).saturating_mul(5) {
            return Err(reject("archive_limit"));
        }
        let header = Header::from_byte_slice(&block);
        let checksum: u32 = block
            .iter()
            .enumerate()
            .map(|(i, b)| {
                if (148..156).contains(&i) {
                    32
                } else {
                    *b as u32
                }
            })
            .sum();
        if header.cksum()? != checksum {
            return Err(reject("invalid_tar_checksum"));
        }
        let entry_type = header.entry_type().as_byte();
        let extension_bound = limits
            .path_bytes
            .checked_mul(2)
            .and_then(|n| n.checked_add(4096))
            .ok_or_else(|| reject("invalid_limits"))?;
        if b"xgLK".contains(&entry_type) {
            let raw = padded_body(&mut decoded, header.entry_size()?, extension_bound)?;
            match entry_type {
                b'x' => {
                    if !extensions.is_empty() {
                        return Err(reject("duplicate_pax"));
                    }
                    extensions = parse_extensions(&raw)?;
                }
                b'g' => {
                    for (key, value) in parse_extensions(&raw)? {
                        if value.is_empty() {
                            globals.remove(&key);
                        } else {
                            globals.insert(key, value);
                        }
                    }
                    if globals.len() > 64 {
                        return Err(reject("archive_extension_limit"));
                    }
                }
                b'L' | b'K' => {
                    let value = text(raw.strip_suffix(&[0]).unwrap_or(&raw))?;
                    if value.len() > limits.path_bytes {
                        return Err(reject("archive_extension_limit"));
                    }
                    let target = if entry_type == b'L' {
                        &mut long_name
                    } else {
                        &mut long_link
                    };
                    if target.replace(value).is_some() {
                        return Err(reject("duplicate_long_name"));
                    }
                }
                _ => unreachable!(),
            }
            continue;
        }
        let mut attributes = globals.clone();
        attributes.append(&mut extensions);
        let kind = match entry_type {
            0 | b'0' => Kind::File,
            b'5' => Kind::Directory,
            b'2' => Kind::Symlink,
            b'1' => Kind::Hardlink,
            _ => return Err(reject("unsupported_file_type")),
        };
        let mut name = if let Some(value) = long_name.take() {
            value
        } else if let Some(value) = attributes.get("path") {
            value.clone()
        } else {
            text(&header.path_bytes())?
        };
        if kind == Kind::Directory {
            name = name.trim_end_matches('/').to_owned();
        }
        canonical_name(&name, limits)?;
        if seen.contains_key(&name) {
            return Err(reject("duplicate_archive_path"));
        }
        let mode = header.mode()?;
        if mode & !0o777 != 0 {
            return Err(reject("unsafe_archive_mode_or_size"));
        }
        let size = match attributes.get("size") {
            Some(value) => {
                if !value.bytes().all(|b| b.is_ascii_digit()) {
                    return Err(reject("invalid_pax_size"));
                }
                value.parse().map_err(|_| reject("invalid_pax_size"))?
            }
            None => header.entry_size()?,
        };
        if kind != Kind::File && size != 0 {
            return Err(reject("nonfile_payload"));
        }
        if !name.contains('/') && kind != Kind::Directory {
            return Err(reject("invalid_root_type"));
        }
        let mut ancestor = name.as_str();
        while let Some((parent, _)) = ancestor.rsplit_once('/') {
            if !seen
                .get(parent)
                .is_some_and(|(kind, _)| *kind == Kind::Directory)
            {
                return Err(reject("invalid_archive_parent"));
            }
            ancestor = parent;
        }
        total = total
            .checked_add(size)
            .ok_or_else(|| reject("archive_limit"))?;
        if members.len() >= limits.entries || total > limits.bytes {
            return Err(reject("archive_limit"));
        }
        let target = staging.path.join(&name);
        let link = long_link
            .take()
            .or_else(|| attributes.get("linkpath").cloned())
            .or_else(|| {
                header
                    .link_name_bytes()
                    .and_then(|v| String::from_utf8(v.into_owned()).ok())
            });
        match kind {
            Kind::Directory => {
                fs::create_dir(&target)?;
                fs::set_permissions(&target, fs::Permissions::from_mode(0o700))?;
            }
            Kind::File => {
                let mut output = fs::OpenOptions::new()
                    .write(true)
                    .create_new(true)
                    .open(&target)?;
                output.set_permissions(fs::Permissions::from_mode(0o600))?;
                copy_exact(&mut decoded, &mut output, size, &mut copy_buffer)?;
                output.flush()?;
            }
            Kind::Hardlink => {
                let link = link.ok_or_else(|| reject("unsafe_hardlink"))?;
                canonical_name(&link, limits)?;
                if seen.get(&link) != Some(&(Kind::File, mode)) {
                    return Err(reject("unsafe_hardlink"));
                }
                fs::hard_link(staging.path.join(link), &target)?;
            }
            Kind::Symlink => {
                let link = link.ok_or_else(|| reject("invalid_symlink"))?;
                if link.contains('\0') || link.len() > limits.path_bytes {
                    return Err(reject("invalid_symlink"));
                }
                symlink(link, &target)?;
            }
        }
        padding(&mut decoded, size)?;
        seen.insert(name.clone(), (kind, mode));
        members.push(Member { name, kind, mode });
    }
    if ROOT_NAMES.iter().any(|root| {
        !seen
            .get(*root)
            .is_some_and(|(kind, _)| *kind == Kind::Directory)
    }) {
        return Err(reject("missing_persistent_root"));
    }
    // The tar terminator does not authorize ignoring late gzip CRCs or suffixes.
    io::copy(&mut decoded, &mut io::sink())?;
    let compressed = decoded.source.into_inner();
    if compressed.bytes != before.st_size as u64
        || format!("{:x}", compressed.hash.unwrap().finalize()) != expected_sha256
        || !same(&before, &sysfs::fstat(&source_file)?)
    {
        return Err(reject("archive_digest_mismatch"));
    }
    drop(extraction);
    let _sync = crate::timing::Stage::new("archive.sync_publish");
    for member in &members {
        let path = staging.path.join(&member.name);
        if member.kind == Kind::File {
            let file = nofollow(&path, false)?;
            if let Some(owner) = owner {
                sysfs::fchown(
                    &file,
                    Some(Uid::from_raw(owner.uid)),
                    Some(Gid::from_raw(owner.gid)),
                )?;
            }
            sysfs::fchmod(&file, Mode::from_raw_mode(member.mode))?;
            file.sync_all()?;
        } else if member.kind == Kind::Symlink
            && let Some(owner) = owner
        {
            sysfs::chownat(
                sysfs::CWD,
                &path,
                Some(Uid::from_raw(owner.uid)),
                Some(Gid::from_raw(owner.gid)),
                AtFlags::SYMLINK_NOFOLLOW,
            )?;
        }
    }
    for member in members.iter().rev().filter(|m| m.kind == Kind::Directory) {
        let file = nofollow(&staging.path.join(&member.name), true)?;
        if let Some(owner) = owner {
            sysfs::fchown(
                &file,
                Some(Uid::from_raw(owner.uid)),
                Some(Gid::from_raw(owner.gid)),
            )?;
        }
        sysfs::fchmod(&file, Mode::from_raw_mode(member.mode))?;
        file.sync_all()?;
    }
    let staged = nofollow(&staging.path, true)?;
    if let Some(owner) = owner {
        sysfs::fchown(
            &staged,
            Some(Uid::from_raw(owner.uid)),
            Some(Gid::from_raw(owner.gid)),
        )?;
    }
    staged.sync_all()?;
    sysfs::renameat_with(
        &parent_fd,
        staging.path.file_name().unwrap(),
        &parent_fd,
        destination
            .file_name()
            .ok_or_else(|| reject("invalid_destination_parent"))?,
        RenameFlags::NOREPLACE,
    )?;
    staging.published = true;
    parent_fd.sync_all()?;
    Ok(RestoreReceipt {
        version: 1,
        sha256: expected_sha256.into(),
        entries: members.len(),
    })
}

pub fn capture_default(roots: [&Path; 2], target: &Path) -> io::Result<CaptureReceipt> {
    capture(roots, target, Limits::default(), FRAME_BYTES)
}

#[cfg(test)]
mod buffering_tests {
    use super::*;
    #[test]
    fn bounded_copy_handles_partial_reads_and_rejects_truncation() {
        struct Short(std::io::Cursor<Vec<u8>>);
        impl Read for Short {
            fn read(&mut self, out: &mut [u8]) -> io::Result<usize> {
                let max = out.len().min(13);
                self.0.read(&mut out[..max])
            }
        }
        let bytes = vec![0xa5; COPY_BYTES + 37];
        let mut source = Short(io::Cursor::new(bytes.clone()));
        let mut target = Vec::new();
        let mut scratch = vec![0; COPY_BYTES];
        copy_exact(&mut source, &mut target, bytes.len() as u64, &mut scratch).unwrap();
        assert_eq!(target, bytes);
        let mut source = io::Cursor::new(b"short");
        assert!(copy_exact(&mut source, &mut Vec::new(), 6, &mut scratch).is_err());
    }
}
