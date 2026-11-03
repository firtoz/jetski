//! Durable command admission, observation and output. Unknown execution is never replayed.
use crate::command_spec::Specification;
use crate::fence::{Fence, LockedFence, Phase, State};
use crate::protocol::{Lease, canonical_uuid};
use crate::terminal_input::TerminalInputs;
use base64::{Engine as _, engine::general_purpose::STANDARD};
use rustix::fs::{self as sysfs, FileType, FlockOperation, Mode, OFlags};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::fs::File;
use std::io;
use std::os::unix::fs::FileExt;
use std::path::Path;
use std::thread;
use std::time::{Duration, Instant};
pub const OUTPUT_BYTES: u64 = 16 * 1024 * 1024;
pub const START_WAIT_MAX_MS: u32 = 1000;
fn reject(message: &'static str) -> io::Error {
    io::Error::other(message)
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum CommandPhase {
    Queued,
    Running,
    Succeeded,
    Failed,
    Cancelled,
    Uncertain,
}
impl CommandPhase {
    pub fn terminal(self) -> bool {
        matches!(self, Self::Succeeded | Self::Failed | Self::Cancelled)
    }
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Receipt {
    pub id: String,
    pub spec: Specification,
    pub phase: CommandPhase,
    pub exit_code: Option<i32>,
    pub cancel_requested: bool,
    #[serde(flatten)]
    pub details: BTreeMap<String, Value>,
}
impl Receipt {
    pub fn validate(&self) -> io::Result<()> {
        if !canonical_uuid(&self.id)
            || self.details.keys().any(|key| {
                ["id", "spec", "phase", "exitCode", "cancelRequested"].contains(&key.as_str())
            })
        {
            return Err(reject("invalid_command_journal"));
        }
        self.spec.validate()
    }
}
pub struct WorkerGuard {
    _file: Option<File>,
}
pub fn worker_guard(
    root: &Path,
    lease: &Lease,
    command: &str,
    create: bool,
) -> io::Result<Option<WorkerGuard>> {
    lease.validate()?;
    if !canonical_uuid(command) {
        return Err(reject("invalid_command_id"));
    }
    let mut flags = OFlags::RDWR | OFlags::NOFOLLOW | OFlags::NONBLOCK | OFlags::CLOEXEC;
    if create {
        flags |= OFlags::CREATE;
    }
    let file = match sysfs::open(
        root.join(format!("{}-{command}.worker", lease.assignment_id)),
        flags,
        Mode::from_raw_mode(0o600),
    ) {
        Ok(fd) => File::from(fd),
        Err(rustix::io::Errno::NOENT) if !create => return Ok(Some(WorkerGuard { _file: None })),
        Err(error) => return Err(error.into()),
    };
    let meta = sysfs::fstat(&file)?;
    if FileType::from_raw_mode(meta.st_mode) != FileType::RegularFile
        || meta.st_uid != rustix::process::geteuid().as_raw()
        || meta.st_mode & 0o077 != 0
        || meta.st_nlink != 1
    {
        return Err(reject("unsafe_worker_guard"));
    }
    match sysfs::flock(&file, FlockOperation::NonBlockingLockExclusive) {
        Ok(()) => Ok(Some(WorkerGuard { _file: Some(file) })),
        Err(rustix::io::Errno::WOULDBLOCK) => Ok(None),
        Err(error) => Err(error.into()),
    }
}
pub fn receipt(state: &State, id: &str) -> io::Result<Receipt> {
    if !canonical_uuid(id) {
        return Err(reject("invalid_command_id"));
    }
    let value = state
        .sections
        .get("commands")
        .and_then(|v| v.get(id))
        .ok_or_else(|| reject("unknown_command"))?;
    let row: Receipt =
        serde_json::from_value(value.clone()).map_err(|_| reject("invalid_command_journal"))?;
    row.validate()?;
    if row.id != id {
        return Err(reject("invalid_command_journal"));
    }
    Ok(row)
}
pub fn save(guard: &LockedFence<'_>, state: &mut State, row: Receipt) -> io::Result<Receipt> {
    row.validate()?;
    let commands = state
        .sections
        .entry("commands".into())
        .or_insert_with(|| json!({}))
        .as_object_mut()
        .ok_or_else(|| reject("invalid_command_journal"))?;
    commands.insert(
        row.id.clone(),
        serde_json::to_value(&row).map_err(io::Error::other)?,
    );
    guard.write(state)?;
    Ok(row)
}
pub fn reconcile_workers_locked(
    guard: &LockedFence<'_>,
    state: &mut State,
    root: &Path,
) -> io::Result<()> {
    let Some(value) = state.sections.get("commands") else {
        return Ok(());
    };
    let rows = value
        .as_object()
        .ok_or_else(|| reject("invalid_command_journal"))?;
    let ids: Vec<_> = rows.keys().cloned().collect();
    let mut changed = false;
    for id in ids {
        let mut row = receipt(state, &id)?;
        if row.phase == CommandPhase::Running
            && worker_guard(root, &state.lease, &id, false)?.is_some()
        {
            row.phase = CommandPhase::Uncertain;
            row.exit_code = None;
            row.details.insert("reason".into(), json!("worker_lost"));
            state.sections.get_mut("commands").unwrap()[&id] =
                serde_json::to_value(row).map_err(io::Error::other)?;
            state.phase = Phase::Quarantined;
            changed = true;
        }
    }
    if changed {
        guard.write(state)?;
    }
    Ok(())
}
pub struct Commands<'a> {
    pub fence: &'a Fence,
    pub worker_root: &'a Path,
    pub output_root: &'a Path,
    pub terminal_root: &'a Path,
    pub launch: &'a dyn Fn(&str) -> io::Result<()>,
}
impl Commands<'_> {
    fn state(&self, guard: &LockedFence<'_>, lease: &Lease) -> io::Result<State> {
        lease.validate()?;
        let mut state = guard.read()?.ok_or_else(|| reject("stale_lease"))?;
        state.matches(lease)?;
        reconcile_workers_locked(guard, &mut state, self.worker_root)?;
        Ok(state)
    }
    pub fn start(&self, lease: &Lease, id: &str, spec: Specification) -> io::Result<Receipt> {
        lease.validate()?;
        if !canonical_uuid(id) {
            return Err(reject("invalid_command_id"));
        }
        spec.validate()?;
        let guard = self.fence.locked()?;
        let mut state = self.state(&guard, lease)?;
        if state
            .sections
            .get("commands")
            .and_then(|v| v.get(id))
            .is_some()
        {
            let row = receipt(&state, id)?;
            if row.spec != spec {
                return Err(reject("command_identity_conflict"));
            }
            return Ok(row);
        }
        if state.phase != Phase::Open
            || state
                .sections
                .get("runtime")
                .and_then(|v| v.get("phase"))
                .and_then(Value::as_str)
                != Some("running")
        {
            return Err(reject("runtime_not_running"));
        }
        if let Some(rows) = state.sections.get("commands")
            && rows
                .as_object()
                .ok_or_else(|| reject("invalid_command_journal"))?
                .len()
                >= 256
        {
            return Err(reject("command_history_limit"));
        }
        if spec.terminal {
            TerminalInputs::new(self.fence, self.terminal_root)
                .initialize_locked(&guard, lease, id)?;
        }
        let row = save(
            &guard,
            &mut state,
            Receipt {
                id: id.into(),
                spec,
                phase: CommandPhase::Queued,
                exit_code: None,
                cancel_requested: false,
                details: BTreeMap::new(),
            },
        )?;
        // A launch error leaves its original queued identity. Reconnect observes;
        // it does not spawn another worker with unknown execution completion.
        (self.launch)(id)?;
        Ok(row)
    }
    pub fn status(&self, lease: &Lease, id: &str) -> io::Result<Receipt> {
        let guard = self.fence.locked()?;
        receipt(&self.state(&guard, lease)?, id)
    }
    pub fn wait(&self, lease: &Lease, id: &str, milliseconds: u32) -> io::Result<Receipt> {
        if milliseconds > START_WAIT_MAX_MS {
            return Err(reject("invalid_command_wait"));
        }
        let until = Instant::now() + Duration::from_millis(milliseconds as u64);
        loop {
            let row = self.status(lease, id)?;
            if !matches!(row.phase, CommandPhase::Queued | CommandPhase::Running)
                || Instant::now() >= until
            {
                return Ok(row);
            }
            thread::sleep(
                Duration::from_millis(10).min(until.saturating_duration_since(Instant::now())),
            );
        }
    }
    pub fn cancel(&self, lease: &Lease, id: &str) -> io::Result<Receipt> {
        let guard = self.fence.locked()?;
        let mut state = self.state(&guard, lease)?;
        let mut row = receipt(&state, id)?;
        if row.phase.terminal() {
            return Ok(row);
        }
        row.cancel_requested = true;
        if row.phase == CommandPhase::Queued {
            row.phase = CommandPhase::Cancelled;
            row.details.insert("neverStarted".into(), json!(true));
        }
        save(&guard, &mut state, row)
    }
    pub fn prepare_quiesce(&self, lease: &Lease) -> io::Result<()> {
        self.fence.close(lease)?;
        let until = Instant::now() + Duration::from_secs(10);
        loop {
            let guard = self.fence.locked()?;
            let mut state = self.state(&guard, lease)?;
            let mut pending = false;
            let ids: Vec<_> = match state.sections.get("commands") {
                None => Vec::new(),
                Some(value) => value
                    .as_object()
                    .ok_or_else(|| reject("invalid_command_journal"))?
                    .keys()
                    .cloned()
                    .collect(),
            };
            for id in ids {
                let mut row = receipt(&state, &id)?;
                match row.phase {
                    CommandPhase::Queued => {
                        row.phase = CommandPhase::Cancelled;
                        row.cancel_requested = true;
                        row.details.insert("neverStarted".into(), json!(true));
                    }
                    CommandPhase::Running => {
                        row.cancel_requested = true;
                        pending = true;
                    }
                    _ => {}
                }
                state.sections.get_mut("commands").unwrap()[&id] =
                    serde_json::to_value(row).map_err(io::Error::other)?;
            }
            guard.write(&state)?;
            drop(guard);
            if !pending {
                return Ok(());
            }
            if Instant::now() >= until {
                return Err(reject("command_quiescence_pending"));
            }
            thread::sleep(Duration::from_millis(50));
        }
    }
    pub fn output(
        &self,
        lease: &Lease,
        id: &str,
        channel: &str,
        offset: u64,
        count: usize,
    ) -> io::Result<Value> {
        if !["stdout", "stderr"].contains(&channel) || !(1..=256 * 1024).contains(&count) {
            return Err(reject("invalid_output_cursor"));
        }
        let row = self.status(lease, id)?;
        let terminal = row.phase.terminal() || row.phase == CommandPhase::Uncertain;
        let opened = (|| {
            let mut dir = File::from(sysfs::open(
                self.output_root,
                OFlags::RDONLY | OFlags::DIRECTORY | OFlags::NOFOLLOW | OFlags::CLOEXEC,
                Mode::empty(),
            )?);
            for name in [&lease.assignment_id, id] {
                dir = File::from(sysfs::openat(
                    &dir,
                    name,
                    OFlags::RDONLY | OFlags::DIRECTORY | OFlags::NOFOLLOW | OFlags::CLOEXEC,
                    Mode::empty(),
                )?);
            }
            let file = File::from(sysfs::openat(
                &dir,
                channel,
                OFlags::RDONLY | OFlags::NOFOLLOW | OFlags::NONBLOCK | OFlags::CLOEXEC,
                Mode::empty(),
            )?);
            Ok::<_, io::Error>(file)
        })();
        let file = match opened {
            Ok(file) => file,
            Err(error) if error.kind() == io::ErrorKind::NotFound => {
                if offset != 0 {
                    return Err(reject("output_cursor_beyond_end"));
                }
                return Ok(json!({"base64":"","nextOffset":0,"terminal":terminal}));
            }
            Err(error) => return Err(error),
        };
        let meta = sysfs::fstat(&file)?;
        if FileType::from_raw_mode(meta.st_mode) != FileType::RegularFile
            || meta.st_size < 0
            || meta.st_size as u64 > OUTPUT_BYTES
            || offset > meta.st_size as u64
        {
            return Err(reject("output_extent_invalid"));
        }
        let mut data = vec![0; count];
        let n = file.read_at(&mut data, offset)?;
        data.truncate(n);
        Ok(
            json!({"base64":STANDARD.encode(&data),"nextOffset":offset+n as u64,"terminal":terminal && offset+n as u64==meta.st_size as u64}),
        )
    }
    pub fn snapshot(&self, lease: &Lease, id: &str) -> io::Result<Value> {
        if !self.status(lease, id)?.phase.terminal() {
            return Ok(Value::Null);
        }
        let mut channels = json!({});
        for channel in ["stdout", "stderr"] {
            let value = self.output(lease, id, channel, 0, 8192)?;
            channels[channel] = Value::Null;
            if value["terminal"] == true {
                let data = STANDARD
                    .decode(
                        value["base64"]
                            .as_str()
                            .ok_or_else(|| reject("invalid_output"))?,
                    )
                    .map_err(|_| reject("invalid_output"))?;
                channels[channel] =
                    json!({"base64":value["base64"],"sha256":format!("{:x}",Sha256::digest(data))});
            }
        }
        Ok(json!({"version":1,"channels":channels}))
    }
}
