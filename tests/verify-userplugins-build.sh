#!/usr/bin/env sh
set -eu

ROOT=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)
HELPER="$ROOT/scripts/verify-userplugins-build.py"
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT INT TERM

mkdir -p "$WORK/userplugins/alpha" "$WORK/userplugins/beta" "$WORK/userplugins/_shared" "$WORK/dist"
printf '%s\n' 'export default definePlugin({ name: "AlphaPlugin" });' > "$WORK/userplugins/alpha/index.tsx"
printf '%s\n' 'export default definePlugin({' '    name: "BetaPlugin",' '});' > "$WORK/userplugins/beta/index.ts"
printf '%s\n' 'export const ignored = true;' > "$WORK/userplugins/_shared/index.ts"

inventory_output=$(python3 "$HELPER" inventory "$WORK/userplugins" "$WORK/inventory.json")
printf '%s\n' "$inventory_output" | grep -F 'AlphaPlugin (alpha)'
printf '%s\n' "$inventory_output" | grep -F 'BetaPlugin (beta)'
python3 - "$WORK/inventory.json" <<'PY'
import json
import sys
from pathlib import Path

assert json.loads(Path(sys.argv[1]).read_text(encoding="utf-8")) == [
    {"destination": "alpha", "name": "AlphaPlugin", "source": "alpha/index.tsx"},
    {"destination": "beta", "name": "BetaPlugin", "source": "beta/index.ts"},
]
PY

# Both names are present to model embedded source strings. Only the sourcemap can
# prove that each canonical entry point was compiled into the renderer bundle.
printf '%s\n' 'const alpha = "AlphaPlugin"; const beta = "BetaPlugin";' > "$WORK/dist/renderer.js"
printf '%s\n' '{"version":3,"sources":["../src/userplugins/alpha/index.tsx"]}' > "$WORK/dist/renderer.js.map"
if python3 "$HELPER" verify "$WORK/inventory.json" "$WORK/dist/renderer.js" "$WORK/dist/renderer.js.map" > "$WORK/missing.out" 2>&1; then
    echo 'expected missing plugin verification failure' >&2
    exit 1
fi
grep -F 'BetaPlugin (beta)' "$WORK/missing.out"

printf '%s\n' '{"version":3,"sources":["../src/userplugins/alpha/index.tsx","../src/userplugins/beta/index.ts"]}' > "$WORK/dist/renderer.js.map"
verify_output=$(python3 "$HELPER" verify "$WORK/inventory.json" "$WORK/dist/renderer.js" "$WORK/dist/renderer.js.map")
printf '%s\n' "$verify_output" | grep -F 'AlphaPlugin (alpha)'
printf '%s\n' "$verify_output" | grep -F 'BetaPlugin (beta)'

mkdir -p "$WORK/userplugins/invalid"
printf '%s\n' 'export default definePlugin({});' > "$WORK/userplugins/invalid/index.tsx"
if python3 "$HELPER" inventory "$WORK/userplugins" "$WORK/invalid.json" >/dev/null 2>&1; then
    echo 'expected invalid plugin inventory failure' >&2
    exit 1
fi

printf '%s\n' 'verify-userplugins-build focused checks passed'
