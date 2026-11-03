mod support;
use jetski_host::{
    exec_api::{ExecApi, connect_unix},
    host_config::HostConfig,
    protocol::Request,
    stream_broker,
    streams::{Delivery, StreamPhase, Streams},
};
use serde_json::json;
use std::{
    io::{Read, Write},
    net::Shutdown,
    os::unix::net::{UnixListener, UnixStream},
    sync::Arc,
    thread,
    time::{Duration, Instant},
};
use support::{Fixture, ID, IMAGE};
fn request(stream: &mut UnixStream) -> (String, serde_json::Value) {
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
        .find_map(|v| v.strip_prefix("Content-Length: "))
        .unwrap()
        .parse()
        .unwrap();
    let mut body = vec![0; size];
    stream.read_exact(&mut body).unwrap();
    (
        header,
        if body.is_empty() {
            serde_json::Value::Null
        } else {
            serde_json::from_slice(&body).unwrap()
        },
    )
}
#[test]
fn binary_relay_uses_native_api_requires_fins_and_never_reconnects_a_completed_id() {
    let f = Fixture::new();
    {
        let guard = f.fence.locked().unwrap();
        let mut state = guard.read().unwrap().unwrap();
        state.sections.get_mut("runtime").unwrap()["configuration"] = json!({"relay":true});
        guard.write(&state).unwrap();
    }
    let path = f.root().join("engine.sock");
    let listener = UnixListener::bind(&path).unwrap();
    listener.set_nonblocking(true).unwrap();
    let api = ExecApi::with_connector(Arc::new(move |timeout| connect_unix(&path, timeout)));
    let ingress = vec![b'D', 0, 0, 0, 3, 0, 255, 7, b'F', 0, 0, 0, 0];
    let mut egress = vec![b'R', 0, 0, 0, 0];
    egress.extend(&ingress);
    let expected = egress.clone();
    let service = thread::spawn(move || {
        let deadline = Instant::now() + Duration::from_secs(5);
        for step in 0..3 {
            let mut stream = loop {
                match listener.accept() {
                    Ok((s, _)) => break s,
                    Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                        assert!(Instant::now() < deadline);
                        thread::sleep(Duration::from_millis(2));
                    }
                    Err(e) => panic!("{e}"),
                }
            };
            let (header, body) = request(&mut stream);
            match step {
                0 => {
                    assert!(header.contains("/containers/"));
                    assert_eq!(
                        body["Cmd"],
                        json!(["/jetski-tcp-relay", "--jetski-tcp-v1", "8080"])
                    );
                    let body = json!({"Id":"a".repeat(64)}).to_string();
                    write!(
                        stream,
                        "HTTP/1.1 201 Created\r\nContent-Length: {}\r\n\r\n{body}",
                        body.len()
                    )
                    .unwrap();
                }
                1 => {
                    assert!(header.contains("/start "));
                    stream.write_all(b"HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: tcp\r\n\r\n").unwrap();
                    let mut input = vec![0; ingress.len()];
                    stream.read_exact(&mut input).unwrap();
                    assert_eq!(input, ingress);
                    let mut frame = vec![1, 0, 0, 0];
                    frame.extend((egress.len() as u32).to_be_bytes());
                    frame.extend(&egress);
                    stream.write_all(&frame).unwrap();
                }
                _ => {
                    assert!(header.contains("/json "));
                    let body = r#"{"Running":false,"ExitCode":0}"#;
                    write!(
                        stream,
                        "HTTP/1.1 200 OK\r\nContent-Length: {}\r\n\r\n{body}",
                        body.len()
                    )
                    .unwrap();
                }
            }
        }
    });
    let config: HostConfig = serde_json::from_value(
        json!({"version":1,"machineId":"host","poolId":"pool","images":[IMAGE]}),
    )
    .unwrap();
    let request = Request {
        version: 1,
        id: ID.into(),
        action: "stream-open".into(),
        payload: json!({"lease":f.lease,"image":IMAGE,"streamId":ID,"port":8080}),
    };
    let (mut client, server) = UnixStream::pair().unwrap();
    client
        .set_read_timeout(Some(Duration::from_secs(3)))
        .unwrap();
    client
        .write_all(&[b'D', 0, 0, 0, 3, 0, 255, 7, b'F', 0, 0, 0, 0])
        .unwrap();
    client.shutdown(Shutdown::Write).unwrap();
    stream_broker::serve(&request, &config, &f.fence, &api, &server, &server).unwrap();
    service.join().unwrap();
    let mut output = vec![0; expected.len()];
    client.read_exact(&mut output).unwrap();
    assert_eq!(output, expected);
    let receipt = Streams { fence: &f.fence }.status(&f.lease, ID).unwrap();
    assert_eq!(receipt.phase, StreamPhase::Closed);
    assert_eq!(receipt.delivery, Delivery::Complete);
    let never = ExecApi::with_connector(Arc::new(|_| {
        panic!("stream identity must never be replayed")
    }));
    assert!(stream_broker::serve(&request, &config, &f.fence, &never, &server, &server).is_err());
}
