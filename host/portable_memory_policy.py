"""Portable logical policy proof; never a substitute for a fenced restore.

Physical identities are checked against trusted expected host paths before their
representation is normalized. Everything else in OCI/runtime policy is retained.
The current same-host memory proof remains deliberately unchanged.
"""

import copy
import re

from fence import identity
from gvisor_oci import absolute_path, specification_sha256


def configuration_sha256(spec, lease, *, image_root, assignment, cgroup_path, runtime):
    lease = identity(lease)
    image_root, assignment, cgroup_path = map(absolute_path, (image_root, assignment, cgroup_path))
    policy = copy.deepcopy(spec)
    if policy["root"]["path"] != image_root or policy["root"]["readonly"] is not True:
        raise ValueError("portable_root_policy_mismatch")
    policy["root"]["path"] = "@approved-image-root"
    annotations = policy["annotations"]
    if annotations.get("org.jetski.assignment") != lease["assignmentId"] or annotations.get(
        "org.jetski.generation"
    ) != str(lease["generation"]):
        raise ValueError("portable_assignment_policy_mismatch")
    del annotations["org.jetski.assignment"]
    del annotations["org.jetski.generation"]
    if policy["linux"]["cgroupsPath"] != cgroup_path:
        raise ValueError("portable_cgroup_policy_mismatch")
    policy["linux"]["cgroupsPath"] = "@enforced-private-cgroup"
    destinations = set()
    for mount in policy["mounts"]:
        target = mount["destination"]
        if target in destinations:
            raise ValueError("portable_duplicate_mount")
        destinations.add(target)
        name = {"/workspace": "workspace", "/home/sandbox": "home"}.get(target)
        if name is not None:
            if mount["source"] != assignment + "/" + name or mount["type"] != "bind":
                raise ValueError("portable_persistent_mount_mismatch")
            mount["source"] = "@persistent/" + name
    if not {"/workspace", "/home/sandbox"}.issubset(destinations):
        raise ValueError("portable_persistent_mount_missing")
    if not isinstance(runtime, list) or len(runtime) < 2:
        raise ValueError("portable_runtime_policy_mismatch")
    arguments = list(runtime)
    absolute_path(arguments[0])
    arguments[0] = "@pinned-runsc"
    roots = [index for index, item in enumerate(arguments) if item.startswith("--root=")]
    if len(roots) != 1:
        raise ValueError("portable_runtime_root_mismatch")
    absolute_path(arguments[roots[0]][len("--root=") :])
    arguments[roots[0]] = "--root=@private-runtime-state"
    return specification_sha256(dict(oci=policy, runtime=arguments))


def cpu_features(value):
    """Explicit exposed baseline; do not silently derive it from /proc/cpuinfo.

    The caller must test each requested feature against runsc's actual supported
    feature names and inspect the resulting statefile before acknowledging RAM.
    """
    if (
        not isinstance(value, list)
        or not value
        or len(value) > 512
        or any(
            not isinstance(item, str) or not re.fullmatch(r"[a-zA-Z0-9_]{1,64}", item)
            for item in value
        )
        or value != sorted(set(value))
    ):
        raise ValueError("invalid_portable_cpu_features")
    return list(value)
