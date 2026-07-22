/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { cp, mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, normalize, sep } from "node:path";

import { embeddedUserPluginFiles, embeddedUserPluginInventory } from "./embeddedSeeds.generated";

export { embeddedUserPluginFiles, embeddedUserPluginInventory };

export async function materializeEmbeddedUserPluginsTree(
    destination: string,
    files: Readonly<Record<string, string>> = embeddedUserPluginFiles
): Promise<void> {
    await rm(destination, { recursive: true, force: true });
    await mkdir(destination, { recursive: true });

    await Promise.all(Object.entries(files).map(async ([relativePath, content]) => {
        const normalized = normalize(relativePath);
        if (normalized === ".." || normalized.startsWith(`..${sep}`)) {
            throw new Error(`Embedded userplugin path escapes its destination: ${relativePath}`);
        }
        const path = join(destination, normalized);
        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, content, "utf8");
    }));
}

export async function materializeUserPluginsTree(sourceRoot: string, userpluginsRoot: string): Promise<void> {
    const destination = join(sourceRoot, "src", "userplugins");
    await rm(destination, { recursive: true, force: true });
    await mkdir(dirname(destination), { recursive: true });
    await cp(userpluginsRoot, destination, { recursive: true, errorOnExist: true, force: false });
}
