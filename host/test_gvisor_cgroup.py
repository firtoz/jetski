"""Launcher policy checks; no host cgroups are created or joined here."""

import types
import unittest
from unittest.mock import patch

from gvisor_cgroup import enter
from gvisor_environment import RootlessEnvironment
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

    def test_only_launch_and_execution_enter_their_exact_workload_cgroup(self):
        environment = object.__new__(RootlessEnvironment)
        environment.account = types.SimpleNamespace(pw_uid=1234)
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
                [
                    "runuser",
                    "podman",
                    "--cgroup-manager=cgroupfs",
                    "unshare",
                    *prefix,
                    "list",
                    "--format=json",
                ],
            )
