//! Authenticated forced-command stdin/stdout. Does not listen on a public socket.
use crate::{
    checkpoint_cache::reject,
    checkpoint_transfer::Transfer,
    control::{Control, Paths},
    exec_api::ExecApi,
    fence::Fence,
    host_config::{self, HostConfig, RootlessRunner, RuntimeAccount, WorkloadIdentity},
    process::BoundedCommand,
    protocol::{self, Request},
    stream_broker::{self, Nonblocking, ready, write_bounded},
    stream_protocol::MAGIC,
};
use rustix::event::PollFlags;
use std::{
    fs::File,
    io::{self, Read},
    os::fd::AsFd,
    path::Path,
    process::{Command, Stdio},
    time::{Duration, Instant},
};

pub enum Header {
    Control(Request),
    Stream(Request),
}
fn exact(source: &impl AsFd, count: usize, deadline: Instant) -> io::Result<Vec<u8>> {
    let mut data = vec![0; count];
    let mut at = 0;
    while at < count {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() || !ready(source, PollFlags::IN, remaining)? {
            return Err(reject("host_header_deadline"));
        }
        match rustix::io::read(source, &mut data[at..]) {
            Ok(0) => return Err(reject("truncated_host_request")),
            Ok(n) => at += n,
            Err(rustix::io::Errno::AGAIN | rustix::io::Errno::INTR) => {}
            Err(e) => return Err(e.into()),
        }
    }
    Ok(data)
}
/// Input is exclusively owned by the control connection; deadline and size bounded.
pub fn header(source: &impl AsFd) -> io::Result<Header> {
    let _flags = Nonblocking::new(source)?;
    let deadline = Instant::now() + Duration::from_secs(10);
    let first = exact(source, 1, deadline)?;
    if first[0] == b'J' {
        if exact(source, MAGIC.len() - 1, deadline)? != MAGIC[1..] {
            return Err(reject("invalid_stream_protocol"));
        }
        let length = u32::from_be_bytes(exact(source, 4, deadline)?.try_into().unwrap()) as usize;
        if !(1..=16384).contains(&length) {
            return Err(reject("stream_header_bound"));
        }
        return Ok(Header::Stream(Request::decode(&exact(
            source, length, deadline,
        )?)?));
    }
    let mut raw = first;
    let mut buffer = [0; 65536];
    let deadline = Instant::now() + Duration::from_secs(120);
    loop {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() || !ready(source, PollFlags::IN, remaining)? {
            return Err(reject("host_request_deadline"));
        }
        let count = match rustix::io::read(source, &mut buffer) {
            Ok(n) => n,
            Err(rustix::io::Errno::AGAIN | rustix::io::Errno::INTR) => continue,
            Err(e) => return Err(e.into()),
        };
        if count == 0 {
            break;
        }
        raw.extend_from_slice(&buffer[..count]);
        if raw.len() > protocol::IMPORT_REQUEST_BYTES {
            return Err(reject("host_request_limit"));
        }
    }
    Ok(Header::Control(Request::decode(&raw)?))
}
pub(crate) fn transfer_account(name: &str) -> io::Result<(u32, u32)> {
    let mut raw = String::new();
    File::open("/etc/passwd")?
        .take(4 * 1024 * 1024 + 1)
        .read_to_string(&mut raw)?;
    if raw.len() > 4 * 1024 * 1024 {
        return Err(reject("account_database_limit"));
    }
    let rows: Vec<_> = raw
        .lines()
        .map(|line| line.split(':').collect::<Vec<_>>())
        .filter(|row| row.first() == Some(&name))
        .collect();
    if rows.len() != 1 || rows[0].len() != 7 {
        return Err(reject("invalid_transfer_account"));
    }
    let uid = rows[0][2]
        .parse()
        .map_err(|_| reject("invalid_transfer_account"))?;
    let gid = rows[0][3]
        .parse()
        .map_err(|_| reject("invalid_transfer_account"))?;
    let transfer = Transfer {
        root: Path::new("/tmp/jetski-checkpoint-imports"),
        uid,
        gid,
    };
    transfer.validate()?;
    Ok((uid, gid))
}
pub fn entry(expected_sha256: &str) -> io::Result<()> {
    let input = File::from(rustix::io::fcntl_dupfd_cloexec(io::stdin(), 3)?);
    let output = File::from(rustix::io::fcntl_dupfd_cloexec(io::stdout(), 3)?);
    let request = header(&input)?;
    dispatch_header(expected_sha256, request, input, output)
}
pub(crate) fn dispatch_header(
    expected_sha256: &str,
    request: Header,
    input: File,
    output: File,
) -> io::Result<()> {
    let config = HostConfig::load()?;
    crate::installation::verify(&config, Some(expected_sha256))?;
    let account = RuntimeAccount::lookup()?;
    let ownership = WorkloadIdentity::load(&account)?;
    let control = Path::new(host_config::CONTROL_ROOT);
    let slot = control.join("slot");
    let fence = Fence::open(&slot)?;
    if let Header::Stream(request) = request {
        return stream_broker::serve(
            &request,
            &config,
            &fence,
            &ExecApi::new(account.uid)?,
            &input,
            &output,
        );
    }
    let Header::Control(request) = request else {
        unreachable!()
    };
    let executable = std::env::current_exe()?;
    let run = RootlessRunner {
        account: account.clone(),
        command: BoundedCommand {
            executable: executable.clone(),
            scratch: control.into(),
        },
    };
    let launch = |id: &str, lease: &crate::protocol::Lease| -> io::Result<()> {
        lease.validate()?;
        Command::new(&executable)
            .arg("__worker")
            .arg(id)
            .arg(serde_json::to_string(lease).map_err(io::Error::other)?)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .current_dir("/")
            .env_clear()
            .env("PATH", "/usr/bin:/bin")
            .env("LANG", "C.UTF-8")
            .spawn()?;
        Ok(())
    };
    let commands = control.join("commands");
    let terminal = control.join("terminal-input");
    let transfer = config
        .archive_transfer_user
        .as_deref()
        .map(transfer_account)
        .transpose()?;
    let importer = transfer.map(|(uid, gid)| Transfer {
        root: Path::new("/tmp/jetski-checkpoint-imports"),
        uid,
        gid,
    });
    let exporter = transfer.map(|(uid, gid)| Transfer {
        root: Path::new("/tmp/jetski-checkpoint-exports"),
        uid,
        gid,
    });
    let handler = Control {
        fence: &fence,
        config: &config,
        account: &account,
        ownership: &ownership,
        run: &run,
        paths: Paths {
            slot: &slot,
            commands: &commands,
            terminal: &terminal,
            data: Path::new(host_config::DATA_ROOT),
            archives: Path::new(host_config::ARCHIVE_ROOT),
            supervisor: Path::new("/opt/jetski/command-supervisor"),
            relay: Path::new("/opt/jetski/tcp-relay"),
        },
        transfer: importer,
        export: exporter,
        launch: &launch,
    };
    let mut result = handler.dispatch(&request)?;
    if request.action == "status" {
        result["hostBackend"] = serde_json::json!({"kind":"rust","sha256":expected_sha256});
    }
    let encoded = request.response(result)?;
    let _flags = Nonblocking::new(&output)?;
    write_bounded(&output, &encoded)
}
