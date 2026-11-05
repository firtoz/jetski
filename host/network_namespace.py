"""Trusted namespace-only engine adapter; native runsc retains workload authority.

No workload image/code, credentials, persistent paths or host network are mounted
into the keeper. Its sole executable is a root-owned static control binary.
Methods are called under the supervisor's generation fence. Unknown engine
outcomes are observed using the same deterministic name, never another identity.
"""

import hashlib
import json
import io
import tarfile
import os
import pathlib
import re
import stat
import shutil

from archive import sync_dir
from fence import identity
from network_filter_tc import TcBpfEgressFilter
from network_policy import DNS_IPV4, GUEST_IPV4, TABLE, policy_sha256, ruleset

IMAGE_PROOF = pathlib.Path("/etc/jetski/network-helper.json")
RESOLVER_BYTES = b"nameserver 10.0.2.3\noptions timeout:2 attempts:2\n"
KEEPER = pathlib.Path("/opt/jetski/network-keeper")
NETWORK_NAME = r"jetski-net-[a-f0-9-]{36}-g[1-9][0-9]{0,15}"
PASTA_NETWORK = (
    "pasta:-4,-I,tap0,-m,1500,-a,"
    + GUEST_IPV4
    + ",-n,24,-g,10.0.2.2,--dns-forward,"
    + DNS_IPV4
    + ",--no-map-gw,--ns-mac-addr,52:54:00:12:34:56,-t,none,-u,none,-T,none,-U,none"
)


def namespace_name(raw):
    lease = identity(raw)
    return f"jetski-net-{lease['assignmentId']}-g{lease['generation']}"


def namespace_identity(pid, account, ownership):
    if type(pid) is not int or pid < 2:
        raise ValueError("invalid_namespace_pid")
    process = pathlib.Path("/proc", str(pid))
    status = (process / "status").read_text()
    uid = next(line.split()[1:] for line in status.splitlines() if line.startswith("Uid:"))
    if set(map(int, uid)) != {account.pw_uid}:
        raise ValueError("namespace_owner_mismatch")
    for file, key, workload, host_id in (
        ("uid_map", "uidMappings", "workloadUid", account.pw_uid),
        ("gid_map", "gidMappings", "workloadGid", account.pw_gid),
    ):
        expected = [(0, host_id, 1), (1, ownership[workload] - 999, ownership[key][1][2])]
        observed = [
            tuple(map(int, line.split())) for line in (process / file).read_text().splitlines()
        ]
        if observed != expected:
            raise ValueError("network_namespace_mapping_mismatch")
    result = {name: (process / "ns" / name).stat().st_ino for name in ("user", "net")}
    if any(result[name] == pathlib.Path("/proc/1/ns", name).stat().st_ino for name in result):
        raise ValueError("host_namespace_exposed")
    result.update(pid=pid, startTime=(process / "stat").read_text().rsplit(")", 1)[1].split()[19])
    return result


def read_image_proof():
    meta = IMAGE_PROOF.lstat()
    if (
        not stat.S_ISREG(meta.st_mode)
        or meta.st_uid != 0
        or meta.st_mode & 0o077
        or meta.st_nlink != 1
        or meta.st_size > 4096
    ):
        raise ValueError("unsafe_network_image_proof")
    proof = json.loads(IMAGE_PROOF.read_bytes())
    if (
        set(proof) != {"version", "image", "binarySha256"}
        or proof["version"] != 1
        or not re.fullmatch(r"sha256:[a-f0-9]{64}", proof["image"])
    ):
        raise ValueError("invalid_network_image_proof")
    binary = KEEPER.lstat()
    if (
        not stat.S_ISREG(binary.st_mode)
        or binary.st_uid != 0
        or binary.st_mode & 0o022
        or binary.st_size > 4 * 1024**2
        or hashlib.sha256(KEEPER.read_bytes()).hexdigest() != proof["binarySha256"]
    ):
        raise ValueError("network_keeper_integrity")
    return proof


