//! Native command worker: one admitted identity, private output, authenticated completion.
use crate::command_spec::Specification;
use crate::commands::{self, CommandPhase, OUTPUT_BYTES};
use crate::exec_api::{Completion, CompletionDecoder, ExecApi, Output};
use crate::fence::{Fence, Phase};
use crate::host_config::{HostConfig, NamespaceMapping};
use crate::process::HostRunner;
use crate::protocol::{Lease, canonical_uuid};
use crate::runtime::{PodmanRuntime, RuntimeOptions};
use crate::terminal_input::{TerminalInputs, ensure_private_directory};
use serde_json::{Value, json};
use std::fs::{self, DirBuilder, File};
use std::io::{self, Read, Write};
use std::net::Shutdown;
use std::os::unix::fs::{DirBuilderExt, OpenOptionsExt};
use std::os::unix::net::UnixStream;
use std::path::Path;
use std::sync::{
    Mutex,
    atomic::{AtomicBool, Ordering},
};
use std::thread;
use std::time::{Duration, Instant};
fn reject(message: &'static str) -> io::Error {
    io::Error::other(message)
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum StopReason {
    Cancelled,
    Timeout,
    OutputLimit,
    InputUncertain,
}
impl StopReason {
    fn as_str(self) -> &'static str {
        match self {
            Self::Cancelled => "cancelled",
            Self::Timeout => "timeout",
            Self::OutputLimit => "output_limit",
            Self::InputUncertain => "terminal_input_uncertain",
        }
    }
}
struct Monitor<'a> {
    command: &'a str,
    lease: &'a Lease,
    spec: &'a Specification,
    session: &'a str,
    input: UnixStream,
    done: &'a AtomicBool,
    stop: &'a Mutex<Option<StopReason>>,
    deadline: Instant,
}

