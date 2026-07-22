/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";

export const USER_PLUGIN_MANAGER_SCHEMA_VERSION = 1 as const;
export const USER_PLUGIN_MANAGER_INFRASTRUCTURE_ID = "@vencord/user-plugin-manager";

export type SourceKind = "git" | "http-archive" | "http-file" | "local-file" | "local-directory";
export type UpdatePolicy = "manual" | "check-on-open";
export type SourceShape = "plugin-root" | "collection" | "single-file";
export type PendingChangeKind = "install" | "update" | "resync" | "remove" | "adopt";
export type UserPluginManagerErrorCode =
    | "INVALID_STATE"
    | "UNSUPPORTED_SCHEMA_VERSION"
    | "PENDING_CHANGE_CONFLICT"
    | "PROTECTED_INFRASTRUCTURE";

export interface ManagedEntryV1 {
    sourcePath: string;
    destination: string;
    contentDigest: string;
}

export interface ManagedSourceV1 {
    id: string;
    displayName: string;
    kind: SourceKind;
    locator: string;
    requestedRef?: string;
    resolvedRevision: string;
    contentDigest: string;
    entries: ManagedEntryV1[];
    updatePolicy: UpdatePolicy;
    installedAt: string;
    updatedAt: string;
}

interface InspectedPendingChangeV1 {
    inspectionId: string;
    stagedPath: string;
    shape: SourceShape;
    inspectedRevision: string;
    inspectedDigest: string;
    entries: ManagedEntryV1[];
}

export interface PendingInstallV1 extends InspectedPendingChangeV1 {
    kind: "install";
    source: ManagedSourceV1;
}

export interface PendingUpdateV1 extends InspectedPendingChangeV1 {
    kind: "update" | "resync";
    sourceId: string;
    expectedInstalledDigest: string;
}

export interface PendingRemoveV1 {
    kind: "remove";
    sourceId: string;
    destinations: string[];
    expectedInstalledDigest: string;
}

export interface PendingAdoptV1 {
    kind: "adopt";
    sourceId: string;
    source: ManagedSourceV1;
    inspectionId: string;
    inspectedRevision: string;
    inspectedDigest: string;
    entries: ManagedEntryV1[];
}

export type PendingChangeV1 = PendingInstallV1 | PendingUpdateV1 | PendingRemoveV1 | PendingAdoptV1;

export interface PendingChangeSetV1 {
    id: string;
    createdAt: string;
    updatedAt: string;
    changes: PendingChangeV1[];
}

export interface ApplyResultV1 {
    operationId: string;
    completedAt: string;
    sourceIds: string[];
}

export interface ManagerStateV1 {
    schemaVersion: typeof USER_PLUGIN_MANAGER_SCHEMA_VERSION;
    riskAcknowledgedAt?: string;
    sources: ManagedSourceV1[];
    pending?: PendingChangeSetV1;
    lastApply?: ApplyResultV1;
}

export interface DestinationConflict {
    destination: string;
    sourceIds: string[];
}
export interface UserPluginManagerInspectionInput {
    kind: SourceKind;
    locator: string;
    requestedRef?: string;
    subpath?: string;
    selectedSharedEntries?: string[];
}

export interface UserPluginManagerInspectionEntry {
    kind: "plugin" | "shared";
    sourcePath: string;
    destination: string;
    contentDigest: string;
}

export interface UserPluginManagerInspection {
    inspectionId: string;
    expiresAt: string;
    kind: SourceKind;
    locator: string;
    requestedRef?: string;
    resolvedRevision: string;
    shape: SourceShape;
    entries: UserPluginManagerInspectionEntry[];
    contentDigest: string;
}

export interface StageInstallInput {
    inspectionId: string;
    displayName: string;
    updatePolicy?: UpdatePolicy;
}

export interface StageUpdateInput {
    inspectionId: string;
    sourceId: string;
    kind?: "update" | "resync";
}

export interface StageAdoptInput {
    sourceId: string;
    displayName: string;
    kind: SourceKind;
    locator: string;
    requestedRef?: string;
    resolvedRevision: string;
    destinations: string[];
    updatePolicy?: UpdatePolicy;
}

export interface StageReconfigureInput {
    sourceId: string;
    updatePolicy: UpdatePolicy;
}

export interface UserPluginInventoryEntry {
    destination: string;
    state: "managed" | "unmanaged" | "conflict" | "missing";
    sourceIds: string[];
    contentDigest?: string;
}

