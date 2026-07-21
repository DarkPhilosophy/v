#!/usr/bin/env sh
# install.sh — install our custom Vencord (INTEGRATED model) into ~/.config/Vencord.
#
#   sh -c "$(curl -sS https://raw.githubusercontent.com/DarkPhilosophy/vencord-custom/main/install.sh)"
#
# Sets up an upstream Vencord checkout at ~/.config/Vencord with our overlay
# (src/userplugins + custom-patches) baked in, builds it, and points Discord at
# ~/.config/Vencord/dist directly. Vencord's own Updater tab then keeps it current:
# update.patch reapplies our patches over the freshly pulled upstream, locally.
# No prebuild, no CI. The build toolchain (node_modules) stays in the checkout so
# the in-app updater can rebuild — that is the cost of native auto-update.
set -eu

VENCORD="${XDG_CONFIG_HOME:-$HOME/.config}/Vencord"
VENCORD_REPO="${VENCORD_UPSTREAM:-https://github.com/Vendicated/Vencord.git}"
PKG_TARBALL="${VENCORD_CUSTOM_TARBALL:-https://codeload.github.com/DarkPhilosophy/vencord-custom/tar.gz/refs/heads/main}"
INSTALLER_URL="https://github.com/Vencord/Installer/releases/latest/download/VencordInstallerCli-linux"

say() { printf '\033[1;36m[install]\033[0m %s\n' "$*"; }
die() { printf '\033[1;31m[install] %s\033[0m\n' "$*" >&2; exit 1; }

for c in git node curl tar; do
    command -v "$c" >/dev/null 2>&1 || die "missing dependency: $c"
done
command -v pnpm >/dev/null 2>&1 || corepack enable >/dev/null 2>&1 || die "pnpm unavailable (enable corepack)"

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT INT TERM

# 1) our overlay (local checkout if run from inside it, else HTTPS tarball -> temp)
if [ -d "./userplugins" ] && [ -f "./patches/translate.patch" ]; then
    PKG="$(pwd)"
else
    say "Fetching overlay"
    curl -fsSL "$PKG_TARBALL" | tar -xz --strip-components=1 -C "$WORK" || die "overlay download failed"
    PKG="$WORK"
fi

# 2) remove leftovers from older installs
[ -L "${VENCORD}/dist" ] && { rm -f "${VENCORD}/dist"; say "Removed stale ${VENCORD}/dist symlink"; }
[ -d "$HOME/.local/share/vencord-custom" ] && { rm -rf "$HOME/.local/share/vencord-custom"; say "Removed old ~/.local/share/vencord-custom"; }

# 3) upstream Vencord checkout at ~/.config/Vencord (init in place; keeps settings/)
if [ ! -d "${VENCORD}/.git" ]; then
    say "Setting up upstream Vencord checkout at ${VENCORD}"
    mkdir -p "${VENCORD}"
    git -C "${VENCORD}" init -q
    git -C "${VENCORD}" remote add origin "${VENCORD_REPO}" 2>/dev/null || git -C "${VENCORD}" remote set-url origin "${VENCORD_REPO}"
    git -C "${VENCORD}" fetch origin 2>/dev/null || GIT_CONFIG_GLOBAL=/dev/null git -C "${VENCORD}" fetch origin
    BR="$(git -C "${VENCORD}" remote show origin 2>/dev/null | sed -n 's/.*HEAD branch: //p')"
    git -C "${VENCORD}" checkout -f "${BR:-main}"
fi

# 4) seed our overlay into the checkout (persist: userplugins gitignored, custom-patches untracked)
mkdir -p "${VENCORD}/src/userplugins" "${VENCORD}/custom-patches"
cp -r "${PKG}/userplugins/." "${VENCORD}/src/userplugins/"
cp -r "${PKG}/patches/." "${VENCORD}/custom-patches/"

# 5) deps + apply patches + build (git-mode updater stays enabled)
[ -d "${VENCORD}/node_modules" ] || { say "Installing deps"; ( cd "${VENCORD}" && pnpm i --frozen-lockfile ); }
for p in translate.patch update.patch; do
    if git -C "${VENCORD}" apply --reverse --check "${VENCORD}/custom-patches/$p" 2>/dev/null; then :
    elif git -C "${VENCORD}" apply --check "${VENCORD}/custom-patches/$p" 2>/dev/null; then git -C "${VENCORD}" apply "${VENCORD}/custom-patches/$p"
    else die "$p does not apply cleanly (upstream drift)"; fi
done
say "Building"
( cd "${VENCORD}" && pnpm build )

# 6) point Discord at ~/.config/Vencord/dist directly (dev install; no symlink, no official download)
disc=""
for c in \
    "/var/lib/flatpak/app/com.discordapp.Discord/current/active/files/discord" \
    "$HOME/.local/share/flatpak/app/com.discordapp.Discord/current/active/files/discord" \
    "/opt/discord" "/usr/share/discord" "/usr/lib/discord"; do
    [ -d "$c/resources" ] && { disc="$c"; break; }
done
[ -n "$disc" ] || die "Discord install not found; open Discord once, then re-run."
inst="$WORK/VencordInstallerCli"
curl -fsSL "$INSTALLER_URL" -o "$inst"
chmod +x "$inst"
say "Patching Discord at ${disc}"
if [ -w "$disc/resources" ]; then
    env VENCORD_USER_DATA_DIR="${VENCORD}" VENCORD_DEV_INSTALL=1 "$inst" -install -location "$disc"
else
    sudo env VENCORD_USER_DATA_DIR="${VENCORD}" VENCORD_DEV_INSTALL=1 "$inst" -install -location "$disc"
fi
# flatpak: let the in-app updater run git/node on the host
if [ "${disc#*flatpak}" != "$disc" ] && command -v flatpak >/dev/null 2>&1; then
    flatpak override --user --talk-name=org.freedesktop.Flatpak com.discordapp.Discord 2>/dev/null \
        && say "Granted flatpak portal permission (enables in-app updater)" || true
fi

say "Done. Everything lives in ${VENCORD}. Restart Discord (Ctrl+R)."
say "Update from Discord: Settings -> Vencord -> Updater -> Check for updates."
