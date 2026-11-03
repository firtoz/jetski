//! Differential compatibility for native primitives; no cloud/container allocation.
use jetski_host::fence::{Fence, Phase, ReleaseReceipt};
use jetski_host::frames::FrameWriter;
use jetski_host::protocol::Lease;
use serde_json::json;
use std::io::{Read, Write};
use std::os::unix::fs::PermissionsExt;
use std::path::Path;
use std::process::Command;

fn python(program: &str, args: &[&Path]) {
    let host = Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .join("host");
    let output = Command::new("python3")
        .args(["-I", "-c", program])
        .arg(host)
        .args(args)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "Python reference failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
}

#[test]
fn native_and_python_fences_continue_the_same_released_journal() {
    let temp = tempfile::tempdir().unwrap();
    std::fs::set_permissions(temp.path(), std::fs::Permissions::from_mode(0o700)).unwrap();
    let fence = Fence::open(temp.path()).unwrap();
    let mut lease: Lease = serde_json::from_value(json!({"owner":"owner","poolId":"pool","machineId":"host","slotId":"11111111-1111-4111-8111-111111111111","sandboxId":"22222222-2222-4222-8222-222222222222","assignmentId":"33333333-3333-4333-8333-333333333333","generation":1})).unwrap();
    let receipt = ReleaseReceipt {
        checkpoint_id: "44444444-4444-4444-8444-444444444444".into(),
        sha256: "a".repeat(64),
    };
    fence.claim(&lease).unwrap();
    fence.close(&lease).unwrap();
    fence.release(&lease, &receipt, |_, _| Ok(true)).unwrap();
    python(
        r#"
import sys,json,pathlib
sys.path.insert(0,sys.argv[1])
from fence import Fence
root=pathlib.Path(sys.argv[2]); fence=Fence(root)
state=fence.read(); assert state['phase']=='released'
lease=dict(state['lease'],generation=2)
fence.claim(lease); fence.close(lease)
fence.release(lease,lambda *_:True,state['releaseReceipt'])
"#,
        &[temp.path()],
    );
    lease.generation = 3;
    let state = Fence::open(temp.path()).unwrap().claim(&lease).unwrap();
    assert_eq!(state.phase, Phase::Open);
    assert_eq!(state.lease.generation, 3);
}

#[test]
fn gzip_frames_decode_in_both_languages_with_identical_expanded_bytes() {
    let temp = tempfile::tempdir().unwrap();
    let raw: Vec<u8> = (0_u8..=255).cycle().take(1_050_003).collect();
    let mut writer = FrameWriter::new(Vec::new(), 256 * 1024, true, None).unwrap();
    writer.write_all(&raw).unwrap();
    let archive = writer.finish().unwrap();
    std::fs::write(temp.path().join("rust.gz"), &archive.output).unwrap();
    std::fs::write(temp.path().join("raw"), &raw).unwrap();
    python(
        r#"
import sys,gzip,pathlib
sys.path.insert(0,sys.argv[1])
from frames import FrameWriter
root=pathlib.Path(sys.argv[2]); raw=(root/'raw').read_bytes()
assert gzip.decompress((root/'rust.gz').read_bytes())==raw
with open(root/'python.gz','wb') as output:
    with FrameWriter(output,256*1024,adaptive=True) as writer:
        for offset in range(0,len(raw),137): writer.write(raw[offset:offset+137])
"#,
        &[temp.path()],
    );
    let encoded = std::fs::read(temp.path().join("python.gz")).unwrap();
    let mut decoded = Vec::new();
    flate2::read::MultiGzDecoder::new(encoded.as_slice())
        .read_to_end(&mut decoded)
        .unwrap();
    assert_eq!(decoded, raw);
    decoded.clear();
    assert!(
        flate2::read::MultiGzDecoder::new(&encoded[..encoded.len() - 4])
            .read_to_end(&mut decoded)
            .is_err()
    );
}
