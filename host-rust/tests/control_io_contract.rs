use jetski_host::{
    control_io::{self, Header},
    stream_protocol::MAGIC,
};
use std::{
    io::{Read, Write},
    net::Shutdown,
    os::unix::net::UnixStream,
};
#[test]
fn ordinary_json_and_binary_headers_are_bounded_without_eating_stream_payload() {
    let raw = br#"{"version":1,"id":"one","action":"status","payload":{}}"#;
    let (client, server) = UnixStream::pair().unwrap();
    client.try_clone().unwrap().write_all(raw).unwrap();
    client.shutdown(Shutdown::Write).unwrap();
    match control_io::header(&server).unwrap() {
        Header::Control(request) => assert_eq!(request.id, "one"),
        _ => panic!("wrong route"),
    }
    let (mut client, mut server) = UnixStream::pair().unwrap();
    client.write_all(MAGIC).unwrap();
    client.write_all(&(raw.len() as u32).to_be_bytes()).unwrap();
    client.write_all(raw).unwrap();
    client.write_all(b"\0binary\xff").unwrap();
    assert!(matches!(
        control_io::header(&server).unwrap(),
        Header::Stream(_)
    ));
    let mut next = [0; 8];
    server.read_exact(&mut next).unwrap();
    assert_eq!(&next, b"\0binary\xff");
    for bad in [
        b"JETSKI-X".as_slice(),
        b"JETSKI-STREAM/1\n\xff\xff\xff\xff",
        br#"{"version":2,"id":"one","action":"status","payload":{}}"#,
    ] {
        let (mut client, server) = UnixStream::pair().unwrap();
        client.write_all(bad).unwrap();
        client.shutdown(Shutdown::Write).unwrap();
        assert!(control_io::header(&server).is_err());
    }
}
