//! Bounded protocol-v1 envelopes. Dispatch and authenticated transport are separate.
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::io::{self, Read};

pub const REQUEST_BYTES: usize = 1024 * 1024;
pub const IMPORT_REQUEST_BYTES: usize = 6 * 1024 * 1024;
pub const RESPONSE_BYTES: usize = 2 * 1024 * 1024;
pub const MAX_GENERATION: u64 = (1_u64 << 53) - 1;

#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Request {
    pub version: u8,
    pub id: String,
    pub action: String,
    pub payload: Value,
}

fn invalid(message: &'static str) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, message)
}

impl Request {
    pub fn validate(&self) -> io::Result<()> {
        if self.version != 1
            || !(1..=128).contains(&self.id.chars().count())
            || !(self.payload.is_object() || (self.action == "status" && self.payload.is_null()))
        {
            return Err(invalid("invalid_protocol_request"));
        }
        Ok(())
    }
    pub fn decode(raw: &[u8]) -> io::Result<Self> {
        if raw.len() > IMPORT_REQUEST_BYTES {
            return Err(invalid("host_request_limit"));
        }
        let request: Self =
            serde_json::from_slice(raw).map_err(|_| invalid("invalid_protocol_request"))?;
        request.validate()?;
        if request.action != "import-chunk" && raw.len() > REQUEST_BYTES {
            return Err(invalid("host_request_limit"));
        }
        Ok(request)
    }

    /// The transport must impose a deadline independently of this byte bound.
    pub fn read(reader: impl Read) -> io::Result<Self> {
        let mut raw = Vec::new();
        reader
            .take((IMPORT_REQUEST_BYTES + 1) as u64)
            .read_to_end(&mut raw)?;
        Self::decode(&raw)
    }

    pub fn response(&self, result: Value) -> io::Result<Vec<u8>> {
        let response = serde_json::json!({"version": 1, "id": self.id, "result": result});
        let mut encoded = serde_json::to_vec(&response).map_err(io::Error::other)?;
        if encoded.len() > RESPONSE_BYTES {
            return Err(invalid("host_response_limit"));
        }
        encoded.push(b'\n');
        Ok(encoded)
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Lease {
    pub owner: String,
    pub pool_id: String,
    pub slot_id: String,
    pub machine_id: String,
    pub sandbox_id: String,
    pub assignment_id: String,
    pub generation: u64,
}

pub fn canonical_uuid(value: &str) -> bool {
    value.len() == 36
        && value.bytes().enumerate().all(|(index, byte)| {
            if [8, 13, 18, 23].contains(&index) {
                byte == b'-'
            } else {
                byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte)
            }
        })
}

impl Lease {
    pub fn validate(&self) -> io::Result<()> {
        if [&self.owner, &self.pool_id, &self.machine_id]
            .into_iter()
            .any(|part| !(1..=160).contains(&part.chars().count()))
        {
            return Err(invalid("invalid_scope"));
        }
        if [&self.slot_id, &self.sandbox_id, &self.assignment_id]
            .into_iter()
            .any(|part| !canonical_uuid(part))
        {
            return Err(invalid("invalid_id"));
        }
        if !(1..=MAX_GENERATION).contains(&self.generation) {
            return Err(invalid("invalid_generation"));
        }
        Ok(())
    }

    pub fn same_slot(&self, other: &Self) -> bool {
        self.owner == other.owner
            && self.pool_id == other.pool_id
            && self.slot_id == other.slot_id
            && self.machine_id == other.machine_id
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn envelope_rejects_version_duplicate_and_unknown_fields() {
        for raw in [
            r#"{"version":2,"id":"request","action":"status","payload":{}}"#,
            r#"{"version":1,"id":"a","id":"b","action":"status","payload":{}}"#,
            r#"{"version":1,"id":"a","action":"status","payload":{},"extra":1}"#,
            r#"{"version":1,"id":"a","action":"claim","payload":null}"#,
        ] {
            assert!(Request::decode(raw.as_bytes()).is_err());
        }
    }

    #[test]
    fn provider_readiness_accepts_null_status_payload_without_relaxing_mutations() {
        // Both real host providers send this no-argument status form.
        let request =
            Request::decode(br#"{"version":1,"id":"readiness","action":"status","payload":null}"#)
                .unwrap();
        request.validate().unwrap();
        for action in ["claim", "create", "import-finish"] {
            let mut value = serde_json::to_value(&request).unwrap();
            value["action"] = Value::String(action.into());
            assert!(Request::decode(&serde_json::to_vec(&value).unwrap()).is_err());
        }
    }

    #[test]
    fn import_has_separate_bound_and_response_preserves_identity() {
        let mut value = serde_json::json!({"version":1,"id":"original","action":"status","payload":{"data":"x".repeat(REQUEST_BYTES)}});
        assert!(Request::decode(&serde_json::to_vec(&value).unwrap()).is_err());
        value["action"] = Value::String("import-chunk".into());
        let request = Request::decode(&serde_json::to_vec(&value).unwrap()).unwrap();
        let response: Value =
            serde_json::from_slice(&request.response(Value::Null).unwrap()).unwrap();
        assert_eq!(response["id"], "original");
        assert!(Request::decode(&vec![b' '; IMPORT_REQUEST_BYTES + 1]).is_err());
        assert!(
            request
                .response(Value::String("x".repeat(RESPONSE_BYTES)))
                .is_err()
        );
    }

    #[test]
    fn identity_uses_canonical_uuid_and_exact_integer_generation() {
        let raw = serde_json::json!({"owner":"owner","poolId":"pool","machineId":"host","slotId":"11111111-1111-4111-8111-111111111111","sandboxId":"22222222-2222-4222-8222-222222222222","assignmentId":"33333333-3333-4333-8333-333333333333","generation":1});
        let lease: Lease = serde_json::from_value(raw.clone()).unwrap();
        lease.validate().unwrap();
        for generation in [
            serde_json::json!(true),
            serde_json::json!(-1),
            serde_json::json!(1.0),
        ] {
            let mut changed = raw.clone();
            changed["generation"] = generation;
            assert!(serde_json::from_value::<Lease>(changed).is_err());
        }
        let mut changed = lease;
        changed.generation = MAX_GENERATION + 1;
        assert!(changed.validate().is_err());
        assert!(!canonical_uuid("AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA"));
    }
}
