"""Verified classic BPF at tc egress: same public IPv4 policy as nft netdev.

Classic BPF avoids the privileged BPF syscall. Packet loads are length-checked:
the kernel's implicit zero on an out-of-bounds load is TC_ACT_OK, not a denial.
"""

import hashlib
import ipaddress
import json

from network_policy import DENIED_IPV4, DNS_IPV4, GUEST_IPV4, host_ipv4_addresses

TC_OK = 0
TC_DROP = 2
PREFERENCE = 49152


def instructions(host_addresses):
    code, labels, jumps = [], {}, []

    def emit(op, k=0, jt=0, jf=0):
        code.append(dict(code=op, jt=jt, jf=jf, k=k))

    def jump(label):
        jumps.append((len(code), label))
        emit(0x05)

    def branch(op, k, label, when=True):
        emit(op, k, jt=0 if when else 1, jf=1 if when else 0)
        jump(label)

    def label(name):
        labels[name] = len(code)

    emit(0x80)  # packet length
    branch(0x35, 14, "drop", when=False)
    emit(0x28, 12)  # Ethernet type
    branch(0x15, 0x0806, "accept")  # ARP, as in the nft policy
    branch(0x15, 0x0800, "drop", when=False)
    emit(0x80)
    branch(0x35, 34, "drop", when=False)
    emit(0x30, 14)
    emit(0x54, 0xF0)
    branch(0x15, 0x40, "drop", when=False)
    emit(0x30, 14)
    emit(0x54, 0x0F)
    branch(0x35, 5, "drop", when=False)
    emit(0x20, 26)  # source IPv4
    branch(0x15, int(ipaddress.ip_address(GUEST_IPV4)), "drop", when=False)
    emit(0x20, 30)
    branch(0x15, int(ipaddress.ip_address(DNS_IPV4)), "dns")
    networks = [*DENIED_IPV4, *[host + "/32" for host in host_ipv4_addresses(host_addresses)]]
    for value in networks:
        network = ipaddress.ip_network(value)
        emit(0x20, 30)
        emit(0x54, int(network.netmask))
        branch(0x15, int(network.network_address), "drop")
    emit(0x30, 23)  # protocol
    for protocol in (6, 17, 1):
        branch(0x15, protocol, "accept")
    jump("drop")
    label("dns")
    emit(0x30, 23)
    branch(0x15, 6, "ports")
    branch(0x15, 17, "drop", when=False)
    label("ports")
    emit(0x28, 20)
    branch(0x45, 0x1FFF, "drop")  # no port load from a non-initial fragment
    emit(0xB1, 14)  # X = IPv4 header length
    emit(0x80)
    branch(0x3D, 0, "drop", when=False)  # length >= X, before unsigned subtraction
    emit(0x1C)  # length - X
    branch(0x35, 18, "drop", when=False)
    emit(0x48, 16)  # destination port at Ethernet + IP header + 2
    branch(0x15, 53, "accept")
    jump("drop")
    label("accept")
    emit(0x06, TC_OK)
    label("drop")
    emit(0x06, TC_DROP)
    for index, target in jumps:
        distance = labels[target] - index - 1
        if distance < 0:
            raise ValueError("backward_network_filter_jump")
        code[index]["k"] = distance
    if len(code) > 4096:
        raise ValueError("network_filter_program_bound")
    return code


def bytecode(code):
    return (
        str(len(code))
        + ","
        + ",".join(f"{row['code']} {row['jt']} {row['jf']} {row['k']}" for row in code)
        + ","
    )


def fingerprint(code):
    return hashlib.sha256(
        json.dumps(code, sort_keys=True, separators=(",", ":")).encode()
    ).hexdigest()


class TcBpfEgressFilter:
    def __init__(self, tc, run):
        self.tc, self.run = tc, run

    def install(self, device, hosts):
        # Names come from the fixed keeper protocol, never workload input.
        if device != "tap0":
            raise ValueError("unsupported_filter_device")
        code = instructions(hosts)
        qdisc = self.run([self.tc, "qdisc", "add", "dev", device, "clsact"])
        if qdisc["exitCode"]:
            raise ValueError("network_tc_qdisc_unconfirmed")
        result = self.run(
            [
                self.tc,
                "filter",
                "add",
                "dev",
                device,
                "egress",
                "protocol",
                "all",
                "pref",
                str(PREFERENCE),
                "handle",
                "1",
                "bpf",
                "bytecode",
                bytecode(code),
                "da",
            ]
        )
        if result["exitCode"]:
            raise ValueError("network_tc_installation_unconfirmed")
        observed = self.proof(device)
        if observed != fingerprint(code):
            raise ValueError("network_tc_bytecode_mismatch")
        return observed

    def proof(self, device):
        result = self.run([self.tc, "-j", "-d", "filter", "show", "dev", device, "egress"])
        if result["exitCode"] or len(result["stdout"].encode()) > 65536:
            raise ValueError("network_tc_inventory_unavailable")
        rows = json.loads(result["stdout"])
        if not isinstance(rows, list) or len(rows) != 2:
            raise ValueError("network_tc_filter_set_changed")
        for row in rows:
            if (
                row.get("kind") != "bpf"
                or row.get("protocol") != "all"
                or row.get("pref") != PREFERENCE
                or row.get("chain") != 0
            ):
                raise ValueError("network_tc_filter_identity_changed")
        leaves = [row["options"] for row in rows if "options" in row]
        if (
            len(leaves) != 1
            or leaves[0].get("handle") != "0x1"
            or leaves[0].get("direct-action") is not True
        ):
            raise ValueError("network_tc_action_changed")
        value = leaves[0].get("bytecode", {})
        code = value.get("insns")
        if (
            not isinstance(code, list)
            or not 1 <= len(code) <= 4096
            or value.get("length") != len(code)
        ):
            raise ValueError("network_tc_bytecode_unavailable")
        if any(
            set(row) != {"code", "jt", "jf", "k"} or any(type(v) is not int for v in row.values())
            for row in code
        ):
            raise ValueError("network_tc_bytecode_invalid")
        return fingerprint(code)
