#!/usr/bin/env python3
"""Regenerate the generated blocks of .github/README.md from the sources of truth.

Blocks are delimited by <!-- NAME-START --> ... <!-- NAME-END -->:
  PLUGINS   custom plugins: entries of core/src/userplugins + descriptions from forge.json
  PATCHES   patches in patches/series order + metadata from forge.json
  FORGE     latest Forge version (forge/Cargo.toml) and its release

Usage: gen-docs.py [--check]   (--check: exit 1 if the README is out of date, write nothing)
"""
from __future__ import annotations

import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
README = ROOT / ".github" / "README.md"


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


BLOCKS = {"PLUGINS": block_plugins, "PATCHES": block_patches, "FORGE": block_forge}


def render(text: str, manifest: dict) -> str:
    for name, build in BLOCKS.items():
        pattern = re.compile(rf"(<!-- {name}-START -->\n).*?(<!-- {name}-END -->)", re.S)
        if not pattern.search(text):
            raise SystemExit(f"README is missing the {name} block markers")
        body = build(manifest)
        text = pattern.sub(lambda m: m.group(1) + body + "\n" + m.group(2), text)
    return text


def main(argv: list[str]) -> int:
    manifest = load_manifest()
    current = README.read_text(encoding="utf-8")
    updated = render(current, manifest)
    if "--check" in argv:
        if updated != current:
            print("README.md is out of date; run scripts/gen-docs.py", file=sys.stderr)
            return 1
        return 0
    if updated != current:
        README.write_text(updated, encoding="utf-8")
        print("README.md updated")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
