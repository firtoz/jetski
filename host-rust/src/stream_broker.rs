//! Native authenticated TCP relay composition. Dispatch is never replayed.
use crate::{
    checkpoint_cache::reject,
    exec_api::{ExecApi, Output},
    fence::{Fence, Phase},
    host_config::HostConfig,
    protocol::{Lease, Request},
    stream_protocol::Decoder,
    streams::{Outcome, StreamPhase, Streams},
};
use rustix::{
    event::{PollFd, PollFlags, Timespec},
    fs::{OFlags, fcntl_getfl, fcntl_setfl},
};
use serde::Deserialize;
use std::{
    io::{self, Write},
    net::Shutdown,
    os::fd::AsFd,
    sync::atomic::{AtomicBool, Ordering},
    thread,
    time::{Duration, Instant},
};
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Payload {
    lease: Lease,
    image: String,
    stream_id: String,
    port: u16,
}
pub(crate) struct Nonblocking<'a, F: AsFd> {
    fd: &'a F,
    flags: OFlags,
}
impl<'a, F: AsFd> Nonblocking<'a, F> {
    pub(crate) fn new(fd: &'a F) -> io::Result<Self> {
        let flags = fcntl_getfl(fd)?;
        fcntl_setfl(fd, flags | OFlags::NONBLOCK)?;
        Ok(Self { fd, flags })
    }
}
impl<F: AsFd> Drop for Nonblocking<'_, F> {
    fn drop(&mut self) {
        let _ = fcntl_setfl(self.fd, self.flags);
    }
}
pub(crate) fn ready(fd: &impl AsFd, flags: PollFlags, timeout: Duration) -> io::Result<bool> {
    let mut poll = [PollFd::new(fd, flags)];
    let timeout = Timespec::try_from(timeout).map_err(|_| reject("invalid_stream_deadline"))?;
    loop {
        match rustix::event::poll(&mut poll, Some(&timeout)) {
            Ok(n) => return Ok(n > 0),
            Err(rustix::io::Errno::INTR) => continue,
            Err(e) => return Err(e.into()),
        }
    }
}
pub(crate) fn write_bounded(fd: &impl AsFd, data: &[u8]) -> io::Result<()> {
    let deadline = Instant::now() + Duration::from_secs(5);
    let mut offset = 0;
    while offset < data.len() {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() || !ready(fd, PollFlags::OUT, remaining)? {
            return Err(reject("stream_output_backpressure"));
        }
        match rustix::io::write(fd, &data[offset..]) {
            Ok(0) => return Err(reject("stream_output_closed")),
            Ok(n) => offset += n,
            Err(rustix::io::Errno::AGAIN | rustix::io::Errno::INTR) => continue,
            Err(e) => return Err(e.into()),
        }
    }
    Ok(())
}
pub fn serve<S: AsFd + Sync, D: AsFd>(
    request: &Request,
    config: &HostConfig,
    fence: &Fence,
    api: &ExecApi,
    source: &S,
    destination: &D,
) -> io::Result<()> {
    if request.version != 1 || request.action != "stream-open" {
        return Err(reject("invalid_stream_request"));
    }
    let payload: Payload = serde_json::from_value(request.payload.clone())
        .map_err(|_| reject("invalid_stream_payload"))?;
    payload.lease.validate()?;
    if request.id != payload.stream_id
        || payload.lease.machine_id != config.machine_id
        || payload.lease.pool_id != config.pool_id
        || !config.images.contains(&payload.image)
    {
        return Err(reject("stream_scope_conflict"));
    }
    {
        let guard = fence.locked()?;
        let state = guard.read()?.ok_or_else(|| reject("stale_lease"))?;
        state.matches(&payload.lease)?;
        let runtime = state
            .sections
            .get("runtime")
            .ok_or_else(|| reject("stream_image_conflict"))?;
        if runtime.get("image").and_then(|v| v.as_str()) != Some(payload.image.as_str())
            || runtime
                .pointer("/configuration/relay")
                .and_then(|v| v.as_bool())
                != Some(true)
        {
            return Err(reject("stream_image_conflict"));
        }
    }
    // Validate local descriptors before recording any remote effect.
    let _input_flags = Nonblocking::new(source)?;
    let _output_flags = Nonblocking::new(destination)?;
    let streams = Streams { fence };
    let lease = &payload.lease;
    let id = payload.stream_id.as_str();
    streams.reserve(lease, id, payload.port)?;
    let admitted = streams.prepare(lease, id, |container, port| {
        api.create(
            container,
            vec![
                "/jetski-tcp-relay".into(),
                "--jetski-tcp-v1".into(),
                port.to_string(),
            ],
            "/workspace",
            false,
            true,
        )
    })?;
    if !admitted.fresh {
        return Err(reject("stream_already_dispatched_observe_receipt"));
    }
    let session = admitted
        .receipt
        .session
        .ok_or_else(|| reject("invalid_stream_journal"))?;
    let mut complete = false;
    let result = (|| {
        {
            let guard = fence.locked()?;
            let state = guard.read()?.ok_or_else(|| reject("stale_lease"))?;
            state.matches(lease)?;
            if state.phase != Phase::Open
                || streams_phase(&state, id) != Some(StreamPhase::Dispatched)
            {
                drop(guard);
                api.remove(&session)?;
                streams.finish(lease, id, &session, |_| Ok(Outcome::Cancelled))?;
                return Err(reject("stream_admission_cancelled"));
            }
        }
        // prepare persisted dispatch intent. This call is made once for this ID.
        let mut attach = api.attach(&session, Duration::from_secs(3630), &[])?;
        let mut input = attach.input()?;
        let abort = input.try_clone()?;
        let halt = AtomicBool::new(false);
        let cancel = AtomicBool::new(false);
        let input_fin = AtomicBool::new(false);
        let started = Instant::now();
        let mut decoder = Decoder::new(true);
        thread::scope(|scope| -> io::Result<()> {
            let reader = scope.spawn(|| -> io::Result<()> {
                let result = (|| {
                    let mut decoder = Decoder::new(false);
                    let mut data = [0u8; 16384];
                    while !halt.load(Ordering::Acquire) {
                        if !ready(source, PollFlags::IN, Duration::from_millis(100))? {
                            continue;
                        }
                        let count = match rustix::io::read(source, &mut data) {
                            Ok(n) => n,
                            Err(rustix::io::Errno::AGAIN | rustix::io::Errno::INTR) => continue,
                            Err(e) => return Err(e.into()),
                        };
                        if count == 0 {
                            decoder.finish()?;
                            return Ok(());
                        }
                        for frame in decoder.feed(&data[..count])? {
                            input.write_all(&frame.bytes)?;
                            if frame.tag == b'F' {
                                input_fin.store(true, Ordering::Release);
                            }
                        }
                    }
                    Ok(())
                })();
                if result.is_err() {
                    cancel.store(true, Ordering::Release);
                }
                result
            });
            let monitor = scope.spawn(|| {
                while !halt.load(Ordering::Acquire) {
                    let phase = streams.status(lease, id).map(|r| r.phase);
                    if phase.is_err()
                        || phase.is_ok_and(|p| {
                            matches!(
                                p,
                                StreamPhase::CancelRequested
                                    | StreamPhase::Cancelled
                                    | StreamPhase::Uncertain
                            )
                        })
                        || started.elapsed() > Duration::from_secs(3600)
                    {
                        cancel.store(true, Ordering::Release);
                    }
                    if cancel.load(Ordering::Acquire) {
                        let _ = streams.cancel(lease, id);
                        let _ = abort.shutdown(Shutdown::Both);
                        let _ = api.remove(&session);
                        return;
                    }
                    thread::park_timeout(Duration::from_millis(100));
                }
            });
            let observed = (|| {
                loop {
                    if cancel.load(Ordering::Acquire) {
                        return Err(reject("stream_interrupted"));
                    }
                    match attach.poll()? {
                        Output::Pending => {}
                        Output::Eof => break,
                        Output::Data { channel, bytes } => {
                            if channel == "stderr" && !bytes.is_empty() {
                                return Err(reject("stream_interrupted"));
                            }
                            if channel != "stdout" {
                                continue;
                            }
                            for frame in decoder.feed(&bytes)? {
                                if frame.tag == b'R' && !streams.connected(lease, id, &session)? {
                                    return Err(reject("stream_admission_cancelled"));
                                }
                                write_bounded(destination, &frame.bytes)?;
                            }
                        }
                    }
                }
                decoder.finish()?;
                if !input_fin.load(Ordering::Acquire) || cancel.load(Ordering::Acquire) {
                    return Err(reject("stream_delivery_uncertain"));
                }
                for _ in 0..20 {
                    let status = api.inspect(&session)?;
                    if status.get("Running").and_then(|v| v.as_bool()) == Some(false) {
                        if status.get("ExitCode").and_then(|v| v.as_i64()) == Some(0) {
                            return Ok(());
                        }
                        break;
                    }
                    thread::sleep(Duration::from_millis(50));
                }
                Err(reject("stream_completion_unconfirmed"))
            })();
            if observed.is_err() {
                cancel.store(true, Ordering::Release);
                monitor.thread().unpark();
            } else {
                halt.store(true, Ordering::Release);
                monitor.thread().unpark();
            }
            // Bounded socket/HTTP writes and polls let all scoped helpers terminate.
            let monitor_result = monitor.join();
            halt.store(true, Ordering::Release);
            let reader_result = reader.join();
            observed?;
            monitor_result.map_err(|_| reject("stream_monitor_uncertain"))?;
            reader_result.map_err(|_| reject("stream_input_uncertain"))??;
            Ok(())
        })?;
        complete = true;
        Ok(())
    })();
    if !complete {
        let _ = api.remove(&session);
    }
    streams.finish(lease, id, &session, |_| {
        Ok(if complete {
            Outcome::Complete
        } else {
            Outcome::Unknown
        })
    })?;
    result
}
fn streams_phase(state: &crate::fence::State, id: &str) -> Option<StreamPhase> {
    serde_json::from_value::<crate::streams::Receipt>(
        state.sections.get("streams")?.get(id)?.clone(),
    )
    .ok()
    .map(|r| r.phase)
}
