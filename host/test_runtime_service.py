import types
import unittest
from runtime_service import service_environment


class RuntimeServiceTests(unittest.TestCase):
    def test_only_activation_fields_survive_inherited_environment(self):
        account = types.SimpleNamespace(
            pw_uid=1234, pw_name="jetski-runtime", pw_dir="/var/lib/jetski-runtime"
        )
        inherited = {
            "HOME": "/wrong",
            "XDG_RUNTIME_DIR": "/run/user/1",
            "CONTAINERS_STORAGE_CONF": "/wrong/storage.conf",
            "TOKEN": "private",
            "LISTEN_PID": "55",
            "LISTEN_FDS": "1",
            "LISTEN_FDNAMES": "api",
        }
        actual = service_environment(account, inherited)
        self.assertEqual(actual["HOME"], account.pw_dir)
        self.assertEqual(actual["XDG_RUNTIME_DIR"], "/run/user/1234")
        self.assertEqual(actual["LISTEN_PID"], "55")
        self.assertEqual(actual["LISTEN_FDS"], "1")
        self.assertNotIn("CONTAINERS_STORAGE_CONF", actual)
        self.assertNotIn("TOKEN", actual)
        account.pw_uid = 0
        with self.assertRaises(ValueError):
            service_environment(account, inherited)