export interface UserPluginManagerSnapshot {
    active: boolean;
    state: ManagerStateV1;
    inventory: UserPluginInventoryEntry[];
    conflicts: DestinationConflict[];
    recovery: {
        action: "none" | "rollback" | "recovery-build" | "commit";
        operationId?: string;
        pendingId?: string;
    };
    locked: boolean;
}

export type UserPluginManagerBuildStage = "preparing" | "building" | "installing";

export interface UserPluginManagerIpcError {
    code: string;
    message: string;
}

export type UserPluginManagerIpcResult<T> =
    | { ok: true; value: T; }
    | { ok: false; error: UserPluginManagerIpcError; };

interface AtomicWriteOperations {
    rename?: typeof rename;
}

let atomicWriteSequence = 0;

export class UserPluginManagerError extends Error {
    constructor(public readonly code: UserPluginManagerErrorCode, message: string) {
        super(message);
        this.name = "UserPluginManagerError";
    }
}

export function createEmptyManagerState(): ManagerStateV1 {
    return {
        schemaVersion: USER_PLUGIN_MANAGER_SCHEMA_VERSION,
        sources: []
    };
}

export function findDestinationConflicts(sources: readonly ManagedSourceV1[]): DestinationConflict[] {
    const owners = new Map<string, Set<string>>();
    for (const source of sources) {
        for (const entry of source.entries) {
            const destinationOwners = owners.get(entry.destination) ?? new Set<string>();
            destinationOwners.add(source.id);
            owners.set(entry.destination, destinationOwners);
        }
    }

    return Array.from(owners.entries())
        .filter(([, sourceIds]) => sourceIds.size > 1)
        .map(([destination, sourceIds]) => ({
            destination,
            sourceIds: Array.from(sourceIds).sort()
        }))
        .sort((left, right) => left.destination.localeCompare(right.destination));
}

export function coalescePendingChange(
    existingChanges: readonly PendingChangeV1[],
    nextChange: PendingChangeV1
): PendingChangeV1[] {
    const nextSourceId = nextChange.kind === "install" ? nextChange.source.id : nextChange.sourceId;
    if (nextChange.kind === "remove" && nextSourceId === USER_PLUGIN_MANAGER_INFRASTRUCTURE_ID) {
        throw new UserPluginManagerError(
            "PROTECTED_INFRASTRUCTURE",
            "User Plugin Manager infrastructure cannot be removed"
        );
    }

    const nextDestinations = new Set(
        nextChange.kind === "remove"
            ? nextChange.destinations
            : nextChange.kind === "install"
                ? nextChange.source.entries.map(entry => entry.destination)
                : nextChange.entries.map(entry => entry.destination)
    );
    let replacementIndex = -1;

    for (let index = 0; index < existingChanges.length; index++) {
        const current = existingChanges[index];
        const currentSourceId = current.kind === "install" ? current.source.id : current.sourceId;
        const currentDestinations = current.kind === "remove"
            ? current.destinations
            : current.kind === "install"
                ? current.source.entries.map(entry => entry.destination)
                : current.entries.map(entry => entry.destination);
        const sharesDestination = currentDestinations.some(destination => nextDestinations.has(destination));

        if (currentSourceId !== nextSourceId && sharesDestination) {
            throw new UserPluginManagerError(
                "PENDING_CHANGE_CONFLICT",
                `Pending changes for ${currentSourceId} and ${nextSourceId} both touch an installed destination`
            );
        }

        if (currentSourceId !== nextSourceId) continue;
        const eitherRemoves = current.kind === "remove" || nextChange.kind === "remove";
        if (current.kind !== nextChange.kind && eitherRemoves) {
            throw new UserPluginManagerError(
                "PENDING_CHANGE_CONFLICT",
                `Pending ${current.kind} and ${nextChange.kind} operations for ${nextSourceId} are contradictory`
            );
        }
        replacementIndex = index;
    }

    if (replacementIndex === -1) return [...existingChanges, nextChange];

    const result = [...existingChanges];
    result[replacementIndex] = nextChange;
    return result;
}

export async function readManagerState(path: string): Promise<ManagerStateV1> {
    let serialized: string;
    try {
        serialized = await readFile(path, "utf8");
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return createEmptyManagerState();
        throw error;
    }

    let parsed: unknown;
    try {
        parsed = JSON.parse(serialized);
    } catch (error) {
        throw new UserPluginManagerError("INVALID_STATE", `Manager state is not valid JSON: ${String(error)}`);
    }

    assertManagerStateV1(parsed);
    return parsed;
}

