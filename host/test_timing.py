import contextlib
import io
import json
import unittest
from unittest.mock import patch
import timing


class TimingTests(unittest.TestCase):
    def test_disabled_and_diagnostic_failure_do_not_change_work(self):
        with (
            patch.object(timing, "_ENABLED", False),
            contextlib.redirect_stderr(io.StringIO()) as output,
        ):
            with timing.stage("archive.restore"):
                pass
            self.assertEqual(output.getvalue(), "")
        with patch.object(timing, "_ENABLED", True), patch.object(timing.sys, "stderr", None):
            with timing.stage("archive.restore"):
                pass

    def test_original_error_is_preserved_without_error_details(self):
        original = ValueError("private-payload")
        with (
            patch.object(timing, "_ENABLED", True),
            contextlib.redirect_stderr(io.StringIO()) as output,
        ):
            with self.assertRaises(ValueError) as raised:
                with timing.stage("archive.restore"):
                    raise original
            self.assertIs(raised.exception, original)
            record = json.loads(output.getvalue().split(":", 1)[1])
            self.assertEqual(record["outcome"], "error")
            self.assertGreaterEqual(record["elapsedMs"], 0)
            self.assertNotIn("private", output.getvalue())
