# Third-party notices

This repository contains a source overlay, custom plugins, patches, and build/install tooling. It does not vendor a Vencord checkout or an OpenAsar binary. Those projects are obtained from their upstream sources during installation.

## Vencord

- Source: https://github.com/Vendicated/Vencord
- Copyright: Vendicated and Vencord contributors
- License: GPL-3.0-or-later

The overlay under `core/src/`, the patches under `patches/`, and the custom plugins integrate with or modify Vencord. Files derived from Vencord retain their upstream copyright and SPDX notices.

## Vencord Installer

- Source: https://github.com/Vencord/Installer
- Copyright: Vendicated and Vencord contributors
- License: GPL-3.0

The OpenAsar lifecycle and loader layout follow the compatibility model used by the official Vencord installer. This repository contains an independent implementation rather than vendored installer source.

## OpenAsar

- Source: https://github.com/GooseMod/OpenAsar
- Copyright: GooseMod/OpenAsar contributors
- License: AGPL-3.0

`i` downloads the official OpenAsar nightly artifact at runtime unless `OPENASAR_URL` is explicitly overridden. No OpenAsar binary or source file is committed to this repository.

## Repository license

Unless a file states otherwise, this repository is licensed under GPL-3.0-or-later. See [`../LICENSE`](../LICENSE).
