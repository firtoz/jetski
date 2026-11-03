mod support;
use base64::{Engine as _, engine::general_purpose::STANDARD};
use jetski_host::{
    archive,
    checkpoint_cache::CheckpointCache,
    checkpoint_import::{CheckpointImport, ImportPhase},
    checkpoint_transfer::{CheckpointExport, Transfer},
    checkpoints::Checkpoints,
    fence::{Phase, ReleaseReceipt},
};
use serde_json::json;
use sha2::{Digest, Sha256};
use std::{
    fs,
    os::unix::fs::{MetadataExt, symlink},
    path::PathBuf,
};
use support::{Fixture, ID};

fn setup() -> (Fixture, PathBuf, Vec<u8>, String) {
    let fixture = Fixture::new();
    let archives = fixture.root().join("archives");
    fs::create_dir(&archives).unwrap();
    fs::create_dir(&fixture.data).unwrap();
    let source = fixture.root().join("source");
    fs::create_dir(&source).unwrap();
    for name in ["workspace", "home"] {
        fs::create_dir(source.join(name)).unwrap();
    }
    fs::write(source.join("workspace/bytes"), b"\0exact binary\xff").unwrap();
    fs::hard_link(source.join("workspace/bytes"), source.join("home/twin")).unwrap();
    symlink("../workspace/bytes", source.join("home/link")).unwrap();
    let receipt = archive::capture_default(
        [&source.join("workspace"), &source.join("home")],
        &archives.join("fixture.tgz"),
    )
    .unwrap();
    let bytes = fs::read(archives.join("fixture.tgz")).unwrap();
    {
        let guard = fixture.fence.locked().unwrap();
        let mut state = guard.read().unwrap().unwrap();
        state.sections.remove("runtime");
        guard.write(&state).unwrap();
    }
    (fixture, archives, bytes, receipt.sha256)
}
fn import<'a>(f: &'a Fixture, a: &'a std::path::Path) -> CheckpointImport<'a> {
    CheckpointImport {
        fence: &f.fence,
        archives: a,
        data: &f.data,
        owner: None,
        transfer: None,
    }
}
fn hash(data: &[u8]) -> String {
    format!("{:x}", Sha256::digest(data))
}
fn exact(f: &Fixture) {
    let root = f.data.join(&f.lease.assignment_id);
    assert_eq!(
        fs::read(root.join("workspace/bytes")).unwrap(),
        b"\0exact binary\xff"
    );
    assert_eq!(
        fs::metadata(root.join("workspace/bytes")).unwrap().ino(),
        fs::metadata(root.join("home/twin")).unwrap().ino()
    );
    assert_eq!(
        fs::read_link(root.join("home/link")).unwrap(),
        PathBuf::from("../workspace/bytes")
    );
}
#[test]
fn chunk_ack_loss_replay_conflicts_and_restore_admission() {
    let (f, a, bytes, sha) = setup();
    let receiver = import(&f, &a);
    receiver
        .begin(&f.lease, ID, &sha, bytes.len() as u64)
        .unwrap();
    let split = bytes.len() / 2;
    assert!(receiver.finish(&f.lease).is_err());
    let prefix = &bytes[..split];
    let suffix = &bytes[split..];
    receiver
        .chunk(&f.lease, 0, &STANDARD.encode(prefix), &hash(prefix))
        .unwrap();
    // Durable bytes with lost offset ACK are verified before advancing again.
    {
        let guard = f.fence.locked().unwrap();
        let mut state = guard.read().unwrap().unwrap();
        state.sections.get_mut("import").unwrap()["offset"] = json!(0);
        guard.write(&state).unwrap();
    }
    assert_eq!(
        receiver
            .chunk(&f.lease, 0, &STANDARD.encode(prefix), &hash(prefix))
            .unwrap()
            .offset,
        split as u64
    );
    let changed = vec![7; split];
    assert!(
        receiver
            .chunk(&f.lease, 0, &STANDARD.encode(&changed), &hash(&changed))
            .is_err()
    );
    receiver
        .chunk(
            &f.lease,
            split as u64,
            &STANDARD.encode(suffix),
            &hash(suffix),
        )
        .unwrap();
    assert_eq!(receiver.finish(&f.lease).unwrap().phase, ImportPhase::Ready);
    exact(&f);
    fs::write(
        f.data.join(&f.lease.assignment_id).join("workspace/newer"),
        b"acknowledged later work",
    )
    .unwrap();
    receiver.finish(&f.lease).unwrap();
    assert!(
        f.data
            .join(&f.lease.assignment_id)
            .join("workspace/newer")
            .exists()
    );
    assert!(
        receiver
            .chunk(&f.lease, 0, &STANDARD.encode(&bytes), &sha)
            .is_err()
    );
    assert!(
        receiver
            .begin(&f.lease, ID, &"f".repeat(64), bytes.len() as u64)
            .is_err()
    );
}
#[test]
fn extracting_replay_rebuilds_only_unpublished_root_and_rejects_corruption() {
    let (f, a, bytes, sha) = setup();
    let receiver = import(&f, &a);
    receiver
        .begin(&f.lease, ID, &sha, bytes.len() as u64)
        .unwrap();
    receiver
        .chunk(&f.lease, 0, &STANDARD.encode(&bytes), &sha)
        .unwrap();
    receiver.finish(&f.lease).unwrap();
    {
        let guard = f.fence.locked().unwrap();
        let mut state = guard.read().unwrap().unwrap();
        let r = state.sections.get_mut("import").unwrap();
        r["phase"] = json!("extracting");
        r.as_object_mut().unwrap().remove("entries");
        guard.write(&state).unwrap();
    }
    receiver.finish(&f.lease).unwrap();
    exact(&f);
    fs::remove_dir_all(f.data.join(&f.lease.assignment_id)).unwrap();
    {
        let guard = f.fence.locked().unwrap();
        let mut state = guard.read().unwrap().unwrap();
        state.sections.get_mut("import").unwrap()["phase"] = json!("extracting");
        guard.write(&state).unwrap();
    }
    fs::write(
        a.join(format!("{}.upload", f.lease.assignment_id)),
        vec![0; bytes.len()],
    )
    .unwrap();
    assert!(receiver.finish(&f.lease).is_err());
    assert!(!f.data.join(&f.lease.assignment_id).exists());
    assert_eq!(
        f.fence.locked().unwrap().read().unwrap().unwrap().sections["import"]["phase"],
        "extracting"
    );
}
fn seed_cache(f: &Fixture, a: &std::path::Path, bytes: &[u8], sha: &str) {
    let cache = a.join("cache");
    fs::create_dir(&cache).unwrap();
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(&cache, fs::Permissions::from_mode(0o700)).unwrap();
    fs::write(cache.join("archive.tgz"), bytes).unwrap();
    let guard = f.fence.locked().unwrap();
    let mut state = guard.read().unwrap().unwrap();
    state.sections.insert("localCheckpoint".into(),json!({"owner":f.lease.owner,"sandbox":f.lease.sandbox_id,"id":ID,"sha256":sha,"bytes":bytes.len()}));
    guard.write(&state).unwrap();
}
#[test]
fn cache_reuse_is_owner_scoped_verifies_before_ready_and_corruption_falls_back() {
    let (f, a, bytes, sha) = setup();
    seed_cache(&f, &a, &bytes, &sha);
    assert_eq!(
        import(&f, &a)
            .begin(&f.lease, ID, &sha, bytes.len() as u64)
            .unwrap()
            .phase,
        ImportPhase::Ready
    );
    exact(&f);
    let (f, a, bytes, sha) = setup();
    seed_cache(&f, &a, &bytes, &sha);
    fs::write(a.join("cache/archive.tgz"), vec![0; bytes.len()]).unwrap();
    let r = import(&f, &a)
        .begin(&f.lease, ID, &sha, bytes.len() as u64)
        .unwrap();
    assert!(r.cache_rejected);
    assert_eq!(r.offset, 0);
    assert!(!f.data.join(&f.lease.assignment_id).exists());
    import(&f, &a)
        .chunk(&f.lease, 0, &STANDARD.encode(&bytes), &sha)
        .unwrap();
    import(&f, &a).finish(&f.lease).unwrap();
    exact(&f);
    let (f, a, bytes, sha) = setup();
    seed_cache(&f, &a, &bytes, &sha);
    {
        let guard = f.fence.locked().unwrap();
        let mut state = guard.read().unwrap().unwrap();
        state.sections.get_mut("localCheckpoint").unwrap()["owner"] = json!("someone-else");
        guard.write(&state).unwrap();
    }
    assert_eq!(
        import(&f, &a)
            .begin(&f.lease, ID, &sha, bytes.len() as u64)
            .unwrap()
            .offset,
        0
    );
}
#[test]
fn release_gates_cache_and_lost_metadata_ack_recovers_without_copy() {
    let (f, a, bytes, sha) = setup();
    let cache = CheckpointCache {
        fence: &f.fence,
        archives: &a,
    };
    let publication = json!({"checkpointId":ID,"sha256":sha});
    assert!(cache.publish(&f.lease, &publication).is_err());
    fs::write(a.join(format!("{}.tgz", f.lease.assignment_id)), &bytes).unwrap();
    {
        let guard = f.fence.locked().unwrap();
        let mut state = guard.read().unwrap().unwrap();
        state.phase = Phase::Closed;
        state.sections.insert(
            "checkpoint".into(),
            json!({"sha256":sha,"bytes":bytes.len()}),
        );
        state
            .sections
            .insert("runtime".into(), json!({"phase":"removed"}));
        guard.write(&state).unwrap();
    }
    f.fence
        .release(
            &f.lease,
            &ReleaseReceipt {
                checkpoint_id: ID.into(),
                sha256: sha.clone(),
            },
            |_, _| Ok(true),
        )
        .unwrap();
    let original = fs::metadata(a.join(format!("{}.tgz", f.lease.assignment_id)))
        .unwrap()
        .ino();
    let expected = cache.publish(&f.lease, &publication).unwrap();
    assert_eq!(
        fs::metadata(a.join("cache/archive.tgz")).unwrap().ino(),
        original
    );
    {
        let guard = f.fence.locked().unwrap();
        let mut state = guard.read().unwrap().unwrap();
        state.sections.remove("localCheckpoint");
        guard.write(&state).unwrap();
    }
    assert_eq!(cache.publish(&f.lease, &publication).unwrap(), expected);
    let mut next = f.lease.clone();
    next.generation += 1;
    next.assignment_id = ID.into();
    let state = f.fence.claim(&next).unwrap();
    assert!(state.sections.contains_key("localCheckpoint"));
    assert!(cache.publish(&f.lease, &publication).is_err());
}
#[test]
fn binary_transfer_cleanup_precedes_ready_and_exports_are_scoped_links() {
    let (f, a, bytes, sha) = setup();
    let transfer_root = f.root().join("transfers");
    let transfer = Transfer {
        root: &transfer_root,
        uid: rustix::process::geteuid().as_raw(),
        gid: rustix::process::getegid().as_raw(),
    };
    let receiver = CheckpointImport {
        transfer: Some(transfer),
        ..import(&f, &a)
    };
    receiver
        .begin(&f.lease, ID, &sha, bytes.len() as u64)
        .unwrap();
    let ready = receiver.file_begin(&f.lease).unwrap();
    let path = PathBuf::from(ready["path"].as_str().unwrap());
    fs::write(&path, &bytes).unwrap();
    receiver.file_chunk(&f.lease, 0, bytes.len(), &sha).unwrap();
    fs::write(
        path.parent().unwrap().join("unexpected"),
        b"retain unknown file",
    )
    .unwrap();
    assert!(receiver.finish(&f.lease).is_err());
    assert!(!f.data.join(&f.lease.assignment_id).exists());
    fs::remove_file(path.parent().unwrap().join("unexpected")).unwrap();
    receiver.finish(&f.lease).unwrap();
    assert!(!path.exists());
    exact(&f);
    let export_root = f.root().join("exports");
    let exporter = CheckpointExport {
        fence: &f.fence,
        archives: &a,
        transfer: Transfer {
            root: &export_root,
            ..transfer
        },
    };
    fs::write(a.join(format!("{}.tgz", f.lease.assignment_id)), &bytes).unwrap();
    {
        let guard = f.fence.locked().unwrap();
        let mut state = guard.read().unwrap().unwrap();
        state.phase = Phase::Closed;
        state.sections.insert(
            "checkpoint".into(),
            json!({"sha256":sha,"bytes":bytes.len()}),
        );
        guard.write(&state).unwrap();
    }
    let result = exporter
        .prepare(&f.lease, &sha, bytes.len() as u64)
        .unwrap();
    let exported = PathBuf::from(result["path"].as_str().unwrap());
    assert_eq!(fs::read(&exported).unwrap(), bytes);
    exporter
        .prepare(&f.lease, &sha, bytes.len() as u64)
        .unwrap();
    fs::remove_file(&exported).unwrap();
    symlink(a.join("fixture.tgz"), &exported).unwrap();
    assert!(exporter.close(&f.lease).is_err());
    fs::remove_file(&exported).unwrap();
    exporter
        .prepare(&f.lease, &sha, bytes.len() as u64)
        .unwrap();
    exporter.close(&f.lease).unwrap();
    exporter.close(&f.lease).unwrap();
    assert!(!exported.exists());
}
#[test]
fn capture_freezes_encoding_geometry_and_reads_bounded_exact_chunks() {
    let (f, a, bytes, sha) = setup();
    let receiver = import(&f, &a);
    receiver
        .begin(&f.lease, ID, &sha, bytes.len() as u64)
        .unwrap();
    receiver
        .chunk(&f.lease, 0, &STANDARD.encode(&bytes), &sha)
        .unwrap();
    receiver.finish(&f.lease).unwrap();
    let service = Checkpoints {
        fence: &f.fence,
        archives: &a,
        data: &f.data,
    };
    assert!(service.capture(&f.lease, 256 * 1024).is_err());
    {
        let guard = f.fence.locked().unwrap();
        let mut state = guard.read().unwrap().unwrap();
        state.phase = Phase::Closed;
        state
            .sections
            .insert("runtime".into(), json!({"phase":"stopped"}));
        guard.write(&state).unwrap();
    }
    let r = service.capture(&f.lease, 256 * 1024).unwrap();
    assert_eq!(
        service.capture(&f.lease, 256 * 1024).unwrap().sha256,
        r.sha256
    );
    assert!(service.capture(&f.lease, 512 * 1024).is_err());
    let part = service.read(&f.lease, 0, r.bytes as usize).unwrap();
    assert_eq!(
        hash(&STANDARD.decode(part["base64"].as_str().unwrap()).unwrap()),
        r.sha256
    );
    assert!(service.read(&f.lease, u64::MAX, 1).is_err());
}
