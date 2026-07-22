/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { gzipSync, strToU8, zipSync } from "fflate";

import {
    acquireAndInspectSource,
    SourceAcquisitionError,
    verifyInspectionToken
} from "../../core/src/main/userPluginManager/sources.ts";
import { computePathDigest } from "../../core/src/main/userPluginManager/transaction.ts";

const execFileAsync = promisify(execFile);

async function createOperationRoot(): Promise<{ root: string; operationRoot: string; }> {
    const root = await mkdtemp(join(tmpdir(), "vencord-source-test-"));
    const operationRoot = join(root, "operations", "op-1");
    await mkdir(operationRoot, { recursive: true });
    return { root, operationRoot };
}

async function withHttpFixture(
    responses: Record<string, { body?: Uint8Array; headers?: Record<string, string>; status?: number; }>,
    callback: (baseUrl: string) => Promise<void>
): Promise<void> {
    const server = createServer((request, response) => {
        const fixture = responses[request.url ?? ""];
        if (!fixture) {
            response.writeHead(404).end();
            return;
        }
        response.writeHead(fixture.status ?? 200, fixture.headers);
        response.end(fixture.body);
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert(address && typeof address !== "string");
    try {
        await callback(`http://127.0.0.1:${address.port}`);
    } finally {
        await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
}

function tarHeader(name: string, size: number, type = "0"): Uint8Array {
    const header = new Uint8Array(512);
    header.set(strToU8(name), 0);
    header.set(strToU8("0000644\0"), 100);
    header.set(strToU8("0000000\0"), 108);
    header.set(strToU8("0000000\0"), 116);
    header.set(strToU8(`${size.toString(8).padStart(11, "0")}\0`), 124);
    header.set(strToU8("00000000000\0"), 136);
    header.fill(0x20, 148, 156);
    header[156] = type.charCodeAt(0);
    header.set(strToU8("ustar\0"), 257);
    header.set(strToU8("00"), 263);
    const checksum = header.reduce((total, byte) => total + byte, 0);
    header.set(strToU8(`${checksum.toString(8).padStart(6, "0")}\0 `), 148);
    return header;
}

function createTar(files: Record<string, Uint8Array>): Uint8Array {
    const chunks: Uint8Array[] = [];
    for (const [name, data] of Object.entries(files)) {
        chunks.push(tarHeader(name, data.byteLength), data);
        const padding = (512 - data.byteLength % 512) % 512;
        if (padding) chunks.push(new Uint8Array(padding));
    }
    chunks.push(new Uint8Array(1024));
    const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
    const result = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
        result.set(chunk, offset);
        offset += chunk.byteLength;
    }
    return result;
}

test("local plugin roots are staged, inspected, and token-bound", async t => {
    const { root, operationRoot } = await createOperationRoot();
    t.after(() => rm(root, { recursive: true, force: true }));
    const source = join(root, "Fancy Plugin");
    await mkdir(join(source, "components"), { recursive: true });
    await writeFile(join(source, "index.ts"), "import { value } from './components/value';\nexport default value;\n");
    await writeFile(join(source, "components", "value.ts"), "export const value = 1;\n");

    const inspection = await acquireAndInspectSource({
        kind: "local-directory",
        locator: source
    }, { operationRoot });

    assert.equal(inspection.shape, "plugin-root");
    assert.deepEqual(inspection.entries.map(entry => entry.destination), ["fancy-plugin"]);
    await verifyInspectionToken(inspection);
    await writeFile(join(inspection.stagedRoot, "index.ts"), "export default 2;\n");
    await assert.rejects(verifyInspectionToken(inspection), (error: unknown) => {
        return error instanceof SourceAcquisitionError && error.code === "STALE_INSPECTION";
    });
});

test("collection inspection discovers plugin roots and selected shared dependencies", async t => {
    const { root, operationRoot } = await createOperationRoot();
    t.after(() => rm(root, { recursive: true, force: true }));
    const source = join(root, "collection");
    await mkdir(join(source, "alpha"), { recursive: true });
    await mkdir(join(source, "beta"), { recursive: true });
    await mkdir(join(source, "_shared"), { recursive: true });
    await writeFile(join(source, "alpha", "index.ts"), "export default {};\n");
    await writeFile(join(source, "beta", "index.tsx"), "export default {};\n");
    await writeFile(join(source, "_shared", "author.ts"), "export const author = {};\n");

    const inspection = await acquireAndInspectSource({
        kind: "local-directory",
        locator: source,
        selectedSharedEntries: ["author.ts"]
    }, { operationRoot });

    assert.equal(inspection.shape, "collection");
    assert.deepEqual(inspection.entries.map(entry => entry.destination), ["alpha", "beta", "_shared/author.ts"]);
});

test("single-file inspection digests match transaction validation", async t => {
    const { root, operationRoot } = await createOperationRoot();
    t.after(() => rm(root, { recursive: true, force: true }));
    const source = join(root, "standalone.ts");
    await writeFile(source, "export default {};\n");

    const inspection = await acquireAndInspectSource({
        kind: "local-file",
        locator: source
    }, { operationRoot });

    assert.equal(inspection.shape, "single-file");
    assert.equal(inspection.contentDigest, await computePathDigest(inspection.stagedRoot));
    assert.equal(inspection.entries[0].contentDigest, await computePathDigest(inspection.stagedRoot));
});

test("direct files reject relative imports and local sources reject symlinks", async t => {
    const { root, operationRoot } = await createOperationRoot();
    t.after(() => rm(root, { recursive: true, force: true }));
    const direct = join(root, "direct.ts");
    await writeFile(direct, "import './other';\nexport default {};\n");
    await assert.rejects(acquireAndInspectSource({ kind: "local-file", locator: direct }, { operationRoot }), (error: unknown) => {
        return error instanceof SourceAcquisitionError && error.code === "UNSUPPORTED_SOURCE_SHAPE";
    });

    const directory = join(root, "linked");
    await mkdir(directory);
    await writeFile(join(root, "outside.ts"), "export default {};\n");
    await symlink(join(root, "outside.ts"), join(directory, "index.ts"));
    await assert.rejects(acquireAndInspectSource({ kind: "local-directory", locator: directory }, { operationRoot }), (error: unknown) => {
        return error instanceof SourceAcquisitionError && error.code === "UNSAFE_SOURCE";
    });
});

test("git acquisition honors refs without running repository code", async t => {
    const { root, operationRoot } = await createOperationRoot();
    t.after(() => rm(root, { recursive: true, force: true }));
    const repository = join(root, "vc-mediaPlaybackSpeed");
    await mkdir(join(repository, ".githooks"), { recursive: true });
    await execFileAsync("git", ["init", "-q", repository]);
    await execFileAsync("git", ["-C", repository, "config", "user.name", "Fixture"]);
    await execFileAsync("git", ["-C", repository, "config", "user.email", "fixture@example.invalid"]);
    await writeFile(join(repository, "index.ts"), "export default 'v1';\n");
    await writeFile(join(repository, ".githooks", "post-checkout"), `#!/bin/sh\ntouch ${join(root, "hook-ran")}\n`);
    await execFileAsync("git", ["-C", repository, "add", "."]);
    await execFileAsync("git", ["-C", repository, "commit", "-qm", "v1"]);
    await execFileAsync("git", ["-C", repository, "tag", "reviewed"]);
    await writeFile(join(repository, "index.ts"), "export default 'v2';\n");
    await execFileAsync("git", ["-C", repository, "commit", "-qam", "v2"]);

    const inspection = await acquireAndInspectSource({
        kind: "git",
        locator: repository,
        requestedRef: "reviewed"
    }, { operationRoot });

    assert.match(await readFile(join(inspection.stagedRoot, "index.ts"), "utf8"), /v1/);
    assert.match(inspection.resolvedRevision, /^[0-9a-f]{40,64}$/);
    assert.deepEqual(inspection.entries.map(entry => entry.destination), ["vc-mediaplaybackspeed"]);
    await assert.rejects(readFile(join(root, "hook-ran")), { code: "ENOENT" });
});

test("git acquisition uses host Git inside Flatpak", async t => {
    const { root, operationRoot } = await createOperationRoot();
    t.after(() => rm(root, { recursive: true, force: true }));
    const repository = join(root, "plugin");
    await execFileAsync("git", ["init", "-q", repository]);
    await execFileAsync("git", ["-C", repository, "config", "user.name", "Fixture"]);
    await execFileAsync("git", ["-C", repository, "config", "user.email", "fixture@example.invalid"]);
    await writeFile(join(repository, "index.ts"), "export default {};\n");
    await execFileAsync("git", ["-C", repository, "add", "."]);
    await execFileAsync("git", ["-C", repository, "commit", "-qm", "fixture"]);

    const bin = join(root, "bin");
    const marker = join(root, "flatpak-spawn.args");
    const flatpakSpawn = join(bin, "flatpak-spawn");
    await mkdir(bin);
    await writeFile(flatpakSpawn, `#!/bin/sh\nprintf '%s\\n' "$@" > "$UPM_FLATPAK_MARKER"\n[ "$1" = "--host" ] || exit 90\nshift\nexec "$@"\n`);
    await chmod(flatpakSpawn, 0o755);

    const previousFlatpakId = process.env.FLATPAK_ID;
    const previousPath = process.env.PATH;
    const previousMarker = process.env.UPM_FLATPAK_MARKER;
    process.env.FLATPAK_ID = "com.discordapp.Discord";
    process.env.PATH = `${bin}:${previousPath ?? ""}`;
    process.env.UPM_FLATPAK_MARKER = marker;
    t.after(() => {
        if (previousFlatpakId == null) delete process.env.FLATPAK_ID;
        else process.env.FLATPAK_ID = previousFlatpakId;
        if (previousPath == null) delete process.env.PATH;
        else process.env.PATH = previousPath;
        if (previousMarker == null) delete process.env.UPM_FLATPAK_MARKER;
        else process.env.UPM_FLATPAK_MARKER = previousMarker;
    });

    await acquireAndInspectSource({ kind: "git", locator: repository }, { operationRoot });
    assert.deepEqual((await readFile(marker, "utf8")).trim().split("\n").slice(0, 2), ["--host", "git"]);
});

test("git acquisition identifies an unavailable Flatpak host bridge", async t => {
    const { root, operationRoot } = await createOperationRoot();
    t.after(() => rm(root, { recursive: true, force: true }));
    const previousFlatpakId = process.env.FLATPAK_ID;
    const previousPath = process.env.PATH;
    process.env.FLATPAK_ID = "com.discordapp.Discord";
    process.env.PATH = join(root, "missing-bin");
    t.after(() => {
        if (previousFlatpakId == null) delete process.env.FLATPAK_ID;
        else process.env.FLATPAK_ID = previousFlatpakId;
        if (previousPath == null) delete process.env.PATH;
        else process.env.PATH = previousPath;
    });

    await assert.rejects(
        acquireAndInspectSource({ kind: "git", locator: root }, { operationRoot }),
        (error: unknown) => error instanceof SourceAcquisitionError
            && error.code === "ACQUISITION_FAILED"
            && error.message === "Flatpak host bridge is unavailable"
    );
});

test("HTTP ZIP and tar.gz archives are bounded, flattened, and inspected", async t => {
    const zip = zipSync({
        "wrapper/plugin/index.ts": strToU8("export default {};\n"),
        "wrapper/plugin/helper.ts": strToU8("export const helper = 1;\n")
    });
    const tarGz = gzipSync(createTar({
        "wrapper/index.ts": strToU8("export default {};\n")
    }));
    await withHttpFixture({
        "/plugin.zip": { body: zip, headers: { "content-type": "application/zip" } },
        "/plugin.tar.gz": { body: tarGz, headers: { "content-type": "application/gzip" } }
    }, async baseUrl => {
        const first = await createOperationRoot();
        const second = await createOperationRoot();
        t.after(() => Promise.all([
            rm(first.root, { recursive: true, force: true }),
            rm(second.root, { recursive: true, force: true })
        ]));
        const zipInspection = await acquireAndInspectSource({
            kind: "http-archive",
            locator: `${baseUrl}/plugin.zip`
        }, { operationRoot: first.operationRoot });
        const tarInspection = await acquireAndInspectSource({
            kind: "http-archive",
            locator: `${baseUrl}/plugin.tar.gz`
        }, { operationRoot: second.operationRoot });
        assert.equal(zipInspection.shape, "collection");
        assert.deepEqual(zipInspection.entries.map(entry => entry.destination), ["plugin"]);
        assert.equal(tarInspection.shape, "plugin-root");
    });
});

test("HTTP redirects are bounded and source credentials are never returned", async t => {
    await withHttpFixture({
        "/one": { status: 302, headers: { location: "/two" } },
        "/two": { status: 302, headers: { location: "/one" } }
    }, async baseUrl => {
        const { root, operationRoot } = await createOperationRoot();
        t.after(() => rm(root, { recursive: true, force: true }));
        await assert.rejects(acquireAndInspectSource({
            kind: "http-file",
            locator: `${baseUrl.replace("http://", "http://user:secret@")}/one`
        }, { operationRoot }), (error: unknown) => {
            assert(error instanceof SourceAcquisitionError);
            assert.equal(error.code, "LIMIT_EXCEEDED");
            assert(!error.message.includes("secret"));
            return true;
        });
    });
});
