"""Portable logical policy proof; never a substitute for a fenced restore.

Physical identities are checked against trusted expected host paths before their
representation is normalized. Everything else in OCI/runtime policy is retained.
The current same-host memory proof remains deliberately unchanged.
"""

import copy
import re

from fence import identity
from gvisor_oci import absolute_path, specification_sha256


def configuration_sha256(
    spec,
    lease,
    *,
    image_root,
    assignment,
    cgroup_path,
    runtime,
    network_namespace=None,
    resolver_source=None,
):
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
    if network_namespace is not None:
        from network_policy import policy_sha256

        absolute_path(network_namespace)
        absolute_path(resolver_source)
        if annotations.get("org.jetski.network-policy") != policy_sha256():
            raise ValueError("portable_network_policy_mismatch")
        networks = [ns for ns in policy["linux"]["namespaces"] if ns.get("type") == "network"]
        if networks != [{"type": "network", "path": network_namespace}]:
            raise ValueError("portable_network_namespace_mismatch")
        networks[0]["path"] = "@private-public-egress-namespace"
    elif any("path" in ns for ns in policy["linux"]["namespaces"] if ns.get("type") == "network"):
        raise ValueError("unexpected_portable_network_namespace")
    destinations = set()
    for mount in policy["mounts"]:
        target = mount["destination"]
        if target in destinations:
            raise ValueError("portable_duplicate_mount")
        destinations.add(target)
        if target == "/etc/resolv.conf" and network_namespace is not None:
            if mount["source"] != resolver_source or mount["type"] != "bind":
                raise ValueError("portable_network_resolver_mismatch")
            mount["source"] = "@public-network/resolver"
        name = {"/workspace": "workspace", "/home/sandbox": "home"}.get(target)
        if name is not None:
            if mount["source"] != assignment + "/" + name or mount["type"] != "bind":
                raise ValueError("portable_persistent_mount_mismatch")
            mount["source"] = "@persistent/" + name
    if network_namespace is not None and "/etc/resolv.conf" not in destinations:
        raise ValueError("portable_network_resolver_missing")
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


def native_abi_sha256():
    """Byte-pin the native helpers referenced by restored process state.

    The protocol ABI version is independent of physical installation paths.
    Host code must bump it if native import semantics become incompatible.
    """
    import hashlib
    import os
    import stat

    proofs = {}
    for name in ("command-supervisor", "tcp-relay"):
        path = "/opt/jetski/" + name
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        try:
            before = os.fstat(fd)
            if (
                not stat.S_ISREG(before.st_mode)
                or before.st_uid != 0
                or before.st_mode & 0o022
                or before.st_nlink != 1
                or not 1 <= before.st_size <= 4 * 1024**2
            ):
                raise ValueError("unsafe_portable_native_helper")
            digest = hashlib.sha256()
            remaining = before.st_size
            while remaining:
                part = os.read(fd, min(remaining, 256 * 1024))
                if not part:
                    raise ValueError("portable_native_helper_changed")
                digest.update(part)
                remaining -= len(part)

            def token(meta):
                return (
                    meta.st_dev,
                    meta.st_ino,
                    meta.st_size,
                    meta.st_mode,
                    meta.st_uid,
                    meta.st_gid,
                    meta.st_nlink,
                    meta.st_mtime_ns,
                    meta.st_ctime_ns,
                )

            if (
                os.read(fd, 1)
                or token(before) != token(os.fstat(fd))
                or token(before) != token(os.stat(path, follow_symlinks=False))
            ):
                raise ValueError("portable_native_helper_changed")
            proofs[name] = digest.hexdigest()
        finally:
            os.close(fd)
    return specification_sha256(dict(version=1, helpers=proofs))


def verify_compatibility(required, available):
    """A CPU superset is sufficient; all other declared native ABI fields match.

    Both inputs are detached/validated before comparison. This function proves
    compatibility only, never source absence, publication or execution authority.
    """
    fields = {
        "runtimeSha256",
        "hostAbiSha256",
        "image",
        "configurationSha256",
        "platform",
        "kernelVersion",
        "cpuFeatures",
    }
    values = []
    for value in (required, available):
        if not isinstance(value, dict) or set(value) != fields:
            raise ValueError("invalid_portable_compatibility")
        checked = copy.deepcopy(value)
        for key in ("runtimeSha256", "hostAbiSha256", "configurationSha256"):
            if not isinstance(checked[key], str) or not re.fullmatch(r"[a-f0-9]{64}", checked[key]):
                raise ValueError("invalid_portable_compatibility")
        if (
            not isinstance(checked["image"], str)
            or len(checked["image"]) > 1024
            or not re.fullmatch(
                r"[a-zA-Z0-9][a-zA-Z0-9._:/-]*@sha256:[a-f0-9]{64}", checked["image"]
            )
            or checked["platform"] != "systrap"
            or not isinstance(checked["kernelVersion"], str)
            or not re.fullmatch(r"[\x21-\x7e]{1,256}", checked["kernelVersion"])
        ):
            raise ValueError("invalid_portable_compatibility")
        checked["cpuFeatures"] = cpu_features(checked["cpuFeatures"])
        values.append(checked)
    old, new = values
    required_cpu, available_cpu = old.pop("cpuFeatures"), new.pop("cpuFeatures")
    if old != new or not set(required_cpu).issubset(available_cpu):
        raise ValueError("portable_memory_runtime_incompatible")
    return True
