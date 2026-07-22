/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import assert from "node:assert/strict";
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
    createFlatpakUserPluginManagerHost,
    executeUserPluginManagerHostRequest
} from "../../core/src/main/userPluginManager/host";
import { computePathDigest } from "../../core/src/main/userPluginManager/transaction";

test("host request applies staged sources to the host-installed root", async t => {
    const root = await mkdtemp(join(tmpdir(), "vencord-upm-host-"));
    t.after(() => rm(root, { recursive: true, force: true }));

    const dataRoot = join(root, "sandbox-data");
    const installedRoot = join(root, "host-vencord", "src", "userplugins");
    const operationRoot = join(dataRoot, "operations", "apply-host");
    const stagedRoot = join(operationRoot, "sources", "probe");
    const stagedPath = join(stagedRoot, "hostProbe.ts");
    const journalPath = join(dataRoot, "journal.json");
    await mkdir(stagedRoot, { recursive: true });
    await writeFile(stagedPath, "export default { name: \"hostProbe\" };\n");

    const digest = await computePathDigest(stagedRoot);
    const entryDigest = await computePathDigest(stagedPath);
    await executeUserPluginManagerHostRequest({
        action: "apply-transaction",
        plan: {
            operationId: "apply-host",
            pendingId: "pending-host",
            installedRoot,
            operationRoot,
            journalPath,
            sources: [{
                sourceId: "probe-source",
                stagedRoot,
                inspectedRevision: "local",
                inspectedDigest: digest
            }],
            ownership: [],
            adoptions: [],
            mutations: [{
                action: "write",
                destination: "hostProbe.ts",
                sourceId: "probe-source",
                stagedPath,
                inspectedDigest: entryDigest,
                expected: { state: "absent" }
            }]
        }
    });

    assert.equal(
        await readFile(join(installedRoot, "hostProbe.ts"), "utf8"),
        "export default { name: \"hostProbe\" };\n"
    );
});

test("Flatpak host bridge streams requests over stdin without sandbox-only request files", async t => {
    const root = await mkdtemp(join(tmpdir(), "vencord-upm-flatpak-host-"));
    t.after(() => rm(root, { recursive: true, force: true }));

    const bin = join(root, "bin");
    const dataRoot = join(root, "sandbox-data");
    const runnerPath = join(root, "host-runner.cjs");
    const argsMarker = join(root, "flatpak-spawn.args");
    const requestMarker = join(root, "request.json");
    await mkdir(bin);
    await writeFile(
        join(bin, "flatpak-spawn"),
        "#!/bin/sh\nprintf '%s\\n' \"$@\" > \"$UPM_FLATPAK_MARKER\"\n[ \"$1\" = \"--host\" ] || exit 90\nshift\n[ \"$1\" != \"--forward-fd=0\" ] || exit 91\nexec \"$@\"\n"
    );
    await chmod(join(bin, "flatpak-spawn"), 0o755);
    await writeFile(
        runnerPath,
        "const fs = require('node:fs');\nlet input = '';\nprocess.stdin.setEncoding('utf8');\nprocess.stdin.on('data', chunk => input += chunk);\nprocess.stdin.on('end', () => {\n    fs.writeFileSync(process.env.UPM_REQUEST_MARKER, input);\n    const request = JSON.parse(input);\n    process.stdout.write(JSON.stringify({ ok: true, value: request.action }));\n});\n"
    );

    const previousPath = process.env.PATH;
    const previousArgsMarker = process.env.UPM_FLATPAK_MARKER;
    const previousRequestMarker = process.env.UPM_REQUEST_MARKER;
    process.env.PATH = `${bin}:${previousPath ?? ""}`;
    process.env.UPM_FLATPAK_MARKER = argsMarker;
    process.env.UPM_REQUEST_MARKER = requestMarker;
    t.after(() => {
        if (previousPath === undefined) delete process.env.PATH;
        else process.env.PATH = previousPath;
        if (previousArgsMarker === undefined) delete process.env.UPM_FLATPAK_MARKER;
        else process.env.UPM_FLATPAK_MARKER = previousArgsMarker;
        if (previousRequestMarker === undefined) delete process.env.UPM_REQUEST_MARKER;
        else process.env.UPM_REQUEST_MARKER = previousRequestMarker;
    });

    const host = createFlatpakUserPluginManagerHost(dataRoot, runnerPath);
    const result = await host.execute({ action: "ensure-installed-root", installedRoot: join(root, "unused") });

    assert.equal(result, "ensure-installed-root");
    assert.deepEqual(
        (await readFile(argsMarker, "utf8")).trim().split("\n"),
        ["--host", "node", runnerPath]
    );
    assert.deepEqual(
        JSON.parse(await readFile(requestMarker, "utf8")),
        { action: "ensure-installed-root", installedRoot: join(root, "unused") }
    );
    await assert.rejects(readFile(dataRoot), { code: "ENOENT" });
});
