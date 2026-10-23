# Changelog

Vencord Forge releases. `scripts/gen-docs.py` copies the section of the current version
(`forge/Cargo.toml`) into the README, the app's metainfo and the GitHub release notes.

## Unreleased

- PooWangUploader: Tab and Shift+Tab navigate the chooser normally; Enter activates the focused control instead of an unrelated default. The highlight now follows native focus.
- PooWangUploader: remember the last confirmed destination across restarts without skipping the chooser; cancellation preserves both the draft and the saved destination. Unavailable destinations and oversized-file rerouting still take precedence.
- PooWangUploader: separate Cancel on the left from a single “Upload via” label and the Discord/poo.wang buttons on the right; clarify the independent option to always use a destination.
- PooWangUploader: catch oversized attachments at Discord's shared picker/paste/drop validation, before the automatic Nitro notice. Ask each time keeps the chooser; Always Discord only reroutes when enabled. Show the Nitro destination label and a reduced-motion-aware poo.wang recommendation, using Discord's actual rejection instead of a hardcoded size.

## 0.1.3 (2026-10-23) - FLATHUB BUILD

- New restricted mode for the Flathub build: no host commands, only access to Discord installed as a per-user Flatpak. Other Discord installations are reported and need the full build.
- The Vencord runtime for that Discord lives beside Discord's own data, readable without Flatpak overrides.

## 0.1.2 (2026-10-22) - FEWER SANDBOX PERMISSIONS

- The Flatpak no longer needs access to `~/.config/Vencord`: the runtime and the saved selection are written by Forge's helper on the host.
- A failed install restores the previous runtime in every packaging, including Flatpak.
- The host helper also starts on ARM (aarch64) systems.

## 0.1.1 (2026-10-22) - THEMES & INSTALL PAGE

- Add a Themes step with the repatched CreArts v3 (MIT); themes already loaded from QuickCSS are not added twice.
- Redesign the install page: overview cards in rows, hold-to-install in the footer, a build log that fills the window and keeps the progress bar in view.
- Report an internal error instead of hanging when the install thread fails.
- Check whether Discord runs at most every 3 seconds instead of on every frame.
- Build with full LTO: 20% smaller binaries.
- New screenshots and demo video.

## 0.1.0 (2026-10-22) - FIRST RELEASE

- First release of Vencord Forge for Linux (AppImage, binary, Flatpak) and Windows (.exe).
- Pick the Discord installation, custom plugins, patches and OpenAsar; build and install with verification and rollback.
- Runs inside Flatpak, changing Discord's files through a helper on the host.
