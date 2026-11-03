mod support;
use jetski_host::{
    command_spec::Specification,
    commands::{self, CommandPhase, Commands},
    fence::{Fence, Phase},
};
use std::{cell::Cell, fs, io};
use support::{Fixture, ID};
fn spec() -> Specification {
    Specification::new(vec!["/bin/true".into()], "/workspace".into(), 120, None).unwrap()
}
#[test]
fn uncertain_worker_launch_keeps_identity_and_never_dispatches_again() {
    let fixture = Fixture::new();
    let count = Cell::new(0);
    let launch = |_: &str| {
        count.set(count.get() + 1);
        Err(io::Error::other("lost launch ack"))
    };
    let commands = Commands {
        launch: &launch,
        ..fixture.commands()
    };
    assert!(commands.start(&fixture.lease, ID, spec()).is_err());
    assert_eq!(
        commands.start(&fixture.lease, ID, spec()).unwrap().phase,
        CommandPhase::Queued
    );
    assert_eq!(count.get(), 1);
    let mut changed = spec();
    changed.argv.push("different".into());
    assert!(commands.start(&fixture.lease, ID, changed).is_err());
    assert_eq!(
        commands.cancel(&fixture.lease, ID).unwrap().phase,
        CommandPhase::Cancelled
    );
}
#[test]
fn worker_lifetime_lock_prevents_false_loss_and_reopen_marks_unknown_execution() {
    let fixture = Fixture::new();
    let commands = fixture.commands();
    commands.start(&fixture.lease, ID, spec()).unwrap();
    let held = commands::worker_guard(&fixture.worker, &fixture.lease, ID, true)
        .unwrap()
        .unwrap();
    let guard = fixture.fence.locked().unwrap();
    let mut state = guard.read().unwrap().unwrap();
    let mut row = commands::receipt(&state, ID).unwrap();
    row.phase = CommandPhase::Running;
    commands::save(&guard, &mut state, row).unwrap();
    drop(guard);
    assert_eq!(
        commands.status(&fixture.lease, ID).unwrap().phase,
        CommandPhase::Running
    );
    drop(held);
    let reopened = Fence::open(&fixture.worker).unwrap();
    let observer = Commands {
        fence: &reopened,
        ..fixture.commands()
    };
    assert_eq!(
        observer.status(&fixture.lease, ID).unwrap().phase,
        CommandPhase::Uncertain
    );
    assert_eq!(
        reopened.locked().unwrap().read().unwrap().unwrap().phase,
        Phase::Quarantined
    );
}
#[test]
fn output_cursors_and_snapshot_preserve_binary_bytes_after_completion() {
    let fixture = Fixture::new();
    let commands = fixture.commands();
    commands.start(&fixture.lease, ID, spec()).unwrap();
    let root = fixture.output.join(&fixture.lease.assignment_id).join(ID);
    fs::create_dir_all(&root).unwrap();
    fs::write(root.join("stdout"), b"binary\0\xff").unwrap();
    fs::write(root.join("stderr"), b"error").unwrap();
    let guard = fixture.fence.locked().unwrap();
    let mut state = guard.read().unwrap().unwrap();
    let mut row = commands::receipt(&state, ID).unwrap();
    row.phase = CommandPhase::Succeeded;
    row.exit_code = Some(0);
    commands::save(&guard, &mut state, row).unwrap();
    drop(guard);
    let output = commands
        .output(&fixture.lease, ID, "stdout", 0, 8192)
        .unwrap();
    assert_eq!(output["terminal"], true);
    assert_eq!(output["nextOffset"], 8);
    assert_eq!(
        commands.snapshot(&fixture.lease, ID).unwrap()["channels"]["stdout"]["base64"],
        output["base64"]
    );
    assert!(commands.output(&fixture.lease, ID, "stdout", 9, 1).is_err());
}
