mod support;
use jetski_host::{
    command_spec::Specification,
    commands::{self, CommandPhase},
    terminal_input::{Input, Signal, TerminalInputs},
};
use serde_json::json;
use support::{Fixture, ID, OP};
#[test]
fn terminal_frames_and_private_delivery_journal_match_known_protocol() {
    let fixture = Fixture::new();
    let spec = Specification::new(
        vec!["/bin/sh".into()],
        "/workspace".into(),
        120,
        Some((24, 80)),
    )
    .unwrap();
    fixture.commands().start(&fixture.lease, ID, spec).unwrap();
    let inputs = TerminalInputs::new(&fixture.fence, &fixture.terminal);
    let input = Input::Stdin {
        base64: "YmluYXJ5AP8=".into(),
    };
    let first = inputs.admit(&fixture.lease, ID, OP, &input).unwrap();
    assert_eq!(first["phase"], "queued");
    assert!(first.get("frame").is_none());
    assert_eq!(inputs.admit(&fixture.lease, ID, OP, &input).unwrap(), first);
    assert!(
        inputs
            .admit(&fixture.lease, ID, OP, &Input::Close {})
            .is_err()
    );
    let guard = fixture.fence.locked().unwrap();
    let mut state = guard.read().unwrap().unwrap();
    let mut command = commands::receipt(&state, ID).unwrap();
    command.phase = CommandPhase::Running;
    commands::save(&guard, &mut state, command).unwrap();
    drop(guard);
    let mut sent = Vec::new();
    assert!(
        inputs
            .dispatch_one(&fixture.lease, ID, |bytes| {
                sent.extend_from_slice(bytes);
                Ok(())
            })
            .unwrap()
    );
    assert_eq!(sent, b"I\0\0\0\x08binary\0\xff");
    assert_eq!(
        inputs.status(&fixture.lease, ID, OP).unwrap()["phase"],
        "sent"
    );
    assert_eq!(
        Input::Resize {
            rows: 24,
            columns: 80
        }
        .frame()
        .unwrap()
        .1,
        b"R\0\0\0\x04\0\x18\0P"
    );
    assert_eq!(
        Input::Signal {
            signal: Signal::INT
        }
        .frame()
        .unwrap()
        .1,
        b"S\0\0\0\x01\x02"
    );
}
#[test]
fn failed_send_is_uncertain_and_never_automatically_replayed() {
    let fixture = Fixture::new();
    fixture
        .commands()
        .start(
            &fixture.lease,
            ID,
            Specification::new(vec!["sh".into()], "/workspace".into(), 120, Some((24, 80)))
                .unwrap(),
        )
        .unwrap();
    let guard = fixture.fence.locked().unwrap();
    let mut state = guard.read().unwrap().unwrap();
    let mut row = commands::receipt(&state, ID).unwrap();
    row.phase = CommandPhase::Running;
    commands::save(&guard, &mut state, row).unwrap();
    drop(guard);
    let inputs = TerminalInputs::new(&fixture.fence, &fixture.terminal);
    inputs
        .admit(&fixture.lease, ID, OP, &Input::Close {})
        .unwrap();
    assert!(
        inputs
            .dispatch_one(&fixture.lease, ID, |_| Err(std::io::Error::other(
                "lost delivery"
            )))
            .is_err()
    );
    assert_eq!(
        inputs.status(&fixture.lease, ID, OP).unwrap()["phase"],
        "uncertain"
    );
    assert!(
        inputs
            .dispatch_one(&fixture.lease, ID, |_| panic!("must not resend"))
            .is_err()
    );
}
#[test]
fn malformed_or_noncanonical_inputs_are_rejected() {
    for value in [
        json!({"kind":"close","unexpected":1}),
        json!({"kind":"stdin","base64":"YQ"}),
        json!({"kind":"resize","rows":0,"columns":80}),
        json!({"kind":"signal","signal":"KILL"}),
    ] {
        if let Ok(input) = serde_json::from_value::<Input>(value) {
            assert!(input.frame().is_err());
        }
    }
}
