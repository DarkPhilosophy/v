#!/usr/bin/env sh
# i — build custom Vencord in a temporary checkout and install app.asar.
#
#   curl -fsL https://darkphilosophy.github.io/v/i|sh
#
# Only ~/.config/Vencord/app.asar is a persistent compiled Vencord artifact.
# Settings and user data in ~/.config/Vencord are retained; source, dependencies,
# patches, and build output are temporary and removed on exit.
set -eu

VENCORD="${XDG_CONFIG_HOME:-$HOME/.config}/Vencord"
VENCORD_REPO="${VENCORD_UPSTREAM:-https://github.com/Vendicated/Vencord.git}"
PKG_TARBALL="${VENCORD_CUSTOM_TARBALL:-https://codeload.github.com/DarkPhilosophy/v/tar.gz/refs/heads/main}"
CUSTOM_REPO="${VENCORD_CUSTOM_REPO:-https://github.com/DarkPhilosophy/v.git}"
OPENASAR_URL="${OPENASAR_URL:-https://github.com/GooseMod/OpenAsar/releases/download/nightly/app.asar}"

say() { printf '\033[1;36m[install]\033[0m %s\n' "$*"; }
die() { printf '\033[1;31m[install] %s\033[0m\n' "$*" >&2; exit 1; }

for c in git node curl tar python3 install mv; do
    command -v "$c" >/dev/null 2>&1 || die "missing dependency: $c"
done
if ! command -v pnpm >/dev/null 2>&1; then
    command -v corepack >/dev/null 2>&1 || die "pnpm unavailable (install pnpm or enable corepack)"
    corepack enable >/dev/null 2>&1 || die "could not enable corepack"
fi
command -v pnpm >/dev/null 2>&1 || die "pnpm unavailable"

# Keep the temporary workspace beside the final app.asar so the final rename is
# atomic on filesystems where ~/.config is a single mount.
mkdir -p "$VENCORD"
WORK="$(mktemp -d "${VENCORD}.build.XXXXXX")"
SYSTEM_STAGE=""
PRIVILEGED_OPENASAR_HELPER=""
cleanup() {
    rm -rf "$WORK"
    if [ -n "$SYSTEM_STAGE" ] && [ -e "$SYSTEM_STAGE" ]; then
        sudo rm -f "$SYSTEM_STAGE" 2>/dev/null || true
    fi
    if [ -n "$PRIVILEGED_OPENASAR_HELPER" ] && [ -e "$PRIVILEGED_OPENASAR_HELPER" ]; then
        rm -f "$PRIVILEGED_OPENASAR_HELPER" 2>/dev/null || true
    fi
}
trap cleanup EXIT INT TERM

# 1) Obtain our overlay without retaining a checkout.
if [ -d "./core/src/userplugins" ] && [ -d "./core/src/main/userPluginManager" ] && [ -f "./patches/userplugin-manager.patch" ]; then
    PKG="$(pwd -P)"
else
    say "Fetching overlay"
    mkdir -p "$WORK/overlay"
    curl -fsSL "$PKG_TARBALL" | tar -xz --strip-components=1 -C "$WORK/overlay" \
        || die "overlay download failed"
    PKG="$WORK/overlay"
fi
if [ -d "$PKG/.git" ]; then
    OVERLAY_HASH="$(git -C "$PKG" rev-parse HEAD)" || die "could not resolve local overlay revision"
else
    OVERLAY_HASH="${VENCORD_CUSTOM_HASH:-$(git ls-remote "$CUSTOM_REPO" refs/heads/main | cut -f1)}"
fi
[ "${#OVERLAY_HASH}" -eq 40 ] || die "could not resolve overlay revision"

# 2) Clone upstream into the temporary workspace and apply our overlay.
BUILD="$WORK/Vencord"
say "Fetching upstream Vencord"
git clone --depth 1 "$VENCORD_REPO" "$BUILD" >/dev/null 2>&1 \
    || die "upstream clone failed"
UPSTREAM_HASH="$(git -C "$BUILD" rev-parse HEAD)" || die "could not resolve upstream revision"
BUILD_HASH="$(printf '%.12s.%.12s' "$UPSTREAM_HASH" "$OVERLAY_HASH")"
mkdir -p "$BUILD/src/userplugins" "$BUILD/custom-patches"
cp -r "$PKG/core/src/." "$BUILD/src/"
USERPLUGIN_INVENTORY="$WORK/userplugins.json"
say "Staged custom plugins:"
python3 "$PKG/scripts/verify-userplugins-build.py" inventory \
    "$BUILD/src/userplugins" "$USERPLUGIN_INVENTORY" \
    || die "custom plugin inventory failed"
