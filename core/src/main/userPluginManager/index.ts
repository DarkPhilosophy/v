/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { randomUUID } from "node:crypto";
import { cp, mkdir, rm } from "node:fs/promises";
import { basename, join } from "node:path";

import {
    coalescePendingChange,
    findDestinationConflicts,
    type ManagedEntryV1,
    type ManagedSourceV1,
    type ManagerStateV1,
    type PendingChangeV1,
    readManagerState,
    type StageAdoptInput,
    type StageInstallInput,
    type StageUpdateInput,
    type UserPluginInventoryEntry,
    type UserPluginManagerBuildStage,
    type UserPluginManagerInspection,
    type UserPluginManagerInspectionInput,
    type UserPluginManagerSnapshot,
    writeManagerStateAtomic
} from "@shared/userPluginManager";
import { redactSourceLocator, resolveContainedExistingPath } from "@shared/userPluginManagerSafety";

import {
    embeddedUserPluginFiles,
    embeddedUserPluginInventory,
    materializeEmbeddedUserPluginsTree
} from "./buildSources";
import {
    createLocalUserPluginManagerHost,
    type HostInventoryEntry,
    type UserPluginManagerHost
} from "./host";
import {
    acquireAndInspectSource,
    type SourceInspection
} from "./sources";
import {
    type TransactionAdoption,
    type TransactionExpectedDestination,
    type TransactionMutation,
    type TransactionOwnership,
    type TransactionPlan,
    type TransactionSourceCheck
} from "./transaction";

const DEFAULT_INSPECTION_TTL_MS = 15 * 60 * 1000;

export type UserPluginManagerServiceErrorCode =
    | "INACTIVE"
    | "PENDING_CHANGES"
    | "UNKNOWN_INSPECTION"
    | "EXPIRED_INSPECTION"
    | "UNKNOWN_SOURCE"
    | "INVALID_OPERATION"
    | "BUILD_FAILED"
    | "RECOVERY_BUILD_FAILED"
    | "RECOVERY_REQUIRED";

export interface UserPluginManagerPaths {
    dataRoot: string;
    host?: UserPluginManagerHost;
    inspectionTtlMs?: number;
    now?: () => number;
    build?: (userpluginsRoot: string, report?: (stage: UserPluginManagerBuildStage) => void) => Promise<boolean>;
    embeddedUserPlugins?: {
        files: Readonly<Record<string, string>>;
        inventory: readonly HostInventoryEntry[];
    };
}

interface InspectionRecord {
    input: UserPluginManagerInspectionInput;
    result: UserPluginManagerInspection;
    stagedRoot: string;
    expiresAt: number;
}

interface PreparedTransaction {
    plan: TransactionPlan;
    nextState: ManagerStateV1;
    sourceIds: string[];
}

export interface UserPluginManagerService {
    getSnapshot(): Promise<UserPluginManagerSnapshot>;
    acknowledgeRisk(): Promise<UserPluginManagerSnapshot>;
    deactivate(): Promise<UserPluginManagerSnapshot>;
    inspectSource(input: UserPluginManagerInspectionInput): Promise<UserPluginManagerInspection>;
    checkSource(sourceId: string): Promise<UserPluginManagerInspection>;
    stageInstall(input: StageInstallInput): Promise<UserPluginManagerSnapshot>;
    stageUpdate(input: StageUpdateInput): Promise<UserPluginManagerSnapshot>;
    stageRemove(sourceId: string): Promise<UserPluginManagerSnapshot>;
    stageAdopt(input: StageAdoptInput): Promise<UserPluginManagerSnapshot>;
    applyPending(): Promise<UserPluginManagerSnapshot>;
    recover(): Promise<UserPluginManagerSnapshot>;
    discardPending(): Promise<UserPluginManagerSnapshot>;
}

export class UserPluginManagerServiceError extends Error {
    constructor(public readonly code: UserPluginManagerServiceErrorCode, message: string, options?: ErrorOptions) {
        super(message, options);
        this.name = "UserPluginManagerServiceError";
    }
}


