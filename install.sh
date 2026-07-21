#!/usr/bin/env sh
# install.sh — build in /tmp, leave only the compiled bundle. Nothing else persists.
#
#   sh -c "$(curl -sS https://raw.githubusercontent.com/DarkPhilosophy/vencord-custom/main/install.sh)"
#
# The whole build (upstream Vencord + our patches + userplugins + node_modules)
# happens in a temp dir that is DELETED on exit. The only things left on disk:
#   ~/.config/Vencord/dist   (~few MB, the built bundle Discord loads)
#   Discord's patched app.asar
# To update: just run this again. No node_modules, no source, no symlinks, no leftovers.
set -eu

PKG_TARBALL="${VENCORD_CUSTOM_TARBALL:-https://codeload.github.com/DarkPhilosophy/vencord-custom/tar.gz/refs/heads/main}"
VC_TARBALL="${VENCORD_TARBALL:-https://codeload.github.com/Vendicated/Vencord/tar.gz/refs/heads/main}"
DEST="${XDG_CONFIG_HOME:-$HOME/.config}/Vencord/dist"

say() { printf '\033[1;36m[install]\033[0m %s\n' "$*"; }
die() { printf '\033[1;31m[install] %s\033[0m\n' "$*" >&2; exit 1; }

for c in git node curl tar; do
    command -v "$c" >/dev/null 2>&1 || die "missing dependency: $c"
done
command -v pnpm >/dev/null 2>&1 || corepack enable >/dev/null 2>&1 || die "pnpm unavailable (enable corepack)"

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT INT TERM
say "Building in ${WORK} (deleted on exit — including node_modules)"

# 1) our overlay (local checkout if run from inside it, else HTTPS tarball)
if [ -d "./userplugins" ] && [ -f "./patches/translate.patch" ]; then
    PKG="$(pwd)"
else
    curl -fsSL "$PKG_TARBALL" | tar -xz --strip-components=1 -C "$WORK" || die "overlay download failed"
    PKG="$WORK"
fi

# 2) upstream Vencord (temp) + our overlay on top
VC="$WORK/vencord"
mkdir -p "$VC"
say "Fetching upstream Vencord"
curl -fsSL "$VC_TARBALL" | tar -xz --strip-components=1 -C "$VC" || die "Vencord download failed"
mkdir -p "$VC/src/userplugins"
cp -r "$PKG/userplugins/." "$VC/src/userplugins/"
say "Applying translate.patch"
( cd "$VC" && git apply "$PKG/patches/translate.patch" 2>/dev/null ) \
    || ( cd "$VC" && patch -p1 < "$PKG/patches/translate.patch" ) \
    || die "translate.patch failed to apply (upstream drift)"

# 3) build (node_modules created here in /tmp, discarded with WORK)
say "Installing build deps + building (temporary)"
(
    cd "$VC"
    export VENCORD_HASH="${VENCORD_HASH:-custom}" VENCORD_REMOTE="${VENCORD_REMOTE:-Vendicated/Vencord}"
    pnpm i --frozen-lockfile
    pnpm build --standalone --disable-updater
)

# 4) install ONLY the built bundle to its permanent home (real dir, no symlink)
say "Installing bundle -> ${DEST}"
[ -L "${DEST}" ] && rm -f "${DEST}"
mkdir -p "$(dirname "$DEST")"
rm -rf "$DEST"
cp -r "$VC/dist" "$DEST"

# 5) patch Discord to load ${DEST}
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
curl -fsSL https://github.com/Vencord/Installer/releases/latest/download/VencordInstallerCli-linux -o "$inst"
chmod +x "$inst"
if [ -w "$disc/resources" ]; then "$inst" -install -location "$disc"; else sudo "$inst" -install -location "$disc"; fi
# installer may drop official Vencord into DEST; make OUR build win
rm -rf "$DEST"; cp -r "$VC/dist" "$DEST"

# 6) remove leftovers from earlier install attempts
[ -d "$HOME/.local/share/vencord-custom" ] && { rm -rf "$HOME/.local/share/vencord-custom"; say "Removed old ~/.local/share/vencord-custom"; }

say "Done. On disk: ${DEST} + Discord's app.asar. Nothing else. Restart Discord (Ctrl+R)."
