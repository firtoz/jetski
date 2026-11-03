//! Host-only terminal input ledger. Sent means socket acceptance, not consumption.
use crate::fence::{Fence, LockedFence, Phase, State};
use crate::protocol::{Lease, canonical_uuid};
use base64::{Engine as _, engine::general_purpose::STANDARD};
use rustix::fs::{self as sysfs, Mode, OFlags};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::fs::{self, DirBuilder, File};
use std::io;
use std::os::unix::fs::DirBuilderExt;
use std::path::{Path, PathBuf};
fn reject(message: &'static str) -> io::Error {
    io::Error::other(message)
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize, Serialize)]
pub enum Signal {
    INT,
    QUIT,
    TSTP,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(tag = "kind", rename_all = "lowercase", deny_unknown_fields)]
pub enum Input {
    Stdin { base64: String },
    Resize { rows: u16, columns: u16 },
    Signal { signal: Signal },
    Close {},
}
impl Input {
    pub fn frame(&self) -> io::Result<(&'static str, Vec<u8>)> {
        let (kind, tag, body) = match self {
            Self::Stdin { base64 } => {
                if base64.len() > 21848 {
                    return Err(reject("terminal_input_bound"));
                }
                let bytes = STANDARD
                    .decode(base64)
                    .map_err(|_| reject("invalid_terminal_bytes"))?;
                if !(1..=16384).contains(&bytes.len()) || STANDARD.encode(&bytes) != *base64 {
                    return Err(reject("invalid_terminal_bytes"));
                }
                ("stdin", b'I', bytes)
            }
            Self::Resize { rows, columns } => {
                if !(1..=4096).contains(rows) || !(1..=4096).contains(columns) {
                    return Err(reject("invalid_terminal_dimensions"));
                }
                let mut bytes = rows.to_be_bytes().to_vec();
                bytes.extend(columns.to_be_bytes());
                ("resize", b'R', bytes)
            }
            Self::Signal { signal } => (
                "signal",
                b'S',
                vec![match signal {
                    Signal::INT => 2,
                    Signal::QUIT => 3,
                    Signal::TSTP => 20,
                }],
            ),
            Self::Close {} => ("close", b'C', Vec::new()),
        };
        let mut frame = vec![tag];
        frame.extend((body.len() as u32).to_be_bytes());
        frame.extend(body);
        Ok((kind, frame))
    }
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Delivery {
    Queued,
    Dispatched,
    Uncertain,
    Sent,
    Cancelled,
}
#[derive(Clone, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Operation {
    pub id: String,
    pub sequence: u64,
    pub kind: String,
    pub bytes: usize,
    pub sha256: String,
    pub phase: Delivery,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub frame: Option<String>,
}
impl Operation {
    fn public(&self) -> io::Result<Value> {
        let mut value = serde_json::to_value(self).map_err(io::Error::other)?;
        value.as_object_mut().unwrap().remove("frame");
        Ok(value)
    }
}
#[derive(Clone, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Ledger {
    version: u8,
    next: u64,
    ops: BTreeMap<String, Operation>,
}
impl Default for Ledger {
    fn default() -> Self {
        Self {
            version: 1,
            next: 0,
            ops: BTreeMap::new(),
        }
    }
}
impl Ledger {
    fn validate(&self) -> io::Result<()> {
        if self.version != 1 || self.next > 4096 || self.ops.len() > 4096 {
            return Err(reject("terminal_journal_invalid"));
        }
        for (id, op) in &self.ops {
            if !canonical_uuid(id) || op.id != *id || op.sequence >= self.next || op.bytes > 16389 {
                return Err(reject("terminal_journal_invalid"));
            }
        }
        Ok(())
    }
}
pub struct TerminalInputs<'a> {
    fence: &'a Fence,
    root: &'a Path,
}
impl<'a> TerminalInputs<'a> {
    pub fn new(fence: &'a Fence, root: &'a Path) -> Self {
        Self { fence, root }
    }
    fn path(&self, lease: &Lease, command: &str) -> io::Result<PathBuf> {
        lease.validate()?;
        if !canonical_uuid(command) {
            return Err(reject("invalid_command_id"));
        }
        Ok(self.root.join(&lease.assignment_id).join(command))
    }
    pub fn initialize_locked(
        &self,
        guard: &LockedFence<'_>,
        lease: &Lease,
        command: &str,
    ) -> io::Result<()> {
        let state = guard.read()?.ok_or_else(|| reject("stale_lease"))?;
        state.matches(lease)?;
        let path = self.path(lease, command)?;
        for directory in [
            self.root.to_path_buf(),
            self.root.join(&lease.assignment_id),
            path.clone(),
        ] {
            ensure_private_directory(&directory)?;
        }
        let journal = Fence::open(&path)?;
        let lock = journal.locked()?;
        let existing: Option<Ledger> = lock.read_record()?;
        match existing {
            None => lock.write_record(&Ledger::default()),
            Some(value) if value == Ledger::default() => Ok(()),
            _ => Err(reject("terminal_journal_admission_conflict")),
        }
    }
    fn context(
        &self,
        guard: &LockedFence<'_>,
        lease: &Lease,
        command: &str,
    ) -> io::Result<(State, Value, Fence, Ledger)> {
        let state = guard.read()?.ok_or_else(|| reject("stale_lease"))?;
        state.matches(lease)?;
        let command_record = state
            .sections
            .get("commands")
            .and_then(|v| v.get(command))
            .cloned()
            .ok_or_else(|| reject("terminal_unavailable"))?;
        if command_record.pointer("/spec/terminal") != Some(&Value::Bool(true)) {
            return Err(reject("terminal_unavailable"));
        }
        let journal = Fence::open(&self.path(lease, command)?)?;
        let lock = journal.locked()?;
        let mut ledger: Ledger = lock
            .read_record()?
            .ok_or_else(|| reject("terminal_journal_unavailable"))?;
        ledger.validate()?;
        let closed = state.phase != Phase::Open
            || !matches!(command_record["phase"].as_str(), Some("queued" | "running"));
        let mut changed = false;
        for op in ledger.ops.values_mut() {
            if op.phase == Delivery::Dispatched {
                op.phase = Delivery::Uncertain;
                changed = true;
            } else if op.phase == Delivery::Queued && closed {
                op.phase = Delivery::Cancelled;
                op.frame = None;
                changed = true;
            }
        }
        if changed {
            lock.write_record(&ledger)?;
        }
        drop(lock);
        Ok((state, command_record, journal, ledger))
    }
    pub fn admit(
        &self,
        lease: &Lease,
        command: &str,
        id: &str,
        input: &Input,
    ) -> io::Result<Value> {
        if !canonical_uuid(id) {
            return Err(reject("invalid_terminal_input_id"));
        }
        let (kind, frame) = input.frame()?;
        let sha256 = format!("{:x}", Sha256::digest(&frame));
        let guard = self.fence.locked()?;
        let (state, record, journal, mut ledger) = self.context(&guard, lease, command)?;
        if let Some(prior) = ledger.ops.get(id) {
            if prior.sha256 != sha256 {
                return Err(reject("terminal_input_identity_conflict"));
            }
            return prior.public();
        }
        if state.phase != Phase::Open
            || !matches!(record["phase"].as_str(), Some("queued" | "running"))
        {
            return Err(reject("terminal_closed"));
        }
        if ledger.ops.len() >= 4096
            || ledger
                .ops
                .values()
                .filter(|op| op.phase == Delivery::Queued)
                .count()
                >= 64
        {
            return Err(reject("terminal_input_history_bound"));
        }
        if ledger
            .ops
            .values()
            .any(|op| matches!(op.phase, Delivery::Dispatched | Delivery::Uncertain))
        {
            return Err(reject("terminal_input_delivery_uncertain"));
        }
        let op = Operation {
            id: id.into(),
            sequence: ledger.next,
            kind: kind.into(),
            bytes: frame.len(),
            sha256,
            phase: Delivery::Queued,
            frame: Some(STANDARD.encode(frame)),
        };
        ledger.next += 1;
        ledger.ops.insert(id.into(), op.clone());
        journal.locked()?.write_record(&ledger)?;
        op.public()
    }
    pub fn status(&self, lease: &Lease, command: &str, id: &str) -> io::Result<Value> {
        if !canonical_uuid(id) {
            return Err(reject("invalid_terminal_input_id"));
        }
        let guard = self.fence.locked()?;
        let (state, record, _, ledger) = self.context(&guard, lease, command)?;
        match ledger.ops.get(id) {
            Some(op) => op.public(),
            None => Ok(
                json!({"id":id,"phase":"absent","closed":state.phase!=Phase::Open || !matches!(record["phase"].as_str(),Some("queued"|"running"))}),
            ),
        }
    }
    pub fn dispatch_one(
        &self,
        lease: &Lease,
        command: &str,
        send: impl FnOnce(&[u8]) -> io::Result<()>,
    ) -> io::Result<bool> {
        let guard = self.fence.locked()?;
        let (state, record, journal, mut ledger) = self.context(&guard, lease, command)?;
        if state.phase != Phase::Open || record["phase"] != "running" {
            return Ok(false);
        }
        if ledger
            .ops
            .values()
            .any(|op| matches!(op.phase, Delivery::Dispatched | Delivery::Uncertain))
        {
            return Err(reject("terminal_input_delivery_uncertain"));
        }
        let Some(id) = ledger
            .ops
            .values()
            .filter(|op| op.phase == Delivery::Queued)
            .min_by_key(|op| op.sequence)
            .map(|op| op.id.clone())
        else {
            return Ok(false);
        };
        let op = ledger.ops.get_mut(&id).unwrap();
        let frame = STANDARD
            .decode(
                op.frame
                    .as_deref()
                    .ok_or_else(|| reject("terminal_input_corrupt"))?,
            )
            .map_err(|_| reject("terminal_input_corrupt"))?;
        if format!("{:x}", Sha256::digest(&frame)) != op.sha256 {
            return Err(reject("terminal_input_corrupt"));
        }
        op.phase = Delivery::Dispatched;
        journal.locked()?.write_record(&ledger)?;
        if let Err(error) = send(&frame) {
            ledger.ops.get_mut(&id).unwrap().phase = Delivery::Uncertain;
            journal.locked()?.write_record(&ledger)?;
            return Err(error);
        }
        let op = ledger.ops.get_mut(&id).unwrap();
        op.phase = Delivery::Sent;
        op.frame = None;
        journal.locked()?.write_record(&ledger)?;
        Ok(true)
    }
}
/// Parent is supervisor-owned. Names beneath it are fixed or canonical UUIDs.
pub(crate) fn ensure_private_directory(path: &Path) -> io::Result<()> {
    match DirBuilder::new().mode(0o700).create(path) {
        Ok(()) => {
            if let Some(parent) = path.parent() {
                File::from(sysfs::open(
                    parent,
                    OFlags::RDONLY | OFlags::DIRECTORY | OFlags::NOFOLLOW | OFlags::CLOEXEC,
                    Mode::empty(),
                )?)
                .sync_all()?;
            }
        }
        Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {}
        Err(error) => return Err(error),
    }
    let meta = fs::symlink_metadata(path)?;
    use std::os::unix::fs::MetadataExt;
    if !meta.is_dir()
        || meta.uid() != rustix::process::geteuid().as_raw()
        || meta.mode() & 0o077 != 0
    {
        return Err(reject("unsafe_private_directory"));
    }
    Ok(())
}
