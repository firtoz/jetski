//! Supervisor-owned commands with an independent GNU timeout process group.
use rustix::process::{Pid, Signal};
use serde::{Deserialize, Serialize};
use std::ffi::OsString;
use std::fs::File;
use std::io::{self, Read, Seek, SeekFrom};
use std::os::unix::process::{CommandExt, ExitStatusExt};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::thread;
use std::time::{Duration, Instant};

pub const MAX_OUTPUT: usize = 2 * 1024 * 1024;
fn reject(message: &'static str) -> io::Error {
    io::Error::other(message)
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommandResult {
    pub exit_code: i32,
    pub stdout: String,
    pub stderr: String,
}
pub trait HostRunner {
    fn run(&self, args: &[String]) -> io::Result<CommandResult>;
}
impl<F: Fn(&[String]) -> io::Result<CommandResult>> HostRunner for F {
    fn run(&self, args: &[String]) -> io::Result<CommandResult> {
        self(args)
    }
}

/// Called only by the executable's private child mode, before any remote effect.
/// setsid + exec keep the PID and detach lifetime from the SSH control session.
pub fn detached_exec(argv: Vec<OsString>) -> io::Result<()> {
    let (program, args) = argv
        .split_first()
        .ok_or_else(|| reject("missing_child_command"))?;
    rustix::process::setsid()?;
    Err(Command::new(program).args(args).exec())
}

pub struct BoundedCommand {
    pub executable: PathBuf,
    pub scratch: PathBuf,
}
impl BoundedCommand {
    pub fn run(
        &self,
        argv: &[String],
        timeout: Duration,
        max_output: usize,
    ) -> io::Result<CommandResult> {
        if argv.is_empty()
            || argv[0].is_empty()
            || timeout.is_zero()
            || max_output == 0
            || max_output > MAX_OUTPUT
        {
            return Err(reject("invalid_host_command"));
        }
        let watchdog = trusted_program(&["/usr/bin/timeout", "/bin/timeout"])?;
        let out = tempfile::tempfile_in(&self.scratch)?;
        let err = tempfile::tempfile_in(&self.scratch)?;
        let mut child = Command::new(&self.executable)
            .arg("__host-group")
            .arg(watchdog)
            .args([
                "--signal=KILL",
                "--",
                &format!("{:.9}s", timeout.as_secs_f64()),
            ])
            .args(argv)
            .env_clear()
            .env("PATH", "/usr/bin:/bin")
            .env("LANG", "C.UTF-8")
            .current_dir("/")
            .stdin(Stdio::null())
            .stdout(Stdio::from(out.try_clone()?))
            .stderr(Stdio::from(err.try_clone()?))
            .spawn()?;
        let deadline = Instant::now() + timeout;
        let outcome = (|| {
            loop {
                if let Some(status) = child.try_wait()? {
                    if status.signal() == Some(9) && Instant::now() >= deadline {
                        return Err(reject("host_command_timeout"));
                    }
                    let stdout = read_bounded(out, max_output)?;
                    let stderr = read_bounded(err, max_output)?;
                    return Ok(CommandResult {
                        exit_code: status
                            .code()
                            .unwrap_or_else(|| -status.signal().unwrap_or(1)),
                        stdout: String::from_utf8_lossy(&stdout).into_owned(),
                        stderr: String::from_utf8_lossy(&stderr).into_owned(),
                    });
                }
                if Instant::now() >= deadline {
                    return Err(reject("host_command_timeout"));
                }
                if out.metadata()?.len() > max_output as u64
                    || err.metadata()?.len() > max_output as u64
                {
                    return Err(reject("host_command_output_limit"));
                }
                thread::sleep(Duration::from_millis(10));
            }
        })();
        if child.try_wait()?.is_none() {
            terminate_owned_group(&mut child)?;
        }
        outcome
    }
}
fn terminate_owned_group(child: &mut Child) -> io::Result<()> {
    let pid = Pid::from_raw(i32::try_from(child.id()).map_err(|_| reject("invalid_child_pid"))?)
        .ok_or_else(|| reject("invalid_child_pid"))?;
    match rustix::process::getpgid(Some(pid)) {
        Ok(group) if group == pid => match rustix::process::kill_process_group(pid, Signal::KILL) {
            Ok(()) | Err(rustix::io::Errno::SRCH) => {}
            Err(error) => return Err(error.into()),
        },
        Ok(_) => {
            child.kill()?;
        } // Before the helper established its own session.
        Err(rustix::io::Errno::SRCH) => {}
        Err(error) => return Err(error.into()),
    }
    let deadline = Instant::now() + Duration::from_secs(10);
    while child.try_wait()?.is_none() {
        if Instant::now() >= deadline {
            return Err(reject("host_command_cleanup_uncertain"));
        }
        thread::sleep(Duration::from_millis(10));
    }
    Ok(())
}
fn read_bounded(mut file: File, limit: usize) -> io::Result<Vec<u8>> {
    file.seek(SeekFrom::Start(0))?;
    let mut bytes = Vec::new();
    file.take(limit as u64 + 1).read_to_end(&mut bytes)?;
    if bytes.len() > limit {
        return Err(reject("host_command_output_limit"));
    }
    Ok(bytes)
}
pub fn trusted_program(candidates: &[&str]) -> io::Result<PathBuf> {
    candidates
        .iter()
        .map(Path::new)
        .find(|path| path.is_file())
        .map(Path::to_path_buf)
        .ok_or_else(|| reject("required_host_program_unavailable"))
}