struct Outcome {
    phase: CommandPhase,
    exit_code: Option<i32>,
    reason: Option<&'static str>,
}
pub struct Worker<'a, R: HostRunner + Sync> {
    pub fence: &'a Fence,
    pub worker_root: &'a Path,
    pub output_root: &'a Path,
    pub terminal_root: &'a Path,
    pub data_root: &'a Path,
    pub config: &'a HostConfig,
    pub mapping: NamespaceMapping,
    pub run: &'a R,
    pub api: &'a ExecApi,
}
impl<R: HostRunner + Sync> Worker<'_, R> {
    pub fn run(&self, command: &str, lease: &Lease) -> io::Result<()> {
        lease.validate()?;
        if !canonical_uuid(command) {
            return Err(reject("invalid_command_id"));
        }
        if lease.machine_id != self.config.machine_id || lease.pool_id != self.config.pool_id {
            return Err(reject("physical_identity_conflict"));
        }
        self.config.validate()?;
        let Some(_worker_guard) = commands::worker_guard(self.worker_root, lease, command, true)?
        else {
            return Ok(());
        };
        let (spec, image) = {
            let guard = self.fence.locked()?;
            let mut state = guard.read()?.ok_or_else(|| reject("stale_lease"))?;
            state.matches(lease)?;
            if state
                .sections
                .get("commands")
                .and_then(|v| v.get(command))
                .is_none()
            {
                return Ok(());
            }
            let mut row = commands::receipt(&state, command)?;
            if row.phase != CommandPhase::Queued {
                return Ok(());
            }
            if state.phase != Phase::Open || row.cancel_requested {
                row.phase = CommandPhase::Cancelled;
                row.details.insert("neverStarted".into(), json!(true));
                commands::save(&guard, &mut state, row)?;
                return Ok(());
            }
            let image = state
                .sections
                .get("runtime")
                .and_then(|v| v.get("image"))
                .and_then(Value::as_str)
                .ok_or_else(|| reject("invalid_runtime_receipt"))?
                .to_owned();
            row.phase = CommandPhase::Running;
            let spec = row.spec.clone();
            commands::save(&guard, &mut state, row)?;
            (spec, image)
        };
        let mut stage = "prepare";
        let attempted = self.execute(command, lease, &spec, &mut stage);
        let failure = attempted.as_ref().err().map(|e| format!("{:?}", e.kind()));
        let outcome = match attempted {
            Ok(outcome) => outcome,
            Err(_) => {
                // EOF/removal is not a descendant-reaping proof. Stop the whole
                // assigned runtime when possible, but retain uncertain execution.
                if let Ok(runtime) = PodmanRuntime::new(
                    self.fence,
                    self.run,
                    RuntimeOptions {
                        image: &image,
                        approved_images: &self.config.images,
                        data: self.data_root,
                        supervisor: None,
                        relay: None,
                        network: self.config.network_mode,
                        mapping: self.mapping.clone(),
                    },
                ) {
                    let _ = runtime.quiesce(lease);
                }
                Outcome {
                    phase: CommandPhase::Uncertain,
                    exit_code: None,
                    reason: Some("worker_failure"),
                }
            }
        };
        let guard = self.fence.locked()?;
        let mut state = guard.read()?.ok_or_else(|| reject("stale_lease"))?;
        state.matches(lease)?;
        let mut row = commands::receipt(&state, command)?;
        row.phase = outcome.phase;
        row.exit_code = outcome.exit_code;
        row.details.insert("reason".into(), json!(outcome.reason));
        row.details.insert(
            "failureStage".into(),
            if failure.is_some() {
                json!(stage)
            } else {
                Value::Null
            },
        );
        row.details.insert("failureType".into(), json!(failure));
        if row.phase == CommandPhase::Uncertain {
            state.phase = Phase::Quarantined;
        }
        commands::save(&guard, &mut state, row)?;
        Ok(())
    }
    fn execute(
        &self,
        command: &str,
        lease: &Lease,
        spec: &Specification,
        stage: &mut &'static str,
    ) -> io::Result<Outcome> {
        ensure_private_directory(self.output_root)?;
        let assignment = self.output_root.join(&lease.assignment_id);
        ensure_private_directory(&assignment)?;
        let root = assignment.join(command);
        DirBuilder::new().mode(0o700).create(&root)?;
        File::open(&assignment)?.sync_all()?;
        let mut nonce = [0; 32];
        File::open("/dev/urandom")?.read_exact(&mut nonce)?;
        let mut decoder = CompletionDecoder::new(&nonce);
        let mut argv = vec![
            "/jetski-supervisor".into(),
            if spec.terminal {
                "--jetski-pty-v1".into()
            } else {
                "--jetski-exec-v1".into()
            },
        ];
        if spec.terminal {
            argv.extend([
                spec.rows.unwrap().to_string(),
                spec.columns.unwrap().to_string(),
            ]);
        }
        argv.extend(spec.argv.clone());
        *stage = "exec-create";
        let session = self.api.create(
            &format!("jetski-{}", lease.assignment_id),
            argv,
            &spec.cwd,
            false,
            true,
        )?;
        *stage = "start-intent";
        {
            let guard = self.fence.locked()?;
            let mut state = guard.read()?.ok_or_else(|| reject("stale_lease"))?;
            state.matches(lease)?;
            let mut row = commands::receipt(&state, command)?;
            if row.cancel_requested || state.phase != Phase::Open {
                self.api.remove(&session)?;
                return Ok(Outcome {
                    phase: CommandPhase::Cancelled,
                    exit_code: None,
                    reason: Some("never_started"),
                });
            }
            row.details.insert("execSession".into(), json!(session));
            row.details.insert("startDispatched".into(), json!(true));
            commands::save(&guard, &mut state, row)?;
        }
        let deadline = Instant::now() + Duration::from_secs(spec.timeout as u64);
        let mut stdout = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(root.join("stdout"))?;
        let mut stderr = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(root.join("stderr"))?;
        *stage = "attach-stream";
        let mut attach = self.api.attach(
            &session,
            Duration::from_secs(spec.timeout as u64 + 30),
            &nonce,
        )?;
        let input = attach.input()?;
        let done = AtomicBool::new(false);
        let stop = Mutex::new(None);
        let proof = thread::scope(|scope| {
            let monitor = scope.spawn(|| {
                let result = self.monitor(Monitor {
                    command,
                    lease,
                    spec,
                    session: &session,
                    input,
                    done: &done,
                    stop: &stop,
                    deadline,
                });
                if result.is_err() {
                    let _ = set_reason(&stop, StopReason::InputUncertain);
                    let _ = self.api.remove(&session);
                }
                result
            });
            let observed = (|| {
                let mut stdout_bytes = 0_u64;
                let mut stderr_bytes = 0_u64;
                loop {
                    match attach.poll()? {
                        Output::Pending => {}
                        Output::Eof => break,
                        Output::Data { channel, bytes } => {
                            let decoded = if channel == "stderr" {
                                decoder.feed(&bytes)?
                            } else {
                                bytes
                            };
                            let (file, size) = if channel == "stdout" {
                                (&mut stdout, &mut stdout_bytes)
                            } else {
                                (&mut stderr, &mut stderr_bytes)
                            };
                            let allowed = (OUTPUT_BYTES - *size).min(decoded.len() as u64) as usize;
                            file.write_all(&decoded[..allowed])?;
                            *size += allowed as u64;
                            if allowed < decoded.len() {
                                set_reason(&stop, StopReason::OutputLimit)?;
                            }
                        }
                    }
                }
                *stage = "completion-proof";
                let proof = decoder.finish()?;
                *stage = "output-sync";
                stdout.sync_all()?;
                stderr.sync_all()?;
                File::open(&root)?.sync_all()?;
                Ok::<_, io::Error>(proof)
            })();
            done.store(true, Ordering::Release);
            monitor.thread().unpark();
            if observed.is_err() {
                let _ = attach.abort();
            }
            let monitor_result = monitor
                .join()
                .map_err(|_| reject("command_monitor_panicked"))?;
            if observed.is_err() {
                monitor_result?;
            }
            observed
        })?;
        outcome(
            proof,
            *stop
                .lock()
                .map_err(|_| reject("command_monitor_uncertain"))?,
        )
    }
    fn monitor(&self, monitor: Monitor<'_>) -> io::Result<()> {
        let Monitor {
            command,
            lease,
            spec,
            session,
            mut input,
            done,
            stop,
            deadline,
        } = monitor;
        while !done.load(Ordering::Acquire) {
            thread::park_timeout(Duration::from_millis(50));
            if done.load(Ordering::Acquire) {
                return Ok(());
            }
            let requested = {
                let guard = self.fence.locked()?;
                let state = guard.read()?.ok_or_else(|| reject("stale_lease"))?;
                state.matches(lease)?;
                commands::receipt(&state, command)?.cancel_requested
            };
            if requested
                || Instant::now() >= deadline
                || stop
                    .lock()
                    .map_err(|_| reject("command_monitor_uncertain"))?
                    .is_some()
            {
                set_reason(
                    stop,
                    if requested {
                        StopReason::Cancelled
                    } else {
                        StopReason::Timeout
                    },
                )?;
                match input.shutdown(Shutdown::Write) {
                    Ok(()) => {}
                    Err(e) if e.kind() == io::ErrorKind::NotConnected => {}
                    Err(e) => return Err(e),
                }
                self.api.remove(session)?;
                return Ok(());
            }
            if spec.terminal {
                TerminalInputs::new(self.fence, self.terminal_root).dispatch_one(
                    lease,
                    command,
                    |frame| {
                        if frame.first() == Some(&b'C') {
                            set_reason(stop, StopReason::Cancelled)?;
                        }
                        input.write_all(frame)
                    },
                )?;
            }
        }
        Ok(())
    }
}
fn set_reason(reason: &Mutex<Option<StopReason>>, value: StopReason) -> io::Result<()> {
    reason
        .lock()
        .map_err(|_| reject("command_monitor_uncertain"))?
        .get_or_insert(value);
    Ok(())
}
fn outcome(proof: Completion, mut reason: Option<StopReason>) -> io::Result<Outcome> {
    if !proof.cancelled && reason == Some(StopReason::Cancelled) {
        reason = None;
    }
    let phase = if proof.cancelled && reason == Some(StopReason::Cancelled) {
        CommandPhase::Cancelled
    } else if proof.exit_code == 0 && reason.is_none() {
        CommandPhase::Succeeded
    } else {
        CommandPhase::Failed
    };
    Ok(Outcome {
        phase,
        exit_code: Some(proof.exit_code as i32),
        reason: reason.map(StopReason::as_str),
    })
}

