# Add interactive access

Jetski supports command output, PTY terminals, authenticated HTTP/WebSocket
previews and workload TCP forwarding. Start with a running authorized sandbox.
A port permission is not a reachable URL; a gateway must be explicitly configured.
[API availability](compatibility.md) distinguishes source helpers from the release.

## Follow a command

Use `sandbox.startCommand(argv)` and its handle's `status()`, `output(channel,
{ offset })` and `wait()` methods. Reattach with `sandbox.command(savedId)`;
that observes an identity without starting it again. Persist `nextOffset` only
after consuming its bytes, and keep separate stdout/stderr cursors. Retained
output is bounded to 16 MiB per channel and can truncate there. Binary data stays
bytes; text views reject invalid UTF-8.

Breaking an iterator, timeout or abort detaches observation. `cancel()` explicitly
requests cancellation; its acknowledgement is not a confirmed exit. Observe again.
[Recovery and errors](failure-recovery.md) · [shared helper contracts](simple-api.md#interactive-work).

## Use a terminal

Start a PTY with `startTerminal(argv, { id, geometry })`, then observe its status
and merged output. Input frames have their own persisted identities: stdin
(base64, at most 16 KiB), resize (1–4096 rows/columns), signal (`INT`, `QUIT`, `TSTP`)
or close. A sent receipt means transport acceptance, not application consumption.
An uncertain send must not be blindly replayed.

For restart-safe input, use the existing `TerminalAttachment` journal through
`client.attachTerminal(state, attachmentId, sandboxId, terminalId)` or the shared
session helper. Persist its transactional state, serialize sends and call
`resume()` after reconnect. It observes a pending input before any admission.
Acknowledged output cursor updates use `acknowledgeOutput(from, to)` after display.
Display/cursor writes are not atomic, so a local crash can repeat displayed bytes.
Protect the state directory: pending inputs can contain private text.

CLI attachment:

```sh
jetski terminal-attach SANDBOX TERMINAL --id ATTACHMENT --state-dir PRIVATE_DIRECTORY
```

Reuse the ID/directory to reconnect. Ctrl-] and stdin EOF detach; use
`terminal-close` to terminate remotely. TTY modes restore on exit. The CLI bounds
queued input to 64 KiB and submits serialized 16 KiB frames with per-input
deadlines. A timeout retains journal identity. Explicit SDK journals bind server
origin, credential fingerprint and terminal; credential rotation needs deliberate
recovery, not automatic rebinding.

## Configure the SSH gateway

Add this separate gateway to service configuration:

```json
{
  "sshGateway": {
    "hostKeyPath": "/private/gateway-host-key",
    "host": "127.0.0.1",
    "port": 2222,
    "principals": [
      { "owner": "OWNER_ID", "publicKey": "ssh-ed25519 PUBLIC_KEY" }
    ]
  }
}
```

Protect/pin its host key. The key selects the owner; the SSH username selects the
sandbox. Create a terminal first, then attach at an explicit output offset:

```sh
ssh -p 2222 -t SANDBOX_ID@localhost 'attach TERMINAL_ID 0'
```

The grammar is not evaluated by a host shell. Passwords, outer shells, arbitrary
commands, SFTP, environment/agent/X11 forwarding and arbitrary host TCP destinations
are refused. Disconnect detaches without closing the terminal. Ordinary SSH clients
do not persist a verified display cursor or gain permission to replay typed input.

For forwarding, first expose a workload port, then use `jetski forward SANDBOX
EXPOSURE --config PATH`. Configuration requires gateway host/port, private key
path, pinned host public-key path, remote port and optional local port. Authentication
precedes binding `127.0.0.1`; no public listener is created. The optional Node API
is `/client/forward` (`forwardTcp`). Each intentional connection has a new stream
UUID recorded before dispatch; neither reconnect nor byte replay is automatic.

## Configure browser previews

Give each preview its own declared origin, owner, sandbox and exposure:

```json
{
  "preview": {
    "host": "127.0.0.1",
    "port": 8790,
    "controlOrigins": ["https://control.example.com"],
    "routes": [
      {
        "origin": "https://workspace.example-preview.net",
        "owner": "OWNER_ID",
        "sandbox": "SANDBOX_ID",
        "exposure": "EXPOSURE_ID"
      }
    ]
  }
}
```

Terminate HTTPS at a trusted proxy preserving Host. Never serve workload HTML at
the control origin. Authorization is owner/origin/generation scoped; stopping or
replacing an assignment invalidates its exposure. Resume requires a new permission.

Use `jetski.preview(...)` or explicit `createPreviewGrant`, or CLI
`preview-open SANDBOX EXPOSURE --origin ORIGIN --id UUID`. Treat the returned
bootstrap URL as a credential. It carries a 60-second one-use credential; redemption
removes the fragment and sets a host-only Secure/HttpOnly/SameSite=Strict cookie.
Sessions expire 15 minutes after creation; replay does not renew them. Explicit
status/revoke methods and `preview-status`/`preview-revoke` use stable identities.
Database backups contain private session material and require protection.

Credentials/cookies and hop-by-hop metadata are stripped before workload delivery.
Responses use no-store/no-referrer/nosniff and a sandbox CSP; application cookies
and service workers are unsupported. Standalone preview framing is disabled.
Embedded Fetch gateways may explicitly allow configured control origins to frame
content, subject to browser site/cookie policy. Qualify your browser/proxy setup.

## Observe delivery and cleanup

`streamStatus` is a read-only persisted receipt; `cancelStream` requests cancellation.
The CLI exposes `stream-status` and `stream-cancel`. A 202 means requested, not
completed. Network EOF is not proof of application processing or authenticated
host completion. Generation changes, revocation and expiry close access while
uncertain cleanup stays recorded.

Previews use bounded backpressure: 64 MiB HTTP bodies, 32 KiB headers, 30-second
admission and at most one-hour connections; session expiry can close earlier.
Default gateway capacity/deadline limits are not a substitute for ingress policy.
Capability declarations describe implemented/configured APIs, not every host's
health or an operator's security certification. For Workers, inject the portable
Fetch gateway and platform socket/lifetime adapters rather than assuming the Node
HTTP server runs under compatibility flags.

[Platform integration](embedded-platforms.md) · [OpenAPI](openapi.json) ·
[Scoped evidence and deployment limits](../maintainer/qualification.md).
