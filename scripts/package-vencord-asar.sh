#!/usr/bin/env sh
# Package a built Vencord runtime directory as a standalone app.asar.
#
# Usage: package-vencord-asar.sh <built-dist-dir> <output-asar>
# The helper writes <output-asar> atomically via a sibling temporary file.
set -eu

if [ "$#" -ne 2 ]; then
    printf 'usage: %s <built-dist-dir> <output-asar>\n' "$0" >&2
    exit 2
fi

command -v python3 >/dev/null 2>&1 || {
    printf '%s\n' 'package-vencord-asar.sh: python3 is required' >&2
    exit 1
}

exec python3 - "$1" "$2" <<'PY'
import json
import os
import stat
import struct
import sys
from pathlib import Path, PurePosixPath

source_arg, output_arg = sys.argv[1:]
source = Path(source_arg)
output = Path(output_arg)

if not source.is_dir() or source.is_symlink():
    raise SystemExit(f"package-vencord-asar.sh: source is not a real directory: {source}")
if output.exists() and output.is_symlink():
    raise SystemExit(f"package-vencord-asar.sh: output must not be a symlink: {output}")
if not output.parent.is_dir():
    raise SystemExit(f"package-vencord-asar.sh: output parent does not exist: {output.parent}")

source_real = source.resolve()
output_parent_real = output.parent.resolve()
output_abs = output_parent_real / output.name
try:
    if os.path.commonpath((str(source_real), str(output_abs))) == str(source_real):
        raise SystemExit("package-vencord-asar.sh: output must be outside the source directory")
except ValueError:
    pass

files = {}
contents = {}

def fail(path, message):
    raise SystemExit(f"package-vencord-asar.sh: {path}: {message}")

def walk(directory, relative=PurePosixPath()):
    try:
        entries = sorted(os.scandir(directory), key=lambda entry: entry.name)
    except OSError as exc:
        fail(directory, str(exc))
    for entry in entries:
        rel = relative / entry.name
        rel_text = rel.as_posix()
        if entry.is_symlink():
            fail(rel_text, "symlinks are not allowed")
        try:
            mode = entry.stat(follow_symlinks=False).st_mode
        except OSError as exc:
            fail(rel_text, str(exc))
        if stat.S_ISDIR(mode):
            walk(entry.path, rel)
        elif stat.S_ISREG(mode):
            try:
                data = Path(entry.path).read_bytes()
            except OSError as exc:
                fail(rel_text, str(exc))
            files[rel_text] = data
            contents[rel_text] = data
        else:
            fail(rel_text, "only regular files and directories are allowed")

walk(source_real)

# The runtime entry point is always our loader, regardless of upstream build metadata.
package_path = "package.json"
if package_path in contents:
    try:
        package = json.loads(contents[package_path].decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        fail(package_path, f"invalid JSON: {exc}")
    if not isinstance(package, dict):
        fail(package_path, "root value must be an object")
else:
    package = {"name": "vencord", "version": "0.0.0"}
package["main"] = "patcher.js"
contents[package_path] = (json.dumps(package, ensure_ascii=False, sort_keys=True, separators=(",", ":")) + "\n").encode("utf-8")
files[package_path] = contents[package_path]

if "patcher.js" not in contents:
    fail("patcher.js", "required runtime entry point is missing")

def add_node(root, path, size, offset):
    parts = PurePosixPath(path).parts
    node = root
    for part in parts[:-1]:
        child = node.setdefault("files", {}).setdefault(part, {})
        if "size" in child:
            fail(path, "file/directory name collision")
        node = child
    leaf = parts[-1]
    files_node = node.setdefault("files", {})
    if leaf in files_node:
        fail(path, "file/directory name collision")
    files_node[leaf] = {"size": size, "offset": str(offset)}

# Build a stable tree and concatenate bytes in the same lexical path order.
tree = {}
data_parts = []
offset = 0
for path in sorted(contents):
    data = contents[path]
    add_node(tree, path, len(data), offset)
    data_parts.append(data)
    offset += len(data)

header_json = json.dumps(tree, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")
# ASAR's pickle framing: [pickle-size=4][header-size][json-size][json-length][JSON].
header = struct.pack("<IIII", 4, 8 + len(header_json), 4 + len(header_json), len(header_json)) + header_json
temporary = None
try:
    import tempfile

    with tempfile.NamedTemporaryFile(
        mode="wb",
        dir=output.parent,
        prefix=f".{output.name}.",
        suffix=".tmp",
        delete=False,
    ) as stream:
        temporary = Path(stream.name)
        stream.write(header)
        for data in data_parts:
            stream.write(data)
    os.replace(temporary, output)
except OSError as exc:
    if temporary is not None:
        temporary.unlink(missing_ok=True)
    fail(output, str(exc))
PY
