#!/usr/bin/env sh
set -eu

ROOT=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)
HELPER="$ROOT/scripts/package-vencord-asar.sh"
SEED_HELPER="$ROOT/scripts/stage-userplugin-seeds.sh"
UPDATE_PATCH="$ROOT/patches/update.patch"
INSTALLER="$ROOT/i"
RUNTIME_NOISE_PATCH="$ROOT/patches/runtime-noise.patch"
DETECTOR="$ROOT/scripts/detect-discord.py"
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT INT TERM
[ -d "$ROOT/core/src/userplugins" ]
[ ! -e "$ROOT/userplugins" ]
git apply --numstat "$UPDATE_PATCH" >/dev/null

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
python3 - "$WORK/dist/large.bin" <<'PY'
import sys
from pathlib import Path

Path(sys.argv[1]).write_bytes(bytes(32 * 1024 * 1024))
PY
"$HELPER" "$WORK/dist" "$WORK/app.asar"
cp "$WORK/app.asar" "$WORK/first.asar"
expected_size=$(wc -c < "$WORK/first.asar")
printf '%s' 'keep-old' > "$WORK/second.asar"
"$HELPER" "$WORK/dist" "$WORK/second.asar" &
packager_pid=$!
partial_size=
while kill -0 "$packager_pid" 2>/dev/null; do
    observed_size=$(wc -c < "$WORK/second.asar")
    if [ "$observed_size" -ne 8 ] && [ "$observed_size" -ne "$expected_size" ]; then
        partial_size=$observed_size
        break
    fi
done
wait "$packager_pid"
[ -z "$partial_size" ] || {
    printf 'packager exposed a partial output of %s bytes\n' "$partial_size" >&2
    exit 1
}
cmp "$WORK/first.asar" "$WORK/second.asar"
python3 - "$WORK" <<'PY'
import sys
from pathlib import Path

assert not list(Path(sys.argv[1]).glob(".*.tmp"))
PY

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
python3 - "$UPDATE_PATCH" "$INSTALLER" "$DETECTOR" "$RUNTIME_NOISE_PATCH" "$ROOT/core/src/sentryIpc.ts" "$ROOT/core/src/discordNoise.ts" <<'PY'
from pathlib import Path
import sys

