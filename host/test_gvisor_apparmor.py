"""Policy admission checks; never loads a desktop profile or changes a sysctl."""

import unittest
from unittest.mock import Mock, patch

from gvisor_apparmor import configure


class NamespacePolicyTests(unittest.TestCase):
    def test_unrestricted_host_never_loads_policy(self):
        restriction = Mock()
        restriction.exists.return_value = False
        with (
            patch("gvisor_apparmor.os.geteuid", return_value=0),
            patch("gvisor_apparmor.RESTRICTION", restriction),
            patch("gvisor_apparmor.subprocess.run", side_effect=AssertionError("must not load")),
        ):
            self.assertEqual(configure(), "not-required")

    def test_unknown_restriction_or_missing_loader_refuses_before_profile_access(self):
        restriction, profile = Mock(), Mock()
        restriction.exists.return_value = True
        with (
            patch("gvisor_apparmor.os.geteuid", return_value=0),
            patch("gvisor_apparmor.RESTRICTION", restriction),
            patch("gvisor_apparmor.PROFILE", profile),
            patch("gvisor_apparmor.shutil.which", return_value=None),
        ):
            restriction.read_text.return_value = "2"
            with self.assertRaisesRegex(ValueError, "unknown_namespace_restriction"):
                configure()
            restriction.read_text.return_value = "1"
            with self.assertRaisesRegex(ValueError, "loader_unavailable"):
                configure()
            profile.parent.lstat.assert_not_called()