export async function writeManagerStateAtomic(
    path: string,
    state: ManagerStateV1,
    operations: AtomicWriteOperations = {}
): Promise<void> {
    assertManagerStateV1(state);
    const directory = dirname(resolve(path));
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const sequence = atomicWriteSequence++;
    const temporaryPath = `${directory}/.${basename(path)}.${process.pid}.${sequence}.tmp`;
    const handle = await open(temporaryPath, "wx", 0o600);

    try {
        await handle.writeFile(`${JSON.stringify(state, null, 4)}\n`, "utf8");
        await handle.sync();
        await handle.close();
        await (operations.rename ?? rename)(temporaryPath, path);
    } catch (error) {
        await handle.close().catch(() => undefined);
        await rm(temporaryPath, { force: true }).catch(() => undefined);
        throw error;
    }
}

function assertManagerStateV1(value: unknown): asserts value is ManagerStateV1 {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw new UserPluginManagerError("INVALID_STATE", "Manager state must be an object");
    }

    const state = value as Record<string, unknown>;
    if (typeof state.schemaVersion !== "number") {
        throw new UserPluginManagerError("INVALID_STATE", "Manager state schemaVersion must be a number");
    }
    if (state.schemaVersion > USER_PLUGIN_MANAGER_SCHEMA_VERSION) {
        throw new UserPluginManagerError(
            "UNSUPPORTED_SCHEMA_VERSION",
            `Manager state schema version ${state.schemaVersion} is newer than supported version ${USER_PLUGIN_MANAGER_SCHEMA_VERSION}`
        );
    }
    if (state.schemaVersion !== USER_PLUGIN_MANAGER_SCHEMA_VERSION) {
        throw new UserPluginManagerError(
            "INVALID_STATE",
            `Manager state schema version ${state.schemaVersion} is not supported`
        );
    }
    if (!Array.isArray(state.sources)) {
        throw new UserPluginManagerError("INVALID_STATE", "Manager state sources must be an array");
    }
    if (state.riskAcknowledgedAt !== undefined && typeof state.riskAcknowledgedAt !== "string") {
        throw new UserPluginManagerError("INVALID_STATE", "riskAcknowledgedAt must be a string when present");
    }

    for (const source of state.sources) assertManagedSourceV1(source);
    if (state.pending !== undefined) assertPendingChangeSetV1(state.pending);
    if (state.lastApply !== undefined) assertApplyResultV1(state.lastApply);

    const conflicts = findDestinationConflicts(state.sources as ManagedSourceV1[]);
    if (conflicts.length > 0) {
        throw new UserPluginManagerError(
            "INVALID_STATE",
            `Multiple managed sources own destination ${conflicts[0].destination}`
        );
    }
}

function assertManagedSourceV1(value: unknown): asserts value is ManagedSourceV1 {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw new UserPluginManagerError("INVALID_STATE", "Managed source must be an object");
    }

    const source = value as Record<string, unknown>;
    const requiredStrings = [
        "id",
        "displayName",
        "kind",
        "locator",
        "resolvedRevision",
        "contentDigest",
        "installedAt",
        "updatedAt"
    ];
    for (const key of requiredStrings) {
        if (typeof source[key] !== "string" || source[key] === "") {
            throw new UserPluginManagerError("INVALID_STATE", `Managed source ${key} must be a non-empty string`);
        }
    }
    if (source.requestedRef !== undefined && typeof source.requestedRef !== "string") {
        throw new UserPluginManagerError("INVALID_STATE", "Managed source requestedRef must be a string when present");
    }
    if (!["git", "http-archive", "http-file", "local-file", "local-directory"].includes(source.kind as string)) {
        throw new UserPluginManagerError("INVALID_STATE", `Unsupported managed source kind ${String(source.kind)}`);
    }
    if (!["manual", "check-on-open"].includes(source.updatePolicy as string)) {
        throw new UserPluginManagerError("INVALID_STATE", `Unsupported update policy ${String(source.updatePolicy)}`);
    }
    if (!Array.isArray(source.entries) || source.entries.length === 0) {
        throw new UserPluginManagerError("INVALID_STATE", "Managed source entries must be a non-empty array");
    }
    for (const entry of source.entries) assertManagedEntryV1(entry);
}