cp -r "$PKG/patches/." "$BUILD/custom-patches/"
for p in translate.patch update.patch userplugin-manager.patch runtime-noise.patch cloudsync.patch; do
    if git -C "$BUILD" apply --reverse --check "$BUILD/custom-patches/$p" 2>/dev/null; then
        :
    elif git -C "$BUILD" apply --check "$BUILD/custom-patches/$p" 2>/dev/null; then
        git -C "$BUILD" apply "$BUILD/custom-patches/$p"
    else
        die "$p does not apply cleanly (upstream drift)"
    fi
done

# 3) Install dependencies and build only inside the temporary checkout.
say "Installing temporary build dependencies"
(cd "$BUILD" && pnpm install --frozen-lockfile) || die "dependency installation failed"
SEED_HELPER="$PKG/scripts/stage-userplugin-seeds.sh"
[ -x "$SEED_HELPER" ] || die "missing embedded source generator: $SEED_HELPER"
"$SEED_HELPER" "$BUILD/src/userplugins" "$BUILD/src/main/userPluginManager/embeddedSeeds.generated.ts" \
    || die "embedded source generation failed"
say "Building"
(cd "$BUILD" && VENCORD_HASH="$BUILD_HASH" pnpm build) || die "build failed"
say "Verifying custom plugins in renderer bundle"
python3 "$PKG/scripts/verify-userplugins-build.py" verify \
    "$USERPLUGIN_INVENTORY" "$BUILD/dist/renderer.js" "$BUILD/dist/renderer.js.map" \
    || die "custom plugin bundle verification failed"

# 4) Package the complete compiled runtime into a standalone app.asar.
HELPER="$PKG/scripts/package-vencord-asar.sh"
[ -x "$HELPER" ] || die "missing ASAR packager: $HELPER"
APP_ASAR="$WORK/app.asar"
"$HELPER" "$BUILD/dist" "$APP_ASAR" || die "ASAR packaging failed"
[ -s "$APP_ASAR" ] || die "ASAR packaging produced no output"

# 5) Discover every supported Discord layout using the same roots and channel
# names as the official Vencord installer. An explicit override is required when
# more than one installation is found.
DISCORD_DETECTOR="$PKG/scripts/detect-discord.py"
[ -f "$DISCORD_DETECTOR" ] || die "missing Discord detector: $DISCORD_DETECTOR"
DISCORD_TARGET="$WORK/discord-target"
if [ -n "${VENCORD_DISCORD_DIR:-}" ]; then
    python3 "$DISCORD_DETECTOR" --home "$HOME" --override "$VENCORD_DISCORD_DIR" > "$DISCORD_TARGET" \
        || die "Discord install detection failed"
else
    python3 "$DISCORD_DETECTOR" --home "$HOME" > "$DISCORD_TARGET" \
        || die "Discord install detection failed"
fi
IFS="$(printf '\t')" read -r discord_kind discord_app_id resources < "$DISCORD_TARGET"
[ -n "$discord_kind" ] && [ -n "$resources" ] || die "Discord detector returned an invalid target"
loader="$WORK/loader"
mkdir -p "$loader"
python3 - "$loader/patcher.js" "$VENCORD/app.asar/patcher.js" <<'PY'
import json
import sys
from pathlib import Path

target = Path(sys.argv[2])
canonical_target = target.parents[1].resolve() / target.parent.name / target.name
Path(sys.argv[1]).write_text(
    "require(" + json.dumps(str(canonical_target)) + ");\n",
    encoding="utf-8",
)
PY
printf '%s\n' '{"name":"discord","version":"0.0.0"}' > "$loader/package.json"
LOADER_ASAR="$WORK/loader.asar"
"$HELPER" "$loader" "$LOADER_ASAR" || die "loader packaging failed"

# 6) Choose the OpenAsar lifecycle action. Install/update is the interactive and
# non-interactive default; OPENASAR_ACTION=keep/remove are explicit overrides.
OPENASAR_HELPER="$PKG/scripts/manage-openasar.py"
OPENASAR_CHOOSER="$PKG/scripts/choose-openasar-action.sh"
[ -x "$OPENASAR_HELPER" ] || die "missing OpenAsar manager: $OPENASAR_HELPER"
[ -x "$OPENASAR_CHOOSER" ] || die "missing OpenAsar action chooser: $OPENASAR_CHOOSER"
if [ ! -w "$resources" ]; then
    PRIVILEGED_OPENASAR_HELPER="/tmp/vencord-manage-openasar.$$"
    cp "$OPENASAR_HELPER" "$PRIVILEGED_OPENASAR_HELPER" \
        || die "failed to stage OpenAsar manager for privileged installation"
    chmod 0755 "$PRIVILEGED_OPENASAR_HELPER"
