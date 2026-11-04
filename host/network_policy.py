"""Versioned public-IPv4 egress policy; never inferred from workload input.

The initial policy intentionally refuses IPv6. DNS uses only the private virtual
resolver; a DNS answer never grants access to a non-public destination. A trusted
namespace adapter installs these rules before admitting workload execution.
"""

import hashlib
import ipaddress
import re

VERSION = 1
GUEST_IPV4 = "10.0.2.100"
DNS_IPV4 = "10.0.2.3"
DENIED_IPV4 = (
    "0.0.0.0/8",
    "10.0.0.0/8",
    "100.64.0.0/10",
    "127.0.0.0/8",
    "169.254.0.0/16",
    "172.16.0.0/12",
    "192.0.0.0/24",
    "192.0.2.0/24",
    "192.88.99.0/24",
    "192.168.0.0/16",
    "198.18.0.0/15",
    "198.51.100.0/24",
    "203.0.113.0/24",
    "224.0.0.0/4",
    "240.0.0.0/4",
    "168.63.129.16/32",
)
TABLE = "jetski_public_egress"


def host_ipv4_addresses(addresses):
    if not isinstance(addresses, (list, tuple)) or len(addresses) > 256:
        raise ValueError("invalid_host_address_inventory")
    values = []
    for value in addresses:
        address = ipaddress.ip_address(value)
        if address.version == 4:
            values.append(str(address))
    return sorted(set(values))


def allowed(destination, port, protocol, host_addresses=()):
    """Reference predicate for policy tests; kernel filtering is independently qualified."""
    address = ipaddress.ip_address(destination)
    hosts = host_ipv4_addresses(host_addresses)
    if address.version != 4 or protocol not in ("tcp", "udp", "icmp"):
        return False
    if str(address) == DNS_IPV4 and protocol in ("tcp", "udp") and port == 53:
        return True
    if str(address) in hosts:
        return False
    return not any(address in ipaddress.ip_network(network) for network in DENIED_IPV4)


def ruleset(device, host_addresses):
    if not isinstance(device, str) or not re.fullmatch(r"[a-zA-Z][a-zA-Z0-9_-]{0,14}", device):
        raise ValueError("invalid_namespace_device")
    hosts = host_ipv4_addresses(host_addresses)
    denied = ", ".join([*DENIED_IPV4, *[value + "/32" for value in hosts]])
    return f'''table netdev {TABLE} {{
 chain outbound {{
  type filter hook egress device "{device}" priority 0; policy drop;
  ether type arp counter accept
  ether type ip ip saddr {GUEST_IPV4} ip daddr {DNS_IPV4} udp dport 53 counter accept
  ether type ip ip saddr {GUEST_IPV4} ip daddr {DNS_IPV4} tcp dport 53 counter accept
  ether type ip ip daddr {{ {denied} }} counter drop
  ether type ip ip saddr {GUEST_IPV4} ip protocol {{ tcp, udp, icmp }} counter accept
 }}
}}
'''


def policy_sha256():
    # Physical device and current host addresses are verified per placement;
    # the semantic policy is stable across compatible replacement hosts.
    return hashlib.sha256(ruleset("tap0", ()).encode()).hexdigest()
