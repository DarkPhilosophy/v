#!/usr/bin/env python3
"""Locate one Discord installation without silently choosing among several."""
from __future__ import annotations

import argparse
import json
import os
import re
import struct
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable, NoReturn

DISCORD_NAMES = (
    "Discord",
    "DiscordPTB",
    "DiscordCanary",
    "DiscordDevelopment",
    "discord",
    "discordptb",
    "discordcanary",
    "discorddevelopment",
    "discord-ptb",
    "discord-canary",
    "discord-development",
)
FLATPAK_IDS = (
    "com.discordapp.Discord",
    "com.discordapp.DiscordPTB",
    "com.discordapp.DiscordCanary",
    "com.discordapp.DiscordDevelopment",
)
MAX_HEADER_BYTES = 16 * 1024 * 1024
MAX_PACKAGE_BYTES = 1024 * 1024


class DetectionError(RuntimeError):
    pass


@dataclass(frozen=True)
class Target:
    kind: str
    resources: Path
    app_id: str | None = None


@dataclass
class Discovery:
    supported: list[Target]
    unsupported: list[Path]
    bootstrap_only: list[Path]


def _read_discord_package(path: Path) -> dict[str, object] | None:
    try:
        if not path.is_file():
            return None
        size = path.stat().st_size
        with path.open("rb") as stream:
            framing = stream.read(16)
            if len(framing) != 16:
                return None
            pickle_size, header_size, header_object_size, json_size = struct.unpack("<IIII", framing)
            if (
                pickle_size != 4
                or header_size < 8
                or header_object_size < 4
                or json_size == 0
                or json_size > MAX_HEADER_BYTES
                or json_size > size - 16
            ):
                return None
            header = json.loads(stream.read(json_size))
            package_node = header.get("files", {}).get("package.json")
            if not isinstance(package_node, dict):
                return None
            package_size = int(package_node["size"])
            package_offset = int(package_node.get("offset", "0"))
            if package_size < 0 or package_size > MAX_PACKAGE_BYTES or package_offset < 0:
                return None
            data_offset = 8 + header_size
            start = data_offset + package_offset
            if start > size or package_size > size - start:
                return None
            stream.seek(start)
            package = json.loads(stream.read(package_size))
    except (KeyError, OSError, TypeError, ValueError, UnicodeDecodeError, json.JSONDecodeError, struct.error):
        return None
    if not isinstance(package, dict):
        return None
    if package.get("name") != "discord" or not isinstance(package.get("main"), str):
        return None
    return package


def _is_discord_resources(path: Path) -> bool:
    return any(_read_discord_package(path / name) is not None for name in ("app.asar", "_app.asar"))


def _version_key(path: Path) -> tuple[tuple[int, ...], str]:
    return tuple(int(value) for value in re.findall(r"\d+", path.name)), path.name


def _resources_in_base(base: Path) -> Path | None:
    try:
        versioned = [
            child / "resources"
            for child in base.iterdir()
            if child.is_dir() and child.name.startswith("app-") and _is_discord_resources(child / "resources")
        ]
    except OSError:
        versioned = []
    if versioned:
        return max(versioned, key=lambda resources: _version_key(resources.parent))
    resources = base / "resources"
    return resources if _is_discord_resources(resources) else None


def _system_electron_base(base: Path) -> Path | None:
    if (base / "app.asar.unpacked").is_dir() and _read_discord_package(base / "app.asar") is not None:
        return base
    return None


def _append_target(targets: dict[Path, Target], target: Target) -> None:
    try:
        canonical = target.resources.resolve()
    except OSError:
        canonical = target.resources.absolute()
    targets.setdefault(canonical, Target(target.kind, canonical, target.app_id))


def _scan_bases(
    bases: Iterable[Path],
    kind: str,
    targets: dict[Path, Target],
    unsupported: set[Path],
    bootstrap_only: set[Path],
    app_id: str | None = None,
) -> None:
    for base in bases:
        resources = _resources_in_base(base)
        if resources is not None:
            _append_target(targets, Target(kind, resources, app_id))
            continue
        system_electron = _system_electron_base(base)
        if system_electron is not None:
            unsupported.add(system_electron)
            continue
        if (base / "updater_bootstrap").exists():
            bootstrap_only.add(base)


def _flatpak_config_name(app_id: str) -> str:
    suffix = app_id.removeprefix("com.discordapp.")
    return suffix.lower()


