"""Collect pinned dependency and compiler notices beside the standalone artifact."""

import json
import pathlib
import shutil
import subprocess
import sys

root = pathlib.Path(__file__).resolve().parent
output = pathlib.Path(sys.argv[1]) / "notices"
output.mkdir(parents=True, exist_ok=True)
metadata = json.loads(
    subprocess.check_output(
        [
            "cargo",
            "metadata",
            "--locked",
            "--format-version",
            "1",
            "--filter-platform",
            "x86_64-unknown-linux-musl",
            "--manifest-path",
            str(root / "Cargo.toml"),
        ]
    )
)
inventory = []
for package in metadata["packages"]:
    if package["name"] == "jetski-host":
        continue
    source = pathlib.Path(package["manifest_path"]).parent
    selected = [
        p
        for p in source.iterdir()
        if p.is_file() and p.name.upper().startswith(("LICENSE", "COPYING", "COPYRIGHT", "NOTICE"))
    ]
    if not selected or not package.get("license"):
        raise ValueError("dependency_license_review_required: " + package["name"])
    directory = output / (package["name"] + "-" + package["version"])
    directory.mkdir(exist_ok=True)
    for path in selected:
        shutil.copyfile(path, directory / path.name)
    inventory.append({k: package[k] for k in ("name", "version", "license", "source")})
sysroot = pathlib.Path(subprocess.check_output(["rustc", "--print", "sysroot"], text=True).strip())
for name in ("COPYRIGHT.html", "COPYRIGHT-library.html"):
    shutil.copyfile(sysroot / "share/doc/rust" / name, output / ("rust-" + name))
for name in ("LICENSE", "NOTICE"):
    shutil.copyfile(root.parent / name, output / name)
(output / "dependencies.json").write_text(json.dumps(inventory, indent=2) + "\n")
