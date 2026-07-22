import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
    USER_PLUGIN_MANAGER_INFRASTRUCTURE_ID,
    UserPluginManagerError,
    coalescePendingChange,
    createEmptyManagerState,
    findDestinationConflicts,
    readManagerState,
    writeManagerStateAtomic,
    type ManagedSourceV1,
    type ManagerStateV1,
    type PendingChangeV1
} from "../../core/src/shared/userPluginManager.ts";

function source(id: string, destination: string, digest = `${id}-digest`): ManagedSourceV1 {
    return {
        id,
        displayName: id,
        kind: "git",
        locator: `https://example.test/${id}.git`,
        resolvedRevision: `${id}-revision`,
        contentDigest: digest,
        entries: [{ sourcePath: "index.ts", destination, contentDigest: digest }],
        updatePolicy: "manual",
        installedAt: "2026-07-21T00:00:00.000Z",
        updatedAt: "2026-07-21T00:00:00.000Z"
    };
}

function updateChange(id: string, destination = id): PendingChangeV1 {
    return {
        kind: "update",
        sourceId: id,
        inspectionId: `${id}-inspection`,
        stagedPath: `/tmp/${id}-staged`,
        shape: "plugin-root",
        inspectedRevision: `${id}-revision-2`,
        inspectedDigest: `${id}-digest-2`,
        entries: [{ sourcePath: "index.ts", destination, contentDigest: `${id}-digest-2` }],
        expectedInstalledDigest: `${id}-digest`
    };
}

async function withTempDirectory(run: (directory: string) => Promise<void>) {
    const directory = await mkdtemp(join(tmpdir(), "vencord-userplugin-manager-model-"));
    try {
        await run(directory);
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
}

test("v1 state with pending changes round-trips without losing fields", async () => {
    await withTempDirectory(async directory => {
        const path = join(directory, "state.json");
        const initial: ManagerStateV1 = {
            ...createEmptyManagerState(),
            riskAcknowledgedAt: "2026-07-21T00:00:00.000Z",
            sources: [source("alpha", "alpha")],
            pending: {
                id: "pending-1",
                createdAt: "2026-07-21T00:01:00.000Z",
                updatedAt: "2026-07-21T00:02:00.000Z",
                changes: [updateChange("alpha", "alpha")]
            },
            lastApply: {
                operationId: "operation-1",
                completedAt: "2026-07-21T00:03:00.000Z",
                sourceIds: ["alpha"]
            }
        };

        await writeManagerStateAtomic(path, initial);
        assert.deepEqual(await readManagerState(path), initial);
    });
});

test("pending adoption round-trips without requiring an installed digest", async () => {
    await withTempDirectory(async directory => {
        const path = join(directory, "state.json");
        const adoptedSource = source("adopted", "legacy", "legacy-digest");
        const initial: ManagerStateV1 = {
            ...createEmptyManagerState(),
            pending: {
                id: "pending-adopt",
                createdAt: "2026-07-21T00:01:00.000Z",
                updatedAt: "2026-07-21T00:02:00.000Z",
                changes: [{
                    kind: "adopt",
                    sourceId: adoptedSource.id,
                    source: adoptedSource,
                    inspectionId: "adopt-inspection",
                    inspectedRevision: adoptedSource.resolvedRevision,
                    inspectedDigest: adoptedSource.contentDigest,
                    entries: adoptedSource.entries
                }]
            }
        };

        await writeManagerStateAtomic(path, initial);
        assert.deepEqual(await readManagerState(path), initial);
    });
});

test("pending inspected changes require a persisted source shape", async () => {
    await withTempDirectory(async directory => {
        const path = join(directory, "state.json");
        await writeFile(path, JSON.stringify({
            ...createEmptyManagerState(),
            pending: {
                id: "pending-1",
                createdAt: "2026-07-21T00:01:00.000Z",
                updatedAt: "2026-07-21T00:02:00.000Z",
                changes: [{
                    kind: "update",
                    sourceId: "alpha",
                    inspectionId: "alpha-inspection",
                    stagedPath: "/tmp/alpha-staged",
                    inspectedRevision: "alpha-revision",
                    inspectedDigest: "alpha-digest",
                    entries: [{ sourcePath: ".", destination: "alpha", contentDigest: "alpha-digest" }],
                    expectedInstalledDigest: "alpha-digest"
                }]
            }
        }));

        await assert.rejects(readManagerState(path), (error: unknown) => {
            return error instanceof UserPluginManagerError && error.code === "INVALID_STATE";
        });
    });
});

test("future schema versions are rejected without modifying the file", async () => {
    await withTempDirectory(async directory => {
        const path = join(directory, "state.json");
        const original = "{\"schemaVersion\":2,\"sources\":[]}\n";
        await writeFile(path, original);

        await assert.rejects(readManagerState(path), (error: unknown) => {
            return error instanceof UserPluginManagerError && error.code === "UNSUPPORTED_SCHEMA_VERSION";
        });
        assert.equal(await readFile(path, "utf8"), original);
    });
});

test("duplicate ownership and contradictory pending operations are rejected", () => {
    const conflicts = findDestinationConflicts([
        source("alpha", "shared"),
        source("beta", "shared")
    ]);
    assert.deepEqual(conflicts, [{ destination: "shared", sourceIds: ["alpha", "beta"] }]);

    const install: PendingChangeV1 = {
        kind: "install",
        source: source("alpha", "shared"),
        inspectionId: "install-alpha",
        stagedPath: "/tmp/install-alpha-staged",
        shape: "plugin-root",
        inspectedRevision: "alpha-revision",
        inspectedDigest: "alpha-digest",
        entries: [{ sourcePath: ".", destination: "shared", contentDigest: "alpha-digest" }]
    };
    const remove: PendingChangeV1 = {
        kind: "remove",
        sourceId: "beta",
        destinations: ["shared"],
        expectedInstalledDigest: "beta-digest"
    };

    assert.throws(() => coalescePendingChange([install], remove), (error: unknown) => {
        return error instanceof UserPluginManagerError && error.code === "PENDING_CHANGE_CONFLICT";
    });
});

test("a newer compatible source draft deterministically replaces the older draft", () => {
    const first = updateChange("alpha", "alpha");
    const second: PendingChangeV1 = {
        ...updateChange("alpha", "alpha"),
        inspectionId: "alpha-inspection-new",
        inspectedRevision: "alpha-revision-3",
        inspectedDigest: "alpha-digest-3"
    };

    assert.deepEqual(coalescePendingChange([first], second), [second]);
});

test("manager infrastructure cannot be staged for removal", () => {
    assert.throws(() => coalescePendingChange([], {
        kind: "remove",
        sourceId: USER_PLUGIN_MANAGER_INFRASTRUCTURE_ID,
        destinations: ["UserPluginManager"],
        expectedInstalledDigest: "irrelevant"
    }), (error: unknown) => {
        return error instanceof UserPluginManagerError && error.code === "PROTECTED_INFRASTRUCTURE";
    });
});

test("failed atomic replacement preserves the previous valid state", async () => {
    await withTempDirectory(async directory => {
        const path = join(directory, "state.json");
        const original = createEmptyManagerState();
        await writeManagerStateAtomic(path, original);
        const before = await readFile(path, "utf8");

        await assert.rejects(writeManagerStateAtomic(path, {
            ...original,
            riskAcknowledgedAt: "2026-07-21T00:00:00.000Z"
        }, {
            rename: async () => {
                throw new Error("simulated rename failure");
            }
        }));

        assert.equal(await readFile(path, "utf8"), before);
    });
});
