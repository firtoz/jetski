"""Filesystem-only fixture for storage qualification; no workload execution."""

import json
import os
import pathlib
import shutil
import sys
from archive import capture, restore
from test_archive import oracle

base = pathlib.Path(sys.argv[2]).resolve()
source = base / "source"
if sys.argv[1] == "capture":
    workspace, home = source / "workspace", source / "home"
    workspace.mkdir(parents=True)
    home.mkdir()
    (workspace / "binary λ").write_bytes(os.urandom(5 * 1024 * 1024 + 17))
    os.chmod(workspace / "binary λ", 0o640)
    os.link(workspace / "binary λ", home / "hardlink")
    (workspace / "empty").touch()
    (home / "relative").symlink_to("../workspace/binary λ")
    (home / "absolute").symlink_to("/workspace/binary λ")
    (home / "dangling").symlink_to("/absent")
    (home / "dir").mkdir(mode=0o751)
    (home / "dir" / "script").write_bytes(b"#!/bin/sh\nprintf fixture\n")
    os.chmod(home / "dir" / "script", 0o755)
    (workspace / ".git").mkdir()
    (workspace / ".git" / "config").write_text("[core]\nfilemode = true\n")
    roots = dict(workspace=workspace, home=home)
    for version in (1, 2):
        if version == 2:
            (workspace / "empty").rename(workspace / "renamed")
            (home / "dangling").unlink()
            (home / "dir" / "script").write_bytes(b"changed\0bytes\xff")
            os.chmod(home / "dir", 0o750)
        (base / f"oracle-{version}.json").write_text(json.dumps(oracle(source), sort_keys=True))
        manifest = capture(roots, base / f"archive-{version}.tgz")
        (base / f"manifest-{version}.json").write_text(json.dumps(manifest))
    shutil.rmtree(source)
    assert not source.exists()
    print(json.dumps(dict(sourceDeleted=True, versions=2)))
elif sys.argv[1] == "restore":
    version = int(sys.argv[3])
    assert version in (1, 2) and not source.exists()
    manifest = json.loads((base / f"manifest-{version}.json").read_text())
    destination = base / f"restored-{version}"
    restore(base / f"download-{version}.tgz", destination, manifest["sha256"])
    expected = json.loads((base / f"oracle-{version}.json").read_text())
    assert oracle(destination) == expected, "independent filesystem oracle differs"
    print(json.dumps(dict(version=version, exact=True, paths=len(expected))))
else:
    raise ValueError("unknown_fixture_action")
