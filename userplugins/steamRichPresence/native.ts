/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";

import type { SteamGame } from ".";

const execFileAsync = promisify(execFile);
const gameCache = new Map<string, SteamGame>();

const FIND_STEAM_APPS = String.raw`
for environment in /proc/[0-9]*/environ; do
    [ -r "$environment" ] || continue
    app_id=$(cat "$environment" 2>/dev/null | tr '\0' '\n' | sed -n 's/^SteamAppId=//p' | head -n 1)
    case "$app_id" in
        ''|*[!0-9]*|0|7) continue ;;
    esac
    printf '%s\n' "$app_id"
done
`;

export function parseSteamAppIds(output: string): string[] {
    return [...new Set(output.split(/\s+/).filter(value => /^\d+$/.test(value) && value !== "0" && value !== "7"))];
}
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
