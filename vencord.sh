#!/usr/bin/env bash
# vencord.sh — build / inject / update our custom Vencord plugins against a
# PRISTINE upstream Vencord checkout. Our code lives only in ./userplugins and
# ./patches; Vencord/ is never forked, only patched transiently at build time.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VENCORD="${ROOT}/Vencord"
VENCORD_REPO="${VENCORD_UPSTREAM:-https://github.com/Vendicated/Vencord.git}"
CONFIG_DIST="${XDG_CONFIG_HOME:-$HOME/.config}/Vencord/dist"
TRANSLATE_PATCH="${ROOT}/patches/translate.patch"

log() { printf '\033[1;36m[vencord]\033[0m %s\n' "$*"; }
die() { printf '\033[1;31m[vencord] %s\033[0m\n' "$*" >&2; exit 1; }

need() { command -v "$1" >/dev/null 2>&1 || die "missing dependency: $1"; }

ensure_vencord() {
    need git
    if [[ ! -d "${VENCORD}/.git" ]]; then
        log "Cloning upstream Vencord -> ${VENCORD}"
        # full clone (updater needs history for `git log HEAD...origin`); retry
        # ignoring global git config to dodge insteadOf HTTPS->SSH rewrites.
        git clone "${VENCORD_REPO}" "${VENCORD}" 2>/dev/null \
            || GIT_CONFIG_GLOBAL=/dev/null git clone "${VENCORD_REPO}" "${VENCORD}"
    fi
    need node
    command -v pnpm >/dev/null 2>&1 || { corepack enable >/dev/null 2>&1 || true; }
    need pnpm
    if [[ ! -d "${VENCORD}/node_modules" ]]; then
        log "Installing dependencies (pnpm i)"
        ( cd "${VENCORD}" && pnpm i --frozen-lockfile )
    fi
}

# Copy our plugins into the gitignored src/userplugins as REAL files. A symlink
# breaks esbuild alias resolution (it resolves to the real path outside src/),
# so we sync instead. Source of truth stays ./userplugins in this package.
sync_userplugins() {
    local dest="${VENCORD}/src/userplugins"
    [[ -L "${dest}" ]] && rm -f "${dest}"
    rm -rf "${dest}"
    mkdir -p "${dest}"
    cp -r "${ROOT}/userplugins/." "${dest}/"
    log "Synced userplugins -> src/userplugins"
}

