#!/usr/bin/env sh
# Prove the Rust engine produces exactly what the shell installer's tools produce:
#   - patch applier vs `git apply`, for every allowed subset of the patch series
#   - runtime ASAR, embedded seeds, userplugin inventory vs the Python/sh scripts
#   - Vencord loader vs the one `i` builds
#   - OpenAsar fixes vs scripts/manage-openasar.py on a fresh OpenAsar download
# Needs: git, python3, network (upstream tarball, OpenAsar). Work stays under ~/.cache.
set -eu

ROOT=$(CDPATH= cd -- "$(dirname "$0")/../.." && pwd)
VFORGE="$ROOT/forge/target/debug/vencord-forge"
WORK="${XDG_CACHE_HOME:-$HOME/.cache}/vencord-forge-equivalence"
rm -rf "$WORK"
mkdir -p "$WORK"
trap 'rm -rf "$WORK"' EXIT INT TERM
[ -x "$VFORGE" ] || { echo "build first: cargo build -p vencord-forge" >&2; exit 1; }

UPSTREAM=$(tr -d '[:space:]' < "$ROOT/upstream.lock")
echo "upstream $UPSTREAM"
git init -q "$WORK/base"
git -C "$WORK/base" fetch -q --depth 1 https://github.com/Vendicated/Vencord.git "$UPSTREAM"
git -C "$WORK/base" checkout -q FETCH_HEAD
cp -r "$ROOT/core/src/." "$WORK/base/src/"
git -C "$WORK/base" add -A >/dev/null
git -C "$WORK/base" -c user.email=t@t -c user.name=t commit -qm base

python3 - "$ROOT" "$WORK" "$VFORGE" <<'PY'
import itertools, json, shutil, subprocess, sys
from pathlib import Path
root, work, forge_bin = Path(sys.argv[1]), Path(sys.argv[2]), sys.argv[3]
manifest = json.loads((root / "forge.json").read_text())
series = [l.split("#")[0].strip() for l in (root / "patches/series").read_text().splitlines()]
series = [s for s in series if s]
optional = [p for p in series if not manifest["patches"].get(p, {}).get("required")]
base = work / "base"
failures = 0
for n in range(len(optional) + 1):
    for off in itertools.combinations(optional, n):
        chosen = [p for p in series if p not in off]
        a, b = work / "a", work / "b"
        for d in (a, b):
            shutil.rmtree(d, ignore_errors=True)
            shutil.copytree(base, d, ignore=shutil.ignore_patterns(".git"))
        subprocess.run(["git", "init", "-q", str(a)], check=True)
        for p in chosen:
            subprocess.run(["git", "apply", str(root / "patches" / p)], cwd=a, check=True)
            subprocess.run([forge_bin, "apply-patch", str(b), str(root / "patches" / p)], check=True)
        shutil.rmtree(a / ".git")
        if subprocess.run(["diff", "-r", "-q", str(a), str(b)]).returncode:
            failures += 1
            print("MISMATCH with patches off:", off)
print(f"patch applier: {2 ** len(optional)} subsets compared, {failures} mismatches")
sys.exit(1 if failures else 0)
PY

# Runtime ASAR, seeds and inventory against the reference scripts.
mkdir -p "$WORK/dist/nested"
printf 'module.exports = 1;\n' > "$WORK/dist/patcher.js"
printf 'r\n' > "$WORK/dist/renderer.js"
printf 'é ü\n' > "$WORK/dist/nested/ünï.css"
printf '{"name":"vencord","z":1,"a":"é"}' > "$WORK/dist/package.json"
printf 'x\n' > "$WORK/dist/a.txt"
mkdir -p "$WORK/dist/a"; printf 'y\n' > "$WORK/dist/a/b.txt"
sh "$ROOT/scripts/package-vencord-asar.sh" "$WORK/dist" "$WORK/py.asar"
"$VFORGE" pack-runtime "$WORK/dist" "$WORK/rs.asar"
cmp "$WORK/py.asar" "$WORK/rs.asar" && echo "runtime asar: identical"

cp -r "$ROOT/core/src/userplugins" "$WORK/up"
sh "$ROOT/scripts/stage-userplugin-seeds.sh" "$WORK/up" "$WORK/seeds.py.ts"
"$VFORGE" seeds "$WORK/up" "$WORK/seeds.rs.ts"
cmp "$WORK/seeds.py.ts" "$WORK/seeds.rs.ts" && echo "embedded seeds: identical"
python3 "$ROOT/scripts/verify-userplugins-build.py" inventory "$WORK/up" "$WORK/inv.py.json" >/dev/null
"$VFORGE" inventory "$WORK/up" > "$WORK/inv.rs.json"
python3 -c 'import json,sys; a=json.load(open(sys.argv[1])); b=json.load(open(sys.argv[2])); assert a==b, (a,b)' "$WORK/inv.py.json" "$WORK/inv.rs.json" && echo "inventory: identical"

# Loader exactly as ./i builds it.
mkdir -p "$WORK/cfg/Vencord" "$WORK/loader"
RUNTIME="$WORK/cfg/Vencord/app.asar"
python3 - "$WORK/loader/patcher.js" "$RUNTIME/patcher.js" <<'PY'
import json, sys
from pathlib import Path
target = Path(sys.argv[2])
canonical_target = target.parents[1].resolve() / target.parent.name / target.name
Path(sys.argv[1]).write_text("require(" + json.dumps(str(canonical_target)) + ");\n", encoding="utf-8")
PY
printf '%s\n' '{"name":"discord","version":"0.0.0"}' > "$WORK/loader/package.json"
sh "$ROOT/scripts/package-vencord-asar.sh" "$WORK/loader" "$WORK/loader.py.asar"
"$VFORGE" build-loader "$RUNTIME" "$WORK/loader.rs.asar"
cmp "$WORK/loader.py.asar" "$WORK/loader.rs.asar" && echo "loader: identical"

# OpenAsar fixes.
curl -fsSL "$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["openasar"]["url"])' "$ROOT/forge.json")" -o "$WORK/oa.asar"
cp "$WORK/oa.asar" "$WORK/oa.py.asar"
cp "$WORK/oa.asar" "$WORK/oa.rs.asar"
python3 "$ROOT/scripts/manage-openasar.py" prepare-openasar "$WORK/oa.py.asar" >/dev/null
"$VFORGE" prepare-openasar "$WORK/oa.rs.asar" "$ROOT/forge.json"
cmp "$WORK/oa.py.asar" "$WORK/oa.rs.asar" && echo "openasar fixes: identical"
"$VFORGE" prepare-openasar "$WORK/oa.rs.asar" "$ROOT/forge.json"
cmp "$WORK/oa.py.asar" "$WORK/oa.rs.asar" && echo "openasar fixes: idempotent"
echo "equivalence checks passed"
