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
    createUserPluginManagerService,
    UserPluginManagerServiceError
} from "../../core/src/main/userPluginManager/index.ts";

async function createFixture(t: test.TestContext) {
    const root = await mkdtemp(join(tmpdir(), "vencord-manager-service-"));
    const dataRoot = join(root, "data");
    const installedRoot = join(root, "installed");
    const sourceRoot = join(root, "source");
    await mkdir(dataRoot);
    await mkdir(installedRoot);
    await mkdir(sourceRoot);
    await writeFile(join(sourceRoot, "index.ts"), "export default definePlugin({ name: 'Fixture' });\n");
    t.after(() => rm(root, { recursive: true, force: true }));
    return { root, dataRoot, installedRoot, sourceRoot };
}

test("activation gate blocks mutations until explicitly acknowledged", async t => {
    const paths = await createFixture(t);
    const service = await createUserPluginManagerService(paths);

    await assert.rejects(service.inspectSource({
        kind: "local-directory",
        locator: paths.sourceRoot
    }), (error: unknown) => error instanceof UserPluginManagerServiceError && error.code === "INACTIVE");

    const snapshot = await service.acknowledgeRisk();
    assert.equal(typeof snapshot.state.riskAcknowledgedAt, "string");
    assert.equal(snapshot.active, true);
});

test("inspection token is process-issued, expires, and never persists the raw locator", async t => {
    const paths = await createFixture(t);
    let now = Date.parse("2026-07-21T00:00:00.000Z");
    const service = await createUserPluginManagerService({
        ...paths,
        inspectionTtlMs: 1_000,
        now: () => now
    });
    await service.acknowledgeRisk();

    const inspection = await service.inspectSource({
        kind: "local-directory",
        locator: paths.sourceRoot
    });
    assert.notEqual(inspection.inspectionId, inspection.contentDigest);
    assert.equal(inspection.locator, paths.sourceRoot);

    now += 1_001;
    await assert.rejects(service.stageInstall({
        inspectionId: inspection.inspectionId,
        displayName: "Fixture"
    }), (error: unknown) => error instanceof UserPluginManagerServiceError && error.code === "EXPIRED_INSPECTION");

    const stateText = await readFile(join(paths.dataRoot, "state.json"), "utf8");
    assert(!stateText.includes(inspection.inspectionId));
});

test("staging and discard persist a plan without mutating installed files", async t => {
    const paths = await createFixture(t);
    const service = await createUserPluginManagerService(paths);
    await service.acknowledgeRisk();
    const inspection = await service.inspectSource({
        kind: "local-directory",
        locator: paths.sourceRoot
    });

    const staged = await service.stageInstall({
        inspectionId: inspection.inspectionId,
        displayName: "Fixture"
    });
    assert.equal(staged.state.pending?.changes.length, 1);
    assert.equal(staged.inventory.length, 0);
    await assert.rejects(readFile(join(paths.installedRoot, "source", "index.ts")));

    await assert.rejects(service.deactivate(), (error: unknown) => {
        return error instanceof UserPluginManagerServiceError && error.code === "PENDING_CHANGES";
    });

    const discarded = await service.discardPending();
    assert.equal(discarded.state.pending, undefined);
    assert.equal((await service.deactivate()).active, false);
});

test("pending changes survive service recreation while inspection tokens do not", async t => {
    const paths = await createFixture(t);
    const first = await createUserPluginManagerService(paths);
    await first.acknowledgeRisk();
    const inspection = await first.inspectSource({ kind: "local-directory", locator: paths.sourceRoot });
    await first.stageInstall({ inspectionId: inspection.inspectionId, displayName: "Fixture" });

    const second = await createUserPluginManagerService(paths);
    assert.equal((await second.getSnapshot()).state.pending?.changes.length, 1);
    await assert.rejects(second.stageInstall({
        inspectionId: inspection.inspectionId,
        displayName: "Fixture"
    }), (error: unknown) => error instanceof UserPluginManagerServiceError && error.code === "UNKNOWN_INSPECTION");
});

