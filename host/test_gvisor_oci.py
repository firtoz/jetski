import copy
import unittest
import uuid

from gvisor_oci import (
    RunscCommands,
    container_name,
    process_spec,
    sandbox_spec,
    specification_sha256,
)


class OciPolicyTests(unittest.TestCase):
    def setUp(self):
        self.lease = dict(
            owner="owner",
            poolId="pool",
            machineId="machine",
            slotId=str(uuid.uuid4()),
            sandboxId=str(uuid.uuid4()),
            assignmentId=str(uuid.uuid4()),
            generation=1,
        )
        self.image = "example/linux@sha256:" + "a" * 64

    def spec(self, **options):
        return sandbox_spec(
            self.lease,
            self.image,
            "/images/rootfs",
            "/data/assignment",
            "/delegated/workload",
            **options,
        )

    def test_fixed_isolation_and_resource_policy(self):
        spec = self.spec(memory_mb=2048, cpus=2)
        self.assertTrue(spec["root"]["readonly"])
        self.assertTrue(spec["process"]["noNewPrivileges"])
        self.assertEqual(spec["process"]["user"]["uid"], 1000)
        self.assertTrue(all(not caps for caps in spec["process"]["capabilities"].values()))
        self.assertTrue(all(set(ns) == {"type"} for ns in spec["linux"]["namespaces"]))
        self.assertIn({"type": "network"}, spec["linux"]["namespaces"])
        self.assertNotIn("hooks", spec)
        self.assertNotIn("uidMappings", spec["linux"])
        self.assertEqual(spec["linux"]["resources"]["memory"]["limit"], 2048 * 1024**2)
        self.assertEqual(spec["linux"]["resources"]["cpu"]["quota"], 200000)
        writable = {
            m["destination"] for m in spec["mounts"] if m["type"] == "bind" and "rw" in m["options"]
        }
        self.assertEqual(writable, {"/workspace", "/home/sandbox"})
        changed = copy.deepcopy(spec)
        changed["linux"]["resources"]["cpu"]["quota"] += 1
        self.assertNotEqual(specification_sha256(spec), specification_sha256(changed))

    def test_optional_operator_init_changes_configuration_without_host_privileges(self):
        spec = self.spec(init_argv=["/workspace/application", "--serve"])
        self.assertEqual(spec["process"]["args"], ["/workspace/application", "--serve"])
        self.assertEqual(spec["process"]["user"]["uid"], 1000)
        self.assertTrue(spec["process"]["noNewPrivileges"])

    def test_untrusted_argv_is_data_and_bounds_are_enforced(self):
        argv = ["--rootless=true", "$(command)", "'quoted'", "line\nbreak"]
        self.assertEqual(process_spec(argv)["args"], argv)
        for invalid in ([], [""], ["echo", "\0"], ["x"] * 257, ["x" * 65537]):
            with self.assertRaises(ValueError):
                process_spec(invalid)
        with self.assertRaises(ValueError):
            process_spec(["sh"], cwd="/etc")
        with self.assertRaises(ValueError):
            process_spec(["sh"], cwd="/workspace/../etc")
        with self.assertRaises(ValueError):
            self.spec(memory_mb=True)

    def test_native_flags_cannot_select_host_network_or_lazy_unverified_restore(self):
        runsc = RunscCommands("/opt/gvisor/runsc", "/runtime/state")
        restore = runsc.command(
            "restore", self.lease, bundle="/runtime/bundle", image="/runtime/memory"
        )
        self.assertIn("--platform=systrap", restore)
        self.assertIn("--network=sandbox", restore)
        self.assertIn("--rootless=false", restore)
        self.assertIn("--background=false", restore)
        self.assertEqual(restore[-1], container_name(self.lease))
        with self.assertRaises(ValueError):
            runsc.command(
                "restore", self.lease, bundle="/runtime/bundle", image="/runtime/../secret"
            )
        with self.assertRaises(ValueError):
            runsc.command("shell", self.lease)


if __name__ == "__main__":
    unittest.main()
