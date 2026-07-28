/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

export function parseSteamAppIds(output: string): string[] {
    return [...new Set(output.split(/\s+/).filter(value => /^\d+$/.test(value) && value !== "0" && value !== "7"))];
}
