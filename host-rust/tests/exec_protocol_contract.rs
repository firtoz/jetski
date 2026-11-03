use jetski_host::command_spec::Specification;
use jetski_host::exec_api::{CompletionDecoder, ExecApi, Output, connect_unix};
use std::{
    io::{Read, Write},
    os::unix::net::{UnixListener, UnixStream},
    sync::Arc,
    thread,
    time::{Duration, Instant},
};
fn request(stream: &mut UnixStream) -> (String, Vec<u8>) {
    stream
        .set_read_timeout(Some(Duration::from_secs(2)))
        .unwrap();
    let mut header = Vec::new();
    while !header.ends_with(b"\r\n\r\n") {
        let mut byte = [0];
        stream.read_exact(&mut byte).unwrap();
        header.push(byte[0]);
        assert!(header.len() < 32768);
    }
    let text = String::from_utf8(header).unwrap();
    let length = text
        .lines()
        .find_map(|line| line.strip_prefix("Content-Length: "))
        .unwrap()
        .parse::<usize>()
        .unwrap();
    let mut body = vec![0; length];
    stream.read_exact(&mut body).unwrap();
    (text, body)
}
fn server(
    count: usize,
    handler: impl Fn(&mut UnixStream, usize) + Send + 'static,
) -> (ExecApi, thread::JoinHandle<()>) {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("service.sock");
    let listener = UnixListener::bind(&path).unwrap();
    let api = ExecApi::with_connector(Arc::new(move |timeout| connect_unix(&path, timeout)));
    let handle = thread::spawn(move || {
        for index in 0..count {
            let (mut stream, _) = listener.accept().unwrap();
            handler(&mut stream, index);
        }
        drop(temp);
    });
    (api, handle)
}
fn frame(channel: u8, bytes: &[u8]) -> Vec<u8> {
    let mut value = vec![channel, 0, 0, 0];
    value.extend((bytes.len() as u32).to_be_bytes());
    value.extend(bytes);
    value
}
#[test]
fn native_exec_uses_exact_request_scope_chunked_json_and_confirmed_removal() {
    let session = "a".repeat(64);
    let id = session.clone();
    let (api, handle) = server(4, move |stream, index| {
        let (header, body) = request(stream);
        match index {
            0 => {
                assert!(header.starts_with("POST /v4.0.0/libpod/containers/jetski-11111111-1111-4111-8111-111111111111/exec "));
                let body: serde_json::Value = serde_json::from_slice(&body).unwrap();
                assert_eq!(body["User"], "1000:1000");
                assert_eq!(body["Privileged"], false);
                let body = format!("{{\"Id\":\"{id}\"}}");
                write!(
                    stream,
                    "HTTP/1.1 201 Created\r\nContent-Length: {}\r\n\r\n{body}",
                    body.len()
                )
                .unwrap();
            }
            1 => {
                assert!(header.contains(&format!("/exec/{id}/json")));
                let body = b"{\"Running\":false,\"ExitCode\":0}";
                write!(
                    stream,
                    "HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n{:x}\r\n",
                    body.len()
                )
                .unwrap();
                stream.write_all(body).unwrap();
                stream.write_all(b"\r\n0\r\n\r\n").unwrap();
            }
            2 => {
                assert!(header.starts_with(&format!("POST /v4.0.0/libpod/exec/{id}/remove ")));
                assert_eq!(
                    serde_json::from_slice::<serde_json::Value>(&body).unwrap()["Force"],
                    true
                );
                stream
                    .write_all(b"HTTP/1.1 204 No Content\r\n\r\n")
                    .unwrap();
            }
            _ => {
                stream
                    .write_all(b"HTTP/1.1 404 Not Found\r\nContent-Length: 2\r\n\r\n{}")
                    .unwrap();
            }
        }
    });
    let observed = api
        .create(
            "jetski-11111111-1111-4111-8111-111111111111",
            vec!["/bin/true".into()],
            "/workspace",
            false,
            true,
        )
        .unwrap();
    assert_eq!(observed, session);
    assert_eq!(api.inspect(&session).unwrap()["Running"], false);
    api.remove(&session).unwrap();
    handle.join().unwrap();
}
#[test]
fn attach_preserves_binary_frames_and_partial_header_polling() {
    let (api, handle) = server(1, |stream, _| {
        request(stream);
        stream
            .write_all(
                b"HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: tcp\r\n\r\n",
            )
            .unwrap();
        let mut nonce = [0; 32];
        stream.read_exact(&mut nonce).unwrap();
        assert_eq!(nonce, [7; 32]);
        let data = frame(1, b"binary\0\xff");
        stream.write_all(&data[..1]).unwrap();
        thread::sleep(Duration::from_millis(100));
        stream.write_all(&data[1..]).unwrap();
        stream.write_all(&frame(2, b"error")).unwrap();
    });
    let mut attach = api
        .attach(&"b".repeat(64), Duration::from_secs(2), &[7; 32])
        .unwrap();
    let started = Instant::now();
    assert_eq!(attach.poll().unwrap(), Output::Pending);
    assert!(started.elapsed() < Duration::from_millis(90));
    let mut output = Vec::new();
    loop {
        match attach.poll().unwrap() {
            Output::Data { channel, bytes } => output.push((channel, bytes)),
            Output::Pending => {}
            Output::Eof => break,
        }
    }
    assert_eq!(
        output,
        vec![
            ("stdout", b"binary\0\xff".to_vec()),
            ("stderr", b"error".to_vec())
        ]
    );
    handle.join().unwrap();
}
#[test]
fn oversized_and_ambiguous_http_responses_fail_before_body_allocation() {
    for response in [
        b"HTTP/1.1 200 OK\r\nContent-Length: 1048577\r\n\r\n".to_vec(),
        b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nTransfer-Encoding: chunked\r\n\r\n".to_vec(),
        b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nContent-Length: 2\r\n\r\n{}".to_vec(),
    ] {
        let (api, handle) = server(1, move |stream, _| {
            request(stream);
            stream.write_all(&response).unwrap();
        });
        assert!(api.inspect(&"c".repeat(64)).is_err());
        handle.join().unwrap();
    }
}
#[test]
fn completion_nonce_never_becomes_output_and_forged_or_trailing_proofs_fail() {
    let nonce = [19; 32];
    let hex = "13".repeat(32);
    let marker = format!("\0jetski-complete-v1:{hex}:1:143\0").into_bytes();
    let mut raw = b"workload\0\xff".repeat(30);
    raw.extend(&marker);
    for split in 1..marker.len() + 10 {
        let mut decoder = CompletionDecoder::new(&nonce);
        let mut output = Vec::new();
        for bytes in raw.chunks(split) {
            output.extend(decoder.feed(bytes).unwrap());
        }
        assert_eq!(output, b"workload\0\xff".repeat(30));
        let proof = decoder.finish().unwrap();
        assert!(proof.cancelled && proof.descendants_reaped);
        assert_eq!(proof.exit_code, 143);
    }
    for split in 1..marker.len() + 10 {
        let mut decoder = CompletionDecoder::new(&nonce);
        let mut data = raw.clone();
        data.extend(b"unexpected");
        let mut output = Vec::new();
        let mut failed = false;
        for bytes in data.chunks(split) {
            match decoder.feed(bytes) {
                Ok(bytes) => output.extend(bytes),
                Err(_) => {
                    failed = true;
                    break;
                }
            }
        }
        assert!(failed);
        assert!(!output.windows(hex.len()).any(|part| part == hex.as_bytes()));
        assert!(decoder.finish().is_err());
    }
    let mut decoder = CompletionDecoder::new(&[20; 32]);
    decoder.feed(&marker).unwrap();
    assert!(decoder.finish().is_err());
}
#[test]
fn argv_bounds_include_python_ascii_escaping_and_working_directory_scope() {
    assert!(
        Specification::new(
            vec!["echo".into(), "λ".repeat(11000)],
            "/workspace".into(),
            120,
            None
        )
        .is_err()
    );
    assert!(
        Specification::new(vec!["true".into()], "/workspace/../home".into(), 120, None).is_err()
    );
    assert!(
        Specification::new(
            vec!["true".into()],
            "/home/sandbox".into(),
            120,
            Some((0, 80))
        )
        .is_err()
    );
}
