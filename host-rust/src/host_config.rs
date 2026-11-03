//! Trusted Linux host configuration, rootless identities and readiness attestation.
use crate::process::{BoundedCommand, CommandResult, HostRunner, trusted_program};
use rustix::fs::{self as sysfs, FileType, Mode, OFlags};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::fs::{self, File};
use std::io::{self, Read};
use std::os::unix::fs::{FileTypeExt, MetadataExt};
use std::path::{Component, Path, PathBuf};
use std::time::Duration;

pub const ACCOUNT: &str = "jetski-runtime";
pub const HOME: &str = "/var/lib/jetski-runtime";
pub const CONFIG_PATH: &str = "/etc/jetski/host.json";
pub const CONTROL_ROOT: &str = "/var/lib/jetski/control";
pub const DATA_ROOT: &str = "/var/lib/jetski/data";
pub const ARCHIVE_ROOT: &str = "/var/lib/jetski/archives";
pub const KEEP_ID: &str = "keep-id:uid=1000,gid=1000";
pub const PREPARED: &str = "rootless-map";
fn reject(message: &'static str) -> io::Error {
    io::Error::other(message)
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum NetworkMode {
    #[default]
    None,
    Egress,
}
impl NetworkMode {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::None => "none",
            Self::Egress => "egress",
        }
    }
}
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Deserialize, Serialize)]
pub enum StorageMode {
    #[default]
    #[serde(rename = "default")]
    Default,
    #[serde(rename = "fuse-overlayfs")]
    FuseOverlayfs,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HostConfig {
    pub version: u8,
    pub machine_id: String,
    pub pool_id: String,
    pub images: Vec<String>,
    #[serde(default)]
    pub network_mode: NetworkMode,
    #[serde(default)]
    pub storage_mode: StorageMode,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub archive_transfer_user: Option<String>,
}
pub fn pinned_image(value: &str) -> bool {
    let Some((name, hash)) = value.split_once("@sha256:") else {
        return false;
    };
    name.as_bytes()
        .first()
        .is_some_and(u8::is_ascii_alphanumeric)
        && name
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"._:/-".contains(&b))
        && hash.len() == 64
        && hash
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}
impl HostConfig {
    pub fn validate(&self) -> io::Result<()> {
        if self.version != 1 {
            return Err(reject("unsupported_host_configuration"));
        }
        if [&self.machine_id, &self.pool_id]
            .iter()
            .any(|id| id.is_empty() || id.chars().count() > 160 || id.contains('\0'))
        {
            return Err(reject("invalid_host_identity"));
        }
        if !(1..=32).contains(&self.images.len())
            || self.images.iter().any(|image| !pinned_image(image))
        {
            return Err(reject("invalid_image_policy"));
        }
        if self.archive_transfer_user.as_ref().is_some_and(|name| {
            name.is_empty()
                || name.len() > 32
                || !name
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b"_-".contains(&b))
        }) {
            return Err(reject("invalid_archive_transfer_user"));
        }
        Ok(())
    }
    pub fn load() -> io::Result<Self> {
        if !rustix::process::geteuid().is_root() {
            return Err(reject("root_supervisor_required"));
        }
        private_root(Path::new("/etc/jetski"), 0o700)?;
        let config: Self = serde_json::from_slice(&read_private(Path::new(CONFIG_PATH), 65536)?)
            .map_err(|_| reject("invalid_host_configuration"))?;
        config.validate()?;
        for path in [CONTROL_ROOT, ARCHIVE_ROOT] {
            private_root(Path::new(path), 0o700)?;
        }
        private_root(Path::new(DATA_ROOT), 0o711)?;
        Ok(config)
    }
}
pub fn private_root(path: &Path, mode: u32) -> io::Result<()> {
    if !path.is_absolute()
        || path
            .components()
            .any(|part| matches!(part, Component::ParentDir | Component::CurDir))
    {
        return Err(reject("unsafe_supervisor_path"));
    }
    for parent in path.ancestors() {
        let meta = fs::symlink_metadata(parent)?;
        if !meta.is_dir() || meta.uid() != 0 || meta.mode() & 0o022 != 0 {
            return Err(reject("unsafe_supervisor_path"));
        }
    }
    if fs::symlink_metadata(path)?.mode() & 0o7777 != mode {
        return Err(reject("unsafe_supervisor_mode"));
    }
    Ok(())
}
pub(crate) fn read_private(path: &Path, limit: u64) -> io::Result<Vec<u8>> {
    let file = File::from(sysfs::open(
        path,
        OFlags::RDONLY | OFlags::NOFOLLOW | OFlags::NONBLOCK | OFlags::CLOEXEC,
        Mode::empty(),
    )?);
    let meta = sysfs::fstat(&file)?;
    if FileType::from_raw_mode(meta.st_mode) != FileType::RegularFile
        || meta.st_uid != 0
        || meta.st_mode & 0o7777 != 0o600
        || meta.st_nlink != 1
    {
        return Err(reject("unsafe_host_configuration"));
    }
    let mut raw = Vec::new();
    file.take(limit + 1).read_to_end(&mut raw)?;
    if raw.len() as u64 > limit {
        return Err(reject("host_configuration_limit"));
    }
    Ok(raw)
}
#[derive(Clone, Debug)]
pub struct RuntimeAccount {
    pub uid: u32,
    pub gid: u32,
    pub home: String,
}
impl RuntimeAccount {
    pub fn lookup() -> io::Result<Self> {
        let mut raw = String::new();
        File::open("/etc/passwd")?
            .take(4 * 1024 * 1024 + 1)
            .read_to_string(&mut raw)?;
        if raw.len() > 4 * 1024 * 1024 {
            return Err(reject("account_database_limit"));
        }
        let rows: Vec<_> = raw
            .lines()
            .filter_map(|line| {
                let fields: Vec<_> = line.split(':').collect();
                (fields.first() == Some(&ACCOUNT)).then_some(fields)
            })
            .collect();
        if rows.len() != 1 || rows[0].len() != 7 {
            return Err(reject("invalid_runtime_account"));
        }
        let row = &rows[0];
        let account = Self {
            uid: row[2]
                .parse()
                .map_err(|_| reject("invalid_runtime_account"))?,
            gid: row[3]
                .parse()
                .map_err(|_| reject("invalid_runtime_account"))?,
            home: row[5].into(),
        };
        if account.uid < 1000
            || account.uid == u32::MAX
            || account.gid == 0
            || account.gid == u32::MAX
            || account.home != HOME
            || row[6] != "/usr/sbin/nologin"
        {
            return Err(reject("invalid_runtime_account"));
        }
        Ok(account)
    }
    pub fn control_argv(&self) -> io::Result<Vec<String>> {
        validate_runtime_socket(self.uid)?;
        let runuser = trusted_program(&[
            "/usr/sbin/runuser",
            "/usr/bin/runuser",
            "/sbin/runuser",
            "/bin/runuser",
        ])?;
        Ok(vec![
            runuser.to_string_lossy().into_owned(),
            "-u".into(),
            ACCOUNT.into(),
            "--".into(),
            "env".into(),
            "-i".into(),
            format!("HOME={}", self.home),
            format!("USER={ACCOUNT}"),
            format!("LOGNAME={ACCOUNT}"),
            "PATH=/usr/local/bin:/usr/bin:/bin".into(),
            format!("XDG_RUNTIME_DIR=/run/user/{}", self.uid),
            format!(
                "DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/{}/bus",
                self.uid
            ),
            "podman".into(),
            "--remote".into(),
            format!("--url=unix:///run/user/{}/podman/podman.sock", self.uid),
        ])
    }
}
pub fn validate_runtime_socket(uid: u32) -> io::Result<PathBuf> {
    if uid < 1000 || uid == u32::MAX {
        return Err(reject("invalid_runtime_uid"));
    }
    let root = PathBuf::from(format!("/run/user/{uid}"));
    for parent in [&root, &root.join("podman")] {
        let meta = fs::symlink_metadata(parent)?;
        if !meta.is_dir() || meta.uid() != uid || meta.mode() & 0o022 != 0 {
            return Err(reject("unsafe_runtime_socket_parent"));
        }
    }
    let path = root.join("podman/podman.sock");
    let meta = fs::symlink_metadata(&path)?;
    if !meta.file_type().is_socket() || meta.uid() != uid || meta.mode() & 0o007 != 0 {
        return Err(reject("unsafe_runtime_socket"));
    }
    Ok(path)
}
pub struct RootlessRunner {
    pub account: RuntimeAccount,
    pub command: BoundedCommand,
}
impl HostRunner for RootlessRunner {
    fn run(&self, args: &[String]) -> io::Result<CommandResult> {
        let mut argv = self.account.control_argv()?;
        argv.extend_from_slice(args);
        self.command
            .run(&argv, Duration::from_secs(120), crate::process::MAX_OUTPUT)
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct NamespaceMapping {
    pub mode: String,
    pub uid_mappings: Option<Vec<[u64; 3]>>,
    pub gid_mappings: Option<Vec<[u64; 3]>>,
}
impl Default for NamespaceMapping {
    fn default() -> Self {
        Self {
            mode: KEEP_ID.into(),
            uid_mappings: None,
            gid_mappings: None,
        }
    }
}
impl NamespaceMapping {
    pub fn arguments(&self) -> io::Result<Vec<String>> {
        if self.mode == KEEP_ID {
            if self.uid_mappings.is_some() || self.gid_mappings.is_some() {
                return Err(reject("unexpected_namespace_mappings"));
            }
            return Ok(vec![format!("--userns={KEEP_ID}")]);
        }
        if self.mode != PREPARED {
            return Err(reject("unsupported_workload_namespace"));
        }
        let mut args = Vec::new();
        for (flag, mappings) in [
            ("--uidmap", &self.uid_mappings),
            ("--gidmap", &self.gid_mappings),
        ] {
            let rows = mappings
                .as_ref()
                .ok_or_else(|| reject("invalid_namespace_mappings"))?;
            if !(1..=16).contains(&rows.len()) {
                return Err(reject("invalid_namespace_mappings"));
            }
            let mut end = 0_u64;
            for &[inside, parent, size] in rows {
                let next = inside
                    .checked_add(size)
                    .ok_or_else(|| reject("invalid_namespace_mappings"))?;
                if inside != parent || inside != end || size == 0 || next > u32::MAX as u64 {
                    return Err(reject("invalid_namespace_mappings"));
                }
                args.push(format!("{flag}={inside}:{parent}:{size}"));
                end = next;
            }
            if end <= 1000 {
                return Err(reject("unmapped_workload_identity"));
            }
        }
        Ok(args)
    }
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkloadIdentity {
    pub version: u8,
    pub namespace: String,
    pub sha256: String,
    pub runtime_uid: u32,
    pub runtime_gid: u32,
    pub workload_uid: u32,
    pub workload_gid: u32,
    pub uid_mappings: Vec<[u64; 3]>,
    pub gid_mappings: Vec<[u64; 3]>,
}
impl WorkloadIdentity {
    pub fn mapping(&self) -> NamespaceMapping {
        NamespaceMapping {
            mode: self.namespace.clone(),
            uid_mappings: Some(self.uid_mappings.clone()),
            gid_mappings: Some(self.gid_mappings.clone()),
        }
    }
    pub fn validate(&self, account: &RuntimeAccount) -> io::Result<()> {
        let mut payload = serde_json::to_value(self).map_err(io::Error::other)?;
        payload.as_object_mut().unwrap().remove("sha256");
        if format!(
            "{:x}",
            Sha256::digest(serde_json::to_vec(&payload).map_err(io::Error::other)?)
        ) != self.sha256
        {
            return Err(reject("workload_identity_integrity"));
        }
        if self.version != 2
            || self.namespace != PREPARED
            || [
                self.runtime_uid,
                self.runtime_gid,
                self.workload_uid,
                self.workload_gid,
            ]
            .iter()
            .any(|n| *n == 0 || *n == u32::MAX)
        {
            return Err(reject("invalid_workload_identity"));
        }
        if self.runtime_uid != account.uid
            || self.runtime_gid != account.gid
            || self.workload_uid < 65536
            || self.workload_gid < 65536
            || self.workload_uid == account.uid
            || self.workload_gid == account.gid
        {
            return Err(reject("workload_identity_conflict"));
        }
        self.mapping().arguments()?;
        Ok(())
    }
    pub fn load(account: &RuntimeAccount) -> io::Result<Self> {
        private_root(Path::new("/etc/jetski"), 0o700)?;
        let record: Self = serde_json::from_slice(&read_private(
            Path::new("/etc/jetski/workload.json"),
            16384,
        )?)
        .map_err(|_| reject("invalid_workload_identity"))?;
        record.validate(account)?;
        Ok(record)
    }
}
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct IdRange {
    container_id: u64,
    host_id: u64,
    size: u64,
}
fn mapping_proof(rows: &Value) -> io::Result<(u32, u32, Vec<[u64; 3]>)> {
    let mut rows: Vec<IdRange> =
        serde_json::from_value(rows.clone()).map_err(|_| reject("invalid_workload_mapping"))?;
    if !(1..=16).contains(&rows.len()) {
        return Err(reject("invalid_workload_mapping"));
    }
    for (i, row) in rows.iter().enumerate() {
        let end = row
            .container_id
            .checked_add(row.size)
            .ok_or_else(|| reject("invalid_workload_mapping"))?;
        let host_end = row
            .host_id
            .checked_add(row.size)
            .ok_or_else(|| reject("invalid_workload_mapping"))?;
        if row.size == 0 || end > u32::MAX as u64 || host_end > u32::MAX as u64 {
            return Err(reject("invalid_workload_mapping"));
        }
        for old in &rows[..i] {
            if (row.container_id < old.container_id + old.size && old.container_id < end)
                || (row.host_id < old.host_id + old.size && old.host_id < host_end)
            {
                return Err(reject("overlapping_workload_mapping"));
            }
        }
    }
    let resolve = |id| -> io::Result<u32> {
        let found: Vec<_> = rows
            .iter()
            .filter(|r| r.container_id <= id && id < r.container_id + r.size)
            .collect();
        if found.len() != 1 {
            return Err(reject("unmapped_workload_identity"));
        }
        Ok((found[0].host_id + id - found[0].container_id) as u32)
    };
    let root = resolve(0)?;
    let workload = resolve(1000)?;
    rows.sort_by_key(|r| r.container_id);
    Ok((
        root,
        workload,
        rows.iter()
            .map(|r| [r.container_id, r.container_id, r.size])
            .collect(),
    ))
}
pub fn runtime_probe(run: &impl HostRunner) -> io::Result<Value> {
    let result = run.run(&["info".into(), "--format".into(), "json".into()])?;
    if result.exit_code != 0 {
        return Err(reject("rootless_runtime_unavailable"));
    }
    let info: Value =
        serde_json::from_str(&result.stdout).map_err(|_| reject("invalid_runtime_info"))?;
    if info.pointer("/host/security/rootless") != Some(&Value::Bool(true))
        || info.pointer("/host/cgroupVersion").and_then(Value::as_str) != Some("v2")
    {
        return Err(reject("rootless_cgroup_v2_required"));
    }
    let version = info
        .pointer("/version/Version")
        .and_then(Value::as_str)
        .ok_or_else(|| reject("invalid_runtime_version"))?;
    if version
        .split('.')
        .next()
        .and_then(|n| n.parse::<u32>().ok())
        .is_none_or(|major| major < 4)
    {
        return Err(reject("unsupported_podman_version"));
    }
    let driver = info
        .pointer("/store/graphDriverName")
        .and_then(Value::as_str)
        .ok_or_else(|| reject("unsupported_storage_driver"))?;
    if !["overlay", "vfs"].contains(&driver) {
        return Err(reject("unsupported_storage_driver"));
    }
    let (runtime_uid, workload_uid, uid_mappings) = mapping_proof(
        info.pointer("/host/idMappings/uidmap")
            .unwrap_or(&Value::Null),
    )?;
    let (runtime_gid, workload_gid, gid_mappings) = mapping_proof(
        info.pointer("/host/idMappings/gidmap")
            .unwrap_or(&Value::Null),
    )?;
    if workload_uid < 65536 || workload_gid < 65536 {
        return Err(reject("subordinate_workload_identity_required"));
    }
    let mut details = json!({"podmanVersion":version,"storageDriver":driver,"runtimeUid":runtime_uid,"runtimeGid":runtime_gid,"workloadUid":workload_uid,"workloadGid":workload_gid,"uidMappings":uid_mappings,"gidMappings":gid_mappings});
    if let Some(value) = info.pointer("/store/graphOptions/overlay.mount_program")
        && let Some(program) = value
            .as_str()
            .or_else(|| value.get("Executable").and_then(Value::as_str))
    {
        details["storageMountProgram"] = json!(program);
    }
    Ok(details)
}
pub fn preflight(
    config: &HostConfig,
    account: &RuntimeAccount,
    run: &impl HostRunner,
) -> io::Result<Value> {
    if !cfg!(all(target_os = "linux", target_arch = "x86_64")) {
        return Err(reject("unsupported_host_platform"));
    }
    if !Path::new("/sys/fs/cgroup/cgroup.controllers").is_file() {
        return Err(reject("cgroup_v2_required"));
    }
    for path in ["/etc/subuid", "/etc/subgid"] {
        let raw = fs::read_to_string(path)?;
        let found = raw.lines().any(|line| {
            let fields: Vec<_> = line.split(':').collect();
            fields.len() == 3
                && (fields[0] == ACCOUNT || fields[0] == account.uid.to_string())
                && fields[2].parse::<u64>().is_ok_and(|size| size >= 65536)
        });
        if !found {
            return Err(reject("subordinate_ids_required"));
        }
    }
    for namespace in ["user", "mnt", "pid", "net"] {
        if !Path::new("/proc/self/ns").join(namespace).exists() {
            return Err(reject("required_namespace_unavailable"));
        }
    }
    let mut details = runtime_probe(run)?;
    if config.storage_mode == StorageMode::FuseOverlayfs
        && (details["storageDriver"] != "overlay"
            || details["storageMountProgram"] != "/usr/bin/fuse-overlayfs")
    {
        return Err(reject("requested_storage_mode_unavailable"));
    }
    for (key,value) in json!({"ready":true,"version":1,"machineId":config.machine_id,"poolId":config.pool_id,"architecture":"x86_64","rootless":true,"networkMode":config.network_mode.as_str()}).as_object().unwrap() {details[key]=value.clone();}
    Ok(details)
}
