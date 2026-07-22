/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import type {
    StageAdoptInput,
    StageInstallInput,
    StageUpdateInput,
    UpdatePolicy,
    UserPluginManagerInspection,
    UserPluginManagerInspectionInput,
    UserPluginManagerSnapshot
} from "@shared/userPluginManager";

/**
 * Renderer-facing surface of the User Plugin Manager IPC bridge.
 *
 * These signatures intentionally mirror `VencordNative.userPluginManager`,
 * whose methods already unwrap the main-process `UserPluginManagerIpcResult`
 * envelope and reject with an `Error` (carrying the original `code`) on
 * failure. Keeping the shapes aligned lets the renderer hand
 * `VencordNative.userPluginManager` straight to the controller with no adapter.
 */
export interface UserPluginManagerRendererApi {
    getSnapshot(): Promise<UserPluginManagerSnapshot>;
    acknowledgeRisk(): Promise<UserPluginManagerSnapshot>;
    deactivate(): Promise<UserPluginManagerSnapshot>;
    inspectSource(input: UserPluginManagerInspectionInput): Promise<UserPluginManagerInspection>;
    checkSource(sourceId: string): Promise<UserPluginManagerInspection>;
    stageInstall(input: StageInstallInput): Promise<UserPluginManagerSnapshot>;
    stageUpdate(input: StageUpdateInput): Promise<UserPluginManagerSnapshot>;
    stageAdopt(input: StageAdoptInput): Promise<UserPluginManagerSnapshot>;
    stageRemove(sourceId: string): Promise<UserPluginManagerSnapshot>;
    discardPending(): Promise<UserPluginManagerSnapshot>;
    applyPending(): Promise<UserPluginManagerSnapshot>;
    recover(): Promise<UserPluginManagerSnapshot>;
}

type SnapshotListener = (snapshot: UserPluginManagerSnapshot) => void;

export interface UserPluginManagerViewState {
    pendingCount: number;
    hasConflicts: boolean;
    canAdd: boolean;
    canApply: boolean;
    canDeactivate: boolean;
    canRecover: boolean;
}

export class UserPluginManagerController {
    private snapshot: UserPluginManagerSnapshot | null = null;
    private readonly listeners = new Set<SnapshotListener>();

    constructor(private readonly api: UserPluginManagerRendererApi) { }

    static deriveViewState(snapshot: UserPluginManagerSnapshot, busy: boolean): UserPluginManagerViewState {
        const pendingCount = snapshot.state.pending?.changes.length ?? 0;
        const hasConflicts = snapshot.conflicts.length > 0;
        const recoveryRequired = snapshot.recovery.action !== "none";
        const canMutate = snapshot.active && !snapshot.locked && !busy && !hasConflicts;

        return {
            pendingCount,
            hasConflicts,
            canAdd: canMutate,
            canApply: canMutate && pendingCount > 0,
            canDeactivate: snapshot.active && !snapshot.locked && !busy,
            canRecover: snapshot.active && recoveryRequired && !busy
        };
    }

    get current(): UserPluginManagerSnapshot | null {
        return this.snapshot;
    }

    subscribe(listener: SnapshotListener): () => void {
        this.listeners.add(listener);
        if (this.snapshot) listener(this.snapshot);
        return () => this.listeners.delete(listener);
    }

    async load(): Promise<UserPluginManagerSnapshot> {
        return this.publish(await this.api.getSnapshot());
    }

    async activate(accepted: boolean): Promise<UserPluginManagerSnapshot | undefined> {
        if (!accepted) return;
        return this.publish(await this.api.acknowledgeRisk());
    }

    async deactivate(): Promise<UserPluginManagerSnapshot> {
        if (this.snapshot?.state.pending?.changes.length) {
            throw new Error("Discard pending changes first");
        }
        return this.publish(await this.api.deactivate());
    }

    /**
     * Acquire and inspect a candidate source without touching the pending plan,
     * so the resolved revision and entries can be reviewed before queueing.
     */
    async inspect(input: UserPluginManagerInspectionInput): Promise<UserPluginManagerInspection> {
        return this.api.inspectSource(input);
    }

    /** Queue an install for a source the user already reviewed via {@link inspect}. */
    async queueInstall(
        inspectionId: string,
        displayName: string,
        updatePolicy?: UpdatePolicy
    ): Promise<UserPluginManagerSnapshot> {
        return this.publish(await this.api.stageInstall({ inspectionId, displayName, updatePolicy }));
    }

    async inspectAndQueueInstall(
        input: UserPluginManagerInspectionInput,
        displayName: string
    ): Promise<UserPluginManagerSnapshot> {
        const inspection = await this.inspect(input);
        return this.queueInstall(inspection.inspectionId, displayName);
    }

    /** Re-inspect a managed source to review whether a newer revision is available. */
    async checkUpdate(sourceId: string): Promise<UserPluginManagerInspection> {
        return this.api.checkSource(sourceId);
    }

    /** Queue an update for a managed source from a reviewed {@link checkUpdate} inspection. */
    async queueUpdate(
        sourceId: string,
        inspectionId: string,
        kind: "update" | "resync" = "update"
    ): Promise<UserPluginManagerSnapshot> {
        return this.publish(await this.api.stageUpdate({ inspectionId, sourceId, kind }));
    }

    async queueRemove(sourceId: string): Promise<UserPluginManagerSnapshot> {
        return this.publish(await this.api.stageRemove(sourceId));
    }

    async queueAdopt(input: StageAdoptInput): Promise<UserPluginManagerSnapshot> {
        return this.publish(await this.api.stageAdopt(input));
    }

    async reviewPending(): Promise<UserPluginManagerSnapshot> {
        return this.publish(await this.api.getSnapshot());
    }

    async discardPending(): Promise<UserPluginManagerSnapshot> {
        return this.publish(await this.api.discardPending());
    }

    /** Commit the reviewed pending plan in a single transactional apply + rebuild. */
    async applyPending(): Promise<UserPluginManagerSnapshot> {
        return this.publish(await this.api.applyPending());
    }

    /** Reconcile a journal left behind by an interrupted apply. */
    async recover(): Promise<UserPluginManagerSnapshot> {
        return this.publish(await this.api.recover());
    }

    private publish(snapshot: UserPluginManagerSnapshot): UserPluginManagerSnapshot {
        this.snapshot = snapshot;
        for (const listener of this.listeners) listener(snapshot);
        return snapshot;
    }
}
