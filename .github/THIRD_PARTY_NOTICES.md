# Third-Party Notices

This repository contains only original plugins and patches authored for it.
It does **not** bundle Vencord — the upstream client is cloned, pristine, at
build/install time. The notices below cover the upstream projects this package
builds on and derives from.

## Vencord (upstream)

- Repository: https://github.com/Vendicated/Vencord
- Copyright: © Vendicated and Vencord contributors
- License: GPL-3.0-or-later
- Relationship to this package:
  - Plugins in `userplugins/` (PlatformSpoofer, QuestCompleter) are original works
    built against Vencord's plugin APIs and are licensed **GPL-3.0-or-later**
    (see the SPDX headers in each file).
  - `patches/translate.patch` is a **derivative modification** of Vencord's
    built-in Translate plugin (`src/plugins/translate`), likewise GPL-3.0-or-later.
  - Vencord source is **not redistributed here**; `install.sh` / `vencord.sh`
    fetch it from the official repository and apply our overlay on top.

## VencordInstaller

- Repository: https://github.com/Vendicated/VencordInstaller
- License: GPL-3.0-or-later
- Use: downloaded at install time to patch the Discord desktop client into loading
  Vencord. Not bundled in this repository.

---

Because this package derives from and links against Vencord (GPL-3.0-or-later),
the package as a whole is distributed under the same terms — see `LICENSE`.
