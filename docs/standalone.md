# Run a standalone service

Use a service when clients need one independently running controller. For a Node
application that owns lifecycle, [embedded usage](getting-started.md) is simpler.
The service holds provider credentials, metadata and scheduling; SDK clients send
owner-authenticated requests and do not shut it down when they disconnect.

## Configure and start

Install the prebuilt CLI with Node from [`.nvmrc`](../.nvmrc):

```sh
npm install --global @firtoz/jetski@0.2.1
```

Copy one complete configuration to a private path:

- [Boat](../examples/server-boat.json): owned-machine allocation and bootstrap.
- [boxd](../examples/server-boxd.json): optional SDK-backed machines; install the
  [optional peer dependency and review provider fields](boxd.md) first.
- [Adopted SSH](../examples/server.json): operator-prepared Linux hosts; see below.

Choose an absolute private `dataDirectory`, stable `poolId`, digest-approved
images and owner principals. Supply each named credential environment variable;
API bearer tokens need at least 32 random characters. Never put secrets in JSON.
Review resource/lease/idle policy before admitting billable work.

```sh
jetski check-config --config /absolute/path/server.json
jetski serve --config /absolute/path/server.json
```

`check-config` checks structure, not credentials, runtime readiness or provider
compatibility. The API binds loopback by default. Remote access requires an
operator-managed HTTPS reverse proxy or authenticated encrypted tunnel. Local
storage is on the server, not the client's laptop or execution host. R2/S3 moves
objects only; back up SQLite too. [Storage layout](storage-locations.md).

A versioned controller image is `ghcr.io/firtoz/jetski:v0.2.1`; use its verified
release digest and a persistent UID-1000-owned data volume. The controller needs
no local workload runtime. [Deployment and backup requirements](operations.md).

## Connect an application

Use the [service-client example](../examples/01-hello-world/) with `JETSKI_URL`
and `JETSKI_TOKEN`. It creates a sandbox, executes a command and durably stops it.
Both service and embedded sessions follow the same
[API/lifecycle table](simple-api.md#lifecycle).

For explicit CLI work, persist UUIDs **before admission**, then observe each
operation before advancing:

```sh
jetski create --id SANDBOX_UUID --operation CREATE_UUID --image IMAGE_DIGEST
jetski operation SANDBOX_UUID --id CREATE_UUID
jetski exec SANDBOX_UUID --id COMMAND_UUID -- echo hello
jetski stop SANDBOX_UUID --operation STOP_UUID
jetski operation SANDBOX_UUID --id STOP_UUID
```

The worker progresses queued work independently of client polling. A lost reply,
observation timeout or aborted wait does not confirm remote cancellation. Inspect
the original command/operation ID; do not replay the script or invent replacement
IDs. [Recovery](failure-recovery.md).

## Files, history and deletion

Use SDK file helpers, or `jetski files ID /workspace`, `file-read ID PATH` (binary
stdout) and `file-write ID PATH LOCAL_FILE --id UUID`. Uploads are limited to
64 MiB/files and 256 KiB/chunk; paths stay within declared persistent directories.
Finish atomically publishes a file on the execution host, not a remote checkpoint.
Parent directories must exist; replacing a directory entry does not update all
hardlinks to its old inode. Listings are paginated live views, not snapshots.

`checkpoint` stops execution and retains the assignment; `stop` additionally
releases it after publication verification. `resume --checkpoint ROOT` can select
retained files without deleting newer history. `checkpoints`, `checkpoint-info`,
`checkpoint-pin` and `checkpoint-unpin` inspect/protect versions. Unpinning does
not itself retire a root. `copy` creates a separate stopped same-owner sandbox;
resume it with a separate operation ID.

`delete` prevents future execution for that sandbox identity and safely shuts down
assigned work. Acknowledged checkpoints/output remain retained. Deletion is
separate from object GC and never bypasses pins, complete reachability or grace.
Starting/quarantined placements must resolve before deletion is accepted.

## Adopt an SSH host

Prepare a dedicated compatible Linux x86-64 execution host with rootless Podman
prerequisites and GNU `timeout`. Copy the packaged `host/` bundle there. On that
host, run `python3 host/bootstrap.py --config /path/to/host.json` as its operator.
Configuration contains `version: 1`, matching `machineId`/`poolId`, and explicit
digest-approved `images`. Bootstrap refuses unsafe parents/existing assignments;
it does not install OS packages or a runtime on your desktop.

Use a dedicated administrative SSH key forced to
`env -i PATH=/usr/bin:/bin python3 -I /opt/jetski/host/control.py`. Disable
port/agent/X11 forwarding and pin the execution host key in the configured
known-hosts file. This is private controller access; workload users use separate
[scoped interactive gateways](interactive-access.md), never this host shell/key.
SSH retirement releases adoption and leaves the operator's machine running.

For advanced policy use [configuration](advanced-configuration.md),
[networking](networking.md) and [runtime selection](runtime-selection.md).
The [OpenAPI](openapi.json) is the explicit route reference.