test("adoption persists across service recreation and commits without replacing files", async t => {
    const paths = await createFixture(t);
    const destination = join(paths.installedRoot, "adopted");
    await mkdir(destination);
    await writeFile(join(destination, "index.ts"), "export default definePlugin({ name: 'Adopted' });\n");

    const first = await createUserPluginManagerService(paths);
    await first.acknowledgeRisk();
    const staged = await first.stageAdopt({
        sourceId: "adopted-source",
        displayName: "Adopted",
        kind: "local-directory",
        locator: destination,
        resolvedRevision: "local",
        destinations: ["adopted"]
    });
    assert.equal(staged.state.pending?.changes[0].kind, "adopt");

    const second = await createUserPluginManagerService({ ...paths, build: async () => true });
    assert.equal((await second.getSnapshot()).state.pending?.changes[0].kind, "adopt");
    const applied = await second.applyPending();

    assert.equal(applied.state.pending, undefined);
    assert.equal(applied.state.sources[0].id, "adopted-source");
    assert.match(await readFile(join(destination, "index.ts"), "utf8"), /Adopted/);
});

test("Apply commits the whole pending batch with exactly one build", async t => {
    const paths = await createFixture(t);
    let builds = 0;
    const service = await createUserPluginManagerService({
        ...paths,
        build: async () => {
            builds++;
            return true;
        }
    });
    await service.acknowledgeRisk();
    const inspection = await service.inspectSource({
        kind: "local-directory",
        locator: paths.sourceRoot
    });
    await service.stageInstall({
        inspectionId: inspection.inspectionId,
        displayName: "Fixture"
    });

    const applied = await service.applyPending();

    assert.equal(builds, 1);
    assert.equal(applied.state.pending, undefined);
    assert.equal(applied.state.sources.length, 1);
    assert.equal(applied.state.lastApply?.sourceIds.length, 1);
    assert.match(await readFile(join(paths.installedRoot, "source", "index.ts"), "utf8"), /Fixture/);
});

test("Apply installs a direct single-file source", async t => {
    const paths = await createFixture(t);
    const sourceFile = join(paths.root, "standalone.ts");
    await writeFile(sourceFile, "export default definePlugin({ name: 'Standalone' });\n");
    const service = await createUserPluginManagerService({
        ...paths,
        build: async () => true
    });
    await service.acknowledgeRisk();
    const inspection = await service.inspectSource({
        kind: "local-file",
        locator: sourceFile
    });
    await service.stageInstall({
        inspectionId: inspection.inspectionId,
        displayName: "Standalone"
    });

    const applied = await service.applyPending();

    assert.equal(applied.state.sources.length, 1);
    assert.match(
        await readFile(join(paths.installedRoot, inspection.entries[0].destination), "utf8"),
        /Standalone/
    );
});

test("failed Apply restores installed files and preserves the pending batch", async t => {
    const paths = await createFixture(t);
    let builds = 0;
    const service = await createUserPluginManagerService({
        ...paths,
        build: async () => ++builds !== 1
    });
    await service.acknowledgeRisk();
    const inspection = await service.inspectSource({
        kind: "local-directory",
        locator: paths.sourceRoot
    });
    await service.stageInstall({
        inspectionId: inspection.inspectionId,
        displayName: "Fixture"
    });

    await assert.rejects(service.applyPending(), (error: unknown) => {
        return error instanceof UserPluginManagerServiceError && error.code === "BUILD_FAILED";
    });

    const snapshot = await service.getSnapshot();
    assert.equal(builds, 2);
    assert.equal(snapshot.state.pending?.changes.length, 1);
    assert.equal(snapshot.state.sources.length, 0);
    assert.equal(snapshot.recovery.action, "none");
    assert.equal(snapshot.locked, false);
    await assert.rejects(readFile(join(paths.installedRoot, "source", "index.ts")));
});

test("startup recovery rebuilds a restored tree and keeps the pending batch", async t => {
    const paths = await createFixture(t);
    const first = await createUserPluginManagerService({
        ...paths,
        build: async () => false
    });
    await first.acknowledgeRisk();
    const inspection = await first.inspectSource({ kind: "local-directory", locator: paths.sourceRoot });
    await first.stageInstall({ inspectionId: inspection.inspectionId, displayName: "Fixture" });

    await assert.rejects(first.applyPending());
    const interrupted = await first.getSnapshot();
    assert.equal(interrupted.recovery.action, "recovery-build");
    assert.equal(interrupted.locked, true);
    assert.equal(interrupted.state.pending?.changes.length, 1);

    let recoveryBuilds = 0;
    const second = await createUserPluginManagerService({
        ...paths,
        build: async () => {
            recoveryBuilds++;
            return true;
        }
    });
    const recovered = await second.recover();

    assert.equal(recoveryBuilds, 1);
    assert.equal(recovered.recovery.action, "none");
    assert.equal(recovered.locked, false);
    assert.equal(recovered.state.pending?.changes.length, 1);
    await assert.rejects(readFile(join(paths.installedRoot, "source", "index.ts")));
});
