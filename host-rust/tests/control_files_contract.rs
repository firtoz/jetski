use jetski_host::control_files::ControlFiles;
use sha2::{Digest, Sha256};
use std::{
    fs,
    os::unix::fs::{PermissionsExt, symlink},
};
#[test]
fn transferred_json_is_verified_into_immutable_memory_before_dispatch() {
    let tmp = tempfile::tempdir().unwrap();
    let uid = rustix::process::geteuid().as_raw();
    let gid = rustix::process::getegid().as_raw();
    let files = ControlFiles {
        tmp: tmp.path(),
        uid,
        gid,
        parent_uid: uid,
    };
    let path = tmp
        .path()
        .join("jetski-control-11111111-1111-4111-8111-111111111111");
    files.create(&path).unwrap();
    assert!(files.create(&path).is_err());
    let raw = br#"{"version":1,"id":"verified","action":"status","payload":{}}"#;
    let sha = format!("{:x}", Sha256::digest(raw));
    fs::write(path.join("request.json"), raw).unwrap();
    fs::set_permissions(path.join("request.json"), fs::Permissions::from_mode(0o644)).unwrap();
    let request = files.read(&path, raw.len(), &sha).unwrap();
    fs::write(path.join("request.json"), vec![b'x'; raw.len()]).unwrap();
    assert_eq!(request.id, "verified");
    assert!(files.read(&path, raw.len(), &sha).is_err());
    fs::write(path.join("unknown"), b"preserve unknown entry").unwrap();
    assert!(files.close(&path).is_err());
    assert!(path.join("request.json").exists());
    fs::remove_file(path.join("unknown")).unwrap();
    files.close(&path).unwrap();
    files.close(&path).unwrap();
    assert!(!path.exists());
}
#[test]
fn transfer_helpers_reject_aliases_hardlinks_and_paths_outside_the_owned_prefix() {
    let tmp = tempfile::tempdir().unwrap();
    let uid = rustix::process::geteuid().as_raw();
    let gid = rustix::process::getegid().as_raw();
    let files = ControlFiles {
        tmp: tmp.path(),
        uid,
        gid,
        parent_uid: uid,
    };
    assert!(files.create(&tmp.path().join("anything-else")).is_err());
    let path = tmp
        .path()
        .join("jetski-control-11111111-1111-4111-8111-111111111111");
    files.create(&path).unwrap();
    let outside = tmp.path().join("outside");
    fs::write(&outside, b"{}").unwrap();
    symlink(&outside, path.join("request.json")).unwrap();
    assert!(
        files
            .read(&path, 2, &format!("{:x}", Sha256::digest(b"{}")))
            .is_err()
    );
    assert!(files.close(&path).is_err());
    fs::remove_file(path.join("request.json")).unwrap();
    fs::hard_link(&outside, path.join("request.json")).unwrap();
    assert!(
        files
            .read(&path, 2, &format!("{:x}", Sha256::digest(b"{}")))
            .is_err()
    );
    files.close(&path).unwrap();
    assert!(outside.exists());
}
