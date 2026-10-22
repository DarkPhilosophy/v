#!/usr/bin/env sh
# End-to-end test in a clean container: stock Discord (official tarball), no Node.js or git,
# the vencord-forge binary given as $1. Forge must find Discord, build Vencord with a selection, install
# OpenAsar + Vencord, and Discord must start with Vencord and the selected plugins loaded.
#
# Usage: forge/tests/container-e2e.sh <path-to-vencord-forge> [podman image]
set -eu
VFORGE=$(realpath "$1")
IMAGE=${2:-docker.io/library/ubuntu:24.04}
ROOT=$(CDPATH= cd -- "$(dirname "$0")/../.." && pwd)
WORK="${XDG_CACHE_HOME:-$HOME/.cache}/vencord-forge-e2e"
mkdir -p "$WORK"
cp "$VFORGE" "$WORK/vencord-forge"
cp "$ROOT/forge/tests/livecheck.mjs" "$WORK/livecheck.mjs"

cat > "$WORK/run.sh" <<'IN'
#!/bin/sh
set -eu
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq ca-certificates curl xvfb xauth libgtk-3-0t64 libnss3 libasound2t64 libgbm1 libxss1 libxtst6 libatomic1 libnotify4 libsecret-1-0 libdrm2 procps >/dev/null
echo "== node in image: $(command -v node || echo none), git: $(command -v git || echo none)"
curl -fsSL "https://discord.com/api/download?platform=linux&format=tar.gz" -o /tmp/discord.tar.gz
tar xzf /tmp/discord.tar.gz -C /opt
echo "== stock Discord: $(ls /opt/Discord)"
# The tarball is only Discord's updater bootstrap: the first start downloads the real app into
# ~/.config/discord/app-*/resources. Start it once, wait for that, then close it.
xvfb-run -a /opt/Discord/discord --no-sandbox >/tmp/bootstrap.log 2>&1 &
for i in $(seq 1 120); do ls /root/.config/discord/app-*/resources/app.asar >/dev/null 2>&1 && break; sleep 2; done
sleep 10; pkill -f /opt/Discord || true; pkill -f '/root/.config/discord' || true; sleep 3
echo "== bootstrapped: $(ls -d /root/.config/discord/app-* 2>/dev/null || echo none)"
/w/vencord-forge detect
/w/vencord-forge install --openasar install --disable-plugin steamRichPresence --disable-patch hide-media.patch
/w/vencord-forge status
# Discord fetches its core modules on first start; give it time, then check Vencord is live.
xvfb-run -a -s "-screen 0 1280x800x24" /opt/Discord/discord --no-sandbox --remote-debugging-port=9223 >/tmp/discord.log 2>&1 &
NODE=$(ls -d /root/.cache/vencord-forge/node/*/bin/node | head -n1)
"$NODE" /w/livecheck.mjs 9223 240
IN
chmod +x "$WORK/run.sh"
podman run --rm -v "$WORK:/w:Z" "$IMAGE" /w/run.sh
