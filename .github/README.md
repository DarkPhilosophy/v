# vencord-custom

Personal custom [Vencord](https://github.com/Vendicated/Vencord) plugins, packaged for one-line install.

## Principle — upstream stays upstream

This repo contains **only our own code**. It never contains a copy of Vencord and never modifies the upstream tree in place.

| Layer | What | Where |
|-------|------|-------|
| **upstream** | real Vencord, fetched from Vendicated/Vencord | `Vencord/` (gitignored, cloned by the installer) |
| **our new plugins** | code that does not exist upstream | `userplugins/` |
| **our patches over upstream** | tweaks to an existing upstream plugin | `patches/` |

Upstream is cloned pristine. Our plugins are linked in via the gitignored `src/userplugins`, and our patches are applied **transiently at build time** — the upstream tree is reverted to pristine afterwards. No mixing.

## Plugins

- **PlatformSpoofer** — spoof client platform (Desktop/Mobile/Web/Console). *(new plugin → `userplugins/`)*
- **QuestCompleter** — complete Discord Quests without the game installed (video + play/stream via heartbeat spoof). *(new plugin → `userplugins/`)*
- **Translate** — immersive / automatic incoming translation. *(patch over the upstream Translate plugin → `patches/translate.patch`)*

## Install

```sh
sh -c "$(curl -sS https://raw.githubusercontent.com/DarkPhilosophy/vencord-custom/main/install.sh)"
```

The installer is **ephemeral**: it builds everything inside a temp dir (`mktemp`) and self-cleans on exit. The only things left on disk are `~/.config/Vencord/dist` (the compiled bundle Discord loads on every launch — the canonical Vencord location) and Discord's patched `app.asar`. No Vencord source, no `node_modules`, nothing else.

> Needs the repo reachable (public, or run from a local clone). Override the source with `VENCORD_CUSTOM_REPO=<git url>`.

## Usage

```sh
./vencord.sh build       # clone/prepare upstream, apply patches, build
./vencord.sh install     # build + inject into Discord
./vencord.sh update      # revert → git pull upstream → reapply patches → rebuild
./vencord.sh save-patch  # regenerate patches/translate.patch from the current tree
./vencord.sh revert      # restore pristine upstream files
```

## Layout & footprint

The **repository** holds only our code — upstream Vencord is never committed:

```
vencord-custom/
├─ userplugins/
│  ├─ _shared/author.ts     # our author metadata (no fork of constants.ts)
│  ├─ platformSpoofer/
│  └─ questCompleter/
├─ patches/translate.patch  # our only change over upstream code
├─ install.sh               # ephemeral installer (curl | sh)
└─ vencord.sh               # dev tool: build / inject / update
```

Two different on-disk footprints, by role:

- **Dev machine** (`vencord.sh`): keeps a gitignored `Vencord/` checkout so you can rebuild/update; `~/.config/Vencord/dist` is symlinked to it for live rebuilds.
- **Installed machine** (`install.sh`): builds in `/tmp` and self-cleans; leaves only `~/.config/Vencord/dist` + Discord's patched `app.asar`.

## Updating Vencord

`./vencord.sh update` restores the upstream files we patch, fast-forwards `Vencord/`, reapplies `patches/translate.patch`, and rebuilds. If upstream changed the Translate plugin enough that the patch no longer applies, fix `Vencord/src/plugins/translate` by hand once, then `./vencord.sh save-patch`.

## License & attribution

GPL-3.0-or-later. This package derives from and links against [Vencord](https://github.com/Vendicated/Vencord) (GPL-3.0-or-later), so it is distributed under the same terms. See [`LICENSE`](../LICENSE) and [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md).
