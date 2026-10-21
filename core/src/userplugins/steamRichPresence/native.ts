/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";

import type { SteamGame } from ".";
import { parseSteamAppIds } from "./parse";

const execFileAsync = promisify(execFile);
const gameCache = new Map<string, SteamGame>();

// A process counts as a running game only if it carries SteamAppId AND is not a Wine/Proton
// infrastructure process. Wine's services (services.exe, svchost.exe, rpcss.exe, plugplay.exe,
// winedevice.exe, explorer.exe, wineserver, ...) inherit SteamAppId and can outlive the game by
// days when the prefix is not shut down, which kept "Playing <game>" on forever.
const FIND_STEAM_APPS = String.raw`
for environment in /proc/[0-9]*/environ; do
    [ -r "$environment" ] || continue
    app_id=$(cat "$environment" 2>/dev/null | tr '\0' '\n' | sed -n 's/^SteamAppId=//p' | head -n 1)
    case "$app_id" in
        ''|*[!0-9]*|0|7) continue ;;
    esac
    # Judge only the executable (argv[0]), never the whole command line: a game whose install
    # path happens to contain "proton" or "reaper" must still count.
    argv0=$(tr '\0' '\n' < "$(dirname "$environment")/cmdline" 2>/dev/null | head -n 1 | tr 'A-Z' 'a-z')
    case "$argv0" in
        ''|'c:\windows\'*) continue ;;
    esac
    case "$(basename "$(printf '%s' "$argv0" | tr '\\' '/')")" in
        services.exe|svchost.exe|rpcss.exe|plugplay.exe|winedevice.exe|explorer.exe|conhost.exe|tabtip.exe|start.exe|steam.exe|wineserver|wine-preloader|wine64-preloader|reaper|srt-bwrap|pv-adverb|steam-launch-wrapper) continue ;;
    esac
    printf '%s\n' "$app_id"
done
`;

async function runningSteamAppIds(): Promise<string[]> {
    const flatpak = process.platform === "linux" && Boolean(process.env.FLATPAK_ID);
    const command = flatpak ? "flatpak-spawn" : "sh";
    const args = flatpak
        ? ["--host", "sh", "-c", FIND_STEAM_APPS]
        : ["-c", FIND_STEAM_APPS];

    try {
        const { stdout } = await execFileAsync(command, args, {
            encoding: "utf8",
            maxBuffer: 64 * 1024,
            timeout: 10_000
        });
        return parseSteamAppIds(stdout);
    } catch {
        return [];
    }
}

async function fetchSteamGame(appId: string): Promise<SteamGame | null> {
    const cached = gameCache.get(appId);
    if (cached) return cached;

    try {
        const response = await fetch(`https://store.steampowered.com/api/appdetails?appids=${encodeURIComponent(appId)}`);
        if (!response.ok) return null;

        const payload = await response.json() as Record<string, {
            success?: boolean;
            data?: {
                name?: string;
                type?: string;
                short_description?: string;
                header_image?: string;
            };
        }>;
        const entry = payload[appId];
        if (!entry?.success || entry.data?.type !== "game" || !entry.data.name) return null;

        const game: SteamGame = {
            appId,
            name: entry.data.name,
            description: entry.data.short_description,
            headerImage: entry.data.header_image
        };
        gameCache.set(appId, game);
        return game;
    } catch {
        return null;
    }
}

export async function getRunningSteamGame(): Promise<SteamGame | null> {
    for (const appId of await runningSteamAppIds()) {
        const game = await fetchSteamGame(appId);
        if (game) return game;
    }
    return null;
}
