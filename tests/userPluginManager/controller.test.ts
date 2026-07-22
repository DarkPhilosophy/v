/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
    UserPluginManagerController,
    type UserPluginManagerRendererApi
} from "../../core/src/components/settings/tabs/plugins/UserPluginManager/controller.ts";
import type {
    StageInstallInput,
    UserPluginManagerInspection,
    UserPluginManagerInspectionInput,
    UserPluginManagerSnapshot
} from "../../core/src/shared/userPluginManager.ts";

function snapshot(overrides: Partial<UserPluginManagerSnapshot> = {}): UserPluginManagerSnapshot {
    return {
        active: false,
        state: { schemaVersion: 1, sources: [] },
        inventory: [],
        conflicts: [],
        recovery: { action: "none" },
        locked: false,
        ...overrides
    };
}

function fail(code: string, message: string): never {
    throw Object.assign(new Error(message), { code });
}

function fixture() {
    let current = snapshot();
    const calls: string[] = [];
    const inspection: UserPluginManagerInspection = {
        inspectionId: "inspection-1",
        expiresAt: "2026-07-21T01:00:00.000Z",
        kind: "local-directory",
        locator: "/safe/plugin",
        resolvedRevision: "digest-1",
        shape: "plugin-root",
        entries: [{ kind: "plugin", sourcePath: ".", destination: "fixture", contentDigest: "digest-1" }],
        contentDigest: "digest-1"
    };
    const api: UserPluginManagerRendererApi = {
        async getSnapshot() {
            calls.push("snapshot");
            return structuredClone(current);
        },
        async acknowledgeRisk() {
            calls.push("acknowledge");
            current = snapshot({ active: true, state: { schemaVersion: 1, riskAcknowledgedAt: "2026-07-21T00:00:00.000Z", sources: [] } });
            return structuredClone(current);
        },
        async deactivate() {
            calls.push("deactivate");
            if (current.state.pending?.changes.length) {
                fail("PENDING_CHANGES", "Discard pending changes first");
            }
            current = snapshot();
            return structuredClone(current);
        },
        async inspectSource(input: UserPluginManagerInspectionInput) {
            calls.push(`inspect:${input.kind}`);
            return inspection;
        },
        async checkSource() {
            fail("INVALID_STATE", "unused");
        },
        async stageInstall(input: StageInstallInput) {
            calls.push(`stage:${input.inspectionId}`);
            current = snapshot({
                active: true,
                state: {
                    schemaVersion: 1,
                    riskAcknowledgedAt: "2026-07-21T00:00:00.000Z",
                    sources: [],
                    pending: {
                        id: "pending-1",
                        createdAt: "2026-07-21T00:00:00.000Z",
                        updatedAt: "2026-07-21T00:00:00.000Z",
                        changes: [{
                            kind: "install",
                            source: {
                                id: "source-1",
                                displayName: input.displayName,
                                kind: inspection.kind,
                                locator: inspection.locator,
                                resolvedRevision: inspection.resolvedRevision,
                                contentDigest: inspection.contentDigest,
                                entries: inspection.entries.map(entry => ({
                                    sourcePath: entry.sourcePath,
                                    destination: entry.destination,
                                    contentDigest: entry.contentDigest
                                })),
                                updatePolicy: "manual",
                                installedAt: "2026-07-21T00:00:00.000Z",
                                updatedAt: "2026-07-21T00:00:00.000Z"
                            },
                            inspectionId: inspection.inspectionId,
                            stagedPath: "/tmp/inspection-1-staged",
                            inspectedRevision: inspection.resolvedRevision,
                            inspectedDigest: inspection.contentDigest,
                            shape: inspection.shape,
                            entries: inspection.entries.map(entry => ({
                                sourcePath: entry.sourcePath,
                                destination: entry.destination,
                                contentDigest: entry.contentDigest
                            }))
                        }]
                    }
                }
            });
            return structuredClone(current);
        },
        async stageUpdate() {
            fail("INVALID_STATE", "unused");
        },
        async stageAdopt() {
            fail("INVALID_STATE", "unused");
        },
        async stageRemove() {
            fail("INVALID_STATE", "unused");
        },
        async discardPending() {
            calls.push("discard");
            current = snapshot({ active: true, state: { schemaVersion: 1, riskAcknowledgedAt: "2026-07-21T00:00:00.000Z", sources: [] } });
            return structuredClone(current);
        },
        async applyPending() {
            calls.push("apply");
            if (!current.state.pending?.changes.length) {
                fail("INVALID_OPERATION", "There are no pending changes to apply");
            }
            current = snapshot({
                active: true,
                state: {
                    schemaVersion: 1,
                    riskAcknowledgedAt: "2026-07-21T00:00:00.000Z",
                    sources: [],
                    lastApply: { operationId: "operation-1", completedAt: "2026-07-21T00:00:00.000Z", sourceIds: ["source-1"] }
                }
            });
            return structuredClone(current);
        },
        async restart() {
            calls.push("restart");
        },
        async recover() {
            calls.push("recover");
            current = snapshot({ active: true, state: { schemaVersion: 1, riskAcknowledgedAt: "2026-07-21T00:00:00.000Z", sources: [] } });
            return structuredClone(current);
        }
    };
    return { api, calls, getCurrent: () => structuredClone(current) };
}

