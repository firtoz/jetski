//! Pure lifecycle dispatch against a recording runner, with Python parity checks.
use jetski_host::fence::{Fence, Phase};
use jetski_host::host_config::{NamespaceMapping, NetworkMode};
use jetski_host::process::CommandResult;
use jetski_host::protocol::Lease;
use jetski_host::runtime::{PodmanRuntime, RuntimeOptions};
use serde_json::json;
use std::cell::{Cell, RefCell};
use std::fs;
use std::io;
use std::os::unix::fs::PermissionsExt;
use std::path::Path;
use std::process::Command;
const IMAGE: &str = "registry.example/linux@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
fn fixture(root: &Path) -> (Fence, Lease) {
    let control = root.join("control");
    fs::create_dir(&control).unwrap();
    fs::set_permissions(&control, fs::Permissions::from_mode(0o700)).unwrap();
    let fence = Fence::open(&control).unwrap();
    let lease:Lease=serde_json::from_value(json!({"owner":"owner","poolId":"pool","machineId":"host","slotId":"11111111-1111-4111-8111-111111111111","sandboxId":"22222222-2222-4222-8222-222222222222","assignmentId":"33333333-3333-4333-8333-333333333333","generation":1})).unwrap();
    fence.claim(&lease).unwrap();
    for name in ["workspace", "home"] {
        fs::create_dir_all(root.join("data").join(&lease.assignment_id).join(name)).unwrap();
    }
    (fence, lease)
}
fn options(data: &Path) -> RuntimeOptions<'_> {
    RuntimeOptions {
        image: IMAGE,
        approved_images: std::slice::from_ref(IMAGE_STRING.get_or_init(|| IMAGE.into())),
        data,
        supervisor: None,
        relay: None,
        network: NetworkMode::None,
        mapping: NamespaceMapping::default(),
    }
}
static IMAGE_STRING: std::sync::OnceLock<String> = std::sync::OnceLock::new();
fn result(code: i32, out: &str) -> io::Result<CommandResult> {
    Ok(CommandResult {
        exit_code: code,
        stdout: out.into(),
        stderr: String::new(),
    })
}
#[test]
fn native_isolation_argv_and_lifecycle_receipts_match_python() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path();
    let (fence, lease) = fixture(root);
    let data = root.join("data");
    let calls = RefCell::new(Vec::new());
    let run = |args: &[String]| {
        calls.borrow_mut().push(args.to_vec());
        if args[0] == "inspect" {
            result(0, "false\n")
        } else if args[0] == "container" {
            result(1, "")
        } else {
            result(0, "")
        }
    };
    let runtime = PodmanRuntime::new(&fence, &run, options(&data)).unwrap();
    let created = runtime.create(&lease, 512, 1).unwrap();
    assert_eq!(created["phase"], "running");
    let replay = runtime.create(&lease, 512, 1).unwrap();
    assert_eq!(replay, created);
    assert_eq!(calls.borrow().len(), 1);
    assert!(runtime.remove(&lease).is_err());
    runtime.quiesce(&lease).unwrap();
    runtime.remove(&lease).unwrap();
    let host = Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .join("host");
    fs::write(root.join("lease.json"), serde_json::to_vec(&lease).unwrap()).unwrap();
    let output=Command::new("python3").args(["-I","-c",r#"
import sys,pathlib,json
sys.path.insert(0,sys.argv[1]);from fence import Fence;from runtime import PodmanRuntime
base=pathlib.Path(sys.argv[2]);lease=json.loads((base/'lease.json').read_text());fence=Fence(base/'reference-control');fence.claim(lease);calls=[]
def run(args):
    calls.append(args)
    return dict(exitCode=1 if args[:2]==['container','exists'] else 0,stdout='false\n' if args[0]=='inspect' else '')
image='registry.example/linux@sha256:'+'a'*64
runtime=PodmanRuntime(fence,run,image,base/'data',[image]);runtime.create(lease);runtime.quiesce(lease);runtime.remove(lease)
print(json.dumps(dict(calls=calls,state=fence.read())))
"#]).arg(host).arg(root).output().unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let reference: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(reference["calls"], json!(*calls.borrow()));
    let state = fence.locked().unwrap().read().unwrap().unwrap();
    assert_eq!(reference["state"]["runtime"], state.sections["runtime"]);
    assert_eq!(state.phase, Phase::Closed);
}
#[test]
fn lost_creation_ack_is_quarantined_without_replaying_a_run() {
    let temp = tempfile::tempdir().unwrap();
    let (fence, lease) = fixture(temp.path());
    let calls = Cell::new(0);
    let run = |_: &[String]| {
        calls.set(calls.get() + 1);
        Err(io::Error::other("lost acknowledgement"))
    };
    let data = temp.path().join("data");
    let runtime = PodmanRuntime::new(&fence, &run, options(&data)).unwrap();
    assert!(runtime.create(&lease, 512, 1).is_err());
    let state = fence.locked().unwrap().read().unwrap().unwrap();
    assert_eq!(state.phase, Phase::Quarantined);
    assert_eq!(state.sections["runtime"]["phase"], "creating");
    assert!(runtime.create(&lease, 512, 1).is_err());
    assert_eq!(calls.get(), 1);
}
#[test]
fn removal_ack_loss_observes_absence_and_unknown_inspection_keeps_source() {
    let temp = tempfile::tempdir().unwrap();
    let (fence, lease) = fixture(temp.path());
    let present = Cell::new(true);
    let removals = Cell::new(0);
    let run = |args: &[String]| match args[0].as_str() {
        "inspect" => result(0, "false"),
        "container" => result(if present.get() { 0 } else { 1 }, ""),
        "rm" => {
            removals.set(removals.get() + 1);
            present.set(false);
            Err(io::Error::other("lost removal ack"))
        }
        _ => result(0, ""),
    };
    let data = temp.path().join("data");
    let runtime = PodmanRuntime::new(&fence, &run, options(&data)).unwrap();
    runtime.create(&lease, 512, 1).unwrap();
    runtime.quiesce(&lease).unwrap();
    assert!(runtime.remove(&lease).is_err());
    assert_eq!(
        fence.locked().unwrap().read().unwrap().unwrap().sections["runtime"]["phase"],
        "stopped"
    );
    let unknown = |_: &[String]| result(125, "");
    assert!(
        PodmanRuntime::new(&fence, &unknown, options(&data))
            .unwrap()
            .remove(&lease)
            .is_err()
    );
    assert_eq!(
        fence.locked().unwrap().read().unwrap().unwrap().sections["runtime"]["phase"],
        "stopped"
    );
    runtime.remove(&lease).unwrap();
    assert_eq!(removals.get(), 1);
}
#[test]
fn stale_closed_and_changed_configuration_cannot_admit_more_work() {
    let temp = tempfile::tempdir().unwrap();
    let (fence, lease) = fixture(temp.path());
    let calls = Cell::new(0);
    let run = |_: &[String]| {
        calls.set(calls.get() + 1);
        result(0, "")
    };
    let data = temp.path().join("data");
    let runtime = PodmanRuntime::new(&fence, &run, options(&data)).unwrap();
    runtime.create(&lease, 512, 1).unwrap();
    assert!(runtime.create(&lease, 1024, 1).is_err());
    let mut other = options(&data);
    other.network = NetworkMode::Egress;
    assert!(
        PodmanRuntime::new(&fence, &run, other)
            .unwrap()
            .create(&lease, 512, 1)
            .is_err()
    );
    let mut stale = lease.clone();
    stale.generation += 1;
    assert!(runtime.create(&stale, 512, 1).is_err());
    fence.close(&lease).unwrap();
    assert!(runtime.create(&lease, 512, 1).is_err());
    assert_eq!(calls.get(), 1);
}
