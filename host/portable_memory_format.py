"""Host-side validation of version-one portable memory metadata.

Metadata is not execution permission. Native import independently verifies the
published FS identity, all image bytes and target compatibility before restore.
"""

import copy
import hashlib
import json
import re

from gvisor_lifecycle import checkpoint_id
from memory_chunks import validate_memory_layout
from portable_memory_policy import verify_compatibility

MAX_MANIFEST_BYTES = 4 * 1024**2


def manifest_bytes(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()


def manifest_sha256(value):
    return hashlib.sha256(manifest_bytes(value)).hexdigest()


def parse_manifest(value, scope):
    fields = {
        "kind",
        "version",
        "owner",
        "sandbox",
        "checkpointId",
        "generation",
        "filesystemSha256",
        "compatibility",
        "directories",
        "files",
    }
    if (
        not isinstance(value, dict)
        or set(value) != fields
        or len(manifest_bytes(value)) > MAX_MANIFEST_BYTES
    ):
        raise ValueError("invalid_portable_memory_manifest")
    value = copy.deepcopy(value)
    if (
        value["kind"] != "portable-memory"
        or type(value["version"]) is not int
        or value["version"] != 1
        or value["owner"] != scope["owner"]
        or value["sandbox"] != scope["sandbox"]
        or type(value["generation"]) is not int
        or not 1 <= value["generation"] < 2**53
        or not isinstance(value["filesystemSha256"], str)
        or not re.fullmatch(r"[a-f0-9]{64}", value["filesystemSha256"])
    ):
        raise ValueError("invalid_portable_memory_binding")
    checkpoint_id(value["checkpointId"])
    verify_compatibility(value["compatibility"], value["compatibility"])
    files, directories, _, _ = validate_memory_layout(value["files"], value["directories"], scope)
    value.update(files=files, directories=directories)
    return value


def manifest_objects(value):
    objects = {}
    for file in value["files"]:
        for chunk in file["chunks"]:
            obj = chunk["object"]
            if obj["id"] in objects and objects[obj["id"]] != obj:
                raise ValueError("conflicting_portable_memory_object")
            objects[obj["id"]] = copy.deepcopy(obj)
    return objects
