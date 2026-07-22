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
    materializeUserPluginsTree
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
