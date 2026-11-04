import unittest
from network_policy import allowed, host_ipv4_addresses, ruleset, policy_sha256


class PublicEgressPolicyTests(unittest.TestCase):
    def test_dns_does_not_authorize_host_private_metadata_or_ipv6_access(self):
        for destination in (
            "127.0.0.1",
            "10.0.2.2",
            "10.3.4.5",
            "192.168.1.1",
            "172.16.0.1",
            "100.100.100.200",
            "169.254.169.254",
            "168.63.129.16",
            "::1",
            "::ffff:127.0.0.1",
            "2606:4700:4700::1111",
            "224.0.0.1",
            "255.255.255.255",
        ):
            self.assertFalse(allowed(destination, 443, "tcp"), destination)
        self.assertTrue(allowed("10.0.2.3", 53, "udp"))
        self.assertTrue(allowed("10.0.2.3", 53, "tcp"))
        self.assertFalse(allowed("10.0.2.3", 80, "tcp"))
        self.assertTrue(allowed("1.1.1.1", 443, "tcp"))
        self.assertFalse(allowed("1.1.1.1", 443, "tcp", ["1.1.1.1"]))

    def test_rules_and_inventory_are_bounded_canonical_and_not_shell_input(self):
        self.assertEqual(host_ipv4_addresses(["1.1.1.1", "::1", "1.1.1.1"]), ["1.1.1.1"])
        self.assertEqual(
            ruleset("tap0", ["8.8.8.8", "1.1.1.1"]), ruleset("tap0", ["1.1.1.1", "8.8.8.8"])
        )
        self.assertIn("policy drop", ruleset("tap0", []))
        self.assertEqual(len(policy_sha256()), 64)
        for device in ('tap0"; flush ruleset;', "../net", "x" * 16):
            with self.assertRaises(ValueError):
                ruleset(device, [])
        with self.assertRaises(ValueError):
            ruleset("tap0", ["not-an-ip"])
