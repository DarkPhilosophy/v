#!/usr/bin/env sh
set -eu

ROOT=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)
HELPER="$ROOT/scripts/package-vencord-asar.sh"
SEED_HELPER="$ROOT/scripts/stage-userplugin-seeds.sh"
UPDATE_PATCH="$ROOT/patches/update.patch"
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT INT TERM

mkdir -p "$WORK/dist/nested" "$WORK/src/userplugins/mediaPlaybackSpeed" "$WORK/src/userplugins/platformSpoofer" "$WORK/src/userplugins/questCompleter"
printf '%s\n' 'module.exports = 1;' > "$WORK/dist/patcher.js"
printf '%s\n' 'preload' > "$WORK/dist/preload.js"
printf '%s\n' 'css' > "$WORK/dist/nested/renderer.css"
printf '%s\n' '{"name":"fixture"}' > "$WORK/dist/package.json"
printf '%s\n' 'media plugin' > "$WORK/src/userplugins/mediaPlaybackSpeed/index.tsx"
printf '%s\n' 'platform plugin' > "$WORK/src/userplugins/platformSpoofer/index.tsx"
printf '%s\n' 'quest plugin' > "$WORK/src/userplugins/questCompleter/index.tsx"
GENERATED_SEEDS="$WORK/embeddedSeeds.generated.ts"
"$SEED_HELPER" "$WORK/src/userplugins" "$GENERATED_SEEDS"
python3 - "$GENERATED_SEEDS" <<'PY'
import sys
from pathlib import Path

generated = Path(sys.argv[1]).read_text()
assert "mediaPlaybackSpeed/index.tsx" in generated
assert "platformSpoofer/index.tsx" in generated
assert "questCompleter/index.tsx" in generated
assert "media plugin" in generated
PY
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
assert "userPluginSeeds" not in header["files"]
PY

printf 'keep-old-asar' > "$WORK/existing.asar"
if "$HELPER" "$WORK/missing" "$WORK/existing.asar" 2>/dev/null; then
    echo 'expected packaging failure' >&2
    exit 1
fi
python3 - "$UPDATE_PATCH" <<'PY'
from pathlib import Path
import sys

patch = Path(sys.argv[1]).read_text(encoding="utf-8")
generator = 'join(source, "src", "main", "userPluginManager", "embeddedSeeds.generated.ts")'
build = 'await run("node", args, source);'
assert generator in patch
assert patch.index(generator) < patch.index(build)
assert 'join(source, "dist", "userPluginSeeds")' not in patch
assert 'await run("git", ["clone", "--depth", "1", UPSTREAM_REPO, source]);' in patch
assert "UPSTREAM_TARBALL" not in patch
assert 'import { copyFile, cp, mkdir, mkdtemp, rename, rm, stat } from "fs/promises";' in patch
assert 'await cp(join(overlay, "core", "src"), join(source, "src"), { recursive: true });' in patch
assert 'await run("cp"' not in patch
assert 'await rm(work, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })' in patch
assert 'console.warn("[Vencord] Failed to clean User Plugin Manager update workspace", error)' in patch
PY

[ "$(cat "$WORK/existing.asar")" = 'keep-old-asar' ]

ln -s patcher.js "$WORK/dist/unsafe-link"
if "$HELPER" "$WORK/dist" "$WORK/rejected.asar" 2>/dev/null; then
    echo 'expected symlink rejection' >&2
    exit 1
fi
[ ! -e "$WORK/rejected.asar" ]

printf '%s\n' 'package-vencord-asar focused checks passed'
