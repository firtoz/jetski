"""Lifecycle/failure tests with driver doubles; not native network qualification."""

import copy
import json
import pathlib
import tempfile
import types
import unittest
import uuid
from unittest.mock import Mock
from network_namespace import NetworkNamespace, namespace_name
from network_policy import policy_sha256


class NetworkLifecycleTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.lease = dict(
            owner="owner",
            poolId="pool",
            machineId="host",
            slotId=str(uuid.uuid4()),
            sandboxId=str(uuid.uuid4()),
            assignmentId=str(uuid.uuid4()),
            generation=1,
        )
        self.network = object.__new__(NetworkNamespace)
        self.network.root = pathlib.Path(self.temporary.name)
        self.network.nft = "/usr/sbin/nft"
        self.network.image = "sha256:" + "a" * 64
        self.network.account = types.SimpleNamespace(pw_dir=self.temporary.name)
        self.proof = dict(pid=1234, net=100, user=200, startTime="300")
        self.saved = None
        self.observed = None
        self.network.read = Mock(side_effect=lambda lease: copy.deepcopy(self.saved))

        def write(lease, value):
            self.saved = copy.deepcopy(value)
            self.network.path(lease).touch(exist_ok=True)

        self.network.write = Mock(side_effect=write)
        self.network.inspect = Mock(
            side_effect=lambda *args, **kwargs: copy.deepcopy(self.observed)
        )
        self.network.namespace_argv = Mock(return_value=["private-namespace"])
        self.network.host_run = Mock(
            return_value=dict(exitCode=0, stdout='[{"addr_info":[{"local":"1.1.1.1"}]}]')
        )
        self.network.namespace_run = Mock(return_value=dict(exitCode=0, stdout=""))
        self.network.filter_proof = Mock(return_value="kernel-policy-proof")

        def run(argv):
            self.observed = self.proof
            return dict(exitCode=0, stdout="owned-id")

        self.network.run = Mock(side_effect=run)

    def test_filter_is_installed_and_proved_before_readiness_is_persisted(self):
        ready = self.network.prepare(self.lease)
        self.assertEqual(ready["phase"], "ready")
        self.assertEqual(ready["kernelFilterSha256"], "kernel-policy-proof")
        self.assertIn("/usr/sbin/nft", self.network.namespace_run.call_args.args[0])
        self.assertEqual(self.network.write.call_args_list[0].args[1]["phase"], "creating")
        argv = self.network.run.call_args.args[0]
        self.assertIn(self.network.image, argv)
        self.assertIn("--read-only", argv)
        self.assertEqual(argv[-1], "/jetski-network-keeper")
        self.assertFalse(any("workspace" in value or "home/sandbox" in value for value in argv))

    def test_auto_uses_verified_tc_only_for_known_unsupported_nft_and_never_for_unknown_error(self):
        self.network.filter_backend = "auto"
        self.network.namespace_run.return_value = dict(
            exitCode=1, stdout="", stderr="Operation not supported"
        )
        tc = Mock()
        tc.install.return_value = "tc-proof"
        self.network.tc_filter = Mock(return_value=tc)
        ready = self.network.prepare(self.lease)
        self.assertEqual(ready["filterBackend"], "tc-bpf")
        self.assertEqual(ready["kernelFilterSha256"], "tc-proof")
        tc.install.assert_called_once_with("tap0", ["1.1.1.1"])
        self.network.filter_proof.assert_not_called()
        self.network.path(self.lease).unlink()
        self.saved = self.observed = None
        self.network.namespace_run.return_value = dict(
            exitCode=1, stdout="", stderr="Permission denied"
        )
        with self.assertRaisesRegex(ValueError, "capability_unknown"):
            self.network.prepare(self.lease)
        self.assertEqual(tc.install.call_count, 1)

    def test_lost_start_ack_never_blindly_creates_another_keeper(self):
        self.network.run.side_effect = ConnectionError("lost namespace start acknowledgement")
        with self.assertRaises(ConnectionError):
            self.network.prepare(self.lease)
        with self.assertRaisesRegex(ValueError, "preparation_uncertain"):
            self.network.prepare(self.lease)
        self.assertEqual(self.network.run.call_count, 1)
        self.assertEqual(self.saved["phase"], "creating")

    def test_filter_failure_is_not_published_as_ready(self):
        self.network.namespace_run.return_value = dict(exitCode=1, stdout="")
        with self.assertRaisesRegex(ValueError, "filter_installation_failed"):
            self.network.prepare(self.lease)
        self.assertEqual(self.saved["phase"], "creating")

    def test_changed_namespace_or_filter_refuses_reuse(self):
        self.saved = dict(
            version=1,
            lease=self.lease,
            policy=policy_sha256(),
            phase="ready",
            namespace=self.proof,
            kernelFilterSha256="old",
        )
        self.network.path(self.lease).touch()
        self.observed = {**self.proof, "startTime": "different-process"}
        with self.assertRaisesRegex(ValueError, "missing_or_changed"):
            self.network.prepare(self.lease)
        self.observed = self.proof
        with self.assertRaisesRegex(ValueError, "filter_changed"):
            self.network.verify(self.lease)
        self.network.run.assert_not_called()

    def test_cleanup_observes_positive_absence_and_never_deletes_an_unjournaled_keeper(self):
        self.observed = self.proof
        with self.assertRaisesRegex(ValueError, "unjournaled"):
            self.network.cleanup(self.lease)
        self.network.run.assert_not_called()
        self.saved = dict(
            version=1, lease=self.lease, policy=policy_sha256(), phase="ready", namespace=self.proof
        )
        self.network.path(self.lease).touch()

        def remove(argv):
            self.assertEqual(argv, ["rm", "--force", namespace_name(self.lease)])
            self.observed = None
            return dict(exitCode=0, stdout="")

        self.network.run.side_effect = remove
        self.network.cleanup(self.lease)
        self.assertEqual(self.saved["phase"], "removed")


