# Security

Report vulnerabilities privately through this repository's **Security → Report a
vulnerability** page. Do not post credentials or exploit payloads publicly. Until
private reporting is enabled, contact the maintainer through their GitHub profile
before sharing details. There is no contracted response-time SLA.

The latest 0.1 patch release is supported. Security fixes may require upgrading;
older minor releases do not have a backport promise. Use a dedicated control-plane
account, owner-scoped credentials, digest-approved workload images and private
checkpoint credentials. Never expose host-control keys to workloads.

Rootless Podman shares a host kernel. gVisor adds a userspace kernel boundary; it
is not a hardware VM boundary. One active assignment per host and permanent owner
binding reduce reuse exposure; they do not establish suitability for every hostile
multi-tenant workload. Runtime fallback is explicit and never retries failed
workload execution under a weaker runtime. See docs/runtime-selection.md.

The API binds loopback by default. Public use requires TLS at a trusted reverse
proxy, access controls, request limits and monitoring. Preview and forwarding
credentials authorize access to workload services; handle them as credentials.
No unattended updater installs host runtimes on an operator's desktop.
