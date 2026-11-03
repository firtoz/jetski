use base64::{Engine as _, engine::general_purpose::STANDARD};
use jetski_host::fence::Fence;
use jetski_host::files::Files;
use jetski_host::protocol::Lease;
use std::fs;
use std::os::unix::{
    ffi::OsStringExt,
    fs::{PermissionsExt, symlink},
};
use std::path::Path;
use std::process::Command;

fn lease() -> Lease {
    serde_json::from_value(serde_json::json!({"owner":"owner","poolId":"pool","machineId":"host","slotId":"11111111-1111-4111-8111-111111111111","sandboxId":"22222222-2222-4222-8222-222222222222","assignmentId":"33333333-3333-4333-8333-333333333333","generation":1})).unwrap()
}
fn setup(root: &Path) -> (Fence, Lease) {
    let control = root.join("control");
    fs::create_dir(&control).unwrap();
    fs::set_permissions(&control, fs::Permissions::from_mode(0o700)).unwrap();
    let fence = Fence::open(&control).unwrap();
    let lease = lease();
    let mut state = fence.claim(&lease).unwrap();
    state
        .sections
        .insert("runtime".into(), serde_json::json!({"phase":"running"}));
    fence.locked().unwrap().write(&state).unwrap();
    let assignment = root.join("data").join(&lease.assignment_id);
    fs::create_dir_all(assignment.join("workspace")).unwrap();
    fs::create_dir(assignment.join("home")).unwrap();
    fs::write(
        assignment.join("workspace/λ bytes"),
        (0u8..=255).cycle().take(300_001).collect::<Vec<_>>(),
    )
    .unwrap();
    fs::write(assignment.join("home/empty"), b"").unwrap();
    symlink("/etc/passwd", assignment.join("workspace/escape")).unwrap();
    (fence, lease)
}
#[test]
fn native_chunks_and_listing_match_python_version_and_payload_contract() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path();
    let (fence, lease) = setup(root);
    let data = root.join("data");
    let uid = rustix::process::geteuid().as_raw();
    let files = Files::new(&fence, &data, uid, uid);
    let first = files
        .read(&lease, "/workspace/λ bytes", 0, 256 * 1024, None)
        .unwrap();
    let second = files
        .read(
            &lease,
            "/workspace/λ bytes",
            first.next_offset,
            256 * 1024,
            Some(&first.version),
        )
        .unwrap();
    assert!(second.eof);
    let mut bytes = STANDARD.decode(&first.base64).unwrap();
    bytes.extend(STANDARD.decode(&second.base64).unwrap());
    assert_eq!(bytes, (0u8..=255).cycle().take(300_001).collect::<Vec<_>>());
    let listing = files.list(&lease, "/workspace", "", 256, None).unwrap();
    let host = Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .join("host");
    let output=Command::new("python3").args(["-I","-c",r#"
import sys,json,pathlib,os
sys.path.insert(0,sys.argv[1]); from fence import Fence; from files import Files
root=pathlib.Path(sys.argv[2]); fence=Fence(root/'control'); lease=fence.read()['lease']; files=Files(fence,root/'data',os.geteuid())
print(json.dumps(dict(first=files.read(lease,'/workspace/λ bytes',0,256*1024),listing=files.listing(lease,'/workspace','',256))))
"#]).arg(host).arg(root).output().unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let observed: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(observed["first"], serde_json::to_value(first).unwrap());
    assert_eq!(observed["listing"], serde_json::to_value(listing).unwrap());
}
#[test]
fn symlinks_undeclared_paths_wrong_owner_and_changed_versions_are_rejected() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path();
    let (fence, lease) = setup(root);
    let data = root.join("data");
    let uid = rustix::process::geteuid().as_raw();
    let files = Files::new(&fence, &data, uid, uid);
    for path in [
        "/etc/passwd",
        "/workspace/../home",
        "/home/elsewhere",
        "/workspace/escape",
        "/workspace//file",
        "/workspace/./file",
    ] {
        assert!(
            files.read(&lease, path, 0, 10, None).is_err(),
            "accepted {path}"
        );
    }
    assert!(
        Files::new(&fence, &data, uid + 1, uid)
            .read(&lease, "/workspace/λ bytes", 0, 1, None)
            .is_err()
    );
    let before = files
        .read(&lease, "/workspace/λ bytes", 0, 10, None)
        .unwrap();
    fs::write(
        data.join(&lease.assignment_id).join("workspace/λ bytes"),
        b"changed",
    )
    .unwrap();
    assert!(
        files
            .read(&lease, "/workspace/λ bytes", 0, 10, Some(&before.version))
            .is_err()
    );
    let page = files.list(&lease, "/workspace", "", 1, None).unwrap();
    fs::write(
        data.join(&lease.assignment_id).join("workspace/another"),
        b"new",
    )
    .unwrap();
    assert!(
        files
            .list(
                &lease,
                "/workspace",
                page.next.as_deref().unwrap_or(""),
                1,
                Some(&page.version)
            )
            .is_err()
    );
    fence.close(&lease).unwrap();
    assert!(
        files
            .read(&lease, "/home/sandbox/empty", 0, 1, None)
            .is_err()
    );
}
#[test]
fn invalid_filename_bytes_fail_listing_without_lossy_substitution() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path();
    let (fence, lease) = setup(root);
    let data = root.join("data");
    let uid = rustix::process::geteuid().as_raw();
    let files = Files::new(&fence, &data, uid, uid);
    fs::write(
        data.join(&lease.assignment_id)
            .join("workspace")
            .join(std::ffi::OsString::from_vec(vec![0xff])),
        b"keep",
    )
    .unwrap();
    assert!(files.list(&lease, "/workspace", "", 256, None).is_err());
}