def verify_resolver(account):
    resolver = pathlib.Path(account.pw_dir) / "network-resolv.conf"
    fd = os.open(resolver, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(fd, "rb") as source:
        meta = os.fstat(source.fileno())
        if (
            not stat.S_ISREG(meta.st_mode)
            or meta.st_uid != account.pw_uid
            or stat.S_IMODE(meta.st_mode) != 0o444
            or meta.st_nlink != 1
            or meta.st_size != len(RESOLVER_BYTES)
            or source.read(len(RESOLVER_BYTES) + 1) != RESOLVER_BYTES
        ):
            raise ValueError("network_resolver_integrity")


def prepare_image(account, run, import_image):
    """Bootstrap a from-scratch image containing only the trusted static keeper."""
    if os.geteuid() != 0:
        raise ValueError("root_network_bootstrap_required")
    resolver = pathlib.Path(account.pw_dir) / "network-resolv.conf"
    if not os.path.lexists(resolver):
        fd = os.open(resolver, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o444)
        with os.fdopen(fd, "wb") as output:
            os.fchown(output.fileno(), account.pw_uid, account.pw_gid)
            # Public DNS configuration must be readable by the mapped workload
            # UID. The mount is read-only and its outer parent stays private.
            os.fchmod(output.fileno(), 0o444)
            output.write(RESOLVER_BYTES)
            output.flush()
            os.fsync(output.fileno())
        sync_dir(resolver.parent)
    verify_resolver(account)
    if IMAGE_PROOF.exists():
        proof = read_image_proof()
        result = run(["image", "exists", proof["image"]])
        if result["exitCode"] != 0:
            raise ValueError("network_helper_image_missing")
        return proof
    meta = KEEPER.lstat()
    if (
        not stat.S_ISREG(meta.st_mode)
        or meta.st_uid != 0
        or meta.st_mode & 0o022
        or not 1 <= meta.st_size <= 4 * 1024**2
    ):
        raise ValueError("unsafe_network_keeper")
    binary = KEEPER.read_bytes()
    output = io.BytesIO()
    with tarfile.open(fileobj=output, mode="w") as archive:
        for name in ("etc", "dev", "proc", "sys", "run", "tmp"):
            entry = tarfile.TarInfo(name)
            entry.type = tarfile.DIRTYPE
            entry.mode = 0o755
            archive.addfile(entry)
        for name, data, mode in [
            ("jetski-network-keeper", binary, 0o755),
            ("etc/hosts", b"", 0o644),
            ("etc/hostname", b"", 0o644),
            ("etc/resolv.conf", b"", 0o644),
        ]:
            entry = tarfile.TarInfo(name)
            entry.size = len(data)
            entry.mode = mode
            archive.addfile(entry, io.BytesIO(data))
    result = import_image(output.getvalue())
    image = result["stdout"].strip()
    if result["exitCode"] or not re.fullmatch(r"sha256:[a-f0-9]{64}", image):
        raise ValueError("network_image_import_unconfirmed")
    proof = dict(version=1, image=image, binarySha256=hashlib.sha256(binary).hexdigest())
    fd = os.open(IMAGE_PROOF, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, "wb") as target:
        target.write(json.dumps(proof, sort_keys=True).encode())
        target.flush()
        os.fsync(target.fileno())
    sync_dir(IMAGE_PROOF.parent)
    return proof


class NetworkNamespace:
    def __init__(
        self,
        account,
        ownership,
        control_root,
        *,
        run,
        host_run,
        namespace_run,
        filter_backend="auto",
    ):
        if filter_backend not in ("auto", "nft-netdev", "tc-bpf"):
            raise ValueError("unsupported_network_filter_backend")
        self.filter_backend = filter_backend
        self.tc = shutil.which("tc", path="/usr/sbin:/usr/bin:/sbin:/bin")
        self.account, self.ownership = account, ownership
        self.root = pathlib.Path(control_root) / "networks"
        self.run, self.host_run, self.namespace_run = run, host_run, namespace_run
        self.image = read_image_proof()["image"]
        # The sterile runtime PATH intentionally omits sbin. Resolve this trusted
        # control executable before dropping privileges, not in the target namespace.
        self.nft = shutil.which("nft", path="/usr/sbin:/usr/bin:/sbin:/bin")
        if self.nft is None:
            raise ValueError("network_filter_executable_unavailable")
        if not self.root.exists():
            self.root.mkdir(mode=0o700)
        meta = self.root.lstat()
        if (
            os.geteuid() != 0
            or not stat.S_ISDIR(meta.st_mode)
            or meta.st_uid != 0
            or meta.st_mode & 0o077
        ):
            raise ValueError("unsafe_network_journal")

    def path(self, lease):
        return self.root / (namespace_name(lease) + ".json")

    def read(self, lease):
        fd = os.open(self.path(lease), os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        with os.fdopen(fd, "rb") as source:
            meta = os.fstat(source.fileno())
            if (
                not stat.S_ISREG(meta.st_mode)
                or meta.st_uid != 0
                or meta.st_nlink != 1
                or meta.st_mode & 0o077
                or meta.st_size > 65536
            ):
                raise ValueError("unsafe_network_receipt")
            value = json.loads(source.read(65537))
        if value["lease"] != identity(lease) or value["policy"] != policy_sha256():
            raise ValueError("network_receipt_identity_mismatch")
        return value

    def write(self, lease, value):
        target = self.path(lease)
        fd = os.open(
            str(target) + ".next", os.O_WRONLY | os.O_CREAT | os.O_TRUNC | os.O_NOFOLLOW, 0o600
        )
        with os.fdopen(fd, "wb") as out:
            os.fchmod(out.fileno(), 0o600)
            out.write(json.dumps(value, sort_keys=True).encode())
            out.flush()
            os.fsync(out.fileno())
        os.replace(str(target) + ".next", target)
        sync_dir(self.root)

    def inspect(self, lease, *, stopped_ok=False):
        name = namespace_name(lease)
        exists = self.run(["container", "exists", name])
        if exists["exitCode"] == 1:
            return None
        if exists["exitCode"] != 0:
            raise ValueError("network_container_inventory_uncertain")
        result = self.run(["inspect", name])
        if result["exitCode"]:
            raise ValueError("network_container_inspection_uncertain")
        rows = json.loads(result["stdout"])
        if not isinstance(rows, list) or len(rows) != 1:
            raise ValueError("invalid_network_container_inventory")
        container = rows[0]
        labels = container["Config"]["Labels"]
        if (
            container["Name"] != name
            or labels.get("org.jetski.network-policy") != policy_sha256()
            or labels.get("org.jetski.assignment") != identity(lease)["assignmentId"]
        ):
            raise ValueError("network_container_identity_mismatch")
        image = container.get("Image", "")
        if (
            image.removeprefix("sha256:") != self.image.removeprefix("sha256:")
            or container.get("Config", {}).get("Cmd") != ["/jetski-network-keeper"]
            or container.get("HostConfig", {}).get("ReadonlyRootfs") is not True
        ):
            raise ValueError("network_container_configuration_mismatch")
        if container["State"]["Running"] is not True:
            if stopped_ok:
                return {"stopped": True}
            raise ValueError("network_container_not_running")
        return namespace_identity(container["State"]["Pid"], self.account, self.ownership)

    def namespace_argv(self, proof, *, network=False):
        current = namespace_identity(proof["pid"], self.account, self.ownership)
        if current != proof:
            raise ValueError("network_namespace_changed")
        args = ["nsenter", f"--user=/proc/{proof['pid']}/ns/user", "--preserve-credentials"]
        if network:
            args.append(f"--net=/proc/{proof['pid']}/ns/net")
        return args + ["--"]

    def filter_proof(self, proof):
        observed = self.namespace_run(
            self.namespace_argv(proof, network=True)
            + [self.nft, "--json", "list", "table", "netdev", TABLE]
        )
        if observed["exitCode"]:
            raise ValueError("network_filter_unavailable")
        parsed = json.loads(observed["stdout"])
        entries = parsed.get("nftables")
        if not isinstance(entries, list) or len(entries) > 16:
            raise ValueError("network_filter_inventory_invalid")
        chains = [row["chain"] for row in entries if "chain" in row]
        rules = [row["rule"] for row in entries if "rule" in row]
        if (
            len(chains) != 1
            or len(rules) != 5
            or chains[0].get("hook") != "egress"
            or chains[0].get("policy") != "drop"
            or chains[0].get("prio") != 0
            or chains[0].get("type") != "filter"
        ):
            raise ValueError("network_filter_structure_mismatch")
        device = chains[0].get("dev")
        if device is None:
            # nftables 1.0.9 omits the netdev device from JSON. Independently
            # inspect the kernel's text view; absence is never treated as tap0.
            text = self.namespace_run(
                self.namespace_argv(proof, network=True)
                + [self.nft, "--numeric-priority", "list", "chain", "netdev", TABLE, "outbound"]
            )
            if (
                text["exitCode"] != 0
                or re.search(
                    r'type filter hook egress device "?tap0"? priority 0; policy drop;',
                    text["stdout"],
                )
                is None
            ):
                raise ValueError("network_filter_device_unconfirmed")
            chains[0]["dev"] = "tap0"
        elif device != "tap0":
            raise ValueError("network_filter_device_mismatch")

        def stable(value):
            if isinstance(value, dict):
                return {
                    key: stable(item)
                    for key, item in value.items()
                    if key not in ("handle", "packets", "bytes", "metainfo")
                }
            if isinstance(value, list):
                return [
                    stable(item)
                    for item in value
                    if not isinstance(item, dict) or "metainfo" not in item
                ]
            return value

        return hashlib.sha256(json.dumps(stable(entries), sort_keys=True).encode()).hexdigest()

    def tc_filter(self, proof):
        if not self.tc:
            raise ValueError("network_tc_executable_unavailable")
        return TcBpfEgressFilter(
            self.tc,
            lambda argv: self.namespace_run(self.namespace_argv(proof, network=True) + argv),
        )

    def prepare(self, lease):
        lease = identity(lease)
        prior = self.read(lease) if self.path(lease).exists() else None
        observed = self.inspect(lease)
        if prior and prior["phase"] == "ready":
            if observed != prior["namespace"]:
                raise ValueError("network_namespace_missing_or_changed")
            self.verify(lease)
            return prior
        if prior:
            # The original name may exist after a lost acknowledgement. Its
            # configuration/filter still requires explicit reconciliation.
            raise ValueError("network_preparation_uncertain")
        if observed is not None:
            raise ValueError("unjournaled_network_container")
        intent = dict(version=1, lease=lease, policy=policy_sha256(), phase="creating")
        self.write(lease, intent)
        name = namespace_name(lease)
        command = [
            "run",
            "--detach",
            "--name",
            name,
            "--pull=never",
            "--read-only",
            "--user",
            "0:0",
            "--cap-drop=ALL",
            "--security-opt=no-new-privileges",
            "--pids-limit=16",
            "--memory=16m",
            "--cpus=0.1",
            "--network=" + PASTA_NETWORK,
            "--dns=" + DNS_IPV4,
            "--label=org.jetski.network-policy=" + policy_sha256(),
            "--label=org.jetski.assignment=" + lease["assignmentId"],
            self.image,
            "/jetski-network-keeper",
        ]
        result = self.run(command)
        if result["exitCode"]:
            raise ValueError("network_keeper_start_uncertain")
        proof = self.inspect(lease)
        if proof is None:
            raise ValueError("network_keeper_absent_after_start")
        inventory = self.host_run(["ip", "--json", "address", "show"])
        if inventory["exitCode"]:
            raise ValueError("host_address_inventory_unavailable")
        addresses = [
            entry["local"]
            for interface in json.loads(inventory["stdout"])
            for entry in interface.get("addr_info", [])
        ]
        policy = ruleset("tap0", addresses)
        backend = getattr(self, "filter_backend", "nft-netdev")
        if backend == "auto":
            checked = self.namespace_run(
                self.namespace_argv(proof, network=True) + [self.nft, "--check", "--file", "-"],
                policy.encode(),
            )
            if checked["exitCode"] == 0:
                backend = "nft-netdev"
            elif "Operation not supported" in checked.get("stderr", ""):
                backend = "tc-bpf"
            else:
                raise ValueError("network_filter_capability_unknown")
        if backend == "tc-bpf":
            kernel_proof = self.tc_filter(proof).install("tap0", addresses)
        else:
            installed = self.namespace_run(
                self.namespace_argv(proof, network=True) + [self.nft, "--file", "-"],
                policy.encode(),
            )
            if installed["exitCode"]:
                raise ValueError("network_filter_installation_failed")
            kernel_proof = self.filter_proof(proof)
        # Store an immutable placement receipt before any workload can join.
        ready = dict(
            intent,
            phase="ready",
            namespace=proof,
            filterSha256=hashlib.sha256(policy.encode()).hexdigest(),
            kernelFilterSha256=kernel_proof,
            filterBackend=backend,
        )
        self.write(lease, ready)
        return ready

    def verify(self, lease):
        receipt = self.read(lease)
        if receipt["phase"] != "ready" or self.inspect(lease) != receipt["namespace"]:
            raise ValueError("network_namespace_not_ready")
        backend = receipt.get("filterBackend", "nft-netdev")
        if backend == "tc-bpf":
            observed = self.tc_filter(receipt["namespace"]).proof("tap0")
        elif backend == "nft-netdev":
            observed = self.filter_proof(receipt["namespace"])
        else:
            raise ValueError("unknown_network_filter_backend")
        if observed != receipt["kernelFilterSha256"]:
            raise ValueError("network_filter_changed")
        verify_resolver(self.account)
        return receipt

    def verify_workload(self, lease, name):
        """Confirm rootless engine sharing never means the outer host userns."""
        proof = self.verify(lease)["namespace"]
        observed = self.run(["inspect", "--format={{.State.Pid}}", name])
        if observed["exitCode"] != 0:
            raise ValueError("network_workload_unconfirmed")
        pid = int(observed["stdout"].strip())
        if pid < 2:
            raise ValueError("network_workload_pid_invalid")
        process = pathlib.Path("/proc", str(pid))
        for namespace in ("user", "net"):
            if (process / "ns" / namespace).stat().st_ino != proof[namespace]:
                raise ValueError("network_workload_namespace_mismatch")
        status = (process / "status").read_text().splitlines()
        for field, key in (("Uid:", "workloadUid"), ("Gid:", "workloadGid")):
            values = next(line.split()[1:] for line in status if line.startswith(field))
            if set(map(int, values)) != {self.ownership[key]}:
                raise ValueError("network_workload_owner_mismatch")
        # Recheck the keeper's PID/start time, maps and namespace/filter identity
        # after reading workload procfs; never accept a replaced helper.
        if self.verify(lease)["namespace"] != proof:
            raise ValueError("network_workload_namespace_changed")

    def cleanup(self, lease):
        # Call only after native workload absence has been independently proved.
        prior = self.read(lease) if self.path(lease).exists() else None
        if prior is None:
            if self.inspect(lease, stopped_ok=True) is not None:
                raise ValueError("unjournaled_network_cleanup")
            return
        if self.inspect(lease, stopped_ok=True) is not None:
            result = self.run(["rm", "--force", namespace_name(lease)])
            if result["exitCode"]:
                raise ValueError("network_cleanup_unconfirmed")
        if self.inspect(lease, stopped_ok=True) is not None:
            raise ValueError("network_container_remains")
        self.write(lease, dict(prior, phase="removed"))


def controlled_namespace(account):
    """Bind privileged control and sterile runtime-account runners explicitly."""
    from runtime_backend import read_workload_identity
    from supervisor import (
        CONTROL_ROOT,
        bounded_command,
        configuration,
        runtime_argv,
        runtime_control_argv,
    )

    return NetworkNamespace(
        account,
        read_workload_identity(account),
        CONTROL_ROOT,
        filter_backend=configuration().get("networkFilter", "auto"),
        run=lambda args: bounded_command(
            runtime_control_argv(account) + args, CONTROL_ROOT, timeout=60
        ),
        host_run=lambda args: bounded_command(args, CONTROL_ROOT, timeout=15, max_output=65536),
        namespace_run=lambda args, data=None: bounded_command(
            runtime_argv(account)[:-1] + args,
            CONTROL_ROOT,
            timeout=15,
            max_output=65536,
            stdin_bytes=data,
        ),
    )
