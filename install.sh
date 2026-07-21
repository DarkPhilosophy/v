#!/usr/bin/env sh
# install.sh — installer for our custom Vencord (INTEGRATED model).
#
#   sh -c "$(curl -sS https://raw.githubusercontent.com/DarkPhilosophy/vencord-custom/main/install.sh)"
#
# Integrated model: a PERSISTENT Vencord git checkout lives inside this package,
# our patches (translate.patch + update.patch) are applied on top, and Discord's
# built-in Vencord updater is taught (via update.patch) to reapply our overlay on
# every upstream update. No fork, no releases, no external source.
#
# This keeps a checkout + toolchain on disk on purpose — that is what lets the
# built-in "Check for updates" pull upstream and rebuild with our patches.
set -eu

REPO="${VENCORD_CUSTOM_REPO:-https://github.com/DarkPhilosophy/vencord-custom.git}"
DIR="${VENCORD_CUSTOM_DIR:-$HOME/.local/share/vencord-custom}"

say() { printf '\033[1;36m[install]\033[0m %s\n' "$*"; }
die() { printf '\033[1;31m[install] %s\033[0m\n' "$*" >&2; exit 1; }

for c in git node curl; do
    command -v "$c" >/dev/null 2>&1 || die "missing dependency: $c"
done
command -v pnpm >/dev/null 2>&1 || corepack enable >/dev/null 2>&1 || die "pnpm unavailable (enable corepack)"

# Clone helper that survives a global `url.<ssh>.insteadOf = https://github.com/`
# rewrite on machines without a GitHub SSH key: retry ignoring global git config.
gclone() {
    git clone "$@" 2>/dev/null || GIT_CONFIG_GLOBAL=/dev/null git clone "$@"
}

if [ -f "./vencord.sh" ] && [ -d "./userplugins" ]; then
    DIR="$(pwd)"; say "Using local package ${DIR}"
elif [ -d "${DIR}/.git" ]; then
    say "Updating package in ${DIR}"
    git -C "${DIR}" pull --ff-only 2>/dev/null || say "pull skipped (local changes)"
else
    say "Cloning package into ${DIR}"
    gclone "${REPO}" "${DIR}"
fi

cd "${DIR}" && exec ./vencord.sh install
