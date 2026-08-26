/*
 * Vencord, a modification for Discord's desktop app
 * Copyright (c) 2022 Vendicated and contributors
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <https://www.gnu.org/licenses/>.
*/

const BASE_GLOW_WARNING = "Could not find a View Model linked to Artboard BaseGlowRemapped.";
const SCRIPT_COST_WARNING = "[scriptCost] retained URL count exceeded maxUrls (1000); evicting lowest-cost entries.";
const MISSING_LOCALE_MESSAGE = /^Requested message .+ does not have a value in the requested locale .+ nor the default locale .+$/;

export interface ConsoleLike {
    error(...args: unknown[]): void;
    warn(...args: unknown[]): void;
}

export function installDiscordKnownNoiseFilter(consoleObject: ConsoleLike): void {
    const originalError = consoleObject.error.bind(consoleObject);
    const originalWarn = consoleObject.warn.bind(consoleObject);
    consoleObject.error = (...args: unknown[]) => {
        if (args.length === 1 && args[0] === BASE_GLOW_WARNING) return;
        originalError(...args);
    };
    consoleObject.warn = (...args: unknown[]) => {
        if (
            args.length === 1
            && typeof args[0] === "string"
            && (
                args[0] === SCRIPT_COST_WARNING
                || MISSING_LOCALE_MESSAGE.test(args[0])
            )
        ) return;
        originalWarn(...args);
    };
}
