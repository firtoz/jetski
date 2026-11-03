//! Rootless workload lifecycle; no workload-selected host commands or credentials.
use crate::fence::{Fence, Phase, State};
use crate::host_config::{KEEP_ID, NamespaceMapping, NetworkMode, pinned_image};
use crate::process::HostRunner;
use crate::protocol::Lease;
use serde_json::{Value, json};
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
fn reject(message: &'static str) -> io::Error {
    io::Error::other(message)
}

pub struct RuntimeOptions<'a> {
    pub image: &'a str,
    pub approved_images: &'a [String],
    pub data: &'a Path,
    pub supervisor: Option<&'a Path>,
    pub relay: Option<&'a Path>,
    pub network: NetworkMode,
    pub mapping: NamespaceMapping,
}
pub struct PodmanRuntime<'a, R: HostRunner> {
    fence: &'a Fence,
    run: &'a R,
    image: String,
    data: PathBuf,
    supervisor: Option<PathBuf>,
    relay: Option<PathBuf>,
    network: NetworkMode,
    mapping: NamespaceMapping,
    mapping_args: Vec<String>,
}
impl<'a, R: HostRunner> PodmanRuntime<'a, R> {
    pub fn new(fence: &'a Fence, run: &'a R, options: RuntimeOptions<'_>) -> io::Result<Self> {
        if !pinned_image(options.image) {
            return Err(reject("digest_pinned_image_required"));
        }
        if !options
            .approved_images
            .iter()
            .any(|image| image == options.image)
        {
            return Err(reject("image_not_approved"));
        }
        if !options.data.is_absolute() {
            return Err(reject("absolute_data_root_required"));
        }
        for path in [Some(options.data), options.supervisor, options.relay]
            .into_iter()
            .flatten()
        {
            if !path.is_absolute()
                || path
                    .to_str()
                    .is_none_or(|s| s.contains(',') || s.contains('\0'))
            {
                return Err(reject("invalid_runtime_mount_path"));
            }
        }
        let mapping_args = options.mapping.arguments()?;
        Ok(Self {
            fence,
            run,
            image: options.image.into(),
            data: options.data.into(),
            supervisor: options.supervisor.map(Path::to_path_buf),
            relay: options.relay.map(Path::to_path_buf),
            network: options.network,
            mapping: options.mapping,
            mapping_args,
        })
    }
    pub fn container(lease: &Lease) -> String {
        format!("jetski-{}", lease.assignment_id)
    }
    pub fn absent(&self, lease: &Lease) -> io::Result<bool> {
        lease.validate()?;
        Ok(self
            .run
            .run(&["container".into(), "exists".into(), Self::container(lease)])?
            .exit_code
            == 1)
    }
    pub fn create(&self, lease: &Lease, memory_mb: u32, cpus: u32) -> io::Result<Value> {
        let _timing = crate::timing::Stage::new("runtime.create");
        lease.validate()?;
        if !(128..=65536).contains(&memory_mb) || !(1..=64).contains(&cpus) {
            return Err(reject("invalid_workload_resources"));
        }
        let guard = self.fence.locked()?;
        let mut state = guard.read()?.ok_or_else(|| reject("stale_lease"))?;
        state.matches(lease)?;
        if state.phase != Phase::Open {
            return Err(reject("closed_lease"));
        }
        let mut configuration = json!({"image":self.image,"memoryMb":memory_mb,"cpus":cpus,"relay":self.relay.is_some()});
        if self.mapping.mode != KEEP_ID {
            configuration["userNamespace"] = json!(self.mapping.mode);
            configuration["uidMappings"] = json!(self.mapping.uid_mappings);
            configuration["gidMappings"] = json!(self.mapping.gid_mappings);
        }
        if self.network != NetworkMode::None {
            configuration["networkMode"] = json!(self.network.as_str());
        }
        if let Some(existing) = state.sections.get("runtime") {
            if existing.get("configuration") != Some(&configuration) {
                return Err(reject("runtime_configuration_conflict"));
            }
            if existing.get("phase").and_then(Value::as_str) == Some("running") {
                return Ok(existing.clone());
            }
            return Err(reject("runtime_already_admitted"));
        }
        let name = Self::container(lease);
        let creating = json!({"name":name,"phase":"creating","image":self.image,"configuration":configuration});
        state.sections.insert("runtime".into(), creating);
        guard.write(&state)?;
        let effect = (|| {
            for root in ["workspace", "home"] {
                let meta = fs::symlink_metadata(self.data.join(&lease.assignment_id).join(root))?;
                if !meta.is_dir() {
                    return Err(reject("persistent_root_unprepared"));
                }
            }
            let mut args: Vec<String> = [
                "run",
                "--detach",
                "--name",
                &name,
                "--label",
                &format!("org.jetski.assignment={}", lease.assignment_id),
                "--label",
                &format!("org.jetski.generation={}", lease.generation),
                "--read-only",
                "--cap-drop=ALL",
                "--security-opt=no-new-privileges",
                "--user",
                "1000:1000",
            ]
            .into_iter()
            .map(String::from)
            .collect();
            args.extend(self.mapping_args.clone());
            args.extend([
                "--pids-limit".into(),
                "256".into(),
                "--memory".into(),
                format!("{memory_mb}m"),
                "--cpus".into(),
                cpus.to_string(),
                if self.network == NetworkMode::None {
                    "--network=none".into()
                } else {
                    "--network=slirp4netns:allow_host_loopback=false".into()
                },
                "--pull=never".into(),
                "--tmpfs".into(),
                "/tmp:rw,nosuid,nodev,size=128m".into(),
                "--tmpfs".into(),
                "/run:rw,nosuid,nodev,size=16m".into(),
                "--env".into(),
                "HOME=/home/sandbox".into(),
                "--workdir".into(),
                "/workspace".into(),
            ]);
            for (source, target) in [("workspace", "/workspace"), ("home", "/home/sandbox")] {
                args.extend([
                    "--mount".into(),
                    format!(
                        "type=bind,src={},dst={target}",
                        self.data.join(&lease.assignment_id).join(source).display()
                    ),
                ]);
            }
            for (source, target) in [
                (&self.supervisor, "/jetski-supervisor"),
                (&self.relay, "/jetski-tcp-relay"),
            ] {
                if let Some(source) = source {
                    args.extend([
                        "--mount".into(),
                        format!("type=bind,src={},dst={target},ro", source.display()),
                    ]);
                }
            }
            args.extend([
                self.image.clone(),
                "/bin/sh".into(),
                "-c".into(),
                "trap 'exit 0' TERM INT; while :; do sleep 3600 & wait $!; done".into(),
            ]);
            if self.run.run(&args)?.exit_code != 0 {
                return Err(reject("runtime_create_failed"));
            }
            let running = json!({"name":name,"phase":"running","image":self.image,"configuration":configuration});
            state.sections.insert("runtime".into(), running.clone());
            guard.write(&state)?;
            Ok(running)
        })();
        if effect.is_err() {
            let mut current = guard.read()?.ok_or_else(|| reject("stale_lease"))?;
            current.matches(lease)?;
            current.phase = Phase::Quarantined;
            guard.write(&current)?;
        }
        effect
    }
    pub fn quiesce(&self, lease: &Lease) -> io::Result<Value> {
        self.fence.close(lease)?;
        let guard = self.fence.locked()?;
        let mut state = guard.read()?.ok_or_else(|| reject("stale_lease"))?;
        state.matches(lease)?;
        let mut runtime = state
            .sections
            .get("runtime")
            .cloned()
            .ok_or_else(|| reject("runtime_state_uncertain"))?;
        match runtime["phase"].as_str() {
            Some("stopped") => return Ok(runtime),
            Some("running") => {}
            _ => return Err(reject("runtime_state_uncertain")),
        }
        let name = runtime["name"]
            .as_str()
            .ok_or_else(|| reject("invalid_runtime_receipt"))?;
        if name != Self::container(lease) {
            return Err(reject("runtime_identity_conflict"));
        }
        if self
            .run
            .run(&["stop".into(), "--time".into(), "10".into(), name.into()])?
            .exit_code
            != 0
        {
            return Err(reject("runtime_stop_unconfirmed"));
        }
        let inspected = self.run.run(&[
            "inspect".into(),
            "--format".into(),
            "{{.State.Running}}".into(),
            name.into(),
        ])?;
        if inspected.exit_code != 0 || inspected.stdout.trim() != "false" {
            return Err(reject("runtime_quiescence_unconfirmed"));
        }
        runtime["phase"] = json!("stopped");
        state.sections.insert("runtime".into(), runtime.clone());
        cancel_stopped_streams(&mut state)?;
        guard.write(&state)?;
        Ok(runtime)
    }
    pub fn remove(&self, lease: &Lease) -> io::Result<Value> {
        lease.validate()?;
        let guard = self.fence.locked()?;
        let mut state = guard.read()?.ok_or_else(|| reject("stale_lease"))?;
        state.matches(lease)?;
        let mut runtime = state
            .sections
            .get("runtime")
            .cloned()
            .ok_or_else(|| reject("runtime_not_quiesced"))?;
        if state.phase != Phase::Closed
            || !matches!(runtime["phase"].as_str(), Some("stopped" | "removed"))
        {
            return Err(reject("runtime_not_quiesced"));
        }
        if runtime["phase"] == "removed" {
            return Ok(runtime);
        }
        let name = runtime["name"]
            .as_str()
            .ok_or_else(|| reject("invalid_runtime_receipt"))?;
        if name != Self::container(lease) {
            return Err(reject("runtime_identity_conflict"));
        }
        let args = ["container".into(), "exists".into(), name.into()];
        let mut exists = self.run.run(&args)?.exit_code;
        if exists == 0 {
            if self.run.run(&["rm".into(), name.into()])?.exit_code != 0 {
                return Err(reject("runtime_removal_unconfirmed"));
            }
            exists = self.run.run(&args)?.exit_code;
        }
        if exists != 1 {
            return Err(reject("runtime_still_present_or_unknown"));
        }
        runtime["phase"] = json!("removed");
        state.sections.insert("runtime".into(), runtime.clone());
        guard.write(&state)?;
        Ok(runtime)
    }
}
fn cancel_stopped_streams(state: &mut State) -> io::Result<()> {
    let streams = state
        .sections
        .entry("streams".into())
        .or_insert_with(|| json!({}));
    let streams = streams
        .as_object_mut()
        .ok_or_else(|| reject("invalid_stream_journal"))?;
    for row in streams.values_mut() {
        let phase = row
            .get("phase")
            .and_then(Value::as_str)
            .ok_or_else(|| reject("invalid_stream_journal"))?;
        if !["closed", "cancelled"].contains(&phase) {
            let row = row
                .as_object_mut()
                .ok_or_else(|| reject("invalid_stream_journal"))?;
            row.insert("phase".into(), json!("cancelled"));
            row.insert("delivery".into(), json!("unknown"));
            row.insert("reason".into(), json!("runtime_stopped"));
        }
    }
    Ok(())
}
