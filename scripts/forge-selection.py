#!/usr/bin/env python3
"""Print what the user's forge profile excludes, one name per line.

Usage: forge-selection.py <forge.json> <forge-profile.json> <plugins|patches>

The profile is written by Vencord Forge next to the runtime (forge-profile.json). It only lists
exclusions, so plugins and patches added later are enabled by default. Required patches are never
excluded, whatever the profile says. A missing profile excludes nothing.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path


def main(argv: list[str]) -> int:
    if len(argv) != 4 or argv[3] not in ("plugins", "patches"):
        print(__doc__, file=sys.stderr)
        return 2
    manifest = json.loads(Path(argv[1]).read_text(encoding="utf-8"))
    profile_path = Path(argv[2])
    if not profile_path.is_file():
        return 0
    try:
        profile = json.loads(profile_path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as exc:
        print(f"ignoring unreadable forge profile {profile_path}: {exc}", file=sys.stderr)
        return 0
    if not isinstance(profile, dict):
        return 0
    key = "excludePlugins" if argv[3] == "plugins" else "excludePatches"
    names = profile.get(key, [])
    if not isinstance(names, list):
        return 0
    required = {name for name, meta in manifest.get("patches", {}).items() if meta.get("required")}
    shared = set(manifest.get("overlay", {}).get("shared", []))
    for name in names:
        if not isinstance(name, str) or not name or "/" in name or "\\" in name or name.startswith("."):
            continue
        if argv[3] == "plugins" and name in shared:
            continue
        if argv[3] == "patches" and name in required:
            print(f"required patch cannot be excluded: {name}", file=sys.stderr)
            continue
        print(name)
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
