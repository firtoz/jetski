//! Durable lease journal. Callers must validate its supervisor-owned parent path.
use crate::protocol::{Lease, canonical_uuid};
use rustix::fs::{AtFlags, FlockOperation, Mode, OFlags, flock, open, openat, renameat, unlinkat};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;
use std::fs::File;
use std::io::{self, Read, Write};
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};

const STATE_BYTES: u64 = 16 * 1024 * 1024;
static NEXT_TEMP: AtomicU64 = AtomicU64::new(0);

fn reject(message: &'static str) -> io::Error {
    io::Error::other(message)
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Phase {
    Open,
    Closed,
    Released,
    Quarantined,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct State {
    pub lease: Lease,
    pub phase: Phase,
    // Other native lifecycle modules own and validate their journal sections.
    #[serde(flatten)]
    pub sections: BTreeMap<String, Value>,
}

#[derive(Clone, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReleaseReceipt {
    pub checkpoint_id: String,
    pub sha256: String,
}

impl ReleaseReceipt {
    pub fn validate(&self) -> io::Result<()> {
        if !canonical_uuid(&self.checkpoint_id) {
            return Err(reject("invalid_checkpoint_id"));
        }
        if self.sha256.len() != 64
            || !self
                .sha256
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        {
            return Err(reject("invalid_checkpoint_digest"));
        }
        Ok(())
    }
}

pub struct Fence {
    directory: File,
}
pub struct LockedFence<'a> {
    fence: &'a Fence,
    _lock: File,
}

impl Fence {
    /// The installation/configuration layer prepares the directory. Never create
    /// or repair a workload-selected path as part of an incoming lease request.
    pub fn open(path: &Path) -> io::Result<Self> {
        let directory = File::from(open(
            path,
            OFlags::RDONLY | OFlags::DIRECTORY | OFlags::NOFOLLOW | OFlags::CLOEXEC,
            Mode::empty(),
        )?);
        let stat = rustix::fs::fstat(&directory)?;
        if stat.st_uid != rustix::process::geteuid().as_raw() || stat.st_mode & 0o077 != 0 {
            return Err(reject("unsafe_control_root"));
        }
        Ok(Self { directory })
    }

    pub fn locked(&self) -> io::Result<LockedFence<'_>> {
        let lock = File::from(openat(
            &self.directory,
            "lock",
            OFlags::RDWR | OFlags::CREATE | OFlags::NOFOLLOW | OFlags::CLOEXEC,
            Mode::from_raw_mode(0o600),
        )?);
        let stat = rustix::fs::fstat(&lock)?;
        if rustix::fs::FileType::from_raw_mode(stat.st_mode) != rustix::fs::FileType::RegularFile
            || stat.st_uid != rustix::process::geteuid().as_raw()
            || stat.st_mode & 0o077 != 0
            || stat.st_nlink != 1
        {
            return Err(reject("unsafe_fence_lock"));
        }
        flock(&lock, FlockOperation::LockExclusive)?;
        Ok(LockedFence {
            fence: self,
            _lock: lock,
        })
    }

    pub fn claim(&self, lease: &Lease) -> io::Result<State> {
        lease.validate()?;
        let guard = self.locked()?;
        let old = guard.read()?;
        if let Some(state) = &old {
            if &state.lease == lease {
                if state.phase != Phase::Open {
                    return Err(reject("closed_lease"));
                }
                return Ok(state.clone());
            }
            if !state.lease.same_slot(lease) {
                return Err(reject("physical_identity_conflict"));
            }
            if state.phase != Phase::Released {
                return Err(reject("slot_not_released"));
            }
        }
        let expected = old.as_ref().map_or(1, |state| state.lease.generation + 1);
        if lease.generation != expected {
            return Err(reject("generation_gap_or_replay"));
        }
        let mut state = State {
            lease: lease.clone(),
            phase: Phase::Open,
            sections: BTreeMap::new(),
        };
        if let Some(cached) = old
            .as_ref()
            .and_then(|state| state.sections.get("localCheckpoint"))
        {
            state
                .sections
                .insert("localCheckpoint".into(), cached.clone());
        }
        guard.write(&state)?;
        Ok(state)
    }

    pub fn close(&self, lease: &Lease) -> io::Result<State> {
        lease.validate()?;
        let guard = self.locked()?;
        let mut state = match guard.read()? {
            None => {
                if lease.generation != 1 {
                    return Err(reject("generation_gap_or_replay"));
                }
                State {
                    lease: lease.clone(),
                    phase: Phase::Closed,
                    sections: BTreeMap::new(),
                }
            }
            Some(state)
                if state.phase == Phase::Released
                    && lease.generation == state.lease.generation + 1 =>
            {
                if !state.lease.same_slot(lease) {
                    return Err(reject("physical_identity_conflict"));
                }
                State {
                    lease: lease.clone(),
                    phase: Phase::Closed,
                    sections: BTreeMap::new(),
                }
            }
            Some(mut state) => {
                state.matches(lease)?;
                if matches!(state.phase, Phase::Closed | Phase::Released) {
                    return Ok(state);
                }
                state.phase = Phase::Closed;
                state
            }
        };
        state.phase = Phase::Closed;
        guard.write(&state)?;
        Ok(state)
    }

    /// Only trusted lifecycle code supplies this verifier after durable remote
    /// publication and independent process/mount/listener cleanup observation.
    pub fn release(
        &self,
        lease: &Lease,
        receipt: &ReleaseReceipt,
        verify: impl FnOnce(&Lease, &ReleaseReceipt) -> io::Result<bool>,
    ) -> io::Result<State> {
        self.release_checked(lease, receipt, |_, lease, receipt| verify(lease, receipt))
    }
    /// Supplies the already-locked state to avoid recursive fence acquisition.
    pub fn release_checked(
        &self,
        lease: &Lease,
        receipt: &ReleaseReceipt,
        verify: impl FnOnce(&State, &Lease, &ReleaseReceipt) -> io::Result<bool>,
    ) -> io::Result<State> {
        lease.validate()?;
        receipt.validate()?;
        let guard = self.locked()?;
        let mut state = guard.read()?.ok_or_else(|| reject("stale_lease"))?;
        state.matches(lease)?;
        let receipt_value = serde_json::to_value(receipt).map_err(io::Error::other)?;
        if state.phase == Phase::Released {
            if state.sections.get("releaseReceipt") != Some(&receipt_value) {
                return Err(reject("release_receipt_conflict"));
            }
            return Ok(state);
        }
        if state.phase != Phase::Closed {
            return Err(reject("release_before_close"));
        }
        state.settled("commands", &["succeeded", "failed", "cancelled"])?;
        state.settled("streams", &["closed", "cancelled"])?;
        if !verify(&state, lease, receipt)? {
            return Err(reject("cleanup_or_publication_unconfirmed"));
        }
        state.phase = Phase::Released;
        state
            .sections
            .insert("releaseReceipt".into(), receipt_value);
        guard.write(&state)?;
        Ok(state)
    }
}