def discover(
    home: Path,
    root: Path = Path("/"),
    config_home: Path | None = None,
    data_home: Path | None = None,
) -> Discovery:
    home = home.expanduser()
    root = root.expanduser()
    config_home = (config_home or home / ".config").expanduser()
    data_home = (data_home or home / ".local/share").expanduser()
    targets: dict[Path, Target] = {}
    unsupported: set[Path] = set()
    bootstrap_only: set[Path] = set()

    native_roots = (
        root / "usr/share",
        root / "usr/lib",
        root / "usr/lib64",
        root / "opt",
        data_home,
        home / ".dvm",
        config_home,
    )
    _scan_bases(
        (directory / name for directory in native_roots for name in DISCORD_NAMES),
        "native",
        targets,
        unsupported,
        bootstrap_only,
    )

    for app_id in FLATPAK_IDS:
        install_bases = (
            root / "var/lib/flatpak/app" / app_id / "current/active/files/discord",
            data_home / "flatpak/app" / app_id / "current/active/files/discord",
        )
        _scan_bases(install_bases, "flatpak", targets, unsupported, bootstrap_only, app_id)
        config_base = home / ".var/app" / app_id / "config" / _flatpak_config_name(app_id)
        _scan_bases((config_base,), "flatpak", targets, unsupported, bootstrap_only, app_id)

    return Discovery(
        sorted(targets.values(), key=lambda target: str(target.resources)),
        sorted(unsupported, key=str),
        sorted(bootstrap_only, key=str),
    )


def _override_resources(path: Path) -> Path:
    path = path.expanduser()
    if path.is_file() and path.name == "app.asar":
        path = path.parent
    nested = path / "resources"
    if _is_discord_resources(nested):
        return nested
    if _is_discord_resources(path):
        return path
    if _system_electron_base(path) is not None:
        raise DetectionError(
            f"Discord system-electron layout is unsupported: {path} "
            "(app.asar.unpacked must be managed transactionally)"
        )
    raise DetectionError(f"VENCORD_DISCORD_DIR is not a Discord installation or resources directory: {path}")


def _format_choices(discovery: Discovery) -> str:
    lines = [f"  - {target.kind}: {target.resources}" for target in discovery.supported]
    lines.extend(f"  - system-electron (unsupported): {path}" for path in discovery.unsupported)
    return "\n".join(lines)


def select_target(discovery: Discovery, override: Path | None = None) -> Target:
    if override is not None:
        resources = _override_resources(override)
        try:
            canonical = resources.resolve()
        except OSError:
            canonical = resources.absolute()
        for target in discovery.supported:
            try:
                candidate = target.resources.resolve()
            except OSError:
                candidate = target.resources.absolute()
            if candidate == canonical:
                return target
        return Target("native", resources)

    if not discovery.unsupported and len(discovery.supported) > 1:
        app_ids = {target.app_id for target in discovery.supported}
        packaged = [
            target
            for target in discovery.supported
            if target.kind == "flatpak" and target.resources.parts[-3:] == ("files", "discord", "resources")
        ]
        if len(app_ids) == 1 and None not in app_ids and len(packaged) == 1:
            return packaged[0]

    installation_count = len(discovery.supported) + len(discovery.unsupported)
    if installation_count > 1:
        raise DetectionError(
            "multiple Discord installations found; set VENCORD_DISCORD_DIR to one installation or resources directory:\n"
            + _format_choices(discovery)
        )
    if discovery.supported:
        return discovery.supported[0]
    if discovery.unsupported:
        raise DetectionError(
            "Discord system-electron layout is unsupported: "
            f"{discovery.unsupported[0]} (app.asar.unpacked must be managed transactionally)"
        )
    if discovery.bootstrap_only:
        raise DetectionError(
            "Discord bootstrap was found, but its runtime is missing; launch Discord once so it creates "
            f"~/.config/{discovery.bootstrap_only[0].name.lower()}/app-*/resources, then rerun the installer"
        )
    raise DetectionError(
        "Discord installation not found in native, updater-managed, or Flatpak locations; "
        "set VENCORD_DISCORD_DIR explicitly"
    )


def _safe_field(value: str, name: str) -> str:
    if "\t" in value or "\n" in value or "\r" in value:
        raise DetectionError(f"{name} contains unsupported control characters")
    return value


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--home", type=Path, default=Path.home())
    parser.add_argument("--root", type=Path, default=Path("/"))
    parser.add_argument("--override", type=Path)
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv or sys.argv[1:])
    config_home = Path(os.environ["XDG_CONFIG_HOME"]) if os.environ.get("XDG_CONFIG_HOME") else None
    data_home = Path(os.environ["XDG_DATA_HOME"]) if os.environ.get("XDG_DATA_HOME") else None
    override = args.override
    if override is None and os.environ.get("VENCORD_DISCORD_DIR"):
        override = Path(os.environ["VENCORD_DISCORD_DIR"])
    try:
        target = select_target(
            discover(args.home, args.root, config_home=config_home, data_home=data_home),
            override,
        )
        fields = (
            _safe_field(target.kind, "installation kind"),
            _safe_field(target.app_id or "-", "Flatpak app ID"),
            _safe_field(str(target.resources), "Discord resources path"),
        )
    except DetectionError as exc:
        print(f"detect-discord.py: {exc}", file=sys.stderr)
        return 1
    print("\t".join(fields))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