/// Private worker mode. Bootstrap/forced-command policy never exposes this as a
/// workload-selected outer-host shell. Normal control dispatch admits identities.
pub fn entry(command: &str, lease: &Lease) -> io::Result<()> {
    use crate::host_config::{self, RootlessRunner, RuntimeAccount, WorkloadIdentity};
    use crate::process::BoundedCommand;
    use std::path::PathBuf;
    if rustix::process::getsid(None)? != rustix::process::getpid() {
        rustix::process::setsid()?;
    }
    let config = HostConfig::load()?;
    crate::installation::verify(&config, None)?;
    let account = RuntimeAccount::lookup()?;
    let ownership = WorkloadIdentity::load(&account)?;
    let control = PathBuf::from(host_config::CONTROL_ROOT);
    let slot = control.join("slot");
    let fence = Fence::open(&slot)?;
    let api = ExecApi::new(account.uid)?;
    let runner = RootlessRunner {
        account,
        command: BoundedCommand {
            executable: std::env::current_exe()?,
            scratch: control.clone(),
        },
    };
    let output = control.join("commands");
    let terminal = control.join("terminal-input");
    Worker {
        fence: &fence,
        worker_root: &slot,
        output_root: &output,
        terminal_root: &terminal,
        data_root: Path::new(host_config::DATA_ROOT),
        config: &config,
        mapping: ownership.mapping(),
        run: &runner,
        api: &api,
    }
    .run(command, lease)
}