impl State {
    pub fn matches(&self, lease: &Lease) -> io::Result<()> {
        if &self.lease != lease {
            return Err(reject("stale_lease"));
        }
        Ok(())
    }
    fn settled(&self, section: &'static str, terminal: &[&str]) -> io::Result<()> {
        let Some(value) = self.sections.get(section) else {
            return Ok(());
        };
        let rows = value
            .as_object()
            .ok_or_else(|| reject("invalid_actor_journal"))?;
        if rows.values().any(|row| {
            !row.get("phase")
                .and_then(Value::as_str)
                .is_some_and(|phase| terminal.contains(&phase))
        }) {
            return Err(reject("actors_unresolved"));
        }
        Ok(())
    }
}

impl LockedFence<'_> {
    pub fn read(&self) -> io::Result<Option<State>> {
        let state: Option<State> = self.read_record()?;
        if let Some(state) = &state {
            state.lease.validate()?;
        }
        Ok(state)
    }

    pub(crate) fn read_record<T: serde::de::DeserializeOwned>(&self) -> io::Result<Option<T>> {
        let fd = match openat(
            &self.fence.directory,
            "state.json",
            OFlags::RDONLY | OFlags::NOFOLLOW | OFlags::CLOEXEC | OFlags::NONBLOCK,
            Mode::empty(),
        ) {
            Ok(fd) => fd,
            Err(rustix::io::Errno::NOENT) => return Ok(None),
            Err(error) => return Err(error.into()),
        };
        let file = File::from(fd);
        let stat = rustix::fs::fstat(&file)?;
        if rustix::fs::FileType::from_raw_mode(stat.st_mode) != rustix::fs::FileType::RegularFile
            || stat.st_uid != rustix::process::geteuid().as_raw()
            || stat.st_mode & 0o077 != 0
            || stat.st_nlink != 1
        {
            return Err(reject("unsafe_fence_state"));
        }
        let mut raw = Vec::new();
        file.take(STATE_BYTES + 1).read_to_end(&mut raw)?;
        if raw.len() as u64 > STATE_BYTES {
            return Err(reject("host_state_limit"));
        }
        serde_json::from_slice(&raw)
            .map(Some)
            .map_err(io::Error::other)
    }

    pub fn write(&self, state: &State) -> io::Result<()> {
        state.lease.validate()?;
        if state.sections.contains_key("lease") || state.sections.contains_key("phase") {
            return Err(reject("reserved_state_section"));
        }
        self.write_record(state)
    }

    pub(crate) fn write_record<T: serde::Serialize>(&self, state: &T) -> io::Result<()> {
        let raw = serde_json::to_vec(state).map_err(io::Error::other)?;
        if raw.len() as u64 > STATE_BYTES {
            return Err(reject("host_state_limit"));
        }
        for _ in 0..128 {
            let name = format!(
                ".next-{}-{}",
                std::process::id(),
                NEXT_TEMP.fetch_add(1, Ordering::Relaxed)
            );
            let fd = match openat(
                &self.fence.directory,
                &name,
                OFlags::WRONLY | OFlags::CREATE | OFlags::EXCL | OFlags::NOFOLLOW | OFlags::CLOEXEC,
                Mode::from_raw_mode(0o600),
            ) {
                Ok(fd) => fd,
                Err(rustix::io::Errno::EXIST) => continue,
                Err(error) => return Err(error.into()),
            };
            let result = (|| {
                let mut file = File::from(fd);
                file.write_all(&raw)?;
                file.sync_all()?;
                renameat(
                    &self.fence.directory,
                    &name,
                    &self.fence.directory,
                    "state.json",
                )?;
                self.fence.directory.sync_all()?;
                Ok(())
            })();
            // Only the exclusive-created private temporary name is cleaned. A
            // post-rename fsync error stays uncertain; it never rewrites old state.
            let _ = unlinkat(&self.fence.directory, &name, AtFlags::empty());
            return result;
        }
        Err(reject("fence_temporary_collision"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::{PermissionsExt, symlink};

    fn fixture() -> (tempfile::TempDir, Fence, Lease, ReleaseReceipt) {
        let temp = tempfile::tempdir().unwrap();
        std::fs::set_permissions(temp.path(), std::fs::Permissions::from_mode(0o700)).unwrap();
        let fence = Fence::open(temp.path()).unwrap();
        let lease: Lease = serde_json::from_value(serde_json::json!({"owner":"owner","poolId":"pool","machineId":"host","slotId":"11111111-1111-4111-8111-111111111111","sandboxId":"22222222-2222-4222-8222-222222222222","assignmentId":"33333333-3333-4333-8333-333333333333","generation":1})).unwrap();
        let receipt = ReleaseReceipt {
            checkpoint_id: "44444444-4444-4444-8444-444444444444".into(),
            sha256: "a".repeat(64),
        };
        (temp, fence, lease, receipt)
    }

    #[test]
    fn closed_before_claim_survives_reopen() {
        let (temp, fence, lease, _) = fixture();
        fence.close(&lease).unwrap();
        assert_eq!(
            Fence::open(temp.path())
                .unwrap()
                .claim(&lease)
                .unwrap_err()
                .to_string(),
            "closed_lease"
        );
    }

    #[test]
    fn release_requires_proof_and_next_generation_rejects_stale_owner() {
        let (temp, fence, lease, receipt) = fixture();
        fence.claim(&lease).unwrap();
        fence.close(&lease).unwrap();
        assert!(fence.release(&lease, &receipt, |_, _| Ok(false)).is_err());
        assert_eq!(
            fence.locked().unwrap().read().unwrap().unwrap().phase,
            Phase::Closed
        );
        fence.release(&lease, &receipt, |_, _| Ok(true)).unwrap();
        // Same receipt is idempotent and does not run cleanup again.
        fence
            .release(&lease, &receipt, |_, _| {
                panic!("must observe prior receipt")
            })
            .unwrap();
        let mut next = lease.clone();
        next.generation += 1;
        let mut foreign = next.clone();
        foreign.owner = "foreign".into();
        assert!(fence.claim(&foreign).is_err());
        Fence::open(temp.path()).unwrap().claim(&next).unwrap();
        assert!(fence.close(&lease).is_err());
    }

    #[test]
    fn unresolved_actor_and_symlink_state_fail_closed() {
        let (temp, fence, lease, receipt) = fixture();
        let mut state = fence.claim(&lease).unwrap();
        state.sections.insert(
            "commands".into(),
            serde_json::json!({"command":{"phase":"uncertain"}}),
        );
        fence.locked().unwrap().write(&state).unwrap();
        fence.close(&lease).unwrap();
        assert!(
            fence
                .release(&lease, &receipt, |_, _| panic!("must not reach verifier"))
                .is_err()
        );
        std::fs::remove_file(temp.path().join("state.json")).unwrap();
        symlink("/dev/null", temp.path().join("state.json")).unwrap();
        assert!(fence.locked().unwrap().read().is_err());
    }
}
