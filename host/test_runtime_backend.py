import copy
import json
import hashlib
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

    def test_image_mapping_preparation_never_starts_a_workload(self):
        image = "example/linux@sha256:" + "a" * 64
        label = hashlib.sha256(image.encode()).hexdigest()
        name = "jetski-bootstrap-" + label[:32]
        image_id = "b" * 64
        container = dict(
            Name=name,
            Image="sha256:" + image_id,
            Mounts=[],
            Config=dict(User="1000:1000", Labels={"org.jetski.bootstrap-image": label}),
            State=dict(Status="created", Running=False, Pid=0),
        )
        calls = []
        present = False
        lose_create_ack = False
        lose_remove_ack = False

        def run(args):
            nonlocal present, lose_create_ack, lose_remove_ack
            calls.append(args)
            if args[:2] == ["image", "inspect"]:
                return dict(exitCode=0, stdout="sha256:" + image_id)
            if args[:2] == ["container", "exists"]:
                return dict(exitCode=0 if present else 1, stdout="")
            if args[0] == "create":
                self.assertFalse(present)
                present = True
                if lose_create_ack:
                    lose_create_ack = False
                    raise TimeoutError("create_ack_lost")
                return dict(exitCode=0, stdout="c" * 64)
            if args[0] == "inspect":
                return dict(exitCode=0, stdout=json.dumps([container]))
            self.assertEqual(args, ["rm", name])
            present = False
            if lose_remove_ack:
                lose_remove_ack = False
                raise TimeoutError("remove_ack_lost")
            return dict(exitCode=0, stdout=name)

        backend = PodmanBackend()
        backend.prepare_image(run, image)
        self.assertFalse(present)
        create = next(args for args in calls if args[0] == "create")
        self.assertIn("--userns=keep-id:uid=1000,gid=1000", create)
        self.assertIn("--network=none", create)
        self.assertIn("--image-volume=ignore", create)
        self.assertIn("--pull=never", create)
        self.assertFalse(any(args[0] in ("start", "run") for args in calls))
        calls.clear()
        lose_create_ack = True
        with self.assertRaisesRegex(TimeoutError, "create_ack_lost"):
            backend.prepare_image(run, image)
        self.assertTrue(present)
        calls.clear()
        backend.prepare_image(run, image)
        self.assertFalse(present)
        self.assertFalse(any(args[0] == "create" for args in calls))
        lose_remove_ack = True
        with self.assertRaisesRegex(TimeoutError, "remove_ack_lost"):
            backend.prepare_image(run, image)
        self.assertFalse(present)
        backend.prepare_image(run, image)
        self.assertFalse(present)

        for key, value in [
            ("Image", "sha256:" + "d" * 64),
            ("Mounts", [dict(Source="/protected")]),
            ("Name", "another-container"),
            ("State", dict(Status="running", Running=True, Pid=42)),
            ("Config", dict(User="1000:1000", Labels={})),
        ]:
            original = container[key]
            container[key] = value
            present = True
            calls.clear()
            with self.assertRaisesRegex(ValueError, "identity_conflict"):
                backend.prepare_image(run, image)
            self.assertFalse(any(args[0] in ("rm", "create") for args in calls))
            container[key] = original
        calls.clear()
        with self.assertRaisesRegex(ValueError, "digest_pinned"):
            backend.prepare_image(run, "unapproved:latest")
        self.assertEqual(calls, [])

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
