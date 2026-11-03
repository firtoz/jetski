"""Launcher policy checks; no host cgroups are created or joined here."""

import io
import types
import unittest
from unittest.mock import patch

from gvisor_cgroup import enter
from gvisor_environment import RootlessEnvironment, native_namespace_arguments
from gvisor_oci import RunscCommands


class CgroupPolicyTests(unittest.TestCase):
    def test_rejects_escaping_cgroup_and_arbitrary_executable_before_writes(self):
        account = types.SimpleNamespace(pw_uid=1234)
        with (
            patch("gvisor_cgroup.pwd.getpwnam", return_value=account),
            patch("gvisor_cgroup.os.open", side_effect=AssertionError("must not write")),
        ):
            for path, argv in (
                ("/sys/fs/cgroup", ["/usr/sbin/runuser", "-u", "jetski-runtime", "--", "env"]),
                (
                    "/sys/fs/cgroup/../other",
                    ["/usr/sbin/runuser", "-u", "jetski-runtime", "--", "env"],
                ),
                ("/arbitrary", ["sh", "-c", "echo unsafe"]),
            ):
                with self.assertRaises(ValueError):
                    enter(path, argv)

    def test_native_namespace_requires_the_prepared_exact_subordinate_map(self):
        account = types.SimpleNamespace(pw_uid=1234, pw_name="jetski-runtime")
        ownership = dict(
            uidMappings=[[0, 0, 1], [1, 1, 65536]],
            gidMappings=[[0, 0, 1], [1, 1, 65536]],
            workloadUid=100999,
            workloadGid=100999,
        )

        def table(*args):
            return io.StringIO("jetski-runtime:100000:65536\n")

        with patch("builtins.open", side_effect=table):
            argv = native_namespace_arguments(account, ownership)
            self.assertIn("--map-users=1:100000:65536", argv)
            self.assertIn("--map-groups=1:100000:65536", argv)
            with self.assertRaisesRegex(ValueError, "mapping_conflict"):
                native_namespace_arguments(account, {**ownership, "workloadUid": 101000})
        with patch(
            "builtins.open",
            return_value=io.StringIO("jetski-runtime:100000:65536\njetski-runtime:300000:65536\n"),
        ):
            with self.assertRaisesRegex(ValueError, "single_subordinate_range"):
                native_namespace_arguments(account, ownership)

    def test_only_launch_and_execution_enter_their_exact_workload_cgroup(self):
        environment = object.__new__(RootlessEnvironment)
        environment.account = types.SimpleNamespace(pw_uid=1234)
        environment.namespace_argv = [
            "unshare",
            "--user",
            "--map-user=0",
            "--map-group=0",
            "--map-users=1:100000:65536",
            "--map-groups=1:100000:65536",
        ]
        environment.commands = RunscCommands("/opt/runsc", "/runtime/state")
        name = "jetski-aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa-g2"
        prefix = environment.commands.prefix()
        with patch("gvisor_environment.runtime_argv", return_value=["runuser", "podman"]):
            for action in ("run", "restore", "exec"):
                argv = environment.argv(prefix + [action, name])
                self.assertIn("/opt/jetski/gvisor_cgroup.py", argv)
                self.assertIn("/jetski-gvisor/" + name, " ".join(argv))
                self.assertEqual(argv[-len(prefix + [action, name]) :], prefix + [action, name])
            self.assertEqual(
                environment.argv(prefix + ["list", "--format=json"]),
                ["runuser", *environment.namespace_argv, *prefix, "list", "--format=json"],
            )
