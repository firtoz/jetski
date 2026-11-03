"""Opt-in, bounded stage diagnostics; never a lifecycle receipt or workload output."""

import contextlib
import json
import os
import sys
import time

_ENABLED = os.environ.get("JETSKI_HOST_TIMING") == "1"


@contextlib.contextmanager
def stage(name):
    if not _ENABLED:
        yield
        return
    started = time.perf_counter_ns()
    outcome = "error"
    try:
        yield
        outcome = "ok"
    finally:
        try:
            record = dict(
                stage=name, elapsedMs=(time.perf_counter_ns() - started) / 1e6, outcome=outcome
            )
            sys.stderr.write("JETSKI-STAGE/1:" + json.dumps(record, separators=(",", ":")) + "\n")
        except Exception:
            pass  # Diagnostic failures cannot change an acknowledged outcome.
