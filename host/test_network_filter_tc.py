import ipaddress
import json
import struct
import unittest

from network_filter_tc import TcBpfEgressFilter, instructions, fingerprint, PREFERENCE


def packet(destination, protocol=17, port=443, source="10.0.2.100", fragment=0):
    ip = struct.pack(
        "!BBHHHBBHII",
        0x45,
        0,
        28,
        1,
        fragment,
        64,
        protocol,
        0,
        int(ipaddress.ip_address(source)),
        int(ipaddress.ip_address(destination)),
    )
    return b"\x00" * 12 + b"\x08\x00" + ip + struct.pack("!HHHH", 12345, port, 8, 0)


def evaluate(program, data):
    """Independent classic-BPF VM; out-of-bounds has the actual TC_OK behavior."""
    a = x = pc = 0
    for _ in range(4096):
        row = program[pc]
        op, k = row["code"], row["k"]
        pc += 1
        if op in (0x20, 0x28, 0x30, 0x48):
            width = {0x20: 4, 0x28: 2, 0x30: 1, 0x48: 2}[op]
            offset = k + (x if op == 0x48 else 0)
            if offset + width > len(data):
                return 0
            a = int.from_bytes(data[offset : offset + width], "big")
        elif op == 0xB1:
            if k >= len(data):
                return 0
            x = (data[k] & 15) * 4
        elif op == 0x80:
            a = len(data)
        elif op == 0x54:
            a &= k
        elif op == 0x1C:
            a = (a - x) & 0xFFFFFFFF
        elif op in (0x15, 0x35, 0x45, 0x3D):
            condition = {0x15: a == k, 0x35: a >= k, 0x45: bool(a & k), 0x3D: a >= x}[op]
            pc += row["jt"] if condition else row["jf"]
        elif op == 0x05:
            pc += k
        elif op == 0x06:
            return k
        else:
            raise AssertionError("Unsupported opcode")
    raise AssertionError("Non-terminating filter")


class TcPolicyTests(unittest.TestCase):
    def test_public_private_dns_source_and_fragment_boundaries(self):
        code = instructions(["8.8.8.8", "10.39.1.2"])
        for address in [
            "127.0.0.1",
            "10.39.1.2",
            "10.0.2.2",
            "169.254.169.254",
            "192.168.1.1",
            "100.100.100.200",
            "172.17.0.1",
            "168.63.129.16",
            "8.8.8.8",
            "224.0.0.1",
        ]:
            self.assertEqual(evaluate(code, packet(address)), 2, address)
        self.assertEqual(evaluate(code, packet("1.1.1.1")), 0)
        self.assertEqual(evaluate(code, packet("1.1.1.1", source="10.39.1.2")), 2)
        self.assertEqual(evaluate(code, packet("1.1.1.1", protocol=47)), 2)
        for protocol in [6, 17]:
            self.assertEqual(evaluate(code, packet("10.0.2.3", protocol, 53)), 0)
            self.assertEqual(evaluate(code, packet("10.0.2.3", protocol, 80)), 2)
            self.assertEqual(evaluate(code, packet("10.0.2.3", protocol, 53, fragment=1)), 2)
        for address in ["169.254.169.254", "10.0.2.3"]:
            value = packet(address, port=53)
            for size in range(38):
                self.assertEqual(evaluate(code, value[:size]), 2, (address, size))
        self.assertEqual(evaluate(code, b"\x00" * 12 + b"\x86\xdd" + b"\x00" * 50), 2)

    def test_large_header_cannot_underflow_length_and_large_inventory_uses_long_jumps(self):
        code = instructions([])
        truncated = bytearray(packet("10.0.2.3", port=80))
        truncated[14] = 0x4F
        self.assertEqual(evaluate(code, truncated), 2)
        many = instructions([str(ipaddress.ip_address(0x08080000 + n)) for n in range(256)])
        self.assertLessEqual(len(many), 4096)
        self.assertTrue(any(row["code"] == 0x05 and row["k"] > 255 for row in many))
        self.assertEqual(evaluate(many, packet("1.1.1.1")), 0)
        self.assertEqual(evaluate(many, packet("8.8.0.200")), 2)

    def test_inspection_requires_exact_exclusive_kernel_bytecode(self):
        code = instructions([])
        rows = [
            dict(kind="bpf", protocol="all", pref=PREFERENCE, chain=0),
            dict(
                kind="bpf",
                protocol="all",
                pref=PREFERENCE,
                chain=0,
                options={
                    "handle": "0x1",
                    "direct-action": True,
                    "bytecode": {"length": len(code), "insns": code},
                },
            ),
        ]
        runtime = TcBpfEgressFilter(
            "/usr/sbin/tc", lambda _: dict(exitCode=0, stdout=json.dumps(rows))
        )
        self.assertEqual(runtime.proof("tap0"), fingerprint(code))
        rows[1]["options"]["direct-action"] = False
        with self.assertRaisesRegex(ValueError, "action_changed"):
            runtime.proof("tap0")
        rows[1]["options"]["direct-action"] = True
        rows.append(dict(kind="flower", protocol="all", pref=1, chain=0))
        with self.assertRaisesRegex(ValueError, "filter_set_changed"):
            runtime.proof("tap0")
