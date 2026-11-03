//! Independent Python filesystem oracle; no runtime install or network access.
use jetski_host::archive::{self, Limits};
use sha2::{Digest, Sha256};
use std::fs;
use std::path::Path;
use std::process::Command;

fn python(program: &str, root: &Path) {
    let host = Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .join("host");
    let output = Command::new("python3")
        .args(["-I", "-c", program])
        .arg(host)
        .arg(root)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "reference/oracle failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
}
fn reference_fixture(root: &Path) {
    python(
        r#"
import sys,pathlib,os,json
sys.path.insert(0,sys.argv[1])
from test_archive import ArchiveTests,oracle
from archive import capture
base=pathlib.Path(sys.argv[2]); case=ArchiveTests(); case.setUp()
os.rename(case.source,base/'source')
source=base/'source'; workspace=source/'workspace'; home=source/'home'
longdir=workspace/('d'*150); longdir.mkdir()
(longdir/('file'*40)).write_bytes(b'long path\0bytes')
(home/'long-link').symlink_to('../workspace/'+longdir.name+'/'+('file'*40))
(workspace/'literal\\backslash').write_bytes(b'backslash stays literal')
(home/'link\\name').symlink_to('../workspace/literal\\backslash')
(base/'oracle.json').write_text(json.dumps(oracle(source),sort_keys=True))
receipt=capture({name:source/name for name in ('workspace','home')},base/'python.tgz',frame_bytes=256*1024)
(base/'python.json').write_text(json.dumps(receipt))
"#,
        root,
    );
}

#[test]
fn both_languages_restore_exact_modes_links_unicode_and_source_deleted_bytes() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path();
    reference_fixture(root);
    let expected = archive::digest(&root.join("python.tgz")).unwrap();
    archive::restore(
        &root.join("python.tgz"),
        &root.join("rust-from-python"),
        &expected,
        Limits::default(),
        None,
    )
    .unwrap();
    let source = root.join("source");
    let receipt = archive::capture(
        [&source.join("workspace"), &source.join("home")],
        &root.join("rust.tgz"),
        Limits::default(),
        256 * 1024,
    )
    .unwrap();
    let repeated = archive::capture(
        [&source.join("workspace"), &source.join("home")],
        &root.join("same.tgz"),
        Limits::default(),
        256 * 1024,
    )
    .unwrap();
    assert_eq!(receipt.sha256, repeated.sha256);
    assert_eq!(receipt.frames, repeated.frames);
    let replay = archive::capture(
        [&source.join("workspace"), &source.join("home")],
        &root.join("rust.tgz"),
        Limits::default(),
        256 * 1024,
    )
    .unwrap();
    assert_eq!(replay.sha256, receipt.sha256);
    fs::write(
        root.join("rust.json"),
        serde_json::to_vec(&receipt).unwrap(),
    )
    .unwrap();
    fs::remove_dir_all(&source).unwrap();
    archive::restore(
        &root.join("rust.tgz"),
        &root.join("rust-from-rust"),
        &receipt.sha256,
        Limits::default(),
        None,
    )
    .unwrap();
    python(
        r#"
import sys,pathlib,json,gzip,hashlib
sys.path.insert(0,sys.argv[1])
from test_archive import oracle
from archive import restore
base=pathlib.Path(sys.argv[2]); expected=json.loads((base/'oracle.json').read_text())
for name in ('rust-from-python','rust-from-rust'):
    assert oracle(base/name)==expected,name
receipt=json.loads((base/'rust.json').read_text()); encoded=(base/'rust.tgz').read_bytes()
assert hashlib.sha256(encoded).hexdigest()==receipt['sha256']
assert len(encoded)==receipt['bytes']
for frame in receipt['frames']:
    part=encoded[frame['offset']:frame['offset']+frame['bytes']]; expanded=gzip.decompress(part)
    assert len(expanded)==frame['expandedBytes']
    assert hashlib.sha256(part).hexdigest()==frame['sha256']
    assert hashlib.sha256(expanded).hexdigest()==frame['expandedSha256']
restore(base/'rust.tgz',base/'python-from-rust',receipt['sha256'])
assert oracle(base/'python-from-rust')==expected
assert not (base/'source').exists()
"#,
        root,
    );
}

