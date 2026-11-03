mod support;
use jetski_host::{
    stream_protocol::Decoder,
    streams::{Delivery, Outcome, StreamPhase, Streams},
};
use std::io;
use support::{Fixture, ID, OP};
fn session() -> String {
    "a".repeat(64)
}
#[test]
fn lost_creation_ack_is_not_another_connection_and_eof_is_not_delivery() {
    let f = Fixture::new();
    let streams = Streams { fence: &f.fence };
    streams.reserve(&f.lease, ID, 8080).unwrap();
    assert!(
        streams
            .prepare(&f.lease, ID, |_, _| Err(io::Error::other(
                "lost acknowledgement"
            )))
            .is_err()
    );
    assert!(
        !streams
            .prepare(&f.lease, ID, |_, _| panic!(
                "must never replay connection creation"
            ))
            .unwrap()
            .fresh
    );
    assert_eq!(
        streams.status(&f.lease, ID).unwrap().phase,
        StreamPhase::Uncertain
    );
    streams.reserve(&f.lease, OP, 8081).unwrap();
    let prepared = streams
        .prepare(&f.lease, OP, |name, port| {
            assert_eq!(name, format!("jetski-{}", f.lease.assignment_id));
            assert_eq!(port, 8081);
            Ok(session())
        })
        .unwrap();
    assert!(prepared.fresh);
    assert!(streams.connected(&f.lease, OP, &session()).unwrap());
    let row = streams
        .finish(&f.lease, OP, &session(), |_| Ok(Outcome::Unknown))
        .unwrap();
    assert_eq!(row.phase, StreamPhase::Uncertain);
    assert_eq!(row.delivery, Delivery::Unknown);
    let row = streams
        .finish(&f.lease, OP, &session(), |_| Ok(Outcome::Complete))
        .unwrap();
    assert_eq!(row.phase, StreamPhase::Closed);
    assert_eq!(row.delivery, Delivery::Complete);
    streams
        .finish(&f.lease, OP, &session(), |_| {
            panic!("settled receipts are immutable")
        })
        .unwrap();
}
#[test]
fn cancel_before_reserve_is_a_tombstone_and_old_generation_cannot_complete() {
    let f = Fixture::new();
    let streams = Streams { fence: &f.fence };
    streams.cancel(&f.lease, ID).unwrap();
    assert_eq!(
        streams.reserve(&f.lease, ID, 80).unwrap().phase,
        StreamPhase::Cancelled
    );
    assert!(
        !streams
            .prepare(&f.lease, ID, |_, _| panic!("cancelled before dispatch"))
            .unwrap()
            .fresh
    );
    streams.reserve(&f.lease, OP, 81).unwrap();
    streams.prepare(&f.lease, OP, |_, _| Ok(session())).unwrap();
    assert_eq!(
        streams.cancel(&f.lease, OP).unwrap().phase,
        StreamPhase::CancelRequested
    );
    assert!(!streams.connected(&f.lease, OP, &session()).unwrap());
    let mut stale = f.lease.clone();
    stale.generation += 1;
    assert!(
        streams
            .finish(&stale, OP, &session(), |_| Ok(Outcome::Complete))
            .is_err()
    );
}
#[test]
fn relay_parser_preserves_binary_frames_across_splits_and_rejects_early_use() {
    let mut stream = vec![
        b'R', 0, 0, 0, 0, b'D', 0, 0, 0, 3, 0, 255, 1, b'F', 0, 0, 0, 0,
    ];
    for split in 0..=stream.len() {
        let mut decoder = Decoder::new(true);
        let mut frames = decoder.feed(&stream[..split]).unwrap();
        frames.extend(decoder.feed(&stream[split..]).unwrap());
        decoder.finish().unwrap();
        assert_eq!(
            frames.into_iter().flat_map(|f| f.bytes).collect::<Vec<_>>(),
            stream
        );
    }
    assert!(Decoder::new(false).feed(&[b'R', 0, 0, 0, 0]).is_err());
    assert!(Decoder::new(true).feed(&[b'D', 0, 0, 0, 1, 1]).is_err());
    assert!(Decoder::new(false).feed(&[b'D', 0, 0, 64, 1]).is_err());
    stream.push(1);
    assert!(Decoder::new(true).feed(&stream).is_err());
    let mut decoder = Decoder::new(false);
    decoder.feed(&[b'D', 0, 0, 0, 2, 1]).unwrap();
    assert!(decoder.finish().is_err());
}
