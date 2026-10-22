#!/usr/bin/env python3
"""Regenerate the generated blocks of .github/README.md from the sources of truth.

Blocks are delimited by <!-- NAME-START --> ... <!-- NAME-END -->:
  PLUGINS   custom plugins: entries of core/src/userplugins + descriptions from forge.json
  PATCHES   patches in patches/series order + metadata from forge.json
  FORGE     latest Forge version (forge/Cargo.toml) and its release

  LATEST    the current version's section of .github/CHANGELOG.md
  DEMO      demo video (as a clickable screenshot) and screenshots
  LICENSES  every component and its license (THIRD_PARTY_NOTICES lists each Rust crate)
The metainfo <releases> of the app are generated from .github/CHANGELOG.md as well.

Usage: gen-docs.py [--check | --release-notes]
  --check          exit 1 if README or metainfo are out of date, write nothing
  --release-notes  print the GitHub release notes for the current version
"""
from __future__ import annotations

import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
README = ROOT / ".github" / "README.md"
CHANGELOG = ROOT / ".github" / "CHANGELOG.md"
METAINFO = ROOT / "packaging" / "flatpak" / "io.github.DarkPhilosophy.v.metainfo.xml"
NOTICES = ROOT / ".github" / "THIRD_PARTY_NOTICES.md"
SITE = "https://darkphilosophy.github.io/v"


def load_manifest() -> dict:
    return json.loads((ROOT / "forge.json").read_text(encoding="utf-8"))


def series(manifest: dict) -> list[str]:
    text = (ROOT / manifest["overlay"]["series"]).read_text(encoding="utf-8")
    return [line.split("#")[0].strip() for line in text.splitlines() if line.split("#")[0].strip()]


def plugin_entries(manifest: dict) -> list[str]:
    root = ROOT / manifest["overlay"]["userplugins"]
    shared = set(manifest["overlay"].get("shared", []))
    return sorted(p.name for p in root.iterdir() if not p.name.startswith(".") and p.name not in shared)


def forge_version() -> str:
    text = (ROOT / "forge" / "Cargo.toml").read_text(encoding="utf-8")
    match = re.search(r'^\[workspace\.package\][^\[]*?^version\s*=\s*"([^"]+)"', text, re.M | re.S)
    if not match:
        raise SystemExit("forge/Cargo.toml: workspace.package.version not found")
    return match.group(1)


def repo_slug(manifest: dict) -> str:
    return manifest["homepage"].removeprefix("https://github.com/").strip("/")


def block_plugins(manifest: dict) -> str:
    meta = manifest.get("plugins", {})
    lines = []
    for entry in plugin_entries(manifest):
        item = meta.get(entry, {})
        title = item.get("title") or entry
        description = item.get("description") or "No description in forge.json yet."
        lines.append(f"- **{title}** — {description}")
    return "\n".join(lines)


def block_patches(manifest: dict) -> str:
    meta = manifest.get("patches", {})
    lines = ["| Patch | What it does | |", "|---|---|---|"]
    for name in series(manifest):
        item = meta.get(name, {})
        kind = "required" if item.get("required") else "optional"
        lines.append(f"| **{item.get('title') or name}** (`{name}`) | {item.get('description', '')} | {kind} |")
    return "\n".join(lines)


def block_forge(manifest: dict) -> str:
    version = forge_version()
    slug = repo_slug(manifest)
    tag = f"forge-v{version}"
    return (
        f"Latest app version: **{version}** — "
        f"[download for Linux and Windows](https://github.com/{slug}/releases/tag/{tag}) · "
        f"[all releases](https://github.com/{slug}/releases)"
    )


def block_layout(manifest: dict) -> str:
    meta = manifest.get("patches", {})
    names = sorted(series(manifest) + ["series"])
    width = max(len(n) for n in names) + 4
    out = []
    for index, name in enumerate(names):
        branch = "└──" if index == len(names) - 1 else "├──"
        comment = "ordered patch list used by ./i, Forge and the in-app updater" if name == "series" else meta.get(name, {}).get("title", "")
        out.append(f"│   {branch} {name.ljust(width)}# {comment}".rstrip())
    return "\n".join(out)


