mod support;
use jetski_host::{
    control::{Control, Paths, verify_ownership},
    host_config::{self, HostConfig, RuntimeAccount, WorkloadIdentity},
    process::CommandResult,
    protocol::Request,
};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{cell::Cell, fs};
use support::{Fixture, ID, IMAGE};
fn identity() -> WorkloadIdentity {
    let mut value = json!({"version":2,"namespace":"rootless-map","runtimeUid":1000,"runtimeGid":1000,"workloadUid":100999,"workloadGid":200999,"uidMappings":[[0,0,1],[1,1,65536]],"gidMappings":[[0,0,1],[1,1,65536]]});
    value["sha256"] = json!(format!(
        "{:x}",
        Sha256::digest(serde_json::to_vec(&value).unwrap())
    ));
    serde_json::from_value(value).unwrap()
}
#[test]
fn combined_control_records_unknown_work_and_releases_only_the_published_root() {
    let f = Fixture::new();
    let archives = f.root().join("archives");
    fs::create_dir(&archives).unwrap();
    for name in ["workspace", "home"] {
        fs::create_dir_all(f.data.join(&f.lease.assignment_id).join(name)).unwrap();
    }
    fs::write(
        f.data.join(&f.lease.assignment_id).join("workspace/bytes"),
        b"exact\0payload\xff",
    )
    .unwrap();
    let config: HostConfig = serde_json::from_value(
        json!({"version":1,"machineId":"host","poolId":"pool","images":[IMAGE]}),
    )
    .unwrap();
    let account = RuntimeAccount {
        uid: 1000,
        gid: 1000,
        home: host_config::HOME.into(),
    };
    let ownership = identity();
    let present = Cell::new(true);
    let removed = Cell::new(0);
    let unknown = Cell::new(false);
    let launches = Cell::new(0);
    let run = |args: &[String]| {
        let (code, out) = match args[0].as_str() {
            "inspect" => (0, "false"),
            "container" => {
                if unknown.get() {
                    (125, "")
                } else if present.get() {
                    (0, "")
                } else {
                    (1, "")
                }
            }
            "rm" => {
                removed.set(removed.get() + 1);
                present.set(false);
                (0, "")
            }
            _ => (0, ""),
        };
        Ok(CommandResult {
            exit_code: code,
            stdout: out.into(),
            stderr: String::new(),
        })
    };
    let launch = |_: &str, _: &jetski_host::protocol::Lease| {
        launches.set(launches.get() + 1);
        Ok(())
    };
    let handler = Control {
        fence: &f.fence,
        config: &config,
        account: &account,
        ownership: &ownership,
        run: &run,
        paths: Paths {
            slot: &f.worker,
            commands: &f.output,
            terminal: &f.terminal,
            data: &f.data,
            archives: &archives,
            supervisor: &f.root().join("supervisor"),
            relay: &f.root().join("relay"),
        },
        transfer: None,
        export: None,
        launch: &launch,
    };
    let dispatch = |action: &str, extra: Value| {
        let mut payload = json!({"lease":f.lease,"image":IMAGE});
        for (k, v) in extra.as_object().unwrap() {
            payload[k] = v.clone();
        }
        handler.dispatch(&Request {
            version: 1,
            id: "test".into(),
            action: action.into(),
            payload,
        })
    };
    let command = json!({"commandId":ID,"argv":["/bin/true"]});
    let queued = dispatch("command-start", command.clone()).unwrap();
    assert_eq!(queued["phase"], "queued");
    dispatch("command-start", command.clone()).unwrap();
    assert_eq!(launches.get(), 1);
    let mut invalid = command;
    invalid["waitMs"] = json!(1001);
    assert!(dispatch("command-start", invalid).is_err());
    assert_eq!(launches.get(), 1);
    dispatch("command-cancel", json!({"commandId":ID})).unwrap();
    dispatch("quiesce", json!({})).unwrap();
    let checkpoint = dispatch("capture", json!({"frameBytes":262144})).unwrap();
    let publication = json!({"checkpointId":ID,"sha256":checkpoint["sha256"]});
    assert!(dispatch("release", json!({"publication":publication})).is_err());
    assert!(f.data.join(&f.lease.assignment_id).exists());
    let wrong = json!({"checkpointId":ID,"sha256":"f".repeat(64)});
    assert!(dispatch("finalize", json!({"publication":wrong})).is_err());
    assert_eq!(removed.get(), 0);
    unknown.set(true);
    assert!(dispatch("finalize", json!({"publication":publication})).is_err());
    assert!(f.data.join(&f.lease.assignment_id).exists());
    unknown.set(false);
    let receipt = dispatch("finalize", json!({"publication":publication})).unwrap();
    assert_eq!(receipt["finalized"], true);
    assert_eq!(removed.get(), 1);
    assert!(!f.data.join(&f.lease.assignment_id).exists());
    assert!(archives.join("cache/archive.tgz").exists());
    dispatch("finalize", json!({"publication":publication})).unwrap();
    assert_eq!(removed.get(), 1);
    let mut stale = json!({"lease":f.lease});
    stale["lease"]["generation"] = json!(2);
    assert!(
        handler
            .dispatch(&Request {
                version: 1,
                id: "stale".into(),
                action: "purge-source".into(),
                payload: stale
            })
            .is_err()
    );
}
#[test]
fn observed_runtime_ownership_is_compared_with_every_installed_mapping_field() {
    let account = RuntimeAccount {
        uid: 1000,
        gid: 1000,
        home: host_config::HOME.into(),
    };
    let record = identity();
    record.validate(&account).unwrap();
    let proof = json!({"runtimeUid":1000,"runtimeGid":1000,"workloadUid":record.workload_uid,"workloadGid":record.workload_gid,"uidMappings":record.uid_mappings,"gidMappings":record.gid_mappings});
    verify_ownership(&proof, &account, &record).unwrap();
    for key in [
        "runtimeUid",
        "runtimeGid",
        "workloadUid",
        "workloadGid",
        "uidMappings",
        "gidMappings",
    ] {
        let mut bad = proof.clone();
        bad[key] = Value::Null;
        assert!(verify_ownership(&bad, &account, &record).is_err());
    }
}
