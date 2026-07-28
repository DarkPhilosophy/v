/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { cp, mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, normalize, sep } from "node:path";

import { embeddedUserPluginFiles, embeddedUserPluginInventory } from "./embeddedSeeds.generated";

export { embeddedUserPluginFiles, embeddedUserPluginInventory };

function normalizeEmbeddedPath(path: string): string {
    const normalized = normalize(path);
    if (normalized === "." || normalized === ".." || isAbsolute(normalized) || normalized.startsWith(`..${sep}`)) {
        throw new Error(`Embedded userplugin path escapes its destination: ${path}`);
    }
    return normalized;
}

export function selectEmbeddedUserPluginFiles(
    files: Readonly<Record<string, string>>,
    destinations: readonly string[]
): Record<string, string> {
    const roots = destinations.map(destination => normalizeEmbeddedPath(destination).split(sep).join("/"));

    return Object.fromEntries(Object.entries(files).filter(([path]) =>
        roots.some(root => path === root || path.startsWith(`${root}/`))
    ));
}

export async function materializeEmbeddedUserPluginsTree(
    destination: string,
    files: Readonly<Record<string, string>> = embeddedUserPluginFiles
): Promise<void> {
    await rm(destination, { recursive: true, force: true });
    await mkdir(destination, { recursive: true });

    await Promise.all(Object.entries(files).map(async ([relativePath, content]) => {
        const normalized = normalizeEmbeddedPath(relativePath);
        const path = join(destination, normalized);
        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, content, "utf8");
    }));
}

export async function restoreManagedEmbeddedUserPlugins(
    destination: string,
    destinations: readonly string[],
    files: Readonly<Record<string, string>> = embeddedUserPluginFiles
): Promise<void> {
    const selected = selectEmbeddedUserPluginFiles(files, destinations);
    const selectedPaths = Object.keys(selected);
    const roots = [...new Set(destinations.map(path => normalizeEmbeddedPath(path)))].filter(root => {
        const key = root.split(sep).join("/");
        return selectedPaths.some(path => path === key || path.startsWith(`${key}/`));
    });

    await Promise.all(roots.map(root => rm(join(destination, root), { recursive: true, force: true })));
    await Promise.all(Object.entries(selected).map(async ([relativePath, content]) => {
        const path = join(destination, normalizeEmbeddedPath(relativePath));
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