def changelog() -> list[tuple[str, str, str, list[str]]]:
    """(version, date, title, bullets) per `## <version> (<date>) - <TITLE>` section, newest first."""
    sections = []
    for match in re.finditer(r"^## (\S+) \(([^)]+)\)(?: - ([^\n]+))?\n(.*?)(?=^## |\Z)", CHANGELOG.read_text(encoding="utf-8"), re.M | re.S):
        bullets = [line[2:].strip() for line in match.group(4).splitlines() if line.startswith("- ")]
        sections.append((match.group(1), match.group(2).split(" - ")[-1].strip(), (match.group(3) or "").strip(), bullets))
    if not sections:
        raise SystemExit("CHANGELOG.md has no '## <version> (<date>)' sections")
    return sections


def current_section() -> tuple[str, str, str, list[str]]:
    version = forge_version()
    for section in changelog():
        if section[0] == version:
            return section
    raise SystemExit(f"CHANGELOG.md has no section for {version} (forge/Cargo.toml)")


def block_latest(manifest: dict) -> str:
    version, date, title, bullets = current_section()
    heading = f"Latest update ({version}{' · ' + title.capitalize() if title else ''}, {date})"
    return "\n".join(["<details open>", f"<summary><strong>{heading}</strong></summary>", "", *[f"- {b}" for b in bullets], "", "</details>"])


def block_demo(manifest: dict) -> str:
    # github.com does not play external videos inline: a screenshot that opens the video.
    shots = ["discord", "plugins", "themes", "about"]
    lines = [
        f"<p align=\"center\"><strong>▶ <a href=\"{SITE}/screenshots/demo.webm\">Watch the demo</a></strong></p>",
        "",
    ]
    lines.append(" ".join(f'<img src="{SITE}/screenshots/{name}.png" width="24%" alt="{name}">' for name in shots))
    return "\n".join(lines)


def html_escape(text: str) -> str:
    return text.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


def metainfo_releases() -> str:
    out = ["  <releases>"]
    for version, date, _title, bullets in changelog():
        out.append(f'    <release version="{version}" date="{date}">')
        out.append("      <description>")
        out.append("        <ul>")
        out.extend(f"          <li>{html_escape(re.sub(r'[`*]', '', b))}</li>" for b in bullets)
        out.append("        </ul>")
        out.append("      </description>")
        out.append("    </release>")
    out.append("  </releases>")
    return "\n".join(out)


def release_notes() -> str:
    version, _date, title, bullets = current_section()
    return "\n".join([f"### {title.capitalize() or 'Changes'}", "", *[f"- {b}" for b in bullets], "",
        "Download one file and run it: the AppImage or the Linux binary (`chmod +x` first), the Windows `.exe`, or the `.flatpak`.",
        f"Flatpak repository with automatic updates: {SITE}/flatpak/vencord-forge.flatpakref"])


def rust_crates() -> list[tuple[str, str, str]]:
    """(name, version, license) of every crate compiled into Vencord Forge, from Cargo.lock."""
    import subprocess
    out = subprocess.run(["cargo", "metadata", "--format-version", "1", "--locked", "--manifest-path", str(ROOT / "forge" / "Cargo.toml")],
                         check=True, capture_output=True, text=True).stdout
    data = json.loads(out)
    members = set(data["workspace_members"])
    crates = {(p["name"], p["version"], normalize_license(p.get("license") or "see crate")) for p in data["packages"] if p["id"] not in members}
    return sorted(crates)


def normalize_license(expr: str) -> str:
    # Old crates write "MIT/Apache-2.0"; SPDX writes "MIT OR Apache-2.0". Same meaning, one spelling.
    expr = re.sub(r"\s*/\s*", " OR ", expr)
    parts = expr.split(" OR ")
    return " OR ".join(sorted(parts)) if all("(" not in p and " AND " not in p and " WITH " not in p for p in parts) else expr


