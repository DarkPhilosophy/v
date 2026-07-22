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

test("Flatpak host bridge streams requests over stdin without sandbox-only request files", {
    skip: process.platform !== "linux"
}, async t => {
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
    const spawnArgs = (await readFile(argsMarker, "utf8")).trim().split("\n");
    assert.equal(spawnArgs[0], "--host");
    assert.equal(spawnArgs[1], "node");
    assert.notEqual(spawnArgs[2], runnerPath);
    assert.match(spawnArgs[2], new RegExp(`^${dataRoot.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/\\.host-runner-`));
    assert.deepEqual(
        JSON.parse(await readFile(requestMarker, "utf8")),
        { action: "ensure-installed-root", installedRoot: join(root, "unused") }
    );
    await assert.rejects(readFile(spawnArgs[2]), { code: "ENOENT" });
});

test("Flatpak host bridge validates response envelopes without masking host errors", {
    skip: process.platform !== "linux"
}, async t => {
    const root = await mkdtemp(join(tmpdir(), "vencord-upm-flatpak-malformed-"));
    t.after(() => rm(root, { recursive: true, force: true }));

    const bin = join(root, "bin");
    const runnerPath = join(root, "host-runner.cjs");
    await mkdir(bin);
    await writeFile(
        join(bin, "flatpak-spawn"),
        "#!/bin/sh\nshift\ncat >/dev/null\nprintf '%s' \"$UPM_RESPONSE\"\n"
    );
    await chmod(join(bin, "flatpak-spawn"), 0o755);
    await writeFile(runnerPath, "");

    const previousPath = process.env.PATH;
    const previousResponse = process.env.UPM_RESPONSE;
    process.env.PATH = `${bin}:${previousPath ?? ""}`;
    t.after(() => {
        if (previousPath === undefined) delete process.env.PATH;
        else process.env.PATH = previousPath;
        if (previousResponse === undefined) delete process.env.UPM_RESPONSE;
        else process.env.UPM_RESPONSE = previousResponse;
    });

    const host = createFlatpakUserPluginManagerHost(join(root, "unused"), runnerPath);
    for (const response of [
        "not-json",
        "null",
        "{}",
        "{\"ok\":\"yes\"}",
        "{\"ok\":false}",
        "{\"ok\":false,\"error\":null}",
        "{\"ok\":false,\"error\":{\"message\":42}}"
    ]) {
        process.env.UPM_RESPONSE = response;
        await assert.rejects(
            host.execute({ action: "ensure-installed-root", installedRoot: join(root, "unused") }),
            { message: "Malformed User Plugin Manager host response" },
            response
        );
    }

    process.env.UPM_RESPONSE = JSON.stringify({
        ok: false,
        error: { code: "EHOSTTEST", message: "real host failure", name: "HostTestError" }
    });
    await assert.rejects(
        host.execute({ action: "ensure-installed-root", installedRoot: join(root, "unused") }),
        { code: "EHOSTTEST", message: "real host failure", name: "HostTestError" }
    );
});

test("Flatpak host bridge times out a stalled host runner", {
    skip: process.platform !== "linux"
}, async t => {
    const root = await mkdtemp(join(tmpdir(), "vencord-upm-flatpak-timeout-"));
    t.after(() => rm(root, { recursive: true, force: true }));

    const bin = join(root, "bin");
    const runnerPath = join(root, "host-runner.cjs");
    await mkdir(bin);
    await writeFile(join(bin, "flatpak-spawn"), "#!/bin/sh\nshift\nexec \"$@\"\n");
    await chmod(join(bin, "flatpak-spawn"), 0o755);
    // This integration test needs the platform clock because the timeout controls a spawned process.
    await writeFile(runnerPath, "setTimeout(() => {}, 200);\nprocess.stdin.resume();\n");

    const previousPath = process.env.PATH;
    process.env.PATH = `${bin}:${previousPath ?? ""}`;
    t.after(() => {
        if (previousPath === undefined) delete process.env.PATH;
        else process.env.PATH = previousPath;
    });

    const host = createFlatpakUserPluginManagerHost(join(root, "unused"), runnerPath, 25);
    await assert.rejects(
        host.execute({ action: "ensure-installed-root", installedRoot: join(root, "unused") }),
        { message: "User Plugin Manager host process timed out" }
    );
});
