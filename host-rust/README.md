# Experimental native host

This opt-in backend completed its finite hosted qualification. Python remains
the default: the [matched report](../docs/rust-host-benchmarks.md) found no consistent
end-to-end speed win. The [completed goal](../docs/goals/rust-host.md) records scope.

Use the existing Rust toolchain to run `cargo test --manifest-path host-rust/Cargo.toml`.
No host installation, runtime changes or cloud allocation are performed by this
crate's tests. `Cargo.lock` pins dependencies; the final release must use a pinned
build artifact and immutable host identity. Hosted Boat installation, exact replacement recovery and native interactive
paths passed within the boundaries documented in the report.

Build on Linux x86-64 with the pinned Rust 1.97.1 toolchain:

```sh
RUSTFLAGS='-C target-feature=+crt-static' cargo build --locked --release \
  --target x86_64-unknown-linux-musl --manifest-path host-rust/Cargo.toml
sha256sum host-rust/target/x86_64-unknown-linux-musl/release/jetski-host
```

Use an already prepared compiler with the musl target, or the disposable CI build;
the project does not install toolchains/targets on the operator's desktop.
CI produces a separate static musl binary, dependency/compiler notices and SHA/source manifest. The npm artifact
does not require Cargo or build/download native executables at installation.
Select the binary explicitly through `@firtoz/jetski/host-rust-assets`; embed its bytes
and installer through `RustBoatBootstrap` from `@firtoz/jetski/providers/boat-bootstrap-rust`.
Supply the existing base assets loader independently. Give Boat control and stream
transports the same `{kind: "rust", sha256}` backend option. Providers/storage and
the portable core remain unchanged. Call host `status` before assigning work;
native readiness must attest the selected binary identity.

An adopted SSH host needs the same operator-run installation order: run
`install.py` with `{"action":"prepare","identity":...}` before installing the
existing base host bundle, upload the pinned binary to
`/tmp/jetski-native-<sha256>.bin`, then run `install.py` with action `install`.
Identity has version 1, backend `rust`, sha256, bytes, machineId and poolId. Run
the installer as root on the execution host. Configure `SshHost.backend` with
the same kind/hash and restrict its authorized SSH command to the generated
native control command. A forced command still pointing to Python must be
replaced as part of that explicit host preparation; readiness rejects its proof.
This does not grant workload users any outer-host command or shell.

Backend intent must predate base installation. Repeated installation verifies
the same identity and bytes; changing backend, binary or installed policy needs
an explicit replacement host. A Python transport rejects a native intent and a
native binary checks its protected installation marker before control/worker
effects. Never point a new backend at an existing assignment.
