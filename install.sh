#!/usr/bin/env sh
# install.sh — ephemeral installer for our custom Vencord build.
#
#   sh -c "$(curl -sS https://raw.githubusercontent.com/DarkPhilosophy/vencord-custom/main/install.sh)"
#
# It builds everything in a TEMP dir and leaves behind ONLY the compiled bundle
# that Discord must load on every launch:
#
#     $XDG_CONFIG_HOME/Vencord/dist   (~1-2 MB: patcher.js + renderer.js)
#
# The Vencord source checkout, node_modules, this package, and the build
# toolchain are all discarded when the script exits. Nothing else is installed.
set -eu

REPO="${VENCORD_CUSTOM_REPO:-https://github.com/DarkPhilosophy/vencord-custom.git}"
VENCORD_UPSTREAM="${VENCORD_UPSTREAM:-https://github.com/Vendicated/Vencord.git}"
DEST="${XDG_CONFIG_HOME:-$HOME/.config}/Vencord/dist"

say() { printf '\033[1;36m[install]\033[0m %s\n' "$*"; }
die() { printf '\033[1;31m[install] %s\033[0m\n' "$*" >&2; exit 1; }

for c in git node curl; do
    command -v "$c" >/dev/null 2>&1 || die "missing dependency: $c"
done
command -v pnpm >/dev/null 2>&1 || corepack enable >/dev/null 2>&1 || die "pnpm unavailable (enable corepack)"

# Everything happens here and is deleted on exit — no persistent build tree.
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT INT TERM
say "Working in ${WORK} (auto-removed on exit)"

# 1) our overlay (or the local checkout if run from inside it)
if [ -d "./userplugins" ] && [ -f "./patches/translate.patch" ]; then
    PKG="$(pwd)"; say "Using local package ${PKG}"
else
    say "Fetching package"
    git clone --depth=1 "$REPO" "$WORK/pkg"
    PKG="$WORK/pkg"
fi

# 2) pristine upstream Vencord (into temp, never kept)
say "Cloning pristine upstream Vencord"
git clone --depth=1 "$VENCORD_UPSTREAM" "$WORK/vencord"

# 3) layer our plugins + patch onto the pristine tree
mkdir -p "$WORK/vencord/src/userplugins"
cp -r "$PKG/userplugins/." "$WORK/vencord/src/userplugins/"
say "Applying translate.patch"
git -C "$WORK/vencord" apply "$PKG/patches/translate.patch" \
    || die "translate.patch failed to apply (upstream drift). Update the patch on the dev machine."

# 4) build
say "Installing build deps + building (this is the heavy, temporary part)"
( cd "$WORK/vencord" && pnpm i --frozen-lockfile && pnpm build )

# 5) install ONLY the compiled bundle to its permanent home
say "Installing bundle -> ${DEST}"
mkdir -p "$(dirname "$DEST")"
rm -rf "$DEST"
cp -r "$WORK/vencord/dist" "$DEST"

# 6) patch the Discord client to load ${DEST}
disc=""
for c in \
    "/var/lib/flatpak/app/com.discordapp.Discord/current/active/files/discord" \
    "$HOME/.local/share/flatpak/app/com.discordapp.Discord/current/active/files/discord" \
    "/opt/discord" "/usr/share/discord" "/usr/lib/discord"; do
    [ -d "$c/resources" ] && { disc="$c"; break; }
done
[ -n "$disc" ] || die "Discord install not found; open Discord once, then re-run."

say "Patching Discord at ${disc}"
inst="$WORK/VencordInstallerCli"
curl -fsSL https://github.com/Vendicated/VencordInstaller/releases/latest/download/VencordInstallerCli-Linux -o "$inst"
chmod +x "$inst"
if [ -w "$disc/resources" ]; then
    "$inst" -install -location "$disc"
else
    say "Root required to patch ${disc} (system flatpak); using sudo"
    sudo "$inst" -install -location "$disc"
fi
# VencordInstaller may drop the official build into DEST; make OUR build win.
rm -rf "$DEST"
cp -r "$WORK/vencord/dist" "$DEST"

say "Done. Restart Discord (Ctrl+R or relaunch)."
say "Left on disk: ${DEST} (required) + Discord's patched app.asar. Nothing else."
