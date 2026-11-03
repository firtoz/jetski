//! Bounded HTTP over the dedicated rootless Unix socket; no automatic replay.
use crate::command_spec::Specification;
use crate::host_config::validate_runtime_socket;
use crate::protocol::canonical_uuid;
use rustix::event::{PollFd, PollFlags, Timespec};
use rustix::net::{AddressFamily, SocketAddrUnix, SocketFlags, SocketType};
use serde_json::{Value, json};
use std::collections::BTreeMap;
use std::io::{self, BufRead, BufReader, Read, Write};
use std::net::Shutdown;
use std::os::unix::net::UnixStream;
use std::path::Path;
use std::sync::Arc;
use std::time::{Duration, Instant};

const VERSION: &str = "/v4.0.0/libpod";
const MAX_JSON: usize = 1024 * 1024;
const MAX_FRAME: usize = 1024 * 1024;
const MAX_HEADERS: usize = 32768;
const API_TIMEOUT: Duration = Duration::from_secs(30);
fn reject(message: &'static str) -> io::Error {
    io::Error::other(message)
}
pub fn valid_session(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}
fn checked_session(value: &str) -> io::Result<()> {
    if !valid_session(value) {
        return Err(reject("invalid_exec_session"));
    }
    Ok(())
}

/// Nonblocking connect keeps a saturated local service from blocking indefinitely.
pub fn connect_unix(path: &Path, timeout: Duration) -> io::Result<UnixStream> {
    let fd = rustix::net::socket_with(
        AddressFamily::UNIX,
        SocketType::STREAM,
        SocketFlags::CLOEXEC | SocketFlags::NONBLOCK,
        None,
    )?;
    let address = SocketAddrUnix::new(path)?;
    match rustix::net::connect(&fd, &address) {
        Ok(()) => {}
        Err(rustix::io::Errno::INPROGRESS) | Err(rustix::io::Errno::AGAIN) => {
            let mut poll = [PollFd::new(&fd, PollFlags::OUT)];
            let wait = Timespec::try_from(timeout).map_err(|_| reject("invalid_exec_deadline"))?;
            if rustix::event::poll(&mut poll, Some(&wait))? == 0 {
                return Err(reject("exec_connect_timeout"));
            }
            rustix::net::sockopt::socket_error(&fd)??;
        }
        Err(error) => return Err(error.into()),
    }
    let stream = UnixStream::from(fd);
    stream.set_nonblocking(false)?;
    stream.set_read_timeout(Some(timeout))?;
    stream.set_write_timeout(Some(timeout))?;
    Ok(stream)
}