export async function createUserPluginManagerService(
    paths: UserPluginManagerPaths
): Promise<UserPluginManagerService> {
    const { dataRoot } = paths;
    const host = paths.host ?? createLocalUserPluginManagerHost();
    const statePath = join(dataRoot, "state.json");
    const journalPath = join(dataRoot, "journal.json");
    const inspectionsRoot = join(dataRoot, "inspections");
    const now = paths.now ?? Date.now;
    const inspectionTtlMs = paths.inspectionTtlMs ?? DEFAULT_INSPECTION_TTL_MS;
    const embeddedUserPlugins = paths.embeddedUserPlugins ?? {
        files: embeddedUserPluginFiles,
        inventory: embeddedUserPluginInventory
    };
    const inspections = new Map<string, InspectionRecord>();

    await mkdir(dataRoot, { recursive: true, mode: 0o700 });
    let state = await readManagerState(statePath);

    async function persist(nextState: ManagerStateV1): Promise<void> {
        await writeManagerStateAtomic(statePath, nextState);
        state = nextState;
    }

    async function ensureMutable(): Promise<void> {
        if (!state.riskAcknowledgedAt) {
            throw new UserPluginManagerServiceError("INACTIVE", "User Plugin Manager is not active");
        }
        const recovery = await host.execute({ action: "inspect-recovery", journalPath });
        if (recovery.action !== "none") {
            throw new UserPluginManagerServiceError(
                "RECOVERY_REQUIRED",
                "A previous User Plugin Manager operation requires recovery"
            );
        }
    }

    function consumeInspection(inspectionId: string): InspectionRecord {
        const inspection = inspections.get(inspectionId);
        if (!inspection) {
            throw new UserPluginManagerServiceError("UNKNOWN_INSPECTION", "Inspection token is unknown to this process");
        }
        inspections.delete(inspectionId);
        if (inspection.expiresAt <= now()) {
            throw new UserPluginManagerServiceError("EXPIRED_INSPECTION", "Inspection token has expired");
        }
        return inspection;
    }

    async function stage(change: PendingChangeV1): Promise<UserPluginManagerSnapshot> {
        await ensureMutable();
        const timestamp = new Date(now()).toISOString();
        const pending = state.pending ?? {
            id: randomUUID(),
            createdAt: timestamp,
            updatedAt: timestamp,
            changes: []
        };
        const nextState: ManagerStateV1 = {
            ...state,
            pending: {
                ...pending,
                updatedAt: timestamp,
                changes: coalescePendingChange(pending.changes, change)
            }
        };
        await persist(nextState);
        return snapshot();
    }

    async function inspectSource(input: UserPluginManagerInspectionInput): Promise<UserPluginManagerInspection> {
        await ensureMutable();
        const inspectionId = randomUUID();
        const operationRoot = join(inspectionsRoot, inspectionId);
        await mkdir(operationRoot, { recursive: true, mode: 0o700 });
        let acquired: SourceInspection;
        try {
            acquired = await acquireAndInspectSource(input, { operationRoot });
        } catch (error) {
            await rm(operationRoot, { recursive: true, force: true }).catch(() => undefined);
            throw error;
        }
        const expiresAt = now() + inspectionTtlMs;
        const result: UserPluginManagerInspection = {
            inspectionId,
            expiresAt: new Date(expiresAt).toISOString(),
            kind: acquired.kind,
            locator: acquired.locator,
            requestedRef: acquired.requestedRef,
            resolvedRevision: acquired.resolvedRevision,
            shape: acquired.shape,
            entries: acquired.entries,
            contentDigest: acquired.contentDigest
        };
        inspections.set(inspectionId, { input: { ...input }, result, stagedRoot: acquired.stagedRoot, expiresAt });
        return result;
    }

    async function checkSource(sourceId: string): Promise<UserPluginManagerInspection> {
        const source = state.sources.find(candidate => candidate.id === sourceId);
        if (!source) throw new UserPluginManagerServiceError("UNKNOWN_SOURCE", `Managed source ${sourceId} does not exist`);
        return inspectSource({
            kind: source.kind,
            locator: source.locator,
            requestedRef: source.requestedRef,
            selectedSharedEntries: source.entries
                .filter(entry => entry.destination === "_shared")
                .map(entry => entry.sourcePath)
        });
    }

    async function stageInstall(input: StageInstallInput): Promise<UserPluginManagerSnapshot> {
        await ensureMutable();
        const inspection = consumeInspection(input.inspectionId);
        const timestamp = new Date(now()).toISOString();
        const source: ManagedSourceV1 = {
            id: randomUUID(),
            displayName: input.displayName.trim() || basename(inspection.result.locator),
            kind: inspection.result.kind,
            locator: inspection.result.locator,
            requestedRef: inspection.result.requestedRef,
            resolvedRevision: inspection.result.resolvedRevision,
            contentDigest: inspection.result.contentDigest,
            entries: inspection.result.entries,
            updatePolicy: input.updatePolicy ?? "manual",
            installedAt: timestamp,
            updatedAt: timestamp
        };
        return stage({
            kind: "install",
            source,
            inspectionId: input.inspectionId,
            stagedPath: inspection.stagedRoot,
            inspectedRevision: inspection.result.resolvedRevision,
            inspectedDigest: inspection.result.contentDigest,
            shape: inspection.result.shape,
            entries: inspection.result.entries
        });
    }

    async function stageUpdate(input: StageUpdateInput): Promise<UserPluginManagerSnapshot> {
        await ensureMutable();
        const source = state.sources.find(candidate => candidate.id === input.sourceId);
        if (!source) throw new UserPluginManagerServiceError("UNKNOWN_SOURCE", `Managed source ${input.sourceId} does not exist`);
        const inspection = consumeInspection(input.inspectionId);
        if (inspection.result.kind !== source.kind || inspection.result.locator !== source.locator) {
            throw new UserPluginManagerServiceError("INVALID_OPERATION", "Inspection does not belong to the managed source");
        }
        return stage({
            kind: input.kind ?? "update",
            sourceId: source.id,
            inspectionId: input.inspectionId,
            stagedPath: inspection.stagedRoot,
            inspectedRevision: inspection.result.resolvedRevision,
            inspectedDigest: inspection.result.contentDigest,
            shape: inspection.result.shape,
            entries: inspection.result.entries,
            expectedInstalledDigest: source.contentDigest
        });
    }

    async function stageRemove(sourceId: string): Promise<UserPluginManagerSnapshot> {
        await ensureMutable();
        const source = state.sources.find(candidate => candidate.id === sourceId);
        if (!source) throw new UserPluginManagerServiceError("UNKNOWN_SOURCE", `Managed source ${sourceId} does not exist`);
        return stage({
            kind: "remove",
            sourceId,
            destinations: source.entries.map(entry => entry.destination),
            expectedInstalledDigest: source.contentDigest
        });
    }

    async function stageAdopt(input: StageAdoptInput): Promise<UserPluginManagerSnapshot> {
        await ensureMutable();
        if (input.sourceId === "" || state.sources.some(source => source.id === input.sourceId)) {
            throw new UserPluginManagerServiceError("INVALID_OPERATION", `Managed source id ${input.sourceId} is unavailable`);
        }
        if (input.destinations.length === 0 || new Set(input.destinations).size !== input.destinations.length) {
            throw new UserPluginManagerServiceError("INVALID_OPERATION", "Adoption requires unique installed destinations");
        }
        const entries: ManagedEntryV1[] = input.destinations.map(destination => {
            const bundled = embeddedUserPlugins.inventory.find(entry => entry.destination === destination);
            if (!bundled) {
                throw new UserPluginManagerServiceError("INVALID_OPERATION", `Cannot adopt missing destination ${destination}`);
            }
            return {
                sourcePath: destination,
                destination,
                contentDigest: bundled.contentDigest
            };
        });
        const timestamp = new Date(now()).toISOString();
        const source: ManagedSourceV1 = {
            id: input.sourceId,
            displayName: input.displayName,
            kind: input.kind,
            locator: redactSourceLocator(input.locator),
            requestedRef: input.requestedRef,
            resolvedRevision: input.resolvedRevision,
            contentDigest: digestEntries(entries),
            entries,
            updatePolicy: input.updatePolicy ?? "manual",
            installedAt: timestamp,
            updatedAt: timestamp
        };
        return stage({
            kind: "adopt",
            sourceId: source.id,
            source,
            inspectionId: randomUUID(),
            inspectedRevision: source.resolvedRevision,
            inspectedDigest: source.contentDigest,
            entries
        });
    }

    function expectedDestination(
        source: ManagedSourceV1,
        destination: string,
        allowMissing = false
    ): TransactionExpectedDestination {
        const entry = source.entries.find(candidate => candidate.destination === destination);
        return entry
            ? {
                state: allowMissing ? "owned-or-absent" : "owned",
                sourceId: source.id,
                contentDigest: entry.contentDigest
            }
            : { state: "absent" };
    }

    function createCommittedState(
        pending: NonNullable<ManagerStateV1["pending"]>,
        operationId: string
    ): { nextState: ManagerStateV1; sourceIds: string[]; } {
        let nextSources = [...state.sources];
        const sourceIds: string[] = [];
        const timestamp = new Date(now()).toISOString();

        for (const change of pending.changes) {
            if (change.kind === "install" || change.kind === "adopt") {
                if (nextSources.some(source => source.id === change.source.id)) {
                    throw new UserPluginManagerServiceError(
                        "INVALID_OPERATION",
                        `Managed source ${change.source.id} already exists`
                    );
                }
                nextSources.push(change.source);
                sourceIds.push(change.source.id);
                continue;
            }

            const source = nextSources.find(candidate => candidate.id === change.sourceId);
            if (!source) {
                throw new UserPluginManagerServiceError(
                    "UNKNOWN_SOURCE",
                    `Managed source ${change.sourceId} does not exist`
                );
            }

            if (change.kind === "remove") {
                nextSources = nextSources.filter(candidate => candidate.id !== source.id);
                sourceIds.push(source.id);
                continue;
            }

            nextSources = nextSources.map(candidate => candidate.id === source.id
                ? {
                    ...candidate,
                    resolvedRevision: change.inspectedRevision,
                    contentDigest: change.inspectedDigest,
                    entries: change.entries,
                    updatedAt: timestamp
                }
                : candidate
            );
            sourceIds.push(source.id);
        }

        const nextState: ManagerStateV1 = {
            ...state,
            sources: nextSources,
            lastApply: { operationId, completedAt: timestamp, sourceIds: [...new Set(sourceIds)] }
        };
        delete nextState.pending;
        return { nextState, sourceIds };
    }

    async function prepareTransaction(
        pending: NonNullable<ManagerStateV1["pending"]>,
        operationId: string
    ): Promise<PreparedTransaction> {
        const operationRoot = join(dataRoot, "operations", operationId);
        const stagedSourcesRoot = join(operationRoot, "sources");
        const workingRoot = join(operationRoot, "userplugins");
        await materializeEmbeddedUserPluginsTree(workingRoot, embeddedUserPlugins.files);

        const ownership: TransactionOwnership[] = state.sources.flatMap(source =>
            source.entries.map(entry => ({
                destination: entry.destination,
                sourceId: source.id,
                contentDigest: entry.contentDigest
            }))
        );
        const sources: TransactionSourceCheck[] = [];
        const adoptions: TransactionAdoption[] = [];
        const mutations: TransactionMutation[] = [];
        const committed = createCommittedState(pending, operationId);

        for (const change of pending.changes) {
            if (change.kind === "install") {
                const originalStagedPath = await resolveContainedExistingPath(inspectionsRoot, change.stagedPath);
                const stagedRoot = join(stagedSourcesRoot, randomUUID());
                await cp(originalStagedPath, stagedRoot, { recursive: true, errorOnExist: true, force: false });
                sources.push({
                    sourceId: change.source.id,
                    stagedRoot,
                    inspectedRevision: change.inspectedRevision,
                    inspectedDigest: change.inspectedDigest
                });
                for (const entry of change.entries) {
                    mutations.push({
                        action: "write",
                        destination: entry.destination,
                        sourceId: change.source.id,
                        stagedPath: change.shape === "single-file" ? stagedRoot : join(stagedRoot, entry.sourcePath),
                        inspectedDigest: entry.contentDigest,
                        expected: { state: "absent" }
                    });
                }
                continue;
            }

            if (change.kind === "adopt") {
                for (const entry of change.entries) {
                    adoptions.push({
                        destination: entry.destination,
                        sourceId: change.source.id,
                        inspectedDigest: entry.contentDigest
                    });
                }
                continue;
            }

            const source = state.sources.find(candidate => candidate.id === change.sourceId);
            if (!source) {
                throw new UserPluginManagerServiceError(
                    "UNKNOWN_SOURCE",
                    `Managed source ${change.sourceId} does not exist`
                );
            }

            if (change.kind === "remove") {
                for (const destination of change.destinations) {
                    mutations.push({
                        action: "remove",
                        destination,
                        sourceId: source.id,
                        expected: expectedDestination(source, destination)
                    });
                }
                continue;
            }

            const originalStagedPath = await resolveContainedExistingPath(inspectionsRoot, change.stagedPath);
            const stagedRoot = join(stagedSourcesRoot, randomUUID());
            await cp(originalStagedPath, stagedRoot, { recursive: true, errorOnExist: true, force: false });
            sources.push({
                sourceId: source.id,
                stagedRoot,
                inspectedRevision: change.inspectedRevision,
                inspectedDigest: change.inspectedDigest
            });
            const nextDestinations = new Set(change.entries.map(entry => entry.destination));
            for (const entry of change.entries) {
                mutations.push({
                    action: "write",
                    destination: entry.destination,
                    sourceId: source.id,
                    stagedPath: change.shape === "single-file" ? stagedRoot : join(stagedRoot, entry.sourcePath),
                    inspectedDigest: entry.contentDigest,
                    expected: expectedDestination(source, entry.destination, true)
                });
            }
            for (const entry of source.entries) {
                if (!nextDestinations.has(entry.destination)) {
                    mutations.push({
                        action: "remove",
                        destination: entry.destination,
                        sourceId: source.id,
                        expected: expectedDestination(source, entry.destination)
                    });
                }
            }
        }

        return {
            plan: {
                operationId,
                pendingId: pending.id,
                installedRoot: workingRoot,
                operationRoot,
                journalPath,
                sources,
                ownership,
                adoptions,
                mutations
            },
            ...committed
        };
    }

    async function runBuild(
        userpluginsRoot: string,
        report?: (stage: UserPluginManagerBuildStage) => void
    ): Promise<boolean> {
        if (!paths.build) {
            throw new UserPluginManagerServiceError(
                "INVALID_OPERATION",
                "User Plugin Manager build integration is unavailable"
            );
        }
        try {
            return await paths.build(userpluginsRoot, report);
        } catch (error) {
            console.error("[Vencord] User Plugin Manager build failed", error);
            return false;
        }
    }

    async function runRecoveryBuild(
        userpluginsRoot: string,
        report?: (stage: UserPluginManagerBuildStage) => void
    ): Promise<void> {
        const succeeded = await runBuild(userpluginsRoot, report);
        await host.execute({ action: "complete-recovery-build", journalPath, succeeded });
    }

    async function recoverCommit(operationId: string, pendingId: string): Promise<void> {
        if (state.lastApply?.operationId !== operationId) {
            if (!state.pending || state.pending.id !== pendingId) {
                throw new UserPluginManagerServiceError(
                    "RECOVERY_REQUIRED",
                    "Transaction commit cannot be reconciled with the current pending state"
                );
            }
            const committed = createCommittedState(state.pending, operationId);
            await persist(committed.nextState);
        }
        await host.execute({ action: "complete-commit", journalPath });
    }

    async function recover(report?: (stage: UserPluginManagerBuildStage) => void): Promise<UserPluginManagerSnapshot> {
        report?.("preparing");
        const recovery = await host.execute({ action: "inspect-recovery", journalPath });
        if (recovery.action === "none") return snapshot();
        const { journal } = recovery;
        if (!journal) {
            throw new UserPluginManagerServiceError("RECOVERY_REQUIRED", "Transaction journal is unavailable");
        }
        if (recovery.action === "rollback") {
            await host.execute({ action: "rollback-for-recovery", journalPath });
            await runRecoveryBuild(journal.installedRoot, report);
        } else if (recovery.action === "recovery-build") {
            await runRecoveryBuild(journal.installedRoot, report);
        } else {
            await recoverCommit(journal.operationId, journal.pendingId);
        }
        return snapshot();
    }

    async function applyPending(report?: (stage: UserPluginManagerBuildStage) => void): Promise<UserPluginManagerSnapshot> {
        report?.("preparing");
        await ensureMutable();
        const { pending } = state;
        if (!pending || pending.changes.length === 0) {
            throw new UserPluginManagerServiceError("INVALID_OPERATION", "There are no pending changes to apply");
        }

        const operationId = randomUUID();
        let prepared: PreparedTransaction;
        try {
            prepared = await prepareTransaction(pending, operationId);
            await host.execute({ action: "apply-transaction", plan: prepared.plan });
        } catch (error) {
            const recovery = await host.execute({ action: "inspect-recovery", journalPath });
            if (recovery.action === "rollback") {
                const journal = await host.execute({ action: "rollback-for-recovery", journalPath });
                await runRecoveryBuild(journal.installedRoot, report);
            } else if (recovery.action === "recovery-build" && recovery.journal) {
                await runRecoveryBuild(recovery.journal.installedRoot, report);
            } else if (recovery.action === "none") {
                await rm(join(dataRoot, "operations", operationId), { recursive: true, force: true });
            }
            throw error;
        }

        if (!await runBuild(prepared.plan.installedRoot, report)) {
            const journal = await host.execute({ action: "acknowledge-build", journalPath, succeeded: false });
            await runRecoveryBuild(journal.installedRoot, report);
            throw new UserPluginManagerServiceError(
                "BUILD_FAILED",
                "Vencord build failed; installed files were restored and the pending plan was preserved"
            );
        }

        await host.execute({ action: "acknowledge-build", journalPath, succeeded: true });
        await persist(prepared.nextState);
        await host.execute({ action: "complete-commit", journalPath });
        return snapshot();
    }

    async function snapshot(): Promise<UserPluginManagerSnapshot> {
        const recovery = await host.execute({ action: "inspect-recovery", journalPath });
        const inventory = collectInventory(embeddedUserPlugins.inventory, state.sources);
        return {
            active: Boolean(state.riskAcknowledgedAt),
            state: structuredClone(state),
            inventory,
            conflicts: findDestinationConflicts(state.sources),
            recovery: {
                action: recovery.action,
                operationId: recovery.journal?.operationId,
                pendingId: recovery.journal?.pendingId
            },
            locked: recovery.action !== "none",
        };
    }

    return {
        getSnapshot: snapshot,
        async acknowledgeRisk() {
            if (!state.riskAcknowledgedAt) {
                await persist({ ...state, riskAcknowledgedAt: new Date(now()).toISOString() });
            }
            return snapshot();
        },
        async deactivate() {
            if (state.pending?.changes.length) {
                throw new UserPluginManagerServiceError("PENDING_CHANGES", "Discard pending changes before deactivating");
            }
            if (state.riskAcknowledgedAt) {
                const nextState = { ...state };
                delete nextState.riskAcknowledgedAt;
                await persist(nextState);
            }
            return snapshot();
        },
        inspectSource,
        checkSource,
        stageInstall,
        stageUpdate,
        stageRemove,
        stageAdopt,
        applyPending,
        recover,
        async discardPending() {
            await ensureMutable();
            if (state.pending) {
                const nextState = { ...state };
                delete nextState.pending;
                await persist(nextState);
            }
            return snapshot();
        }
    };
}

function collectInventory(
    entries: readonly HostInventoryEntry[],
    sources: readonly ManagedSourceV1[]
): UserPluginInventoryEntry[] {
    const ownership = new Map<string, string[]>();
    for (const source of sources) {
        for (const entry of source.entries) {
            const owners = ownership.get(entry.destination) ?? [];
            owners.push(source.id);
            ownership.set(entry.destination, owners);
        }
    }

    const installed = new Map(entries.map(entry => [entry.destination, entry]));
    const destinations = new Set([...installed.keys(), ...ownership.keys()]);
    return Array.from(destinations)
        .sort((left, right) => left.localeCompare(right))
        .map(destination => {
            const entry = installed.get(destination);
            const owners = ownership.get(destination) ?? [];
            return {
                destination,
                state: entry === undefined
                    ? "missing"
                    : owners.length === 0
                        ? "unmanaged"
                        : owners.length === 1
                            ? "managed"
                            : "conflict",
                sourceIds: owners,
                ...(entry ? { contentDigest: entry.contentDigest } : {})
            };
        });
}

function digestEntries(entries: readonly ManagedEntryV1[]): string {
    return entries
        .map(entry => `${entry.destination}:${entry.contentDigest}`)
        .sort()
        .join("|");
}