test("activation cancel is inert while accept acknowledges exactly once", async () => {
    const { api, calls } = fixture();
    const controller = new UserPluginManagerController(api);
    assert.equal(await controller.activate(false), undefined);
    assert.deepEqual(calls, []);
    assert.equal((await controller.activate(true))?.active, true);
    assert.deepEqual(calls, ["acknowledge"]);
});

test("inspect and queue stages a persistent plan without applying installed files", async () => {
    const { api, calls } = fixture();
    const controller = new UserPluginManagerController(api);
    await controller.activate(true);
    const result = await controller.inspectAndQueueInstall({ kind: "local-directory", locator: "/safe/plugin" }, "Fixture");
    assert.equal(result.state.pending?.changes.length, 1);
    assert.deepEqual(calls, ["acknowledge", "inspect:local-directory", "stage:inspection-1"]);
});

test("review refreshes the complete plan and discard clears it", async () => {
    const { api, calls } = fixture();
    const controller = new UserPluginManagerController(api);
    await controller.activate(true);
    await controller.inspectAndQueueInstall({ kind: "local-directory", locator: "/safe/plugin" }, "Fixture");
    assert.equal((await controller.reviewPending()).state.pending?.id, "pending-1");
    assert.equal((await controller.discardPending()).state.pending, undefined);
    assert.deepEqual(calls.slice(-2), ["snapshot", "discard"]);
});

test("apply commits the reviewed plan and clears pending", async () => {
    const { api, calls } = fixture();
    const controller = new UserPluginManagerController(api);
    await controller.activate(true);
    await controller.inspectAndQueueInstall({ kind: "local-directory", locator: "/safe/plugin" }, "Fixture");
    const applied = await controller.applyPending();
    assert.equal(applied.state.pending, undefined);
    assert.deepEqual(applied.state.lastApply?.sourceIds, ["source-1"]);
    assert.deepEqual(calls.slice(-1), ["apply"]);
});

test("restart delegates to the native bridge", async () => {
    const { api, calls } = fixture();
    const controller = new UserPluginManagerController(api);

    await controller.restart();

    assert.deepEqual(calls, ["restart"]);
});

test("aggregate conflicts disable mutation actions in the view state", () => {
    const conflict = snapshot({
        active: true,
        conflicts: [{ destination: "shared", sourceIds: ["alpha", "beta"] }]
    });
    assert.deepEqual(UserPluginManagerController.deriveViewState(conflict, false), {
        pendingCount: 0,
        hasConflicts: true,
        canAdd: false,
        canApply: false,
        canDeactivate: true,
        canRecover: false
    });
});

test("a locked journal offers recovery and blocks every mutation", async () => {
    const locked = snapshot({
        active: true,
        recovery: { action: "recovery-build", operationId: "operation-1" },
        locked: true
    });
    assert.deepEqual(UserPluginManagerController.deriveViewState(locked, false), {
        pendingCount: 0,
        hasConflicts: false,
        canAdd: false,
        canApply: false,
        canDeactivate: false,
        canRecover: true
    });

    const { api, calls } = fixture();
    const controller = new UserPluginManagerController(api);
    const recovered = await controller.recover();
    assert.equal(recovered.recovery.action, "none");
    assert.deepEqual(calls, ["recover"]);
});

test("a busy renderer suspends recovery and deactivation affordances", () => {
    const locked = snapshot({
        active: true,
        recovery: { action: "rollback", operationId: "operation-1" },
        locked: true
    });
    assert.equal(UserPluginManagerController.deriveViewState(locked, true).canRecover, false);
    assert.equal(UserPluginManagerController.deriveViewState(snapshot({ active: true }), true).canDeactivate, false);
});

test("deactivation surfaces pending work and preserves the plan", async () => {
    const { api, getCurrent } = fixture();
    const controller = new UserPluginManagerController(api);
    await controller.activate(true);
    await controller.inspectAndQueueInstall({ kind: "local-directory", locator: "/safe/plugin" }, "Fixture");
    await assert.rejects(controller.deactivate(), /Discard pending changes first/);
    assert.equal(getCurrent().state.pending?.changes.length, 1);
});
