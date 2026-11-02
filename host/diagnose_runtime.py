"""Read-only diagnostics on a disposable, owned qualification host."""

import json
import os
import pathlib
import re
import sys


def diagnose():
    if os.geteuid() != 0:
        raise ValueError("root_diagnostic_required")
    sys.path.insert(0, "/opt/jetski/host")
    from supervisor import runtime_account
    from podman_exec import ExecApi

    account = runtime_account()
    path = pathlib.Path("/var/lib/jetski/control/slot/state.json")
    if not path.exists():
        return {"assignment": False}
    state = json.loads(path.read_text())
    runtime = state.get("runtime", {})
    result = dict(phase=state.get("phase"), runtimePhase=runtime.get("phase"))
    name = runtime.get("name", "")
    if re.fullmatch(r"jetski-[a-f0-9-]{36}", name):
        status, container = ExecApi(account.pw_uid).request(
            "GET", "/containers/" + name + "/json", statuses=(200, 404)
        )
        result["inspectStatus"] = status
        if container:
            details = container.get("State", {})
            result["container"] = {
                "status": details.get("Status"),
                "running": details.get("Running"),
                "error": str(details.get("Error", ""))[:2048],
            }
    assignment = state.get("lease", {}).get("assignmentId", "")
    if re.fullmatch(r"[a-f0-9-]{36}", assignment):
        parent = pathlib.Path("/var/lib/jetski/data") / assignment
        result["paths"] = []
        for relative in ("", "workspace", "home"):
            path = parent / relative
            if path.exists():
                info = path.lstat()
                result["paths"].append(
                    dict(
                        path=relative,
                        uid=info.st_uid,
                        gid=info.st_gid,
                        mode=oct(info.st_mode & 4095),
                    )
                )
    return result


if __name__ == "__main__":
    print(json.dumps(diagnose()))
