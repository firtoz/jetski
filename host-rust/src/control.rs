//! Protocol actions composed from fenced native components. Trusted controller only.
use crate::{
    archive::Owner,
    checkpoint_cache::{CheckpointCache, reject, sync_dir},
    checkpoint_import::CheckpointImport,
    checkpoint_transfer::{CheckpointExport, Transfer, exists},
    checkpoints::Checkpoints,
    command_spec::Specification,
    commands::{self, Commands},
    fence::{Fence, Phase, ReleaseReceipt},
    files::Files,
    host_config::{self, HostConfig, RuntimeAccount, WorkloadIdentity},
    process::HostRunner,
    protocol::{Lease, Request},
    runtime::{PodmanRuntime, RuntimeOptions},
    streams::Streams,
    terminal_input::{Input, TerminalInputs},
    uploads::{UploadSpec, Uploads},
};
use rustix::{
    fs::{self as sysfs, Mode, OFlags},
    process::{Gid, Uid},
};
use serde::Serialize;
use serde_json::{Value, json};
use std::{
    fs::{self, File},
    io,
    path::Path,
};
fn value(value: impl Serialize) -> io::Result<Value> {
    serde_json::to_value(value).map_err(io::Error::other)
}
fn text<'a>(payload: &'a Value, key: &str) -> io::Result<&'a str> {
    payload
        .get(key)
        .and_then(Value::as_str)
        .ok_or_else(|| reject("invalid_action_payload"))
}
fn optional_text<'a>(payload: &'a Value, key: &str) -> io::Result<Option<&'a str>> {
    match payload.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(s)) => Ok(Some(s)),
        _ => Err(reject("invalid_action_payload")),
    }
}
fn number(payload: &Value, key: &str, default: Option<u64>) -> io::Result<u64> {
    match payload.get(key) {
        None => default.ok_or_else(|| reject("invalid_action_payload")),
        Some(v) => v
            .as_u64()
            .filter(|n| *n <= crate::protocol::MAX_GENERATION)
            .ok_or_else(|| reject("invalid_action_payload")),
    }
}
fn narrow<T: TryFrom<u64>>(payload: &Value, key: &str, default: Option<u64>) -> io::Result<T> {
    number(payload, key, default)?
        .try_into()
        .map_err(|_| reject("invalid_action_payload"))
}
pub struct Paths<'a> {
    pub slot: &'a Path,
    pub commands: &'a Path,
    pub terminal: &'a Path,
    pub data: &'a Path,
    pub archives: &'a Path,
    pub supervisor: &'a Path,
    pub relay: &'a Path,
}
pub struct Control<'a, R: HostRunner> {
    pub fence: &'a Fence,
    pub config: &'a HostConfig,
    pub account: &'a RuntimeAccount,
    pub ownership: &'a WorkloadIdentity,
    pub run: &'a R,
    pub paths: Paths<'a>,
    pub transfer: Option<Transfer<'a>>,
    pub export: Option<Transfer<'a>>,
    pub launch: &'a dyn Fn(&str, &Lease) -> io::Result<()>,
}
impl<R: HostRunner> Control<'_, R> {
    pub fn dispatch(&self, request: &Request) -> io::Result<Value> {
        request.validate()?;
        self.config.validate()?;
        self.ownership.validate(self.account)?;
        if request.action == "status" {
            let mut proof = host_config::preflight(self.config, self.account, self.run)?;
            verify_ownership(&proof, self.account, self.ownership)?;
            proof["cachedResumeVersion"] = json!(1);
            return Ok(proof);
        }
        let payload = &request.payload;
        let lease: Lease = serde_json::from_value(
            payload
                .get("lease")
                .ok_or_else(|| reject("missing_lease"))?
                .clone(),
        )
        .map_err(|_| reject("invalid_identity"))?;
        lease.validate()?;
        if lease.machine_id != self.config.machine_id || lease.pool_id != self.config.pool_id {
            return Err(reject("physical_identity_conflict"));
        }
        if request.action == "claim" {
            return value(self.fence.claim(&lease)?);
        }
        if request.action == "resume-cached" {
            let image = text(payload, "image")?;
            if !self.config.images.iter().any(|v| v == image) {
                return Err(reject("unapproved_image"));
            }
            self.fence.claim(&lease)?;
            let imported = {
                let guard = self.fence.locked()?;
                let state = guard.read()?.ok_or_else(|| reject("stale_lease"))?;
                state.matches(&lease)?;
                if state.sections.contains_key("runtime") {
                    let imported = state
                        .sections
                        .get("import")
                        .ok_or_else(|| reject("cached_resume_identity_conflict"))?;
                    if imported.get("phase").and_then(Value::as_str) != Some("ready")
                        || imported.get("id").and_then(Value::as_str)
                            != Some(text(payload, "checkpointId")?)
                        || imported.get("sha256").and_then(Value::as_str)
                            != Some(text(payload, "sha256")?)
                        || imported.get("bytes").and_then(Value::as_u64)
                            != Some(number(payload, "bytes", None)?)
                    {
                        return Err(reject("cached_resume_identity_conflict"));
                    }
                    Some(imported.clone())
                } else {
                    None
                }
            };
            let imported = match imported {
                Some(v) => v,
                None => self.step(request, "import-begin")?,
            };
            let ready = imported.get("phase").and_then(Value::as_str) == Some("ready");
            let runtime = if ready {
                self.step(request, "create")?
            } else {
                Value::Null
            };
            return Ok(
                json!({"lease":lease,"checkpointId":imported["id"],"sha256":imported["sha256"],"bytes":imported["bytes"],"ready":ready,"runtime":runtime}),
            );
        }
        {
            let guard = self.fence.locked()?;
            let mut state = guard.read()?.ok_or_else(|| reject("stale_lease"))?;
            state.matches(&lease)?;
            commands::reconcile_workers_locked(&guard, &mut state, self.paths.slot)?;
            if request.action == "inspect" {
                return value(state);
            }
        }
        let importer = CheckpointImport {
            fence: self.fence,
            archives: self.paths.archives,
            data: self.paths.data,
            owner: Some(Owner {
                uid: self.ownership.workload_uid,
                gid: self.ownership.workload_gid,
            }),
            transfer: self.transfer,
        };
        let checkpoints = Checkpoints {
            fence: self.fence,
            archives: self.paths.archives,
            data: self.paths.data,
        };
        let uploads = Uploads::new(
            self.fence,
            self.paths.data,
            self.ownership.workload_uid,
            self.ownership.workload_gid,
            0,
        )?;
        let files = Files::new(self.fence, self.paths.data, self.ownership.workload_uid, 0);
        let launch = |command: &str| (self.launch)(command, &lease);
        let commands = Commands {
            fence: self.fence,
            worker_root: self.paths.slot,
            output_root: self.paths.commands,
            terminal_root: self.paths.terminal,
            launch: &launch,
        };
        let streams = Streams { fence: self.fence };
        match request.action.as_str() {
            "stream-reserve" => value(streams.reserve(
                &lease,
                text(payload, "streamId")?,
                narrow(payload, "port", None)?,
            )?),
            "stream-status" => value(streams.status(&lease, text(payload, "streamId")?)?),
            "stream-cancel" => value(streams.cancel(&lease, text(payload, "streamId")?)?),
            "import-begin" => importer.advertised(&importer.begin(
                &lease,
                text(payload, "checkpointId")?,
                text(payload, "sha256")?,
                number(payload, "bytes", None)?,
            )?),
            "import-chunk" => importer.advertised(&importer.chunk(
                &lease,
                number(payload, "offset", None)?,
                text(payload, "base64")?,
                text(payload, "sha256")?,
            )?),
            "import-finish" => importer.advertised(&importer.finish(&lease)?),
            "import-file-begin" => importer.file_begin(&lease),
            "import-file-chunk" => importer.advertised(&importer.file_chunk(
                &lease,
                number(payload, "offset", None)?,
                narrow(payload, "bytes", None)?,
                text(payload, "sha256")?,
            )?),
            "import-file-close" => importer.file_close(&lease),
            "file-write-begin" => value(uploads.begin(
                &lease,
                UploadSpec {
                    id: text(payload, "uploadId")?.into(),
                    path: text(payload, "path")?.into(),
                    bytes: number(payload, "bytes", None)?,
                    sha256: text(payload, "sha256")?.into(),
                    mode: narrow(payload, "mode", Some(0o644))?,
                },
            )?),
            "file-write-chunk" => value(uploads.chunk(
                &lease,
                text(payload, "uploadId")?,
                number(payload, "offset", None)?,
                text(payload, "base64")?,
                text(payload, "sha256")?,
            )?),
            "file-write-finish" => value(uploads.finish(&lease, text(payload, "uploadId")?)?),
            "file-write-status" => value(uploads.status(&lease, text(payload, "uploadId")?)?),
            "file-read" => value(files.read(
                &lease,
                text(payload, "path")?,
                number(payload, "offset", None)?,
                narrow(payload, "bytes", None)?,
                optional_text(payload, "expectedVersion")?,
            )?),
            "file-list" => value(files.list(
                &lease,
                text(payload, "path")?,
                optional_text(payload, "after")?.unwrap_or(""),
                narrow(payload, "limit", Some(256))?,
                optional_text(payload, "expectedVersion")?,
            )?),
            "command-start" | "terminal-start" => {
                let wait_ms: u32 = narrow(payload, "waitMs", Some(0))?;
                if wait_ms > commands::START_WAIT_MAX_MS {
                    return Err(reject("invalid_command_wait"));
                }
                let geometry = if request.action == "terminal-start" {
                    Some((
                        narrow(payload, "rows", Some(24))?,
                        narrow(payload, "columns", Some(80))?,
                    ))
                } else {
                    None
                };
                let argv: Vec<String> = serde_json::from_value(
                    payload
                        .get("argv")
                        .ok_or_else(|| reject("invalid_command_argv"))?
                        .clone(),
                )
                .map_err(|_| reject("invalid_command_argv"))?;
                let spec = Specification::new(
                    argv,
                    optional_text(payload, "cwd")?
                        .unwrap_or("/workspace")
                        .into(),
                    narrow(payload, "timeout", Some(120))?,
                    geometry,
                )?;
                let id = text(payload, "commandId")?;
                let mut receipt = commands.start(&lease, id, spec)?;
                if wait_ms > 0 {
                    receipt = commands.wait(&lease, id, wait_ms)?;
                }
                let terminal = receipt.phase.terminal();
                let mut result = value(receipt)?;
                if terminal {
                    result["outputSnapshot"] = commands.snapshot(&lease, id)?;
                }
                Ok(result)
            }
            "command-status" => {
                let id = text(payload, "commandId")?;
                let receipt = commands.status(&lease, id)?;
                let terminal = receipt.phase.terminal();
                let mut result = value(receipt)?;
                if terminal {
                    result["outputSnapshot"] = commands.snapshot(&lease, id)?;
                }
                Ok(result)
            }
            "command-output" => commands.output(
                &lease,
                text(payload, "commandId")?,
                text(payload, "channel")?,
                number(payload, "offset", None)?,
                narrow(payload, "bytes", None)?,
            ),
            "command-cancel" => value(commands.cancel(&lease, text(payload, "commandId")?)?),
            "terminal-input" => {
                let input: Input = serde_json::from_value(
                    payload
                        .get("input")
                        .ok_or_else(|| reject("invalid_terminal_input"))?
                        .clone(),
                )
                .map_err(|_| reject("invalid_terminal_input"))?;
                TerminalInputs::new(self.fence, self.paths.terminal).admit(
                    &lease,
                    text(payload, "commandId")?,
                    text(payload, "inputId")?,
                    &input,
                )
            }
            "terminal-input-status" => TerminalInputs::new(self.fence, self.paths.terminal).status(
                &lease,
                text(payload, "commandId")?,
                text(payload, "inputId")?,
            ),
            "capture" => value(
                checkpoints.capture(&lease, narrow(payload, "frameBytes", Some(1024 * 1024))?)?,
            ),
            "read-checkpoint" => checkpoints.read(
                &lease,
                number(payload, "offset", None)?,
                narrow(payload, "bytes", None)?,
            ),
            "checkpoint-source" | "checkpoint-source-close" => {
                let Some(transfer) = self.export else {
                    return Ok(json!({"supported":false}));
                };
                let exporter = CheckpointExport {
                    fence: self.fence,
                    archives: self.paths.archives,
                    transfer,
                };
                if request.action == "checkpoint-source-close" {
                    exporter.close(&lease)
                } else {
                    exporter.prepare(
                        &lease,
                        text(payload, "sha256")?,
                        number(payload, "bytes", None)?,
                    )
                }
            }
            "purge-source" => self.purge(&lease, &uploads),
            "finalize" => {
                let publication: ReleaseReceipt = serde_json::from_value(
                    payload
                        .get("publication")
                        .ok_or_else(|| reject("invalid_finalize_publication"))?
                        .clone(),
                )
                .map_err(|_| reject("invalid_finalize_publication"))?;
                publication.validate()?;
                let released = {
                    let guard = self.fence.locked()?;
                    let state = guard.read()?.ok_or_else(|| reject("stale_lease"))?;
                    state.matches(&lease)?;
                    if !matches!(state.phase, Phase::Closed | Phase::Released)
                        || state
                            .sections
                            .get("checkpoint")
                            .and_then(|v| v.get("sha256"))
                            .and_then(Value::as_str)
                            != Some(publication.sha256.as_str())
                        || (state.phase == Phase::Released
                            && state.sections.get("releaseReceipt") != payload.get("publication"))
                    {
                        return Err(reject("invalid_finalize_publication"));
                    }
                    state.phase == Phase::Released
                };
                if !released {
                    self.step(request, "remove")?;
                }
                self.step(request, "release")?;
                self.step(request, "purge-source")?;
                Ok(json!({"finalized":true,"checkpointId":publication.checkpoint_id}))
            }
            "create" | "quiesce" | "remove" | "release" => {
                let runtime = PodmanRuntime::new(
                    self.fence,
                    self.run,
                    RuntimeOptions {
                        image: text(payload, "image")?,
                        approved_images: &self.config.images,
                        data: self.paths.data,
                        supervisor: Some(self.paths.supervisor),
                        relay: Some(self.paths.relay),
                        network: self.config.network_mode,
                        mapping: self.ownership.mapping(),
                    },
                )?;
                match request.action.as_str() {
                    "create" => {
                        self.prepare_roots(&lease)?;
                        runtime.create(
                            &lease,
                            narrow(payload, "memoryMb", Some(512))?,
                            narrow(payload, "cpus", Some(1))?,
                        )
                    }
                    "quiesce" => {
                        let capture_frame_bytes = payload
                            .get("captureFrameBytes")
                            .map(|_| narrow(payload, "captureFrameBytes", None))
                            .transpose()?;
                        if capture_frame_bytes.is_some_and(|bytes| {
                            ![256 * 1024, 512 * 1024, 1024 * 1024].contains(&bytes)
                        }) {
                            return Err(reject("invalid_capture_frame_size"));
                        }
                        commands.prepare_quiesce(&lease)?;
                        let mut result = runtime.quiesce(&lease)?;
                        result["finalizeVersion"] = json!(1);
                        result["checkpointReadBytes"] = json!(crate::checkpoints::READ_BYTES);
                        if let Some(frame_bytes) = capture_frame_bytes {
                            result["archive"] = value(checkpoints.capture(&lease, frame_bytes)?)?;
                        }
                        Ok(result)
                    }
                    "remove" => runtime.remove(&lease),
                    _ => {
                        let publication: ReleaseReceipt = serde_json::from_value(
                            payload
                                .get("publication")
                                .ok_or_else(|| reject("invalid_release_receipt"))?
                                .clone(),
                        )
                        .map_err(|_| reject("invalid_release_receipt"))?;
                        self.fence
                            .release_checked(&lease, &publication, |state, _, p| {
                                if state
                                    .sections
                                    .get("checkpoint")
                                    .and_then(|v| v.get("sha256"))
                                    .and_then(Value::as_str)
                                    != Some(p.sha256.as_str())
                                    || state
                                        .sections
                                        .get("runtime")
                                        .and_then(|v| v.get("phase"))
                                        .and_then(Value::as_str)
                                        != Some("removed")
                                {
                                    return Ok(false);
                                }
                                runtime.absent(&lease)
                            })?;
                        let cache = CheckpointCache {
                            fence: self.fence,
                            archives: self.paths.archives,
                        };
                        cache.publish(&lease, &value(publication)?)?;
                        value(
                            self.fence
                                .locked()?
                                .read()?
                                .ok_or_else(|| reject("stale_lease"))?,
                        )
                    }
                }
            }
            _ => Err(reject("unsupported_host_action")),
        }
    }
    fn step(&self, request: &Request, action: &str) -> io::Result<Value> {
        self.dispatch(&Request {
            version: request.version,
            id: request.id.clone(),
            action: action.into(),
            payload: request.payload.clone(),
        })
    }
    fn prepare_roots(&self, lease: &Lease) -> io::Result<()> {
        let guard = self.fence.locked()?;
        let state = guard.read()?.ok_or_else(|| reject("stale_lease"))?;
        state.matches(lease)?;
        if state.phase != Phase::Open {
            return Err(reject("closed_lease"));
        }
        if state
            .sections
            .get("import")
            .is_some_and(|v| v.get("phase").and_then(Value::as_str) != Some("ready"))
        {
            return Err(reject("checkpoint_import_incomplete"));
        }
        let assignment = self.paths.data.join(&lease.assignment_id);
        for path in [
            &assignment,
            &assignment.join("workspace"),
            &assignment.join("home"),
        ] {
            match sysfs::mkdir(path, Mode::from_raw_mode(0o700)) {
                Ok(()) | Err(rustix::io::Errno::EXIST) => {}
                Err(e) => return Err(e.into()),
            }
            let directory = File::from(sysfs::open(
                path,
                OFlags::RDONLY | OFlags::DIRECTORY | OFlags::NOFOLLOW | OFlags::CLOEXEC,
                Mode::empty(),
            )?);
            let meta = sysfs::fstat(&directory)?;
            if meta.st_uid != 0 && meta.st_uid != self.ownership.workload_uid {
                return Err(reject("unsafe_persistent_root"));
            }
            if path == &assignment {
                sysfs::fchown(&directory, Some(Uid::ROOT), Some(Gid::ROOT))?;
                sysfs::fchmod(&directory, Mode::from_raw_mode(0o711))?;
            } else {
                sysfs::fchown(
                    &directory,
                    Some(Uid::from_raw(self.ownership.workload_uid)),
                    Some(Gid::from_raw(self.ownership.workload_gid)),
                )?;
            }
            directory.sync_all()?;
        }
        sync_dir(self.paths.data)?;
        Ok(())
    }
    fn purge(&self, lease: &Lease, uploads: &Uploads<'_>) -> io::Result<Value> {
        let guard = self.fence.locked()?;
        let state = guard.read()?.ok_or_else(|| reject("stale_lease"))?;
        state.matches(lease)?;
        if state.phase != Phase::Released || !state.sections.contains_key("releaseReceipt") {
            return Err(reject("source_not_durably_released"));
        }
        uploads.purge_locked(&state)?;
        let destination = self.paths.data.join(&lease.assignment_id);
        if exists(&destination)? {
            let meta = fs::symlink_metadata(&destination)?;
            if !meta.is_dir() || meta.is_symlink() {
                return Err(reject("unsafe_source_path"));
            }
            fs::remove_dir_all(&destination)?;
        }
        for suffix in ["tgz", "upload"] {
            let path = self
                .paths
                .archives
                .join(format!("{}.{suffix}", lease.assignment_id));
            if exists(&path)? {
                let meta = fs::symlink_metadata(&path)?;
                if !meta.is_file() || meta.is_symlink() {
                    return Err(reject("unsafe_source_archive"));
                }
                fs::remove_file(path)?;
            }
        }
        sync_dir(self.paths.data)?;
        sync_dir(self.paths.archives)?;
        Ok(json!({"purged":true}))
    }
}
pub fn verify_ownership(
    proof: &Value,
    account: &RuntimeAccount,
    ownership: &WorkloadIdentity,
) -> io::Result<()> {
    for (key, expected) in [
        ("runtimeUid", json!(account.uid)),
        ("runtimeGid", json!(account.gid)),
        ("workloadUid", json!(ownership.workload_uid)),
        ("workloadGid", json!(ownership.workload_gid)),
        ("uidMappings", json!(ownership.uid_mappings)),
        ("gidMappings", json!(ownership.gid_mappings)),
    ] {
        if proof.get(key) != Some(&expected) {
            return Err(reject("runtime_ownership_changed"));
        }
    }
    Ok(())
}