type Connector = Arc<dyn Fn(Duration) -> io::Result<UnixStream> + Send + Sync>;
#[derive(Clone)]
pub struct ExecApi {
    connector: Connector,
}
impl ExecApi {
    pub fn new(uid: u32) -> io::Result<Self> {
        if uid < 1000 || uid == u32::MAX {
            return Err(reject("invalid_runtime_uid"));
        }
        Ok(Self {
            connector: Arc::new(move |timeout| {
                connect_unix(&validate_runtime_socket(uid)?, timeout)
            }),
        })
    }
    /// Trusted composition/testing boundary. Workload requests cannot select it.
    pub fn with_connector(connector: Connector) -> Self {
        Self { connector }
    }
    fn connection(
        &self,
        method: &str,
        path: &str,
        body: &[u8],
        upgrade: bool,
        timeout: Duration,
    ) -> io::Result<BufReader<DeadlineStream>> {
        if !["GET", "POST"].contains(&method)
            || !path.starts_with('/')
            || path.bytes().any(|b| b <= b' ' || b >= 127)
            || body.len() > MAX_JSON
        {
            return Err(reject("invalid_exec_request"));
        }
        let stream = (self.connector)(timeout)?;
        let mut stream = DeadlineStream {
            socket: stream,
            deadline: Some(Instant::now() + timeout),
        };
        let connection = if upgrade {
            "Connection: Upgrade\r\nUpgrade: tcp\r\n"
        } else {
            "Connection: close\r\n"
        };
        let header = format!(
            "{method} {VERSION}{path} HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/json\r\n{connection}Content-Length: {}\r\n\r\n",
            body.len()
        );
        stream.write_all(header.as_bytes())?;
        stream.write_all(body)?;
        Ok(BufReader::new(stream))
    }
    fn request(
        &self,
        method: &str,
        path: &str,
        body: Option<Value>,
        statuses: &[u16],
    ) -> io::Result<(u16, Value)> {
        let body = body
            .map(|body| serde_json::to_vec(&body))
            .transpose()
            .map_err(io::Error::other)?
            .unwrap_or_default();
        let mut stream = self.connection(method, path, &body, false, API_TIMEOUT)?;
        let header = headers(&mut stream)?;
        if !statuses.contains(&header.status) {
            return Err(reject("exec_api_response_invalid"));
        }
        let raw = read_body(&mut stream, &header)?;
        let value = if raw.is_empty() {
            Value::Null
        } else {
            serde_json::from_slice(&raw).map_err(|_| reject("exec_api_response_invalid"))?
        };
        Ok((header.status, value))
    }
    pub fn create(
        &self,
        container: &str,
        argv: Vec<String>,
        cwd: &str,
        tty: bool,
        stdin: bool,
    ) -> io::Result<String> {
        let id = container
            .strip_prefix("jetski-")
            .ok_or_else(|| reject("invalid_exec_container"))?;
        if !canonical_uuid(id) {
            return Err(reject("invalid_exec_container"));
        }
        Specification::new(argv.clone(), cwd.into(), 120, None)?;
        let (_,value)=self.request("POST",&format!("/containers/{container}/exec"),Some(json!({"Cmd":argv,"WorkingDir":cwd,"User":"1000:1000","Privileged":false,"AttachStdin":stdin,"AttachStdout":true,"AttachStderr":true,"Tty":tty})),&[201])?;
        let id = value
            .get("Id")
            .and_then(Value::as_str)
            .ok_or_else(|| reject("invalid_exec_session"))?;
        checked_session(id)?;
        Ok(id.into())
    }
    pub fn inspect(&self, session: &str) -> io::Result<Value> {
        checked_session(session)?;
        let (_, value) = self.request("GET", &format!("/exec/{session}/json"), None, &[200])?;
        if !value.get("Running").is_some_and(Value::is_boolean) {
            return Err(reject("invalid_exec_status"));
        }
        Ok(value)
    }
    pub fn remove(&self, session: &str) -> io::Result<()> {
        checked_session(session)?;
        self.request(
            "POST",
            &format!("/exec/{session}/remove"),
            Some(json!({"Force":true})),
            &[200, 204, 404],
        )?;
        let (status, _) =
            self.request("GET", &format!("/exec/{session}/json"), None, &[200, 404])?;
        if status != 404 {
            return Err(reject("exec_removal_unconfirmed"));
        }
        Ok(())
    }
    /// Caller persists start intent before invoking this once. EOF is not proof.
    pub fn attach(
        &self,
        session: &str,
        timeout: Duration,
        initial_input: &[u8],
    ) -> io::Result<Attach> {
        checked_session(session)?;
        if timeout.is_zero() || timeout > Duration::from_secs(3630) || initial_input.len() > 4096 {
            return Err(reject("invalid_exec_stream_deadline"));
        }
        let mut stream = self.connection(
            "POST",
            &format!("/exec/{session}/start"),
            br#"{"Detach":false,"Tty":false}"#,
            true,
            timeout.min(API_TIMEOUT),
        )?;
        let response = headers(&mut stream)?;
        if ![101, 200].contains(&response.status) {
            return Err(reject("exec_attach_failed"));
        }
        stream.get_mut().deadline = None;
        stream
            .get_ref()
            .socket
            .set_read_timeout(Some(Duration::from_millis(50)))?;
        let mut input = stream.get_ref().socket.try_clone()?;
        input.set_write_timeout(Some(Duration::from_secs(5)))?;
        input.write_all(initial_input)?;
        Ok(Attach {
            stream,
            input,
            header: [0; 8],
            header_bytes: 0,
            body: Vec::new(),
            body_bytes: 0,
            channel: 0,
            deadline: Instant::now() + timeout,
        })
    }
}
struct DeadlineStream {
    socket: UnixStream,
    deadline: Option<Instant>,
}
impl DeadlineStream {
    fn remaining(&self) -> io::Result<Option<Duration>> {
        self.deadline
            .map(|at| {
                at.checked_duration_since(Instant::now())
                    .filter(|d| !d.is_zero())
                    .ok_or_else(|| reject("exec_api_deadline"))
            })
            .transpose()
    }
}
impl Read for DeadlineStream {
    fn read(&mut self, bytes: &mut [u8]) -> io::Result<usize> {
        if let Some(left) = self.remaining()? {
            self.socket.set_read_timeout(Some(left))?;
        }
        self.socket.read(bytes)
    }
}
impl Write for DeadlineStream {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        if let Some(left) = self.remaining()? {
            self.socket.set_write_timeout(Some(left))?;
        }
        self.socket.write(bytes)
    }
    fn flush(&mut self) -> io::Result<()> {
        self.socket.flush()
    }
}
struct Headers {
    status: u16,
    fields: BTreeMap<String, String>,
}
fn line(reader: &mut impl BufRead, limit: usize) -> io::Result<Vec<u8>> {
    let mut line = Vec::new();
    loop {
        let available = reader.fill_buf()?;
        if available.is_empty() {
            return Err(reject("truncated_http_header"));
        }
        let end = available
            .iter()
            .position(|b| *b == b'\n')
            .map_or(available.len(), |p| p + 1);
        if line.len() + end > limit {
            return Err(reject("http_header_bound"));
        }
        line.extend_from_slice(&available[..end]);
        reader.consume(end);
        if line.last() == Some(&b'\n') {
            if !line.ends_with(b"\r\n") {
                return Err(reject("invalid_http_header"));
            }
            line.truncate(line.len() - 2);
            return Ok(line);
        }
    }
}
fn headers(reader: &mut impl BufRead) -> io::Result<Headers> {
    let first = line(reader, 8192)?;
    let first = std::str::from_utf8(&first).map_err(|_| reject("invalid_http_status"))?;
    let mut parts = first.splitn(3, ' ');
    if !matches!(parts.next(), Some("HTTP/1.1" | "HTTP/1.0")) {
        return Err(reject("invalid_http_status"));
    }
    let status = parts
        .next()
        .filter(|s| s.len() == 3 && s.bytes().all(|b| b.is_ascii_digit()))
        .and_then(|s| s.parse::<u16>().ok())
        .filter(|n| (100..=599).contains(n))
        .ok_or_else(|| reject("invalid_http_status"))?;
    let mut fields = BTreeMap::new();
    let mut bytes = first.len();
    for _ in 0..128 {
        let raw = line(reader, 8192)?;
        bytes += raw.len() + 2;
        if bytes > MAX_HEADERS {
            return Err(reject("http_header_bound"));
        }
        if raw.is_empty() {
            if fields.contains_key("content-length") && fields.contains_key("transfer-encoding") {
                return Err(reject("ambiguous_http_body"));
            }
            return Ok(Headers { status, fields });
        }
        let raw = std::str::from_utf8(&raw).map_err(|_| reject("invalid_http_header"))?;
        let (key, value) = raw
            .split_once(':')
            .ok_or_else(|| reject("invalid_http_header"))?;
        if key.is_empty()
            || !key
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"!#$%&'*+-.^_`|~".contains(&b))
        {
            return Err(reject("invalid_http_header"));
        }
        if fields
            .insert(key.to_ascii_lowercase(), value.trim().to_owned())
            .is_some()
        {
            return Err(reject("duplicate_http_header"));
        }
    }
    Err(reject("http_header_bound"))
}
fn read_body(reader: &mut impl BufRead, header: &Headers) -> io::Result<Vec<u8>> {
    if [204, 304].contains(&header.status) {
        return Ok(Vec::new());
    }
    let mut output = Vec::new();
    if let Some(encoding) = header.fields.get("transfer-encoding") {
        if !encoding.eq_ignore_ascii_case("chunked") {
            return Err(reject("unsupported_http_encoding"));
        }
        loop {
            let raw = line(reader, 1024)?;
            let number = raw.split(|b| *b == b';').next().unwrap_or(&[]);
            if number.is_empty() || !number.iter().all(u8::is_ascii_hexdigit) {
                return Err(reject("invalid_http_chunk"));
            }
            let count = usize::from_str_radix(
                std::str::from_utf8(number).map_err(|_| reject("invalid_http_chunk"))?,
                16,
            )
            .map_err(|_| reject("invalid_http_chunk"))?;
            if count == 0 {
                let mut bytes = 0;
                for _ in 0..128 {
                    let tail = line(reader, 8192)?;
                    bytes += tail.len() + 2;
                    if bytes > MAX_HEADERS {
                        return Err(reject("http_header_bound"));
                    }
                    if tail.is_empty() {
                        return Ok(output);
                    }
                }
                return Err(reject("http_header_bound"));
            }
            if count > MAX_JSON - output.len() {
                return Err(reject("exec_response_bound"));
            }
            let start = output.len();
            output.resize(start + count, 0);
            reader.read_exact(&mut output[start..])?;
            let mut end = [0; 2];
            reader.read_exact(&mut end)?;
            if end != *b"\r\n" {
                return Err(reject("invalid_http_chunk"));
            }
        }
    } else if let Some(length) = header.fields.get("content-length") {
        if length.is_empty() || !length.bytes().all(|b| b.is_ascii_digit()) {
            return Err(reject("invalid_http_length"));
        }
        let count = length
            .parse::<usize>()
            .map_err(|_| reject("exec_response_bound"))?;
        if count > MAX_JSON {
            return Err(reject("exec_response_bound"));
        }
        output.resize(count, 0);
        reader.read_exact(&mut output)?;
    } else {
        reader.take(MAX_JSON as u64 + 1).read_to_end(&mut output)?;
        if output.len() > MAX_JSON {
            return Err(reject("exec_response_bound"));
        }
    }
    Ok(output)
}
#[derive(Debug, PartialEq, Eq)]
pub enum Output {
    Data {
        channel: &'static str,
        bytes: Vec<u8>,
    },
    Pending,
    Eof,
}
pub struct Attach {
    stream: BufReader<DeadlineStream>,
    input: UnixStream,
    header: [u8; 8],
    header_bytes: usize,
    body: Vec<u8>,
    body_bytes: usize,
    channel: u8,
    deadline: Instant,
}
impl Attach {
    pub fn input(&self) -> io::Result<UnixStream> {
        self.input.try_clone()
    }
    pub fn abort(&self) -> io::Result<()> {
        self.input.shutdown(Shutdown::Both)
    }
    /// At most one bounded read per poll: partial headers cannot starve cancellation.
    pub fn poll(&mut self) -> io::Result<Output> {
        if Instant::now() >= self.deadline {
            return Err(reject("exec_stream_deadline"));
        }
        if self.header_bytes < 8 {
            let n = match self.stream.read(&mut self.header[self.header_bytes..]) {
                Ok(n) => n,
                Err(e)
                    if matches!(
                        e.kind(),
                        io::ErrorKind::WouldBlock
                            | io::ErrorKind::TimedOut
                            | io::ErrorKind::Interrupted
                    ) =>
                {
                    return Ok(Output::Pending);
                }
                Err(e) => return Err(e),
            };
            if n == 0 {
                if self.header_bytes == 0 {
                    return Ok(Output::Eof);
                }
                return Err(reject("truncated_exec_stream"));
            }
            self.header_bytes += n;
            if self.header_bytes < 8 {
                return Ok(Output::Pending);
            }
            self.channel = self.header[0];
            let size = u32::from_be_bytes(self.header[4..8].try_into().unwrap()) as usize;
            if ![1, 2].contains(&self.channel) || self.header[1..4] != [0; 3] || size > MAX_FRAME {
                return Err(reject("invalid_exec_stream_frame"));
            }
            self.body = vec![0; size];
            self.body_bytes = 0;
            if size > 0 {
                return Ok(Output::Pending);
            }
        } else if self.body_bytes < self.body.len() {
            let end = (self.body_bytes + 65536).min(self.body.len());
            let n = match self.stream.read(&mut self.body[self.body_bytes..end]) {
                Ok(n) => n,
                Err(e)
                    if matches!(
                        e.kind(),
                        io::ErrorKind::WouldBlock
                            | io::ErrorKind::TimedOut
                            | io::ErrorKind::Interrupted
                    ) =>
                {
                    return Ok(Output::Pending);
                }
                Err(e) => return Err(e),
            };
            if n == 0 {
                return Err(reject("truncated_exec_stream"));
            }
            self.body_bytes += n;
            if self.body_bytes < self.body.len() {
                return Ok(Output::Pending);
            }
        }
        self.header_bytes = 0;
        Ok(Output::Data {
            channel: if self.channel == 1 {
                "stdout"
            } else {
                "stderr"
            },
            bytes: std::mem::take(&mut self.body),
        })
    }
}
#[derive(Debug, PartialEq, Eq)]
pub struct Completion {
    pub cancelled: bool,
    pub exit_code: u8,
    pub descendants_reaped: bool,
}
pub struct CompletionDecoder {
    prefix: Vec<u8>,
    extent: usize,
    tail: Vec<u8>,
    done: bool,
}
impl CompletionDecoder {
    pub fn new(nonce: &[u8; 32]) -> Self {
        let hex: String = nonce.iter().map(|b| format!("{b:02x}")).collect();
        let prefix = format!("\0jetski-complete-v1:{hex}:").into_bytes();
        let extent = prefix.len() + 6;
        Self {
            prefix,
            extent,
            tail: Vec::new(),
            done: false,
        }
    }
    pub fn feed(&mut self, data: &[u8]) -> io::Result<Vec<u8>> {
        if self.done {
            return Err(reject("invalid_completion_stream"));
        }
        let mut full = std::mem::take(&mut self.tail);
        full.extend_from_slice(data);
        let boundary = if let Some(position) = full
            .windows(self.prefix.len())
            .position(|part| part == self.prefix)
        {
            if full.len() - position > self.extent {
                self.done = true;
                return Err(reject("unexpected_completion_trailer"));
            }
            position
        } else {
            full.len().saturating_sub(self.extent)
        };
        self.tail = full.split_off(boundary);
        Ok(full)
    }
    pub fn finish(&mut self) -> io::Result<Completion> {
        if self.done {
            return Err(reject("completion_already_consumed"));
        }
        self.done = true;
        if self.tail.len() != self.extent || !self.tail.starts_with(&self.prefix) {
            return Err(reject("supervisor_completion_unconfirmed"));
        }
        let suffix = &self.tail[self.prefix.len()..];
        if !b"01".contains(&suffix[0])
            || suffix[1] != b':'
            || !suffix[2..5].iter().all(u8::is_ascii_digit)
            || suffix[5] != 0
        {
            return Err(reject("invalid_supervisor_completion"));
        }
        let code: u16 = std::str::from_utf8(&suffix[2..5])
            .unwrap()
            .parse()
            .map_err(|_| reject("invalid_supervisor_exit"))?;
        if code > 255 || (suffix[0] == b'1' && code != 143) {
            return Err(reject("invalid_supervisor_exit"));
        }
        let cancelled = suffix[0] == b'1';
        self.tail.clear();
        Ok(Completion {
            cancelled,
            exit_code: code as u8,
            descendants_reaped: true,
        })
    }
}
