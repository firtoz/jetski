#![allow(dead_code)]
use jetski_host::{commands::Commands, fence::Fence, protocol::Lease};
use std::{
    fs, io,
    os::unix::fs::PermissionsExt,
    path::{Path, PathBuf},
};
pub const ID: &str = "55555555-5555-4555-8555-555555555555";
pub const OP: &str = "66666666-6666-4666-8666-666666666666";
pub const IMAGE: &str = "registry.example/linux@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
pub struct Fixture {
    pub temp: tempfile::TempDir,
    pub fence: Fence,
    pub lease: Lease,
    pub worker: PathBuf,
    pub output: PathBuf,
    pub terminal: PathBuf,
    pub data: PathBuf,
}
fn no_launch(_: &str) -> io::Result<()> {
    Ok(())
}
impl Fixture {
    pub fn new() -> Self {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path();
        let worker = root.join("control");
        fs::create_dir(&worker).unwrap();
        fs::set_permissions(&worker, fs::Permissions::from_mode(0o700)).unwrap();
        let fence = Fence::open(&worker).unwrap();
        let lease:Lease=serde_json::from_value(serde_json::json!({"owner":"owner","poolId":"pool","machineId":"host","slotId":"11111111-1111-4111-8111-111111111111","sandboxId":"22222222-2222-4222-8222-222222222222","assignmentId":"33333333-3333-4333-8333-333333333333","generation":1})).unwrap();
        let mut state = fence.claim(&lease).unwrap();
        state.sections.insert("runtime".into(),serde_json::json!({"phase":"running","image":IMAGE,"name":format!("jetski-{}",lease.assignment_id)}));
        fence.locked().unwrap().write(&state).unwrap();
        let output = root.join("commands");
        let terminal = root.join("terminal-input");
        let data = root.join("data");
        Self {
            temp,
            fence,
            lease,
            worker,
            output,
            terminal,
            data,
        }
    }
    pub fn commands(&self) -> Commands<'_> {
        Commands {
            fence: &self.fence,
            worker_root: &self.worker,
            output_root: &self.output,
            terminal_root: &self.terminal,
            launch: &no_launch,
        }
    }
    pub fn root(&self) -> &Path {
        self.temp.path()
    }
}
