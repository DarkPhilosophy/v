#!/usr/bin/env sh
# install.sh — build custom Vencord in a temporary checkout and install app.asar.
#
#   sh -c "$(curl -sS https://raw.githubusercontent.com/DarkPhilosophy/vencord-custom/main/install.sh)"
#
# Only ~/.config/Vencord/app.asar is a persistent compiled Vencord artifact.
# Settings and user data in ~/.config/Vencord are retained; source, dependencies,
# patches, and build output are temporary and removed on exit.
set -eu

VENCORD="${XDG_CONFIG_HOME:-$HOME/.config}/Vencord"
VENCORD_REPO="${VENCORD_UPSTREAM:-https://github.com/Vendicated/Vencord.git}"
PKG_TARBALL="${VENCORD_CUSTOM_TARBALL:-https://codeload.github.com/DarkPhilosophy/vencord-custom/tar.gz/refs/heads/main}"

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
cleanup() {
    rm -rf "$WORK"
    if [ -n "$SYSTEM_STAGE" ] && [ -e "$SYSTEM_STAGE" ]; then
        sudo rm -f "$SYSTEM_STAGE" 2>/dev/null || true
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

# 2) Clone upstream into the temporary workspace and apply our overlay.
BUILD="$WORK/Vencord"
say "Fetching upstream Vencord"
git clone --depth 1 "$VENCORD_REPO" "$BUILD" >/dev/null 2>&1 \
    || die "upstream clone failed"
mkdir -p "$BUILD/src/userplugins" "$BUILD/custom-patches"
cp -r "$PKG/core/src/." "$BUILD/src/"
USERPLUGIN_INVENTORY="$WORK/userplugins.json"
say "Staged custom plugins:"
python3 "$PKG/scripts/verify-userplugins-build.py" inventory \
    "$BUILD/src/userplugins" "$USERPLUGIN_INVENTORY" \
    || die "custom plugin inventory failed"
cp -r "$PKG/patches/." "$BUILD/custom-patches/"
for p in translate.patch update.patch userplugin-manager.patch; do
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
(cd "$BUILD" && pnpm build) || die "build failed"
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
# Keep the packaged runtime in the temporary workspace until the loader has
# also been prepared; a loader/package failure therefore leaves the old app.asar
# untouched.

# 5) Find Discord and install a tiny system loader. The loader's patcher.js
# requires the user-writable runtime app.asar installed above.
disc=""
for c in \
    "/var/lib/flatpak/app/com.discordapp.Discord/current/active/files/discord" \
    "$HOME/.local/share/flatpak/app/com.discordapp.Discord/current/active/files/discord" \
    "/opt/discord" "/usr/share/discord" "/usr/lib/discord"; do
    [ -d "$c/resources" ] && { disc="$c"; break; }
done
[ -n "$disc" ] || die "Discord install not found; open Discord once, then re-run."
resources="$disc/resources"
loader="$WORK/loader"
mkdir -p "$loader"
python3 - "$loader/patcher.js" "$VENCORD/app.asar/patcher.js" <<'PY'
import json
import pathlib
import sys
pathlib.Path(sys.argv[1]).write_text(
    "require(" + json.dumps(sys.argv[2]) + ");\n", encoding="utf-8"
)
PY
printf '%s\n' '{"name":"discord","version":"0.0.0"}' > "$loader/package.json"
LOADER_ASAR="$WORK/loader.asar"
"$HELPER" "$loader" "$LOADER_ASAR" || die "loader packaging failed"

# Remove artifacts from older integrated installs, retaining only settings/user
# data and the currently working runtime until its replacement is ready.
for stale in "$VENCORD"/* "$VENCORD"/.[!.]* "$VENCORD"/..?*; do
    [ -e "$stale" ] || continue
    case "$stale" in
        "$VENCORD/app.asar"|"$VENCORD/settings") continue ;;
    esac
    rm -rf "$stale"
done

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

# Install the compiled runtime only after the system loader has been prepared.
# The rename is atomic within the user data filesystem and leaves an existing
# runtime untouched if it fails.
mv -f "$APP_ASAR" "$VENCORD/app.asar" || die "could not install $VENCORD/app.asar"

# Flatpak must be allowed to read the user-writable runtime path.
if [ "${disc#*flatpak}" != "$disc" ] && command -v flatpak >/dev/null 2>&1; then
    flatpak override --user --filesystem="$VENCORD" com.discordapp.Discord 2>/dev/null || true
fi

say "Done. Runtime installed at ${VENCORD}/app.asar. Restart Discord (Ctrl+R)."
say "Update from Discord: Settings -> Vencord -> Updater -> Check for updates."
