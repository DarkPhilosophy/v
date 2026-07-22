#!/usr/bin/env sh
set -eu

ROOT=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)
HELPER="$ROOT/scripts/package-vencord-asar.sh"
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT INT TERM

mkdir -p "$WORK/dist/nested"
printf '%s\n' 'module.exports = 1;' > "$WORK/dist/patcher.js"
printf '%s\n' 'preload' > "$WORK/dist/preload.js"
printf '%s\n' 'css' > "$WORK/dist/nested/renderer.css"
printf '%s\n' '{"name":"fixture"}' > "$WORK/dist/package.json"
"$HELPER" "$WORK/dist" "$WORK/app.asar"
cp "$WORK/app.asar" "$WORK/first.asar"
"$HELPER" "$WORK/dist" "$WORK/second.asar"
cmp "$WORK/first.asar" "$WORK/second.asar"

if "$HELPER" "$WORK/dist" "$WORK/dist/nested/output.asar" 2>/dev/null; then
    echo 'expected output path rejection' >&2
    exit 1
fi

python3 - "$WORK/app.asar" <<'PY'
import json
import struct
import sys
from pathlib import Path

blob = Path(sys.argv[1]).read_bytes()
pickle_size, header_size, json_size, json_length = struct.unpack_from("<IIII", blob)
assert pickle_size == 4
assert json_size == json_length + 4
header = json.loads(blob[16:16 + json_length])
data_start = 16 + json_length

def file_entry(path):
    node = header["files"]
    for part in path.split("/"):
        node = node["files"][part] if "files" in node else node[part]
    return node

def file_bytes(path):
    entry = file_entry(path)
    start = data_start + int(entry["offset"])
    return blob[start:start + entry["size"]]

package = json.loads(file_bytes("package.json"))
assert package["main"] == "patcher.js"
assert file_bytes("patcher.js") == b"module.exports = 1;\n"
assert file_bytes("preload.js") == b"preload\n"
assert file_bytes("nested/renderer.css") == b"css\n"
PY

printf 'keep-old-asar' > "$WORK/existing.asar"
if "$HELPER" "$WORK/missing" "$WORK/existing.asar" 2>/dev/null; then
    echo 'expected packaging failure' >&2
    exit 1
fi
[ "$(cat "$WORK/existing.asar")" = 'keep-old-asar' ]

ln -s patcher.js "$WORK/dist/unsafe-link"
if "$HELPER" "$WORK/dist" "$WORK/rejected.asar" 2>/dev/null; then
    echo 'expected symlink rejection' >&2
    exit 1
fi
[ ! -e "$WORK/rejected.asar" ]

printf '%s\n' 'package-vencord-asar focused checks passed'
