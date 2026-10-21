/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// Build steps of the custom updater, in plain Node so the in-app update also works where python3
// and sh do not exist (Windows). They mirror scripts/verify-userplugins-build.py,
// scripts/stage-userplugin-seeds.sh and scripts/package-vencord-asar.sh byte for byte; the shell
// installer keeps using those scripts.

import { createHash } from "crypto";
import { existsSync } from "fs";
import { lstat, mkdir, open, readdir, readFile, rename, rm, writeFile } from "fs/promises";
import { basename, dirname, join, posix, relative, sep } from "path";

export const FORGE_PROFILE = "forge-profile.json";

export interface ForgeSelection {
    excludePlugins: Set<string>;
    excludePatches: Set<string>;
}

/** Exclusions chosen in Vencord Forge. Required patches and shared plugin code are never excluded. */
export async function readForgeSelection(runtimeDir: string, overlay: string): Promise<ForgeSelection> {
    const selection: ForgeSelection = { excludePlugins: new Set(), excludePatches: new Set() };
    let profile: any;
    try {
        profile = JSON.parse(await readFile(join(runtimeDir, FORGE_PROFILE), "utf8"));
    } catch {
        return selection;
    }
    let manifest: any = {};
    try {
        manifest = JSON.parse(await readFile(join(overlay, "forge.json"), "utf8"));
    } catch { }
    const required = new Set(Object.entries(manifest?.patches ?? {})
        .filter(([, meta]: [string, any]) => meta?.required).map(([name]) => name));
    const shared = new Set<string>(manifest?.overlay?.shared ?? ["_shared"]);
    const safe = (name: unknown): name is string =>
        typeof name === "string" && !!name && !/[\\/]/.test(name) && !name.startsWith(".");
    for (const name of Array.isArray(profile?.excludePlugins) ? profile.excludePlugins : [])
        if (safe(name) && !shared.has(name)) selection.excludePlugins.add(name);
    for (const name of Array.isArray(profile?.excludePatches) ? profile.excludePatches : [])
        if (safe(name) && !required.has(name)) selection.excludePatches.add(name);
    return selection;
}

export async function removeExcludedPlugins(userplugins: string, selection: ForgeSelection) {
    for (const name of selection.excludePlugins)
        await rm(join(userplugins, name), { recursive: true, force: true });
}

