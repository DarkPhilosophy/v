/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
    materializeEmbeddedUserPluginsTree,
    materializeUserPluginsTree,
    restoreManagedEmbeddedUserPlugins,
    selectEmbeddedUserPluginFiles
} from "../../core/src/main/userPluginManager/buildSources.ts";

test("repatch build replaces upstream userplugins with the embedded transaction tree", async t => {
    const root = await mkdtemp(join(tmpdir(), "vencord-repatch-userplugins-"));
    t.after(() => rm(root, { recursive: true, force: true }));

    const sourceRoot = join(root, "source");
    const embeddedRoot = join(root, "embedded");
    await mkdir(join(sourceRoot, "src", "userplugins", "removed"), { recursive: true });
    await mkdir(join(embeddedRoot, "retained"), { recursive: true });
    await mkdir(join(embeddedRoot, "_shared", "library"), { recursive: true });
    await writeFile(join(sourceRoot, "src", "userplugins", "removed", "index.ts"), "stale\n");
    await writeFile(join(embeddedRoot, "retained", "index.ts"), "embedded\n");
    await writeFile(join(embeddedRoot, "_shared", "library", "index.ts"), "shared\n");

    await materializeUserPluginsTree(sourceRoot, embeddedRoot);

    assert.equal(await readFile(join(sourceRoot, "src", "userplugins", "retained", "index.ts"), "utf8"), "embedded\n");
    assert.equal(await readFile(join(sourceRoot, "src", "userplugins", "_shared", "library", "index.ts"), "utf8"), "shared\n");
    await assert.rejects(readFile(join(sourceRoot, "src", "userplugins", "removed", "index.ts")));
});

test("runtime materializes bundled plugin sources without a seed directory", async t => {
    const root = await mkdtemp(join(tmpdir(), "vencord-bundled-userplugins-"));
    t.after(() => rm(root, { recursive: true, force: true }));

    const destination = join(root, "operations", "userplugins");
    await materializeEmbeddedUserPluginsTree(destination, {
        "_shared/author.ts": "export const author = 'test';\n",
        "questCompleter/index.tsx": "export default {};\n"
    });

    assert.equal(await readFile(join(destination, "_shared", "author.ts"), "utf8"), "export const author = 'test';\n");
    assert.equal(await readFile(join(destination, "questCompleter", "index.tsx"), "utf8"), "export default {};\n");
});

test("automatic rebuild keeps only UserPluginManager-owned sources from the installed runtime", () => {
    const selected = selectEmbeddedUserPluginFiles({
        "_shared/managed.ts": "managed shared\n",
        "_shared/unmanaged.ts": "bundled shared\n",
        "managed/index.ts": "managed plugin\n",
        "managed/submodule.ts": "managed submodule\n",
        "managed-old/index.ts": "prefix collision\n",
        "bundled/index.ts": "bundled plugin\n"
    }, ["managed", "_shared/managed.ts"]);

    assert.deepEqual(selected, {
        "_shared/managed.ts": "managed shared\n",
        "managed/index.ts": "managed plugin\n",
        "managed/submodule.ts": "managed submodule\n"
    });
});

test("automatic rebuild overlays manager-owned sources without removing new bundled plugins", async t => {
    const root = await mkdtemp(join(tmpdir(), "vencord-auto-update-userplugins-"));
    t.after(() => rm(root, { recursive: true, force: true }));

    const destination = join(root, "src", "userplugins");
    await mkdir(join(destination, "managed"), { recursive: true });
    await mkdir(join(destination, "bundled"), { recursive: true });
    await mkdir(join(destination, "_shared"), { recursive: true });
    await writeFile(join(destination, "managed", "index.ts"), "github replacement\n");
    await writeFile(join(destination, "managed", "github-only.ts"), "remove with managed root\n");
    await writeFile(join(destination, "bundled", "index.ts"), "new github plugin\n");
    await writeFile(join(destination, "_shared", "managed.ts"), "github shared replacement\n");
    await writeFile(join(destination, "_shared", "unmanaged.ts"), "new github shared file\n");

    await restoreManagedEmbeddedUserPlugins(destination, ["managed", "_shared/managed.ts"], {
        "managed/index.ts": "installed user version\n",
        "_shared/managed.ts": "installed shared version\n",
        "removed/index.ts": "not manager-owned\n"
    });

    assert.equal(await readFile(join(destination, "managed", "index.ts"), "utf8"), "installed user version\n");
    await assert.rejects(readFile(join(destination, "managed", "github-only.ts")));
    assert.equal(await readFile(join(destination, "bundled", "index.ts"), "utf8"), "new github plugin\n");
    assert.equal(await readFile(join(destination, "_shared", "managed.ts"), "utf8"), "installed shared version\n");
    assert.equal(await readFile(join(destination, "_shared", "unmanaged.ts"), "utf8"), "new github shared file\n");
    await assert.rejects(readFile(join(destination, "removed", "index.ts")));
});
