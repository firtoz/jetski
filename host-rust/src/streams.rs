//! Durable at-most-once relay admission; transport EOF is never cleanup proof.
use crate::{
    checkpoint_cache::reject,
    exec_api::valid_session,
    fence::{Fence, LockedFence, Phase, State},
    protocol::{Lease, canonical_uuid},
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{collections::BTreeMap, io};
pub const MAX_ACTIVE: usize = 64;
pub const MAX_HISTORY: usize = 4096;
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum StreamPhase {
    Reserved,
    Dispatched,
    Connected,
    CancelRequested,
    Closed,
    Cancelled,
    Uncertain,
}
impl StreamPhase {
    pub fn terminal(self) -> bool {
        matches!(self, Self::Closed | Self::Cancelled)
    }
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Delivery {
    Unknown,
    Complete,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Receipt {
    pub id: String,
    pub port: Option<u16>,
    pub phase: StreamPhase,
    pub session: Option<String>,
    pub delivery: Delivery,
    pub reason: Option<String>,
}
impl Receipt {
    fn validate(&self) -> io::Result<()> {
        if !canonical_uuid(&self.id)
            || self.port == Some(0)
            || self.session.as_ref().is_some_and(|v| !valid_session(v))
        {
            return Err(reject("invalid_stream_journal"));
        }
        Ok(())
    }
}
pub enum Outcome {
    Complete,
    Cancelled,
    Unknown,
}
pub struct Prepared {
    pub fresh: bool,
    pub receipt: Receipt,
}
pub struct Streams<'a> {
    pub fence: &'a Fence,
}
impl Streams<'_> {
    fn state(&self, guard: &LockedFence<'_>, lease: &Lease) -> io::Result<State> {
        lease.validate()?;
        let state = guard.read()?.ok_or_else(|| reject("stale_lease"))?;
        state.matches(lease)?;
        Ok(state)
    }
    fn records(state: &State) -> io::Result<BTreeMap<String, Receipt>> {
        let Some(value) = state.sections.get("streams") else {
            return Ok(BTreeMap::new());
        };
        let records: BTreeMap<String, Receipt> =
            serde_json::from_value(value.clone()).map_err(|_| reject("invalid_stream_journal"))?;
        if records.len() > MAX_HISTORY {
            return Err(reject("stream_history_limit"));
        }
        for (id, row) in &records {
            row.validate()?;
            if id != &row.id {
                return Err(reject("invalid_stream_journal"));
            }
        }
        Ok(records)
    }
    fn save(
        guard: &LockedFence<'_>,
        state: &mut State,
        records: &mut BTreeMap<String, Receipt>,
        row: Receipt,
    ) -> io::Result<Receipt> {
        row.validate()?;
        records.insert(row.id.clone(), row.clone());
        state.sections.insert(
            "streams".into(),
            serde_json::to_value(records).map_err(io::Error::other)?,
        );
        guard.write(state)?;
        Ok(row)
    }
    fn running(state: &State) -> io::Result<&str> {
        if state.phase != Phase::Open
            || state
                .sections
                .get("runtime")
                .and_then(|v| v.get("phase"))
                .and_then(Value::as_str)
                != Some("running")
        {
            return Err(reject("stream_runtime_not_running"));
        }
        state
            .sections
            .get("runtime")
            .and_then(|v| v.get("name"))
            .and_then(Value::as_str)
            .ok_or_else(|| reject("invalid_runtime_journal"))
    }
    pub fn reserve(&self, lease: &Lease, id: &str, port: u16) -> io::Result<Receipt> {
        if !canonical_uuid(id) || port == 0 {
            return Err(reject("invalid_stream_identity"));
        }
        let guard = self.fence.locked()?;
        let mut state = self.state(&guard, lease)?;
        let mut records = Self::records(&state)?;
        if let Some(row) = records.get(id) {
            if row.port.is_some_and(|p| p != port) {
                return Err(reject("stream_identity_conflict"));
            }
            return Ok(row.clone());
        }
        Self::running(&state)?;
        if records.len() >= MAX_HISTORY {
            return Err(reject("stream_history_limit"));
        }
        if records.values().filter(|r| !r.phase.terminal()).count() >= MAX_ACTIVE {
            return Err(reject("stream_active_limit"));
        }
        Self::save(
            &guard,
            &mut state,
            &mut records,
            Receipt {
                id: id.into(),
                port: Some(port),
                phase: StreamPhase::Reserved,
                session: None,
                delivery: Delivery::Unknown,
                reason: None,
            },
        )
    }
    pub fn prepare(
        &self,
        lease: &Lease,
        id: &str,
        create: impl FnOnce(&str, u16) -> io::Result<String>,
    ) -> io::Result<Prepared> {
        if !canonical_uuid(id) {
            return Err(reject("invalid_stream_id"));
        }
        let guard = self.fence.locked()?;
        let mut state = self.state(&guard, lease)?;
        let mut records = Self::records(&state)?;
        let mut row = records
            .get(id)
            .ok_or_else(|| reject("stream_unavailable"))?
            .clone();
        if row.phase != StreamPhase::Reserved {
            return Ok(Prepared {
                fresh: false,
                receipt: row,
            });
        }
        let name = Self::running(&state)?.to_owned();
        let port = row.port.ok_or_else(|| reject("invalid_stream_journal"))?;
        row.phase = StreamPhase::Dispatched;
        Self::save(&guard, &mut state, &mut records, row.clone())?;
        let session = match create(&name, port).and_then(|id| {
            if valid_session(&id) {
                Ok(id)
            } else {
                Err(reject("invalid_exec_session"))
            }
        }) {
            Ok(id) => id,
            Err(e) => {
                row.phase = StreamPhase::Uncertain;
                row.reason = Some("exec_creation_uncertain".into());
                Self::save(&guard, &mut state, &mut records, row)?;
                return Err(e);
            }
        };
        row.session = Some(session);
        let receipt = Self::save(&guard, &mut state, &mut records, row)?;
        Ok(Prepared {
            fresh: true,
            receipt,
        })
    }
    pub fn connected(&self, lease: &Lease, id: &str, session: &str) -> io::Result<bool> {
        if !canonical_uuid(id) || !valid_session(session) {
            return Err(reject("invalid_stream_identity"));
        }
        let guard = self.fence.locked()?;
        let mut state = self.state(&guard, lease)?;
        let mut records = Self::records(&state)?;
        let mut row = records
            .get(id)
            .ok_or_else(|| reject("stream_unavailable"))?
            .clone();
        if row.session.as_deref() != Some(session) {
            return Err(reject("stream_session_conflict"));
        }
        if state.phase != Phase::Open
            || !matches!(row.phase, StreamPhase::Dispatched | StreamPhase::Connected)
        {
            return Ok(false);
        }
        row.phase = StreamPhase::Connected;
        Self::save(&guard, &mut state, &mut records, row)?;
        Ok(true)
    }
    pub fn cancel(&self, lease: &Lease, id: &str) -> io::Result<Receipt> {
        if !canonical_uuid(id) {
            return Err(reject("invalid_stream_id"));
        }
        let guard = self.fence.locked()?;
        let mut state = self.state(&guard, lease)?;
        let mut records = Self::records(&state)?;
        let mut row = match records.get(id) {
            Some(row) => row.clone(),
            None => {
                if records.len() >= MAX_HISTORY {
                    return Err(reject("stream_history_limit"));
                }
                Receipt {
                    id: id.into(),
                    port: None,
                    phase: StreamPhase::Reserved,
                    session: None,
                    delivery: Delivery::Unknown,
                    reason: None,
                }
            }
        };
        if row.phase.terminal() {
            return Ok(row);
        }
        row.phase = if row.phase == StreamPhase::Reserved {
            StreamPhase::Cancelled
        } else {
            StreamPhase::CancelRequested
        };
        row.reason = Some("cancel_requested".into());
        Self::save(&guard, &mut state, &mut records, row)
    }
    pub fn finish(
        &self,
        lease: &Lease,
        id: &str,
        session: &str,
        verify: impl FnOnce(&str) -> io::Result<Outcome>,
    ) -> io::Result<Receipt> {
        if !canonical_uuid(id) || !valid_session(session) {
            return Err(reject("invalid_stream_identity"));
        }
        let guard = self.fence.locked()?;
        let mut state = self.state(&guard, lease)?;
        let mut records = Self::records(&state)?;
        let mut row = records
            .get(id)
            .ok_or_else(|| reject("stream_unavailable"))?
            .clone();
        if row.session.as_deref() != Some(session) {
            return Err(reject("stream_session_conflict"));
        }
        if row.phase.terminal() {
            return Ok(row);
        }
        (row.phase, row.delivery) = match verify(session)? {
            Outcome::Complete => (StreamPhase::Closed, Delivery::Complete),
            Outcome::Cancelled => (StreamPhase::Cancelled, Delivery::Unknown),
            Outcome::Unknown => (StreamPhase::Uncertain, Delivery::Unknown),
        };
        Self::save(&guard, &mut state, &mut records, row)
    }
    pub fn status(&self, lease: &Lease, id: &str) -> io::Result<Receipt> {
        if !canonical_uuid(id) {
            return Err(reject("invalid_stream_id"));
        }
        let guard = self.fence.locked()?;
        let state = self.state(&guard, lease)?;
        Self::records(&state)?
            .remove(id)
            .ok_or_else(|| reject("stream_unavailable"))
    }
}