export async function readSeries(patchesDir: string, selection: ForgeSelection) {
    return (await readFile(join(patchesDir, "series"), "utf8"))
        .split("\n").map(line => line.replace(/#.*/, "").trim())
        .filter(line => line && !selection.excludePatches.has(line));
}

// ── Userplugin inventory and bundle verification (verify-userplugins-build.py) ──

export interface InventoryEntry { destination: string; name: string; source: string; }

const NAME_PATTERN = /\bname\s*:\s*(['"])([^'"]+)\1/;

export async function userpluginInventory(root: string): Promise<InventoryEntry[]> {
    const inventory: InventoryEntry[] = [];
    for (const name of (await readdir(root)).sort()) {
        if (name === "_shared" || name.startsWith(".")) continue;
        const entry = join(root, name);
        const stat = await lstat(entry);
        if (stat.isSymbolicLink()) throw new Error(`userplugin entry is a symlink: ${entry}`);
        let source: string;
        if (stat.isFile()) {
            if (!/\.tsx?$/.test(name)) throw new Error(`userplugin entry is not TypeScript: ${entry}`);
            source = entry;
        } else if (stat.isDirectory()) {
            const candidates = ["index.tsx", "index.ts"].map(file => join(entry, file)).filter(file => existsSync(file));
            if (candidates.length !== 1) throw new Error(`userplugin directory must contain exactly one index.ts or index.tsx: ${entry}`);
            source = candidates[0];
        } else throw new Error(`userplugin entry is not a regular file or directory: ${entry}`);
        const match = NAME_PATTERN.exec(await readFile(source, "utf8"));
        if (!match) throw new Error(`userplugin entry point has no literal name property: ${source}`);
        inventory.push({ destination: name, name: match[2], source: relative(root, source).split(sep).join("/") });
    }
    return inventory;
}

export async function verifyUserpluginBundle(inventory: InventoryEntry[], bundlePath: string, mapPath: string) {
    const bundle = await readFile(bundlePath, "utf8");
    const sources: string[] = JSON.parse(await readFile(mapPath, "utf8")).sources.map((s: string) => s.replace(/\\/g, "/"));
    const missing = inventory.filter(plugin => !bundle.includes(plugin.name)
        || !sources.some(source => source.endsWith(`src/userplugins/${plugin.source}`)));
    if (missing.length)
        throw new Error(`custom userplugins missing from renderer bundle: ${missing.map(p => `${p.name} (${p.destination})`).join(", ")}`);
}

// ── Embedded seeds (stage-userplugin-seeds.sh) ──

async function walkFiles(root: string, files: Record<string, string>, dir = root) {
    const entries = (await readdir(dir)).sort();
    for (const name of entries) {
        const path = join(dir, name);
        if ((await lstat(path)).isSymbolicLink()) throw new Error(`userplugin source tree contains a symlink: ${path}`);
    }
    // os.walk order: files of this directory first, then each subdirectory in sorted order.
    const dirs: string[] = [];
    for (const name of entries) {
        const path = join(dir, name);
        const stat = await lstat(path);
        if (stat.isDirectory()) dirs.push(path);
        else if (stat.isFile()) files[relative(root, path).split(sep).join("/")] = await readFile(path, "utf8");
    }
    for (const sub of dirs) await walkFiles(root, files, sub);
}

async function digestPath(root: string) {
    const hash = createHash("sha256");
    const stat = await lstat(root);
    if (stat.isFile()) {
        hash.update("file\0");
        hash.update(await readFile(root));
        return hash.digest("hex");
    }
    const pending = [root];
    while (pending.length) {
        const current = pending.pop()!;
        for (const name of (await readdir(current)).sort()) {
            const entry = join(current, name);
            const rel = relative(root, entry).split(sep).join("/");
            const entryStat = await lstat(entry);
            if (entryStat.isSymbolicLink()) throw new Error(`userplugin source tree contains a symlink: ${entry}`);
            if (entryStat.isDirectory()) {
                hash.update(`directory\0${rel}\0`);
                pending.push(entry);
            } else if (entryStat.isFile()) {
                hash.update(`file\0${rel}\0`);
                hash.update(await readFile(entry));
                hash.update("\0");
            } else throw new Error(`userplugin source is not a regular file or directory: ${entry}`);
        }
    }
    return hash.digest("hex");
}

export async function generateEmbeddedSeeds(userplugins: string, output: string) {
    const files: Record<string, string> = {};
    await walkFiles(userplugins, files);
    const inventory: { destination: string; contentDigest: string; }[] = [];
    for (const name of (await readdir(userplugins)).sort())
        if (name !== "_shared") inventory.push({ destination: name, contentDigest: await digestPath(join(userplugins, name)) });
    const module = "/* Generated by scripts/stage-userplugin-seeds.sh. Do not edit. */\n"
        + `export const embeddedUserPluginFiles = ${JSON.stringify(files)} as const;\n`
        + `export const embeddedUserPluginInventory = ${JSON.stringify(inventory)} as const;\n`;
    await mkdir(dirname(output), { recursive: true });
    const temporary = join(dirname(output), `.${basename(output)}.tmp`);
    await writeFile(temporary, module, "utf8");
    await rename(temporary, output);
}

// ── Runtime ASAR (package-vencord-asar.sh) ──

function sortKeysJson(value: any): string {
    if (Array.isArray(value)) return `[${value.map(sortKeysJson).join(",")}]`;
    if (value && typeof value === "object")
        return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${sortKeysJson(value[key])}`).join(",")}}`;
    return JSON.stringify(value);
}

/** Codepoint order, matching Python's sorted() on str. */
const byCodepoint = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;

export async function packageRuntimeAsar(dist: string, output: string) {
    const contents = new Map<string, Buffer>();
    async function walk(dir: string, rel: string) {
        for (const name of (await readdir(dir)).sort(byCodepoint)) {
            const path = join(dir, name);
            const relPath = rel ? `${rel}/${name}` : name;
            const stat = await lstat(path);
            if (stat.isSymbolicLink()) throw new Error(`${relPath}: symlinks are not allowed`);
            if (stat.isDirectory()) await walk(path, relPath);
            else if (stat.isFile()) contents.set(relPath, await readFile(path));
            else throw new Error(`${relPath}: only regular files and directories are allowed`);
        }
    }
    await walk(dist, "");
    const pkg = contents.has("package.json") ? JSON.parse(contents.get("package.json")!.toString("utf8")) : { name: "vencord", version: "0.0.0" };
    pkg.main = "patcher.js";
    contents.set("package.json", Buffer.from(sortKeysJson(pkg) + "\n", "utf8"));
    if (!contents.has("patcher.js")) throw new Error("patcher.js: required runtime entry point is missing");

    const tree: any = {};
    const parts: Buffer[] = [];
    let offset = 0;
    for (const path of [...contents.keys()].sort(byCodepoint)) {
        const data = contents.get(path)!;
        const segments = posix.normalize(path).split("/");
        let node = tree;
        for (const segment of segments.slice(0, -1)) {
            node.files ??= {};
            node = node.files[segment] ??= {};
            if ("size" in node) throw new Error(`${path}: file/directory name collision`);
        }
        node.files ??= {};
        node.files[segments.at(-1)!] = { size: data.length, offset: String(offset) };
        parts.push(data);
        offset += data.length;
    }
    const json = Buffer.from(sortKeysJson(tree), "utf8");
    const header = Buffer.alloc(16);
    header.writeUInt32LE(4, 0);
    header.writeUInt32LE(8 + json.length, 4);
    header.writeUInt32LE(4 + json.length, 8);
    header.writeUInt32LE(json.length, 12);
    const temporary = join(dirname(output), `.${basename(output)}.${process.pid}.tmp`);
    const handle = await open(temporary, "w");
    try {
        await handle.write(header);
        await handle.write(json);
        for (const data of parts) await handle.write(data);
        await handle.sync();
    } finally {
        await handle.close();
    }
    try {
        await rename(temporary, output);
    } catch (error) {
        await rm(temporary, { force: true });
        throw error;
    }
}