#[test]
fn malformed_or_late_corrupt_archives_never_publish_or_escape_staging() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path();
    python(
        r#"
import sys,pathlib,tarfile,io,gzip
base=pathlib.Path(sys.argv[2])
def create(name,rows):
    stream=io.BytesIO()
    with tarfile.open(fileobj=stream,mode='w',format=tarfile.PAX_FORMAT) as archive:
        for path,kind,target in rows:
            header=tarfile.TarInfo(path); header.type=kind; header.mode=0o700
            if kind==tarfile.REGTYPE: header.size=len(target)
            elif kind in (tarfile.LNKTYPE,tarfile.SYMTYPE): header.linkname=target
            archive.addfile(header,io.BytesIO(target) if kind==tarfile.REGTYPE else None)
    data=gzip.compress(stream.getvalue(),mtime=0); (base/name).write_bytes(data)
roots=[('workspace',tarfile.DIRTYPE,''),('home',tarfile.DIRTYPE,'')]
for index,extra in enumerate([
    [('workspace/../escape',tarfile.REGTYPE,b'x')],
    [('workspace/link',tarfile.SYMTYPE,'/tmp'),('workspace/link/escape',tarfile.REGTYPE,b'x')],
    [('home/link',tarfile.LNKTYPE,'../outside')],
    [('home/a',tarfile.REGTYPE,b'x'),('home/a',tarfile.REGTYPE,b'y')],
    [('home/pipe',tarfile.FIFOTYPE,'')],
    [('home/no-parent/file',tarfile.REGTYPE,b'x')],
    [('workspace//double',tarfile.REGTYPE,b'x')],
    [('workspace/./dot',tarfile.REGTYPE,b'x')],
    [('other/root',tarfile.REGTYPE,b'x')],
]): create(str(index)+'.tgz',roots+extra)
create('missing.tgz',roots[:1]); create('valid.tgz',roots)
data=bytearray((base/'valid.tgz').read_bytes()); data[-1]^=1; (base/'crc.tgz').write_bytes(data)
(base/'truncated.tgz').write_bytes((base/'valid.tgz').read_bytes()[:-5])
(base/'suffix.tgz').write_bytes((base/'valid.tgz').read_bytes()+b'not gzip')
"#,
        root,
    );
    for name in (0..9)
        .map(|i| format!("{i}.tgz"))
        .chain(["missing.tgz", "crc.tgz", "truncated.tgz", "suffix.tgz"].map(String::from))
    {
        let file = root.join(&name);
        let bytes = fs::read(&file).unwrap();
        let digest = format!("{:x}", Sha256::digest(&bytes));
        assert!(
            archive::restore(
                &file,
                &root.join("destination"),
                &digest,
                Limits::default(),
                None
            )
            .is_err(),
            "accepted {name}"
        );
        assert!(!root.join("destination").exists());
        assert!(
            !fs::read_dir(root).unwrap().any(|e| e
                .unwrap()
                .file_name()
                .to_string_lossy()
                .starts_with(".restore-")),
            "staging left for {name}"
        );
    }
    assert!(
        archive::restore(
            &root.join("valid.tgz"),
            &root.join("destination"),
            &"0".repeat(64),
            Limits::default(),
            None
        )
        .is_err()
    );
    assert!(!root.join("destination").exists());
    let digest = archive::digest(&root.join("valid.tgz")).unwrap();
    fs::create_dir(root.join("destination")).unwrap();
    fs::write(root.join("destination/acknowledged"), b"keep").unwrap();
    assert!(
        archive::restore(
            &root.join("valid.tgz"),
            &root.join("destination"),
            &digest,
            Limits::default(),
            None
        )
        .is_err()
    );
    assert_eq!(
        fs::read(root.join("destination/acknowledged")).unwrap(),
        b"keep"
    );
}

#[test]
fn capture_rejects_changed_identity_and_unsupported_source_types() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path();
    reference_fixture(root);
    let source = root.join("source");
    let workspace = source.join("workspace");
    let home = source.join("home");
    let target = root.join("ack.tgz");
    let first = archive::capture_default([&workspace, &home], &target).unwrap();
    fs::write(workspace.join("new"), b"new bytes").unwrap();
    assert!(archive::capture_default([&workspace, &home], &target).is_err());
    assert_eq!(archive::digest(&target).unwrap(), first.sha256);
    assert!(
        archive::capture(
            [&workspace, &home],
            &root.join("limited.tgz"),
            Limits {
                entries: 2,
                ..Limits::default()
            },
            1024
        )
        .is_err()
    );
    assert!(!root.join("limited.tgz").exists());
    std::os::unix::fs::symlink(&workspace, root.join("aliased-root")).unwrap();
    assert!(
        archive::capture_default([&root.join("aliased-root"), &home], &root.join("alias.tgz"))
            .is_err()
    );
}
