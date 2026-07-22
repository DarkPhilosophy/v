#!/usr/bin/env python3
"""Inventory canonical user plugins and verify their renderer bundle registration."""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path

NAME_PATTERN = re.compile(r"\bname\s*:\s*(['\"])(?P<name>[^'\"]+)\1")


def fail(message: str) -> None:
    raise SystemExit(message)


def plugin_source(entry: Path) -> Path:
    if entry.is_symlink():
        fail(f"userplugin entry is a symlink: {entry}")
    if entry.is_file():
        if entry.suffix not in {".ts", ".tsx"}:
            fail(f"userplugin entry is not TypeScript: {entry}")
        return entry
    if not entry.is_dir():
        fail(f"userplugin entry is not a regular file or directory: {entry}")

    candidates = [candidate for candidate in (entry / "index.tsx", entry / "index.ts") if candidate.is_file()]
    if len(candidates) != 1:
        fail(f"userplugin directory must contain exactly one index.ts or index.tsx: {entry}")
    if candidates[0].is_symlink():
        fail(f"userplugin entry point is a symlink: {candidates[0]}")
    return candidates[0]


def collect_inventory(source_root: Path) -> list[dict[str, str]]:
    if not source_root.is_dir():
        fail(f"userplugin source directory does not exist: {source_root}")

    inventory: list[dict[str, str]] = []
    for entry in sorted(source_root.iterdir(), key=lambda candidate: candidate.name):
        if entry.name == "_shared" or entry.name.startswith("."):
            continue
        source = plugin_source(entry)
        try:
            text = source.read_text(encoding="utf-8")
        except UnicodeDecodeError as exc:
            fail(f"userplugin entry point is not UTF-8 text: {source}: {exc}")
        match = NAME_PATTERN.search(text)
        if match is None:
            fail(f"userplugin entry point has no literal name property: {source}")
        inventory.append({
            "destination": entry.name,
            "name": match.group("name"),
            "source": source.relative_to(source_root).as_posix(),
        })

    if not inventory:
        fail(f"no canonical userplugins found in: {source_root}")
    return inventory


def write_inventory(source_root: Path, output: Path) -> None:
    inventory = collect_inventory(source_root)
    output.parent.mkdir(parents=True, exist_ok=True)
    temporary = output.with_name(f".{output.name}.tmp")
    temporary.write_text(json.dumps(inventory, separators=(",", ":")) + "\n", encoding="utf-8")
    temporary.replace(output)
    for plugin in inventory:
        print(f"  - {plugin['name']} ({plugin['destination']})")


def read_inventory(path: Path) -> list[dict[str, str]]:
    try:
        inventory = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as exc:
        fail(f"cannot read userplugin inventory {path}: {exc}")
    if not isinstance(inventory, list) or not all(
        isinstance(plugin, dict)
        and isinstance(plugin.get("destination"), str)
        and isinstance(plugin.get("name"), str)
        and isinstance(plugin.get("source"), str)
        for plugin in inventory
    ):
        fail(f"invalid userplugin inventory: {path}")
    return inventory


def verify_bundle(inventory_path: Path, renderer_bundle: Path, renderer_source_map: Path) -> None:
    inventory = read_inventory(inventory_path)
    try:
        bundle = renderer_bundle.read_bytes()
    except OSError as exc:
        fail(f"cannot read renderer bundle {renderer_bundle}: {exc}")
    try:
        source_map = json.loads(renderer_source_map.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as exc:
        fail(f"cannot read renderer source map {renderer_source_map}: {exc}")
    if not isinstance(source_map, dict) or not isinstance(source_map.get("sources"), list) or not all(
        isinstance(source, str) for source in source_map["sources"]
    ):
        fail(f"invalid renderer source map: {renderer_source_map}")

    compiled_sources = [source.replace("\\", "/") for source in source_map["sources"]]
    missing = [
        plugin
        for plugin in inventory
        if plugin["name"].encode("utf-8") not in bundle
        or not any(
            source.endswith(f"src/userplugins/{plugin['source']}")
            for source in compiled_sources
        )
    ]
    if missing:
        names = ", ".join(f"{plugin['name']} ({plugin['destination']})" for plugin in missing)
        fail(f"custom userplugins missing from renderer bundle: {names}")
    for plugin in inventory:
        print(f"  - {plugin['name']} ({plugin['destination']})")


def main(argv: list[str]) -> None:
    if (len(argv) != 4 and argv[1:2] == ["inventory"]) or (len(argv) != 5 and argv[1:2] == ["verify"]) or argv[1:2] not in (["inventory"], ["verify"]):
        fail(f"usage: {argv[0]} inventory <source-userplugins-dir> <inventory-json>\n"
             f"       {argv[0]} verify <inventory-json> <renderer-bundle> <renderer-source-map>")
    if argv[1] == "inventory":
        write_inventory(Path(argv[2]), Path(argv[3]))
    else:
        verify_bundle(Path(argv[2]), Path(argv[3]), Path(argv[4]))


if __name__ == "__main__":
    main(sys.argv)