fi
python3 "$OPENASAR_HELPER" validate-runtime "$APP_ASAR" \
    || die "Vencord runtime candidate validation failed"
RUNTIME_BACKUP="$WORK/runtime-backup.asar"
RUNTIME_EXISTED=0
if [ -f "$VENCORD/app.asar" ]; then
    cp -p "$VENCORD/app.asar" "$RUNTIME_BACKUP" \
        || die "failed to preserve existing Vencord runtime"
    RUNTIME_EXISTED=1
fi
restore_runtime() {
    if [ "$RUNTIME_EXISTED" -eq 1 ]; then
        mv -f "$RUNTIME_BACKUP" "$VENCORD/app.asar"
    else
        rm -f "$VENCORD/app.asar"
    fi
}
OPENASAR_ACTION="$("$OPENASAR_CHOOSER")" || die "invalid OpenAsar action"
OPENASAR_CANDIDATE=""
if [ "$OPENASAR_ACTION" = "install" ]; then
    OPENASAR_CANDIDATE="$WORK/openasar.asar"
    say "Downloading OpenAsar"
    curl -fsSL "$OPENASAR_URL" -o "$OPENASAR_CANDIDATE" || die "OpenAsar download failed"
    python3 "$OPENASAR_HELPER" prepare-openasar "$OPENASAR_CANDIDATE" \
        || die "OpenAsar candidate preparation failed"
fi

manage_openasar() {
    if [ -w "$resources" ]; then
        python3 "$OPENASAR_HELPER" "$@"
    else
        command -v sudo >/dev/null 2>&1 || die "Discord resources need write permission and sudo is unavailable"
        sudo python3 "$PRIVILEGED_OPENASAR_HELPER" "$@"
    fi
}

# prepare-loader copies the current Discord bootstrap to _app.asar without
# removing app.asar. OpenAsar mutations are atomic and retain the validated
# original as app.asar.backup.
manage_openasar prepare-loader "$resources" || die "Discord bootstrap preparation failed"
case "$OPENASAR_ACTION" in
    install) manage_openasar install "$resources" "$OPENASAR_CANDIDATE" || die "OpenAsar installation failed" ;;
    keep) manage_openasar keep "$resources" || die "OpenAsar state validation failed" ;;
    remove) manage_openasar remove "$resources" || die "OpenAsar removal failed" ;;
esac

# Replace app.asar only after the active bootstrap is valid. Until this rename,
# Discord still has its previous app.asar.
SYSTEM_STAGE="$resources/.app.asar.vencord.$$"
if [ -w "$resources" ]; then
    install -m 0644 "$LOADER_ASAR" "$SYSTEM_STAGE"
    mv -f "$SYSTEM_STAGE" "$resources/app.asar"
    SYSTEM_STAGE=""
else
    command -v sudo >/dev/null 2>&1 || die "Discord resources are not writable and sudo is unavailable"
    sudo install -m 0644 "$LOADER_ASAR" "$SYSTEM_STAGE"
    sudo mv -f "$SYSTEM_STAGE" "$resources/app.asar"
    SYSTEM_STAGE=""
fi

# Install the validated runtime atomically, then verify only the final on-disk
# chain. Restore the previous runtime if that final verification fails.
mv -f "$APP_ASAR" "$VENCORD/app.asar" || die "failed to install $VENCORD/app.asar"
if ! python3 "$OPENASAR_HELPER" verify-chain "$resources" "$VENCORD/app.asar" auto; then
    restore_runtime || die "bootstrap verification failed and runtime rollback failed"
    die "OpenAsar/Vencord bootstrap verification failed; previous runtime restored"
fi

# Remove artifacts from older integrated installs only after the new chain is
# verified, retaining settings/user data and the active runtime.
for stale in "$VENCORD"/* "$VENCORD"/.[!.]* "$VENCORD"/..?*; do
    [ -e "$stale" ] || continue
    case "$stale" in
        "$VENCORD/app.asar"|"$VENCORD/settings") continue ;;
    esac
    rm -rf "$stale"
done

# Flatpak must be allowed to load the user-writable runtime path. Native
# installations do not receive Flatpak-specific configuration.
if [ "$discord_kind" = "flatpak" ] && command -v flatpak >/dev/null 2>&1; then
    flatpak override --user --filesystem="$VENCORD" "$discord_app_id" 2>/dev/null || true
fi

say "Done. Runtime installed at ${VENCORD}/app.asar with OpenAsar action: ${OPENASAR_ACTION}. Restart Discord (Ctrl+R)."
say "Update from Discord: Settings -> Vencord -> Updater -> Check for updates."
