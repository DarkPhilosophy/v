# Changelog

Vencord Forge releases. `scripts/gen-docs.py` copies the section of the current version
(`forge/Cargo.toml`) into the README, the app's metainfo and the GitHub release notes.

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