function assertManagedEntryV1(value: unknown): asserts value is ManagedEntryV1 {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw new UserPluginManagerError("INVALID_STATE", "Managed entry must be an object");
    }

    const entry = value as Record<string, unknown>;
    for (const key of ["sourcePath", "destination", "contentDigest"]) {
        if (typeof entry[key] !== "string" || entry[key] === "") {
            throw new UserPluginManagerError("INVALID_STATE", `Managed entry ${key} must be a non-empty string`);
        }
    }
}

function assertPendingChangeSetV1(value: unknown): asserts value is PendingChangeSetV1 {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw new UserPluginManagerError("INVALID_STATE", "Pending change set must be an object");
    }

    const pending = value as Record<string, unknown>;
    for (const key of ["id", "createdAt", "updatedAt"]) {
        if (typeof pending[key] !== "string" || pending[key] === "") {
            throw new UserPluginManagerError("INVALID_STATE", `Pending change set ${key} must be a non-empty string`);
        }
    }
    if (!Array.isArray(pending.changes)) {
        throw new UserPluginManagerError("INVALID_STATE", "Pending changes must be an array");
    }
    for (const change of pending.changes) assertPendingChangeV1(change);
}

function assertPendingChangeV1(value: unknown): asserts value is PendingChangeV1 {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw new UserPluginManagerError("INVALID_STATE", "Pending change must be an object");
    }

    const change = value as Record<string, unknown>;
    if (!["install", "update", "resync", "remove", "adopt"].includes(change.kind as string)) {
        throw new UserPluginManagerError("INVALID_STATE", `Unsupported pending change kind ${String(change.kind)}`);
    }
    if (change.kind === "install") {
        assertManagedSourceV1(change.source);
    } else if (typeof change.sourceId !== "string" || change.sourceId === "") {
        throw new UserPluginManagerError("INVALID_STATE", "Pending change sourceId must be a non-empty string");
    }
    if (change.kind === "remove") {
        if (!Array.isArray(change.destinations) || change.destinations.some(item => typeof item !== "string" || item === "")) {
            throw new UserPluginManagerError("INVALID_STATE", "Pending removal destinations must be strings");
        }
        if (typeof change.expectedInstalledDigest !== "string" || change.expectedInstalledDigest === "") {
            throw new UserPluginManagerError("INVALID_STATE", "Pending removal expectedInstalledDigest must be a non-empty string");
        }
        return;
    }
    if (change.kind === "adopt") {
        assertManagedSourceV1(change.source);
    } else {
        if (typeof change.stagedPath !== "string" || change.stagedPath === "") {
            throw new UserPluginManagerError("INVALID_STATE", "Pending change stagedPath must be a non-empty string");
        }
        if (!["plugin-root", "collection", "single-file"].includes(change.shape as string)) {
            throw new UserPluginManagerError("INVALID_STATE", `Unsupported pending source shape ${String(change.shape)}`);
        }
    }
    for (const key of ["inspectionId", "inspectedRevision", "inspectedDigest"]) {
        if (typeof change[key] !== "string" || change[key] === "") {
            throw new UserPluginManagerError("INVALID_STATE", `Pending change ${key} must be a non-empty string`);
        }
    }
    if (!Array.isArray(change.entries) || change.entries.length === 0) {
        throw new UserPluginManagerError("INVALID_STATE", "Pending change entries must be a non-empty array");
    }
    for (const entry of change.entries) assertManagedEntryV1(entry);
    if ((change.kind === "update" || change.kind === "resync") && (typeof change.expectedInstalledDigest !== "string" || change.expectedInstalledDigest === "")) {
        throw new UserPluginManagerError("INVALID_STATE", "Pending update expectedInstalledDigest must be a non-empty string");
    }
}

function assertApplyResultV1(value: unknown): asserts value is ApplyResultV1 {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw new UserPluginManagerError("INVALID_STATE", "Last apply result must be an object");
    }

    const result = value as Record<string, unknown>;
    if (typeof result.operationId !== "string" || result.operationId === "") {
        throw new UserPluginManagerError("INVALID_STATE", "Last apply operationId must be a non-empty string");
    }
    if (typeof result.completedAt !== "string" || result.completedAt === "") {
        throw new UserPluginManagerError("INVALID_STATE", "Last apply completedAt must be a non-empty string");
    }
    if (!Array.isArray(result.sourceIds) || result.sourceIds.some(item => typeof item !== "string" || item === "")) {
        throw new UserPluginManagerError("INVALID_STATE", "Last apply sourceIds must be strings");
    }
}