def block_licenses(manifest: dict) -> str:
    """Everything Vencord Forge and the installer bring together, and under which license."""
    rows = [
        ("This project (overlay, custom plugins, patches, installer, Forge)", "source in this repository", "GPL-3.0-or-later"),
        (f"[Vencord]({manifest['upstream'].get('homepage', manifest['upstream']['git'])})", "downloaded and built at install time", manifest["upstream"].get("license", "see project")),
    ]
    if manifest.get("openasar"):
        oa = manifest["openasar"]
        rows.append((f"[OpenAsar]({oa.get('homepage', oa['url'])})", "downloaded at install time (optional)", oa.get("license", "see project")))
    for theme in manifest.get("themes", {}).values():
        how = "bundled in `themes/`" if theme.get("file") else "loaded from its author's site"
        rows.append((f"[{theme['title']}]({theme.get('homepage', '')}) by {theme.get('author', '')}", how, theme.get("license", "see project")))
    rows.append(("[Node.js](https://nodejs.org) and [pnpm](https://pnpm.io)", "downloaded by Forge to build Vencord when missing", "MIT"))
    crates = rust_crates()
    rows.append((f"{len(crates)} Rust crates, including the Ubuntu font egui embeds", "compiled into the Vencord Forge binaries", "permissive (MIT, Apache-2.0, BSD, Zlib, ISC, Unicode, OFL/UFL, …); full list in THIRD_PARTY_NOTICES"))
    lines = ["| Component | How it is used | License |", "|---|---|---|"]
    lines += [f"| {a} | {b} | {c} |" for a, b, c in rows]
    return "\n".join(lines)


def block_rust_crates(manifest: dict) -> str:
    groups: dict[str, list[str]] = {}
    for name, version, license in rust_crates():
        groups.setdefault(license, []).append(f"{name} {version}")
    lines = []
    for license in sorted(groups, key=lambda l: (-len(groups[l]), l)):
        names = groups[license]
        lines.append(f"<details><summary><strong>{license}</strong> ({len(names)})</summary>\n\n{', '.join(names)}\n\n</details>")
    return "\n".join(lines)


BLOCKS = {"PLUGINS": block_plugins, "PATCHES": block_patches, "FORGE": block_forge, "LATEST": block_latest, "DEMO": block_demo, "LICENSES": block_licenses}
NOTICE_BLOCKS = {"RUST-CRATES": block_rust_crates}


def render(text: str, manifest: dict, blocks: dict | None = None) -> str:
    for name, build in (BLOCKS if blocks is None else blocks).items():
        pattern = re.compile(rf"(<!-- {name}-START -->\n).*?(<!-- {name}-END -->)", re.S)
        if not pattern.search(text):
            raise SystemExit(f"README is missing the {name} block markers")
        body = build(manifest)
        text = pattern.sub(lambda m: m.group(1) + body + "\n" + m.group(2), text)
    return text


def main(argv: list[str]) -> int:
    if "--release-notes" in argv:
        print(release_notes())
        return 0
    manifest = load_manifest()
    outputs = {
        README: render(README.read_text(encoding="utf-8"), manifest),
        NOTICES: render(NOTICES.read_text(encoding="utf-8"), manifest, NOTICE_BLOCKS),
        METAINFO: re.sub(r"  <releases>.*?</releases>", lambda _: metainfo_releases(), METAINFO.read_text(encoding="utf-8"), count=1, flags=re.S),
    }
    stale = [path for path, text in outputs.items() if path.read_text(encoding="utf-8") != text]
    if "--check" in argv:
        for path in stale:
            print(f"{path.relative_to(ROOT)} is out of date; run scripts/gen-docs.py", file=sys.stderr)
        return 1 if stale else 0
    for path in stale:
        path.write_text(outputs[path], encoding="utf-8")
        print(f"{path.relative_to(ROOT)} updated")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
