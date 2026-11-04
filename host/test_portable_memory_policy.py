import copy
import unittest
import uuid

from gvisor_oci import RunscCommands, sandbox_spec
from portable_memory_policy import configuration_sha256, cpu_features


class PortablePolicyTests(unittest.TestCase):
    def setUp(self):
        self.lease = dict(
            owner="owner",
            poolId="pool",
            machineId="source",
            slotId=str(uuid.uuid4()),
            sandboxId=str(uuid.uuid4()),
            assignmentId=str(uuid.uuid4()),
            generation=1,
        )
        self.image = "example/linux@sha256:" + "a" * 64

    def prepare(self, lease=None, prefix="/source"):
        lease = lease or self.lease
        paths = dict(
            image_root=prefix + "/image",
            assignment=prefix + "/assignment",
            cgroup_path=prefix + "/cgroup",
            runtime=RunscCommands(prefix + "/runsc", prefix + "/state").prefix(),
        )
        spec = sandbox_spec(
            lease, self.image, paths["image_root"], paths["assignment"], paths["cgroup_path"]
        )
        return spec, paths

    def test_physical_host_and_lease_changes_preserve_logical_policy(self):
        spec, paths = self.prepare()
        source = configuration_sha256(spec, self.lease, **paths)
        other = {
            **self.lease,
            "machineId": "replacement",
            "assignmentId": str(uuid.uuid4()),
            "generation": 9,
        }
        target, target_paths = self.prepare(other, "/replacement")
        self.assertEqual(source, configuration_sha256(target, other, **target_paths))
        self.assertEqual(spec["root"]["path"], paths["image_root"])

    def test_resource_execution_and_isolation_changes_remain_in_digest(self):
        spec, paths = self.prepare()
        source = configuration_sha256(spec, self.lease, **paths)
        for change in (
            lambda s: s["linux"]["resources"]["memory"].update(limit=1024),
            lambda s: s["process"]["args"].append("different"),
            lambda s: s["process"].update(noNewPrivileges=False),
        ):
            changed = copy.deepcopy(spec)
            change(changed)
            self.assertNotEqual(source, configuration_sha256(changed, self.lease, **paths))
        changed_paths = copy.deepcopy(paths)
        changed_paths["runtime"].append("--network=host")
        self.assertNotEqual(source, configuration_sha256(spec, self.lease, **changed_paths))

    def test_paths_cannot_be_normalized_without_matching_expected_identity(self):
        spec, paths = self.prepare()
        spec["mounts"][-3]["source"] = "/other-owner/home"
        with self.assertRaises(ValueError):
            configuration_sha256(spec, self.lease, **paths)

    def test_cpu_baseline_is_explicit_sorted_and_not_mutable_by_caller(self):
        value = ["sse", "sse2"]
        parsed = cpu_features(value)
        value.append("sse3")
        self.assertEqual(parsed, ["sse", "sse2"])
        for invalid in ([], ["sse2", "sse"], ["sse", "sse"], ["x,y"], "sse"):
            with self.assertRaises(ValueError):
                cpu_features(invalid)


if __name__ == "__main__":
    unittest.main()
