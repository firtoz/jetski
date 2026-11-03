mod support;
use jetski_host::{
    command_spec::Specification,
    commands::CommandPhase,
    exec_api::{ExecApi, connect_unix},
    fence::Phase,
    host_config::{HostConfig, NamespaceMapping},
    process::CommandResult,
    worker::Worker,
};
use serde_json::json;
use std::{
    io::{Read, Write},
    os::unix::net::{UnixListener, UnixStream},
    sync::{Arc, mpsc},
    thread,
    time::{Duration, Instant},
};
use support::{Fixture, ID, IMAGE};
fn request(stream: &mut UnixStream) -> (String, Vec<u8>) {
    stream
        .set_read_timeout(Some(Duration::from_secs(3)))
        .unwrap();
    stream
        .set_write_timeout(Some(Duration::from_secs(3)))
        .unwrap();
    let mut raw = Vec::new();
    while !raw.ends_with(b"\r\n\r\n") {
        let mut byte = [0];
        stream.read_exact(&mut byte).unwrap();
        raw.push(byte[0]);
        assert!(raw.len() < 32768);
    }
    let header = String::from_utf8(raw).unwrap();
    let size: usize = header
        .lines()
        .find_map(|s| s.strip_prefix("Content-Length: "))
        .unwrap()
        .parse()
        .unwrap();
    let mut body = vec![0; size];
    stream.read_exact(&mut body).unwrap();
    (header, body)
}
fn frame(stream: &mut UnixStream, channel: u8, data: &[u8]) {
    let mut header = vec![channel, 0, 0, 0];
    header.extend((data.len() as u32).to_be_bytes());
    stream.write_all(&header).unwrap();
    stream.write_all(data).unwrap();
}
#[derive(Clone, Copy, PartialEq, Eq)]
enum Mode {
    Complete,
    MissingProof,
    Cancel,
}
fn service(mode: Mode, attached: Option<mpsc::Sender<()>>) -> (ExecApi, thread::JoinHandle<()>) {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("engine.sock");
    let listener = UnixListener::bind(&path).unwrap();
    listener.set_nonblocking(true).unwrap();
    let api = ExecApi::with_connector(Arc::new(move |timeout| connect_unix(&path, timeout)));
    let thread = thread::spawn(move || {
        let mut children = Vec::new();
        let mut accepted = 0;
        let deadline = Instant::now() + Duration::from_secs(5);
        let expected = if mode == Mode::Cancel { 4 } else { 2 };
        while accepted < expected {
            match listener.accept() {
                Ok((mut stream, _)) => {
                    accepted += 1;
                    let attached = attached.clone();
                    children.push(thread::spawn(move||{let(header,body)=request(&mut stream);if header.contains("/containers/") {let body:serde_json::Value=serde_json::from_slice(&body).unwrap();assert_eq!(body["Cmd"][0],"/jetski-supervisor");assert_eq!(body["Privileged"],false);let response=format!("{{\"Id\":\"{}\"}}","a".repeat(64));write!(stream,"HTTP/1.1 201 Created\r\nContent-Length: {}\r\n\r\n{response}",response.len()).unwrap();}
 else if header.contains("/start "){stream.write_all(b"HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: tcp\r\n\r\n").unwrap();let mut nonce=[0;32];stream.read_exact(&mut nonce).unwrap();frame(&mut stream,1,b"binary\0\xff");if mode==Mode::Cancel{attached.unwrap().send(()).unwrap();let mut rest=Vec::new();stream.read_to_end(&mut rest).unwrap();}
if mode!=Mode::MissingProof{let nonce:String=nonce.iter().map(|n|format!("{n:02x}")).collect();let suffix=if mode==Mode::Cancel{"1:143"}else{"0:000"};let mut stderr=b"stderr".to_vec();stderr.extend(format!("\0jetski-complete-v1:{nonce}:{suffix}\0").as_bytes());frame(&mut stream,2,&stderr);}}
 else if header.contains("/remove "){stream.write_all(b"HTTP/1.1 204 No Content\r\n\r\n").unwrap();}
 else{assert!(header.contains("/json "));stream.write_all(b"HTTP/1.1 404 Not Found\r\nContent-Length: 2\r\n\r\n{}").unwrap();}}));
                }
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                    assert!(
                        Instant::now() < deadline,
                        "fixture did not receive expected request"
                    );
                    thread::sleep(Duration::from_millis(2));
                }
                Err(error) => panic!("{error}"),
            }
        }
        for child in children {
            child.join().unwrap();
        }
        drop(temp);
    });
    (api, thread)
}
fn config() -> HostConfig {
    serde_json::from_value(json!({"version":1,"machineId":"host","poolId":"pool","images":[IMAGE]}))
        .unwrap()
}
#[test]
fn native_worker_retains_only_workload_bytes_after_authenticated_completion() {
    let fixture = Fixture::new();
    let commands = fixture.commands();
    commands
        .start(
            &fixture.lease,
            ID,
            Specification::new(vec!["/bin/true".into()], "/workspace".into(), 120, None).unwrap(),
        )
        .unwrap();
    let config = config();
    let (api, server) = service(Mode::Complete, None);
    let run = |_: &[String]| {
        Ok(CommandResult {
            exit_code: 0,
            stdout: "false".into(),
            stderr: String::new(),
        })
    };
    let worker = Worker {
        fence: &fixture.fence,
        worker_root: &fixture.worker,
        output_root: &fixture.output,
        terminal_root: &fixture.terminal,
        data_root: &fixture.data,
        config: &config,
        mapping: NamespaceMapping::default(),
        run: &run,
        api: &api,
    };
    worker.run(ID, &fixture.lease).unwrap();
    server.join().unwrap();
    assert_eq!(
        commands.status(&fixture.lease, ID).unwrap().phase,
        CommandPhase::Succeeded
    );
    assert_eq!(
        commands.status(&fixture.lease, ID).unwrap().exit_code,
        Some(0)
    );
    let snapshot = commands.snapshot(&fixture.lease, ID).unwrap();
    assert_eq!(snapshot["channels"]["stderr"]["base64"], "c3RkZXJy");
    let output = std::fs::read(
        fixture
            .output
            .join(&fixture.lease.assignment_id)
            .join(ID)
            .join("stdout"),
    )
    .unwrap();
    assert_eq!(output, b"binary\0\xff");
    worker.run(ID, &fixture.lease).unwrap(); // Observes the existing record; no second exec request.
}
#[test]
fn missing_completion_proof_quarantines_instead_of_inventing_an_exit() {
    let fixture = Fixture::new();
    fixture
        .commands()
        .start(
            &fixture.lease,
            ID,
            Specification::new(vec!["true".into()], "/workspace".into(), 120, None).unwrap(),
        )
        .unwrap();
    let config = config();
    let (api, server) = service(Mode::MissingProof, None);
    let run = |_: &[String]| {
        Ok(CommandResult {
            exit_code: 0,
            stdout: "false".into(),
            stderr: String::new(),
        })
    };
    Worker {
        fence: &fixture.fence,
        worker_root: &fixture.worker,
        output_root: &fixture.output,
        terminal_root: &fixture.terminal,
        data_root: &fixture.data,
        config: &config,
        mapping: NamespaceMapping::default(),
        run: &run,
        api: &api,
    }
    .run(ID, &fixture.lease)
    .unwrap();
    server.join().unwrap();
    let row = fixture.commands().status(&fixture.lease, ID).unwrap();
    assert_eq!(row.phase, CommandPhase::Uncertain);
    assert_eq!(row.exit_code, None);
    assert_eq!(row.details["failureStage"], "completion-proof");
    assert_eq!(
        fixture
            .fence
            .locked()
            .unwrap()
            .read()
            .unwrap()
            .unwrap()
            .phase,
        Phase::Quarantined
    );
}
#[test]
fn cancellation_requires_authenticated_reaping_proof_and_preserves_output() {
    let fixture = Fixture::new();
    fixture
        .commands()
        .start(
            &fixture.lease,
            ID,
            Specification::new(
                vec!["sleep".into(), "60".into()],
                "/workspace".into(),
                120,
                None,
            )
            .unwrap(),
        )
        .unwrap();
    let config = config();
    let (tx, rx) = mpsc::channel();
    let (api, server) = service(Mode::Cancel, Some(tx));
    let run = |_: &[String]| {
        Ok(CommandResult {
            exit_code: 0,
            stdout: "false".into(),
            stderr: String::new(),
        })
    };
    let worker = Worker {
        fence: &fixture.fence,
        worker_root: &fixture.worker,
        output_root: &fixture.output,
        terminal_root: &fixture.terminal,
        data_root: &fixture.data,
        config: &config,
        mapping: NamespaceMapping::default(),
        run: &run,
        api: &api,
    };
    thread::scope(|scope| {
        let executing = scope.spawn(|| worker.run(ID, &fixture.lease));
        rx.recv_timeout(Duration::from_secs(2)).unwrap();
        fixture.commands().cancel(&fixture.lease, ID).unwrap();
        executing.join().unwrap().unwrap();
    });
    server.join().unwrap();
    let row = fixture.commands().status(&fixture.lease, ID).unwrap();
    assert_eq!(row.phase, CommandPhase::Cancelled);
    assert_eq!(row.exit_code, Some(143));
    assert_eq!(row.details["reason"], "cancelled");
    assert_eq!(
        fixture
            .commands()
            .output(&fixture.lease, ID, "stdout", 0, 256)
            .unwrap()["nextOffset"],
        8
    );
}
