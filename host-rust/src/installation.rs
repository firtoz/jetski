//! Immutable opt-in identity. Root-only installation verifies the artifact digest.
use crate::{
    checkpoint_cache::{reject, valid_hash},
    host_config::{self, HostConfig},
};
use serde::Deserialize;
use std::{fs, io, os::unix::fs::MetadataExt, path::Path};
const BINARY: &str = "/opt/jetski/native/jetski-host";
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Marker {
    version: u8,
    backend: String,
    sha256: String,
    bytes: u64,
    machine_id: String,
    pool_id: String,
    bootstrap_digest: String,
}
pub fn verify(config: &HostConfig, expected: Option<&str>) -> io::Result<()> {
    host_config::private_root(Path::new("/var/lib/jetski-native"), 0o700)?;
    host_config::private_root(Path::new("/opt/jetski/native"), 0o700)?;
    let marker: Marker = serde_json::from_slice(&host_config::read_private(
        Path::new("/etc/jetski/native-host.json"),
        16384,
    )?)
    .map_err(|_| reject("invalid_native_installation"))?;
    let intent: serde_json::Value = serde_json::from_slice(&host_config::read_private(
        Path::new("/var/lib/jetski-native/intent.json"),
        16384,
    )?)
    .map_err(|_| reject("invalid_native_installation"))?;
    if marker.version != 1
        || marker.backend != "rust"
        || !valid_hash(&marker.sha256)
        || !valid_hash(&marker.bootstrap_digest)
        || !(64..=6 * 1024 * 1024).contains(&marker.bytes)
        || expected.is_some_and(|sha| sha != marker.sha256)
        || marker.machine_id != config.machine_id
        || marker.pool_id != config.pool_id
        || intent
            != serde_json::json!({"version":1,"backend":"rust","sha256":marker.sha256,"bytes":marker.bytes,"machineId":marker.machine_id,"poolId":marker.pool_id})
    {
        return Err(reject("native_installation_identity_conflict"));
    }
    let installed = fs::symlink_metadata(BINARY)?;
    let actual = fs::metadata(std::env::current_exe()?)?;
    if !installed.is_file()
        || installed.uid() != 0
        || installed.mode() & 0o7777 != 0o555
        || installed.nlink() != 1
        || installed.len() != marker.bytes
        || (installed.dev(), installed.ino()) != (actual.dev(), actual.ino())
    {
        return Err(reject("native_installation_binary_conflict"));
    }
    Ok(())
}
