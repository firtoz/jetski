import copy
import json
import unittest
from runtime_backend import PodmanBackend


class BackendProbeTests(unittest.TestCase):
    def test_podman_probe_checks_runtime_requirements(self):
        info = dict(
            host=dict(security=dict(rootless=True), cgroupVersion="v2"),
            version=dict(Version="4.9.3"),
            store=dict(graphDriverName="overlay"),
        )
        calls = []

        def run(argv):
            calls.append(argv)
            return dict(exitCode=0, stdout=json.dumps(info))

        self.assertEqual(
            PodmanBackend().probe(run), dict(podmanVersion="4.9.3", storageDriver="overlay")
        )
        self.assertEqual(calls, [["info", "--format", "json"]])
        info["store"]["graphOptions"] = {
            "overlay.mount_program": {"Executable": "/usr/bin/fuse-overlayfs"}
        }
        self.assertEqual(
            PodmanBackend().probe(run)["storageMountProgram"], "/usr/bin/fuse-overlayfs"
        )
        for field, key, value in [
            ("version", "Version", "3.0"),
            ("store", "graphDriverName", "unknown"),
            ("host", "cgroupVersion", "v1"),
        ]:
            invalid = copy.deepcopy(info)
            invalid[field][key] = value
            with self.assertRaises(ValueError):
                PodmanBackend().probe(lambda _: dict(exitCode=0, stdout=json.dumps(invalid)))
        invalid = copy.deepcopy(info)
        invalid["host"]["security"]["rootless"] = False
        with self.assertRaises(ValueError):
            PodmanBackend().probe(lambda _: dict(exitCode=0, stdout=json.dumps(invalid)))
        with self.assertRaisesRegex(ValueError, "unavailable"):
            PodmanBackend().probe(lambda _: dict(exitCode=1, stdout=""))

    def test_injected_probe_cannot_replace_shared_host_identity(self):
        import types
        from unittest.mock import patch, Mock
        from supervisor import preflight

        path = Mock()
        path.is_file.return_value = True
        path.exists.return_value = True
        path.read_text.return_value = "jetski-runtime:100000:65536"
        config = dict(machineId="owned", poolId="pool")
        account = types.SimpleNamespace(pw_uid=1000)
        backend = types.SimpleNamespace(probe=Mock(return_value=dict(runtimeId="fixture")))
        with (
            patch("supervisor.platform.system", return_value="Linux"),
            patch("supervisor.platform.machine", return_value="x86_64"),
            patch("supervisor.pathlib.Path", return_value=path),
        ):
            result = preflight(config, account, None, backend)
            self.assertEqual(result["machineId"], "owned")
            self.assertEqual(result["runtimeId"], "fixture")
            for key in [
                "machineId",
                "ready",
                "rootless",
                "poolId",
                "architecture",
                "version",
                "networkMode",
            ]:
                backend.probe.return_value = {key: "forged"}
                with self.assertRaisesRegex(ValueError, "authority_conflict"):
                    preflight(config, account, None, backend)
            backend.probe.return_value = dict(
                storageDriver="overlay", storageMountProgram="/usr/bin/fuse-overlayfs"
            )
            config["storageMode"] = "fuse-overlayfs"
            self.assertTrue(preflight(config, account, None, backend)["ready"])
            backend.probe.return_value = dict(storageDriver="overlay")
            with self.assertRaisesRegex(ValueError, "requested_storage_mode_unavailable"):
                preflight(config, account, None, backend)
            backend.probe.reset_mock()
            path.is_file.return_value = False
            with self.assertRaisesRegex(ValueError, "cgroup_v2_required"):
                preflight(config, account, None, backend)
            backend.probe.assert_not_called()
