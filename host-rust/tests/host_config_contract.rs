use jetski_host::host_config::{
    self, HostConfig, NamespaceMapping, RuntimeAccount, WorkloadIdentity,
};
use jetski_host::process::CommandResult;
use serde_json::{Value, json};
use std::path::Path;
use std::process::Command;
#[test]
fn mapped_probe_and_record_validation_match_python() {
    let temp = tempfile::tempdir().unwrap();
    let host = Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .join("host");
    let output=Command::new("python3").args(["-I","-c",r#"
import sys,json,types,hashlib
sys.path.insert(0,sys.argv[1]);from runtime_backend import PodmanBackend,validate_workload_identity
info=dict(host=dict(security=dict(rootless=True),cgroupVersion='v2',idMappings=dict(uidmap=[dict(container_id=0,host_id=1000,size=1),dict(container_id=1,host_id=100000,size=65536)],gidmap=[dict(container_id=0,host_id=1000,size=1),dict(container_id=1,host_id=200000,size=65536)])),version=dict(Version='4.9.3'),store=dict(graphDriverName='overlay',graphOptions={'overlay.mount_program':dict(Executable='/usr/bin/fuse-overlayfs')}))
proof=PodmanBackend().probe(lambda _:dict(exitCode=0,stdout=json.dumps(info)))
record={key:proof[key] for key in ('runtimeUid','runtimeGid','workloadUid','workloadGid','uidMappings','gidMappings')};record.update(version=2,namespace='rootless-map');record['sha256']=hashlib.sha256(json.dumps(record,sort_keys=True,separators=(',',':')).encode()).hexdigest();validate_workload_identity(types.SimpleNamespace(pw_uid=1000,pw_gid=1000),record)
print(json.dumps(dict(info=info,proof=proof,record=record)))
"#]).arg(host).output().unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let reference: Value = serde_json::from_slice(&output.stdout).unwrap();
    let run = |_: &[String]| {
        Ok(CommandResult {
            exit_code: 0,
            stdout: reference["info"].to_string(),
            stderr: String::new(),
        })
    };
    assert_eq!(
        host_config::runtime_probe(&run).unwrap(),
        reference["proof"]
    );
    let record: WorkloadIdentity = serde_json::from_value(reference["record"].clone()).unwrap();
    record
        .validate(&RuntimeAccount {
            uid: 1000,
            gid: 1000,
            home: host_config::HOME.into(),
        })
        .unwrap();
    let mut changed = record.clone();
    changed.workload_uid += 1;
    assert!(
        changed
            .validate(&RuntimeAccount {
                uid: 1000,
                gid: 1000,
                home: host_config::HOME.into()
            })
            .is_err()
    );
    let mut ambiguous = reference["info"].clone();
    ambiguous["host"]["idMappings"]["uidmap"][1]["host_id"] = json!(1000);
    let run = |_: &[String]| {
        Ok(CommandResult {
            exit_code: 0,
            stdout: ambiguous.to_string(),
            stderr: String::new(),
        })
    };
    assert!(host_config::runtime_probe(&run).is_err());
    drop(temp);
}
#[test]
fn operator_configuration_and_namespace_limits_fail_closed() {
    let base = json!({"version":1,"machineId":"host","poolId":"pool","images":[format!("registry.example/linux@sha256:{}","a".repeat(64))]});
    let config: HostConfig = serde_json::from_value(base.clone()).unwrap();
    config.validate().unwrap();
    for change in [
        json!({"networkMode":"host"}),
        json!({"storageMode":"evil"}),
        json!({"injected":true}),
    ] {
        let mut value = base.clone();
        for (k, v) in change.as_object().unwrap() {
            value[k] = v.clone();
        }
        assert!(serde_json::from_value::<HostConfig>(value).is_err());
    }
    let mut mapping = NamespaceMapping {
        mode: host_config::PREPARED.into(),
        uid_mappings: Some(vec![[0, 0, 1], [1, 1, 65536]]),
        gid_mappings: Some(vec![[0, 0, 1], [1, 1, 65536]]),
    };
    assert_eq!(mapping.arguments().unwrap().len(), 4);
    mapping.uid_mappings = Some(vec![[0, 0, 1], [2, 2, 65536]]);
    assert!(mapping.arguments().is_err());
}