apply_patches() {
    local patch name
    for patch in "${ROOT}"/patches/*.patch; do
        [[ -f "$patch" ]] || continue
        name="$(basename "$patch")"
        if git -C "${VENCORD}" apply --reverse --check "$patch" 2>/dev/null; then
            log "${name} already applied"
        elif git -C "${VENCORD}" apply --check "$patch" 2>/dev/null; then
            git -C "${VENCORD}" apply "$patch"
            log "${name} applied"
        else
            die "${name} does NOT apply cleanly (upstream drift). Fix the file, then ./vencord.sh save-patch."
        fi
    done
}

revert_upstream() {
    # restore pristine upstream files we patch (our plugins are untouched)
    git -C "${VENCORD}" checkout -- src/plugins/translate src/main/updater/git.ts 2>/dev/null || true
    log "Upstream tree restored to pristine"
}

cmd_build() {
    ensure_vencord
    sync_userplugins
    apply_patches
    log "Building"
    ( cd "${VENCORD}" && pnpm build )
    log "Build done: ${VENCORD}/dist"
}

cmd_link_dist() {
    mkdir -p "$(dirname "${CONFIG_DIST}")"
    if [[ "$(readlink -f "${CONFIG_DIST}" 2>/dev/null)" != "$(readlink -f "${VENCORD}/dist")" ]]; then
        [[ -e "${CONFIG_DIST}" && ! -L "${CONFIG_DIST}" ]] && mv "${CONFIG_DIST}" "${CONFIG_DIST}.bak.$(date +%s)"
        rm -f "${CONFIG_DIST}"
        ln -s "${VENCORD}/dist" "${CONFIG_DIST}"
        log "Linked ${CONFIG_DIST} -> our build"
    else
        log "${CONFIG_DIST} already points at our build"
    fi
}

cmd_inject() {
    cmd_link_dist
    # Patch the Discord app to load ${CONFIG_DIST}. Uses the official installer,
    # which only rewrites Discord's app.asar (our dist is the symlink above).
    local disc
    disc="$(discord_dir)" || die "Discord install not found; open Discord once, then retry."
    log "Injecting into: ${disc}"
    local tmp; tmp="$(mktemp)"
    curl -fsSL https://github.com/Vendicated/VencordInstaller/releases/latest/download/VencordInstallerCli-Linux -o "${tmp}"
    chmod +x "${tmp}"
    if [[ ! -w "${disc}/resources" ]]; then
        log "Need root to patch ${disc} (system flatpak). Running with sudo."
        sudo "${tmp}" -install -location "${disc}"
    else
        "${tmp}" -install -location "${disc}"
    fi
    rm -f "${tmp}"
    # Integrated updater runs `git`/`node` on the host via flatpak-spawn; the
    # flatpak Discord needs permission to talk to the Flatpak portal for that.
    if [[ "${disc}" == *flatpak* ]] && command -v flatpak >/dev/null 2>&1; then
        flatpak override --user --talk-name=org.freedesktop.Flatpak com.discordapp.Discord 2>/dev/null \
            && log "Granted flatpak portal permission (enables built-in updater)" \
            || log "Could not grant flatpak permission; built-in updater may not run on flatpak"
    fi
    log "Injected. Restart Discord (Ctrl+R or relaunch)."
}

discord_dir() {
    local c
    for c in \
        "/var/lib/flatpak/app/com.discordapp.Discord/current/active/files/discord" \
        "$HOME/.local/share/flatpak/app/com.discordapp.Discord/current/active/files/discord" \
        "/opt/discord" "/usr/share/discord" "/usr/lib/discord"; do
        [[ -d "${c}/resources" ]] && { echo "${c}"; return 0; }
    done
    return 1
}

cmd_install() { cmd_build; cmd_inject; }

cmd_update() {
    ensure_vencord
    revert_upstream
    log "Pulling upstream"
    git -C "${VENCORD}" pull --ff-only || die "git pull failed (detached/dirty?). Resolve manually."
    ( cd "${VENCORD}" && pnpm i --frozen-lockfile )
    cmd_build
    cmd_link_dist
    log "Updated. Restart Discord to load."
}

cmd_save_patch() {
    ensure_vencord
    git -C "${VENCORD}" diff src/plugins/translate > "${ROOT}/patches/translate.patch"
    git -C "${VENCORD}" diff src/main/updater/git.ts > "${ROOT}/patches/update.patch"
    log "Saved translate.patch + update.patch from current tree"
}

usage() {
    cat <<'EOF'
vencord.sh — custom Vencord plugin manager

  ./vencord.sh build        Clone/prepare Vencord, apply patches, build
  ./vencord.sh inject       Point Discord at our build and patch it (may sudo)
  ./vencord.sh install      build + inject (full setup)
  ./vencord.sh update       Revert, git pull upstream, reapply, rebuild
  ./vencord.sh save-patch   Regenerate patches/translate.patch from current tree
  ./vencord.sh revert       Restore pristine upstream files

Env: VENCORD_UPSTREAM (upstream repo), XDG_CONFIG_HOME
EOF
}

case "${1:-}" in
    build) cmd_build ;;
    inject) cmd_inject ;;
    install) cmd_install ;;
    update) cmd_update ;;
    save-patch) cmd_save_patch ;;
    revert) revert_upstream ;;
    ""|-h|--help|help) usage ;;
    *) die "unknown command: $1 (see --help)" ;;
esac
