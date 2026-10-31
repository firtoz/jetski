import pathlib
import shutil
import subprocess
import sys
import tempfile
import unittest
from bootstrap import MODULES


class BootstrapTests(unittest.TestCase):
    def test_installed_bundle_imports_without_source_checkout(self):
        with tempfile.TemporaryDirectory(prefix="jetski-installed-") as temporary:
            installed = pathlib.Path(temporary)
            source = pathlib.Path(__file__).resolve().parent
            for module in MODULES:
                shutil.copyfile(source / module, installed / module)
            result = subprocess.run(
                [
                    sys.executable,
                    "-I",
                    "-c",
                    "import sys; sys.path.insert(0,sys.argv[1]); import control; import commands",
                    str(installed),
                ],
                cwd="/",
                capture_output=True,
                text=True,
                timeout=10,
            )
            self.assertEqual(result.returncode, 0, result.stderr)


if __name__ == "__main__":
    unittest.main()
