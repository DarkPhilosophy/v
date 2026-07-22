#!/usr/bin/env sh
set -eu

ROOT=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)
HELPER="$ROOT/scripts/manage-openasar.py"
PACKAGER="$ROOT/scripts/package-vencord-asar.sh"
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT INT TERM

make_asar() {
    source_dir=$1
    output=$2
    marker=$3
    mkdir -p "$source_dir"
    printf '%s\n' '{"name":"discord","main":"patcher.js"}' > "$source_dir/package.json"
    printf '%s\n' "$marker" > "$source_dir/patcher.js"
    "$PACKAGER" "$source_dir" "$output"
}

make_asar "$WORK/original-src" "$WORK/original.asar" "console.log('Discord original');"
mkdir -p "$WORK/openasar-src/updater"
printf '%s\n' \
    "fs.rmSync(downloadPath,{recursive:true,force:true});mkdir(downloadPath);continueStartup();" \
    > "$WORK/openasar-src/updater/moduleUpdater.js"
make_asar "$WORK/openasar-src" "$WORK/openasar.asar" "global.oaVersion='nightly-test'; console.log('OpenAsar');"
make_asar "$WORK/openasar-next-src" "$WORK/openasar-next.asar" "global.oaVersion='nightly-next'; console.log('OpenAsar');"
printf '%s\n' 'not an asar' > "$WORK/invalid.asar"
if python3 "$HELPER" validate-openasar "$WORK/invalid.asar" >/dev/null 2>&1; then
    echo 'expected invalid standalone OpenAsar candidate rejection' >&2
    exit 1
fi
python3 "$HELPER" validate-openasar "$WORK/openasar.asar"
python3 "$HELPER" prepare-openasar "$WORK/openasar.asar"
python3 - "$HELPER" "$WORK/openasar.asar" <<'PY'
import importlib.util
import sys
from pathlib import Path

spec = importlib.util.spec_from_file_location("manage_openasar", sys.argv[1])
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
source = module.Asar(Path(sys.argv[2])).read("updater/moduleUpdater.js")
broken = b"fs.rmSync(downloadPath,{recursive:true,force:true});mkdir(downloadPath);"
fixed = b"skipModule||[fs.rmSync(downloadPath,{recursive:true,force:true}),mkdir(downloadPath)];"
assert broken not in source
assert source.count(fixed) == 1
assert b"continueStartup();" in source
PY
patched_openasar=$(sha256sum "$WORK/openasar.asar")
python3 "$HELPER" prepare-openasar "$WORK/openasar.asar"
[ "$(sha256sum "$WORK/openasar.asar")" = "$patched_openasar" ]

mkdir -p "$WORK/fresh-resources"
cp "$WORK/original.asar" "$WORK/fresh-resources/app.asar"
python3 "$HELPER" prepare-loader "$WORK/fresh-resources"
cmp "$WORK/original.asar" "$WORK/fresh-resources/app.asar"
cmp "$WORK/original.asar" "$WORK/fresh-resources/_app.asar"
python3 "$HELPER" prepare-loader "$WORK/fresh-resources"

mkdir -p "$WORK/runtime-src" "$WORK/loader-src" "$WORK/resources"
printf '%s\n' '{"name":"vencord","main":"patcher.js"}' > "$WORK/runtime-src/package.json"
printf '%s\n' "require(require.main.filename);" > "$WORK/runtime-src/patcher.js"
printf '%s\n' 'renderer bundle' > "$WORK/runtime-src/renderer.js"
"$PACKAGER" "$WORK/runtime-src" "$WORK/runtime.asar"
python3 "$HELPER" validate-runtime "$WORK/runtime.asar"
if python3 "$HELPER" validate-runtime "$WORK/invalid.asar" >/dev/null 2>&1; then
    echo 'expected invalid Vencord runtime rejection' >&2
    exit 1
fi
if python3 "$HELPER" validate-runtime "$WORK/original.asar" >/dev/null 2>&1; then
    echo 'expected Discord bootstrap to fail Vencord runtime validation' >&2
    exit 1
fi
printf '%s\n' '{"name":"discord","main":"patcher.js"}' > "$WORK/loader-src/package.json"
printf "require('%s/patcher.js');\n" "$WORK/runtime.asar" > "$WORK/loader-src/patcher.js"
"$PACKAGER" "$WORK/loader-src" "$WORK/resources/app.asar"
if python3 "$HELPER" prepare-loader "$WORK/resources" >/dev/null 2>&1; then
    echo 'expected existing Vencord loader without _app.asar to fail preparation' >&2
    exit 1
fi
cp "$WORK/original.asar" "$WORK/resources/_app.asar"
python3 "$HELPER" prepare-loader "$WORK/resources"

if python3 "$HELPER" install "$WORK/resources" "$WORK/invalid.asar" >/dev/null 2>&1; then
    echo 'expected invalid OpenAsar candidate rejection' >&2
    exit 1
fi
cmp "$WORK/original.asar" "$WORK/resources/_app.asar"
[ ! -e "$WORK/resources/app.asar.backup" ]

python3 "$HELPER" install "$WORK/resources" "$WORK/openasar.asar"
cmp "$WORK/openasar.asar" "$WORK/resources/_app.asar"
cmp "$WORK/original.asar" "$WORK/resources/app.asar.backup"
python3 "$HELPER" verify-chain "$WORK/resources" "$WORK/runtime.asar" openasar
ln -s "$WORK" "$WORK/runtime-link"
python3 "$HELPER" verify-chain "$WORK/resources" "$WORK/runtime-link/runtime.asar" openasar

active_before_keep=$(sha256sum "$WORK/resources/_app.asar")
backup_before_keep=$(sha256sum "$WORK/resources/app.asar.backup")
python3 "$HELPER" keep "$WORK/resources"
[ "$(sha256sum "$WORK/resources/_app.asar")" = "$active_before_keep" ]
[ "$(sha256sum "$WORK/resources/app.asar.backup")" = "$backup_before_keep" ]

python3 "$HELPER" install "$WORK/resources" "$WORK/openasar-next.asar"
cmp "$WORK/openasar-next.asar" "$WORK/resources/_app.asar"
cmp "$WORK/original.asar" "$WORK/resources/app.asar.backup"

python3 "$HELPER" remove "$WORK/resources"
cmp "$WORK/original.asar" "$WORK/resources/_app.asar"
[ ! -e "$WORK/resources/app.asar.backup" ]
python3 "$HELPER" verify-chain "$WORK/resources" "$WORK/runtime.asar" original
python3 "$HELPER" keep "$WORK/resources"

cp "$WORK/openasar.asar" "$WORK/resources/_app.asar"
if python3 "$HELPER" remove "$WORK/resources" >/dev/null 2>&1; then
    echo 'expected removal without original backup to fail' >&2
    exit 1
fi
cmp "$WORK/openasar.asar" "$WORK/resources/_app.asar"

cp "$WORK/original.asar" "$WORK/resources/app.asar.backup"
printf '%s\n' "require('$WORK/wrong-runtime.asar');" > "$WORK/loader-src/patcher.js"
"$PACKAGER" "$WORK/loader-src" "$WORK/resources/app.asar"
if python3 "$HELPER" verify-chain "$WORK/resources" "$WORK/runtime.asar" openasar >/dev/null 2>&1; then
    echo 'expected wrong Vencord loader target to fail chain verification' >&2
    exit 1
fi

printf '%s\n' 'manage-openasar focused checks passed'