patch = Path(sys.argv[1]).read_text(encoding="utf-8")
installer = Path(sys.argv[2]).read_text(encoding="utf-8")
detector = Path(sys.argv[3]).read_text(encoding="utf-8")
runtime_noise_patch = Path(sys.argv[4]).read_text(encoding="utf-8")
sentry_ipc = Path(sys.argv[5]).read_text(encoding="utf-8")
discord_noise = Path(sys.argv[6]).read_text(encoding="utf-8")
generator = 'join(source, "src", "main", "userPluginManager", "embeddedSeeds.generated.ts")'
build = 'await run("node", args, source, { VENCORD_HASH: buildHash });'
assert generator in patch
assert patch.index(generator) < patch.index(build)
assert 'join(source, "dist", "userPluginSeeds")' not in patch
assert 'await run("git", ["fetch", "--depth", "1", "origin", upstreamHash], source);' in patch
assert "UPSTREAM_TARBALL" not in patch
assert 'import { cp, mkdir, mkdtemp, rm } from "fs/promises";' in patch
assert 'await cp(join(overlay, "core", "src"), join(source, "src"), { recursive: true });' in patch
assert 'await run("cp"' not in patch
assert 'if (userpluginsRoot) await materializeUserPluginsTree(source, userpluginsRoot);' in patch
assert 'join(overlay, "userplugins")' not in patch
assert patch.count('join(overlay, "scripts", "verify-userplugins-build.py")') == 2
assert './core/src/userplugins' in installer
assert '$PKG/userplugins' not in installer
assert installer.count('$PKG/scripts/verify-userplugins-build.py') == 2
assert "runtime-noise.patch" in installer
assert 'event.error.message === "Sentry successfully disabled"' in runtime_noise_patch
assert "event.preventDefault();" in runtime_noise_patch
assert 'installNoopSentryIpc(window as unknown as Record<string, unknown>);' in runtime_noise_patch
assert runtime_noise_patch.count('installDiscordKnownNoiseFilter(console);') == 2
assert 'import { installDiscordKnownNoiseFilter } from "../../discordNoise";' in runtime_noise_patch
assert 'SCRIPT_COST_WARNING = "[scriptCost] retained URL count exceeded maxUrls (1000); evicting lowest-cost entries.";' in discord_noise
assert "MISSING_LOCALE_MESSAGE" in discord_noise
assert 'if (!popoutWindow?.document || !vencordRootNode) return;' in runtime_noise_patch
assert 'pushDirective("connect-src", "sentry-ipc:");' not in runtime_noise_patch
assert 'sendRendererStart() { }' in sentry_ipc
assert 'sendScope() { }' in sentry_ipc
assert 'sendEnvelope() { }' in sentry_ipc
assert 'sendStatus() { }' in sentry_ipc
assert 'sendStructuredLog() { }' in sentry_ipc
assert 'sendMetric() { }' in sentry_ipc
assert 'BASE_GLOW_WARNING = "Could not find a View Model linked to Artboard BaseGlowRemapped.";' in discord_noise
assert 'args.length === 1' in discord_noise
assert '"$BUILD/dist/renderer.js" "$BUILD/dist/renderer.js.map"' in installer
assert 'OPENASAR_URL="${OPENASAR_URL:-https://github.com/GooseMod/OpenAsar/releases/download/nightly/app.asar}"' in installer
assert 'OPENASAR_ACTION="$("$OPENASAR_CHOOSER")"' in installer
assert 'python3 "$OPENASAR_HELPER" prepare-openasar "$OPENASAR_CANDIDATE"' in installer
assert 'python3 "$OPENASAR_HELPER" validate-runtime "$APP_ASAR"' in installer
assert 'target = Path(sys.argv[2])' in installer
assert 'target.parents[1].resolve() / target.parent.name / target.name' in installer
assert 'DISCORD_DETECTOR="$PKG/scripts/detect-discord.py"' in installer
assert 'python3 "$DISCORD_DETECTOR" --home "$HOME"' in installer
assert 'VENCORD_DISCORD_DIR' in installer
assert 'IFS="$(printf \'\\t\')" read -r discord_kind discord_app_id resources' in installer
assert 'com.discordapp.Discord' not in installer
assert '"/opt/discord"' not in installer
assert 'if [ "$discord_kind" = "flatpak" ]' in installer
assert 'flatpak override --user --filesystem="$VENCORD" "$discord_app_id"' in installer
assert all(f'"{name}"' in detector for name in ("Discord", "DiscordPTB", "DiscordCanary", "DiscordDevelopment"))
assert all(f'root / "{root}"' in detector for root in ("usr/share", "usr/lib64", "opt"))
assert 'manage_openasar prepare-loader "$resources"' in installer
assert 'install) manage_openasar install "$resources" "$OPENASAR_CANDIDATE"' in installer
assert 'keep) manage_openasar keep "$resources"' in installer
assert 'remove) manage_openasar remove "$resources"' in installer
assert 'python3 "$OPENASAR_HELPER" verify-chain "$resources" "$VENCORD/app.asar" auto' in installer
assert installer.index('prepare-openasar "$OPENASAR_CANDIDATE"') < installer.index('manage_openasar prepare-loader "$resources"')
assert installer.index('validate-runtime "$APP_ASAR"') < installer.index('manage_openasar prepare-loader "$resources"')
assert installer.index('manage_openasar prepare-loader "$resources"') < installer.index('mv -f "$SYSTEM_STAGE" "$resources/app.asar"')
assert installer.index('mv -f "$APP_ASAR" "$VENCORD/app.asar"') < installer.index('verify-chain "$resources" "$VENCORD/app.asar" auto')
assert 'RUNTIME_BACKUP="$WORK/runtime-backup.asar"' in installer
assert 'restore_runtime' in installer
assert 'join(source, "dist", "renderer.js.map")' in patch
assert 'await rm(work, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })' in patch
assert 'console.warn("[Vencord] Failed to clean User Plugin Manager update workspace", error)' in patch
assert 'await run(join(overlay, "scripts", "package-vencord-asar.sh"), [join(source, "dist"), RUNTIME_ASAR]);' in patch
assert "await packageRuntime(overlay, source);" in patch
assert 'report?.("building");' in patch
assert 'report?.("installing");' in patch
assert 'import gitHash from "~git-hash";' in patch
assert 'buildHash: `${upstreamHash.slice(0, 12)}.${overlayHash.slice(0, 12)}`' in patch
assert 'if (gitHash === buildHash) return [];' in patch
assert '`${OVERLAY_TARBALL}/${overlayHash}`' in patch
assert 'VENCORD_HASH: buildHash' in patch
assert 'BUILD_HASH="$(printf \'%.12s.%.12s\' "$UPSTREAM_HASH" "$OVERLAY_HASH")"' in installer
assert "waitForPackagedRuntime" not in patch
assert "const candidate" not in patch
PY

[ "$(cat "$WORK/existing.asar")" = 'keep-old-asar' ]

ln -s patcher.js "$WORK/dist/unsafe-link"
if "$HELPER" "$WORK/dist" "$WORK/rejected.asar" 2>/dev/null; then
    echo 'expected symlink rejection' >&2
    exit 1
fi
[ ! -e "$WORK/rejected.asar" ]

printf '%s\n' 'package-vencord-asar focused checks passed'
