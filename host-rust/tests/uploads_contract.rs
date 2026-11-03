use base64::{Engine as _, engine::general_purpose::STANDARD};
use jetski_host::fence::Fence;
use jetski_host::protocol::Lease;
use jetski_host::uploads::{UploadPhase, UploadSpec, Uploads};
use sha2::{Digest, Sha256};
use std::fs;
use std::os::unix::fs::{PermissionsExt, symlink};
use std::path::Path;
use std::process::Command;
const ID: &str = "55555555-5555-4555-8555-555555555555";
fn hash(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
fn setup(root: &Path) -> (Fence, Lease) {
    let control = root.join("control");
    fs::create_dir(&control).unwrap();
    fs::set_permissions(&control, fs::Permissions::from_mode(0o700)).unwrap();
    let fence = Fence::open(&control).unwrap();
    let lease:Lease=serde_json::from_value(serde_json::json!({"owner":"owner","poolId":"pool","machineId":"host","slotId":"11111111-1111-4111-8111-111111111111","sandboxId":"22222222-2222-4222-8222-222222222222","assignmentId":"33333333-3333-4333-8333-333333333333","generation":1})).unwrap();
    let mut state = fence.claim(&lease).unwrap();
    state
        .sections
        .insert("runtime".into(), serde_json::json!({"phase":"running"}));
    fence.locked().unwrap().write(&state).unwrap();
    fs::create_dir_all(
        root.join("data")
            .join(&lease.assignment_id)
            .join("workspace"),
    )
    .unwrap();
    (fence, lease)
}
fn spec(bytes: &[u8]) -> UploadSpec {
    UploadSpec {
        id: ID.into(),
        path: "/workspace/雪.bin".into(),
        bytes: bytes.len() as u64,
        sha256: hash(bytes),
        mode: 0o640,
    }
}
fn uploads<'a>(fence: &'a Fence, data: &'a Path) -> Uploads<'a> {
    Uploads::new(
        fence,
        data,
        rustix::process::geteuid().as_raw(),
        rustix::process::getegid().as_raw(),
        rustix::process::geteuid().as_raw(),
    )
    .unwrap()
}
#[test]
fn rust_staging_resumes_in_python_without_changing_identity_or_bytes() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path();
    let (fence, lease) = setup(root);
    let data = root.join("data");
    let upload = uploads(&fence, &data);
    let bytes: Vec<u8> = (0u8..=255).cycle().take(300001).collect();
    upload.begin(&lease, spec(&bytes)).unwrap();
    upload
        .chunk(
            &lease,
            ID,
            0,
            &STANDARD.encode(&bytes[..262144]),
            &hash(&bytes[..262144]),
        )
        .unwrap();
    let host = Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .join("host");
    let output=Command::new("python3").args(["-I","-c",r#"
import sys,pathlib,types,os,base64,hashlib
sys.path.insert(0,sys.argv[1]);from fence import Fence;from file_upload import FileUpload
root=pathlib.Path(sys.argv[2]);fence=Fence(root/'control');lease=fence.read()['lease'];upload=FileUpload(fence,root/'data',types.SimpleNamespace(pw_uid=os.geteuid(),pw_gid=os.getegid()))
data=(bytes(range(256))*1172)[:300001];key='55555555-5555-4555-8555-555555555555';remaining=data[262144:]
upload.chunk(lease,key,262144,base64.b64encode(remaining).decode(),hashlib.sha256(remaining).hexdigest())
assert upload.finish(lease,key)['phase']=='committed'
"#]).arg(host).arg(root).output().unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert_eq!(
        upload.status(&lease, ID).unwrap().phase,
        UploadPhase::Committed
    );
    let target = data.join(&lease.assignment_id).join("workspace/雪.bin");
    assert_eq!(fs::read(&target).unwrap(), bytes);
    assert_eq!(
        fs::metadata(&target).unwrap().permissions().mode() & 0o777,
        0o640
    );
    fs::write(&target, b"newer").unwrap();
    upload.finish(&lease, ID).unwrap();
    assert_eq!(fs::read(&target).unwrap(), b"newer");
}
#[test]
fn chunk_and_publication_ack_loss_reconcile_without_overwriting_newer_inode() {
    for replaced in [false, true] {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path();
        let (fence, lease) = setup(root);
        let data = root.join("data");
        let upload = uploads(&fence, &data);
        let bytes = b"acknowledged bytes";
        upload.begin(&lease, spec(bytes)).unwrap();
        upload
            .chunk(&lease, ID, 0, &STANDARD.encode(bytes), &hash(bytes))
            .unwrap();
        // A durable chunk without its progress write: same bytes resume; changed replay fails.
        let guard = fence.locked().unwrap();
        let mut state = guard.read().unwrap().unwrap();
        state.sections.get_mut("uploads").unwrap()[ID]["offset"] = serde_json::json!(0);
        guard.write(&state).unwrap();
        drop(guard);
        upload
            .chunk(&lease, ID, 0, &STANDARD.encode(bytes), &hash(bytes))
            .unwrap();
        assert!(
            upload
                .chunk(
                    &lease,
                    ID,
                    0,
                    &STANDARD.encode(b"changed"),
                    &hash(b"changed")
                )
                .is_err()
        );
        upload.finish(&lease, ID).unwrap();
        // Retain the pre-commit journal identity after consumed staging. This is
        // the reachable state if the final receipt write/ack is lost after rename.
        let guard = fence.locked().unwrap();
        let mut state = guard.read().unwrap().unwrap();
        state.sections.get_mut("uploads").unwrap()[ID]["phase"] = serde_json::json!("publishing");
        guard.write(&state).unwrap();
        drop(guard);
        let workspace = data.join(&lease.assignment_id).join("workspace");
        let target = workspace.join("雪.bin");
        if replaced {
            fs::write(workspace.join("new"), b"newer").unwrap();
            fs::rename(workspace.join("new"), &target).unwrap();
        }
        let reopened = Fence::open(&root.join("control")).unwrap();
        let upload = uploads(&reopened, &data);
        assert_eq!(
            upload.finish(&lease, ID).unwrap().phase,
            if replaced {
                UploadPhase::Uncertain
            } else {
                UploadPhase::Committed
            }
        );
        assert_eq!(
            fs::read(&target).unwrap(),
            if replaced {
                b"newer".as_slice()
            } else {
                bytes.as_slice()
            }
        );
        upload.finish(&lease, ID).unwrap();
    }
}
#[test]
fn incomplete_or_corrupt_upload_and_parent_symlink_do_not_publish() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path();
    let (fence, lease) = setup(root);
    let data = root.join("data");
    let upload = uploads(&fence, &data);
    let bytes = b"bytes";
    upload.begin(&lease, spec(bytes)).unwrap();
    assert!(upload.finish(&lease, ID).is_err());
    upload
        .chunk(&lease, ID, 0, &STANDARD.encode(bytes), &hash(bytes))
        .unwrap();
    fs::write(data.join(".uploads").join(ID), b"corrupt").unwrap();
    assert!(upload.finish(&lease, ID).is_err());
    assert!(
        !data
            .join(&lease.assignment_id)
            .join("workspace/雪.bin")
            .exists()
    );
    let mut other = spec(b"");
    other.id = "66666666-6666-4666-8666-666666666666".into();
    other.path = "/workspace/escape/outside".into();
    symlink(
        root,
        data.join(&lease.assignment_id).join("workspace/escape"),
    )
    .unwrap();
    upload.begin(&lease, other.clone()).unwrap();
    assert!(upload.finish(&lease, &other.id).is_err());
    assert!(!root.join("outside").exists());
    fence.close(&lease).unwrap();
    assert!(
        upload
            .chunk(&lease, ID, 0, &STANDARD.encode(bytes), &hash(bytes))
            .is_err()
    );
}
#[test]
fn empty_upload_replaces_only_the_final_symlink_and_replay_keeps_newer_bytes() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path();
    let (fence, lease) = setup(root);
    let data = root.join("data");
    let upload = uploads(&fence, &data);
    let target = data.join(&lease.assignment_id).join("workspace/雪.bin");
    fs::write(root.join("outside"), b"keep").unwrap();
    symlink(root.join("outside"), &target).unwrap();
    upload.begin(&lease, spec(b"")).unwrap();
    assert_eq!(
        upload.finish(&lease, ID).unwrap().phase,
        UploadPhase::Committed
    );
    assert_eq!(fs::read(&target).unwrap(), b"");
    assert_eq!(fs::read(root.join("outside")).unwrap(), b"keep");
    fs::write(&target, b"newer").unwrap();
    assert_eq!(
        upload.begin(&lease, spec(b"")).unwrap().phase,
        UploadPhase::Committed
    );
    assert_eq!(fs::read(&target).unwrap(), b"newer");
}
