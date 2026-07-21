#!/usr/bin/env sh
# install.sh — ephemeral installer for our custom Vencord build.
#
#   sh -c "$(curl -sS https://raw.githubusercontent.com/DarkPhilosophy/vencord-custom/main/install.sh)"
#
# Fetches everything over plain HTTPS tarballs (no `git clone`, so it is immune
# to git `insteadOf` HTTPS->SSH rewrites), builds in a temp dir, and leaves on
# disk ONLY the compiled bundle Discord loads on every launch:
#
#     $XDG_CONFIG_HOME/Vencord/dist   (~1-2 MB: patcher.js + renderer.js)
#
# Vencord source, node_modules, and the toolchain are discarded on exit.
set -eu

PKG_REF="${VENCORD_CUSTOM_REF:-main}"
PKG_TARBALL="${VENCORD_CUSTOM_TARBALL:-https://codeload.github.com/DarkPhilosophy/vencord-custom/tar.gz/refs/heads/${PKG_REF}}"
VC_TARBALL="${VENCORD_TARBALL:-https://codeload.github.com/Vendicated/Vencord/tar.gz/refs/heads/main}"
DEST="${XDG_CONFIG_HOME:-$HOME/.config}/Vencord/dist"

say() { printf '\033[1;36m[install]\033[0m %s\n' "$*"; }
die() { printf '\033[1;31m[install] %s\033[0m\n' "$*" >&2; exit 1; }

for c in curl tar node; do
    command -v "$c" >/dev/null 2>&1 || die "missing dependency: $c"
done
command -v pnpm >/dev/null 2>&1 || corepack enable >/dev/null 2>&1 || die "pnpm unavailable (enable corepack)"

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT INT TERM
say "Working in ${WORK} (auto-removed on exit)"

# 1) our overlay: local checkout if run from inside it, else HTTPS tarball
if [ -d "./userplugins" ] && [ -f "./patches/translate.patch" ]; then
    PKG="$(pwd)"; say "Using local package ${PKG}"
else
    say "Fetching package (HTTPS tarball)"
    mkdir -p "$WORK/pkg"
    curl -fsSL "$PKG_TARBALL" | tar -xz --strip-components=1 -C "$WORK/pkg" \
        || die "could not download package tarball: ${PKG_TARBALL}"
    PKG="$WORK/pkg"
fi

# 2) pristine upstream Vencord (HTTPS tarball, into temp)
say "Fetching pristine upstream Vencord (HTTPS tarball)"
mkdir -p "$WORK/vencord"
curl -fsSL "$VC_TARBALL" | tar -xz --strip-components=1 -C "$WORK/vencord" \
    || die "could not download Vencord tarball"

# 3) layer our plugins + patch onto the pristine tree
mkdir -p "$WORK/vencord/src/userplugins"
cp -r "$PKG/userplugins/." "$WORK/vencord/src/userplugins/"
say "Applying translate.patch"
if ! ( cd "$WORK/vencord" && git apply "$PKG/patches/translate.patch" 2>/dev/null ); then
    ( cd "$WORK/vencord" && patch -p1 < "$PKG/patches/translate.patch" ) \
        || die "translate.patch failed to apply (upstream drift; regenerate on the dev machine)"
fi

# 4) build (git is not a repo here, so feed the version via env)
say "Installing build deps + building (heavy, temporary)"
(
    cd "$WORK/vencord"
    export VENCORD_HASH="${VENCORD_HASH:-custom}"
    export VENCORD_REMOTE="${VENCORD_REMOTE:-Vendicated/Vencord}"
    pnpm i --frozen-lockfile
    pnpm build --standalone --disable-updater
)

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
