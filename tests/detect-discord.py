#!/usr/bin/env python3
from __future__ import annotations

import importlib.util
import json
import struct
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
HELPER = ROOT / "scripts" / "detect-discord.py"

spec = importlib.util.spec_from_file_location("detect_discord", HELPER)
if spec is None or spec.loader is None:
    raise RuntimeError(f"cannot load {HELPER}")
detector = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = detector
spec.loader.exec_module(detector)


def write_discord_asar(path: Path, *, name: str = "discord") -> None:
    package = json.dumps({"name": name, "main": "patcher.js"}, separators=(",", ":")).encode()
    header = json.dumps(
        {"files": {"package.json": {"size": len(package), "offset": "0"}}},
        separators=(",", ":"),
    ).encode()
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(struct.pack("<IIII", 4, 8 + len(header), 4 + len(header), len(header)) + header + package)


class DetectDiscordTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name) / "root"
        self.home = Path(self.temp.name) / "home"
        self.root.mkdir()
        self.home.mkdir()

    def discover(self):
        return detector.discover(self.home, self.root)

    def test_discovers_every_native_channel_in_standard_roots(self) -> None:
        expected = {
            "Discord": self.root / "usr/share/Discord/resources",
            "DiscordPTB": self.root / "usr/lib/DiscordPTB/resources",
            "discordcanary": self.root / "usr/lib64/discordcanary/resources",
            "discord-development": self.root / "opt/discord-development/resources",
        }
        for resources in expected.values():
            write_discord_asar(resources / "app.asar")

        result = self.discover()

        self.assertEqual({target.resources for target in result.supported}, set(expected.values()))
        self.assertTrue(all(target.kind == "native" for target in result.supported))

    def test_prefers_latest_updater_app_directory_over_static_resources(self) -> None:
        base = self.home / ".config/discord"
        write_discord_asar(base / "resources/app.asar")
        write_discord_asar(base / "app-0.0.99/resources/app.asar")
        write_discord_asar(base / "app-0.0.100/resources/app.asar")

        result = self.discover()

        self.assertEqual(len(result.supported), 1)
        self.assertEqual(result.supported[0].resources, base / "app-0.0.100/resources")

    def test_discovers_system_and_user_flatpak_with_their_app_ids(self) -> None:
        system_resources = (
            self.root
            / "var/lib/flatpak/app/com.discordapp.DiscordCanary/current/active/files/discord/resources"
        )
        user_resources = (
            self.home
            / ".local/share/flatpak/app/com.discordapp.DiscordPTB/current/active/files/discord/resources"
        )
        write_discord_asar(system_resources / "app.asar")
        write_discord_asar(user_resources / "app.asar")

        result = self.discover()

        actual = {(target.resources, target.app_id) for target in result.supported}
        self.assertEqual(
            actual,
            {
                (system_resources, "com.discordapp.DiscordCanary"),
                (user_resources, "com.discordapp.DiscordPTB"),
            },
        )
        self.assertTrue(all(target.kind == "flatpak" for target in result.supported))

    def test_discovers_latest_flatpak_updater_directory(self) -> None:
        base = self.home / ".var/app/com.discordapp.Discord/config/discord"
        write_discord_asar(base / "app-0.0.98/resources/app.asar")
        expected = base / "app-0.0.101/resources"
        write_discord_asar(expected / "app.asar")

        result = self.discover()

        self.assertEqual(len(result.supported), 1)
        self.assertEqual(result.supported[0].resources, expected)
        self.assertEqual(result.supported[0].app_id, "com.discordapp.Discord")

    def test_detects_an_already_managed_flatpak_installation(self) -> None:
        resources = (
            self.home
            / ".var/app/com.discordapp.Discord/config/discord/app-0.0.101/resources"
        )
        resources.mkdir(parents=True)
        (resources / "app.asar").write_text("Vencord loader")
        write_discord_asar(resources / "_app.asar")

        result = self.discover()

        self.assertEqual(len(result.supported), 1)
        self.assertEqual(result.supported[0].resources, resources)
        self.assertEqual(result.supported[0].app_id, "com.discordapp.Discord")

    def test_deduplicates_symlinked_installations_by_canonical_resources_path(self) -> None:
        resources = self.root / "opt/discord/resources"
        write_discord_asar(resources / "app.asar")
        alias = self.root / "usr/share/discord"
        alias.parent.mkdir(parents=True)
        alias.symlink_to(resources.parent, target_is_directory=True)

        result = self.discover()

        self.assertEqual(len(result.supported), 1)
        self.assertEqual(result.supported[0].resources, resources)

    def test_ignores_a_file_that_is_not_a_discord_asar(self) -> None:
        invalid = self.root / "opt/discord/resources/app.asar"
        invalid.parent.mkdir(parents=True)
        invalid.write_text("not an asar")
        write_discord_asar(
            self.root / "usr/share/Discord/resources/app.asar",
            name="not-discord",
        )

        result = self.discover()

        self.assertEqual(result.supported, [])

    def test_reports_system_electron_layout_as_unsupported(self) -> None:
        install = self.root / "usr/lib/discord"
        write_discord_asar(install / "app.asar")
        (install / "app.asar.unpacked").mkdir()

        result = self.discover()

        self.assertEqual(result.supported, [])
        self.assertEqual(result.unsupported, [install])
        with self.assertRaisesRegex(detector.DetectionError, "system-electron"):
            detector.select_target(result)

    def test_bootstrap_only_install_explains_missing_runtime(self) -> None:
        bootstrap = self.root / "usr/share/discord/updater_bootstrap"
        bootstrap.mkdir(parents=True)

        result = self.discover()

        self.assertEqual(result.supported, [])
        with self.assertRaisesRegex(
            detector.DetectionError,
            r"bootstrap.*launch Discord once.*\.config/discord/app-\*",
        ):
            detector.select_target(result)

    def test_ambiguous_installations_require_an_explicit_override(self) -> None:
        first = self.root / "opt/discord/resources"
        second = self.root / "usr/share/DiscordCanary/resources"
        write_discord_asar(first / "app.asar")
        write_discord_asar(second / "app.asar")
        result = self.discover()

        with self.assertRaisesRegex(detector.DetectionError, "multiple Discord installations"):
            detector.select_target(result)

        selected = detector.select_target(result, first.parent)
        self.assertEqual(selected.resources, first)

    def test_override_accepts_a_resources_directory(self) -> None:
        resources = self.home / "Discord Custom/resources"
        write_discord_asar(resources / "app.asar")

        selected = detector.select_target(self.discover(), resources)

        self.assertEqual(selected.resources, resources)
        self.assertEqual(selected.kind, "native")

    def test_cli_emits_install_kind_app_id_and_resources(self) -> None:
        resources = (
            self.root
            / "var/lib/flatpak/app/com.discordapp.Discord/current/active/files/discord/resources"
        )
        write_discord_asar(resources / "app.asar")

        completed = subprocess.run(
            [
                sys.executable,
                str(HELPER),
                "--home",
                str(self.home),
                "--root",
                str(self.root),
            ],
            check=True,
            capture_output=True,
            text=True,
        )

        self.assertEqual(completed.stdout.rstrip("\n"), f"flatpak\tcom.discordapp.Discord\t{resources}")
        self.assertEqual(completed.stderr, "")


if __name__ == "__main__":
    unittest.main()