class KernelPolicyProofTests(unittest.TestCase):
    def test_counters_do_not_change_identity_but_rule_changes_do(self):
        network = object.__new__(NetworkNamespace)
        network.nft = "/usr/sbin/nft"
        network.namespace_argv = Mock(return_value=["private-namespace"])
        body = {
            "nftables": [
                {
                    "chain": {
                        "hook": "egress",
                        "policy": "drop",
                        "dev": "tap0",
                        "type": "filter",
                        "prio": 0,
                    }
                }
            ]
            + [
                {
                    "rule": {
                        "handle": i,
                        "expr": [{"counter": {"packets": i, "bytes": i * 64}}, {"accept": None}],
                    }
                }
                for i in range(5)
            ]
        }
        network.namespace_run = Mock(
            side_effect=lambda argv: dict(exitCode=0, stdout=json.dumps(body))
        )
        first = network.filter_proof({})
        body["nftables"][1]["rule"]["expr"][0]["counter"]["packets"] += 100
        self.assertEqual(first, network.filter_proof({}))
        body["nftables"][1]["rule"]["expr"][1] = {"drop": None}
        self.assertNotEqual(first, network.filter_proof({}))
        body["nftables"][0]["chain"]["policy"] = "accept"
        with self.assertRaisesRegex(ValueError, "structure_mismatch"):
            network.filter_proof({})

    def test_missing_device_in_tool_json_requires_independent_kernel_text_proof(self):
        network = object.__new__(NetworkNamespace)
        network.nft = "/usr/sbin/nft"
        network.namespace_argv = Mock(return_value=["private-namespace"])
        body = {
            "nftables": [
                {"chain": {"hook": "egress", "policy": "drop", "type": "filter", "prio": 0}}
            ]
            + [
                {"rule": {"expr": [{"counter": {"packets": 0, "bytes": 0}}, {"accept": None}]}}
                for _ in range(5)
            ]
        }

        def run(argv):
            if "--json" in argv:
                return dict(exitCode=0, stdout=json.dumps(body))
            return dict(
                exitCode=0, stdout='type filter hook egress device "tap0" priority 0; policy drop;'
            )

        network.namespace_run = Mock(side_effect=run)
        self.assertEqual(len(network.filter_proof({})), 64)
        network.namespace_run.side_effect = lambda argv: (
            dict(exitCode=0, stdout=json.dumps(body))
            if "--json" in argv
            else dict(
                exitCode=0, stdout='type filter hook egress device "other" priority 0; policy drop;'
            )
        )
        with self.assertRaisesRegex(ValueError, "device_unconfirmed"):
            network.filter_proof({})


class ResolverPermissionTests(unittest.TestCase):
    def test_mapped_workload_can_read_but_cannot_write_dns_configuration(self):
        import os
        import tempfile
        from types import SimpleNamespace
        from network_namespace import RESOLVER_BYTES, verify_resolver

        with tempfile.TemporaryDirectory() as directory:
            account = SimpleNamespace(pw_dir=directory, pw_uid=os.getuid())
            resolver = pathlib.Path(directory) / "network-resolv.conf"
            resolver.write_bytes(RESOLVER_BYTES)
            resolver.chmod(0o444)
            verify_resolver(account)
            for mode in (0o400, 0o644, 0o666):
                resolver.chmod(mode)
                with self.assertRaisesRegex(ValueError, "resolver_integrity"):
                    verify_resolver(account)
            resolver.unlink()
            resolver.symlink_to("/etc/resolv.conf")
            with self.assertRaises(OSError):
                verify_resolver(account)


class WorkloadNamespaceGuardTests(unittest.TestCase):
    def test_engine_namespace_must_match_private_keeper_and_mapped_workload_owner(self):
        from unittest.mock import patch

        real_path = pathlib.Path
        with tempfile.TemporaryDirectory() as directory:
            process = real_path(directory) / "42"
            (process / "ns").mkdir(parents=True)
            for namespace in ("user", "net"):
                (process / "ns" / namespace).touch()
            proof = {
                namespace: (process / "ns" / namespace).stat().st_ino
                for namespace in ("user", "net")
            }
            status = process / "status"
            status.write_text(
                "Uid:\t100999 100999 100999 100999\nGid:\t100999 100999 100999 100999\n"
            )
            network = object.__new__(NetworkNamespace)
            network.ownership = dict(workloadUid=100999, workloadGid=100999)
            network.verify = Mock(return_value={"namespace": proof})
            network.run = Mock(return_value=dict(exitCode=0, stdout="42\n"))

            def redirected(*parts):
                if parts[0] == "/proc":
                    return real_path(directory, *parts[1:])
                return real_path(*parts)

            with patch("network_namespace.pathlib.Path", side_effect=redirected):
                network.verify_workload({}, "owned-workload")
                status.write_text("Uid:\t0 0 0 0\nGid:\t100999 100999 100999 100999\n")
                with self.assertRaisesRegex(ValueError, "owner_mismatch"):
                    network.verify_workload({}, "owned-workload")
                proof["user"] += 1
                with self.assertRaisesRegex(ValueError, "namespace_mismatch"):
                    network.verify_workload({}, "owned-workload")
