/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { createHash } from "node:crypto";
import {
    cp,
    lstat,
    mkdir,
    open,
    readFile,
    readdir,
    rename,
    rm,
    stat
} from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";

import {
    resolveContainedDestination,
    resolveContainedExistingPath,
    resolveOperationCleanupPath
} from "../../shared/userPluginManagerSafety";

export type TransactionJournalPhase =
    | "prepared"
    | "files-swapped"
    | "awaiting-build"
    | "rolling-back"
    | "awaiting-recovery-build"
    | "committing";

export type TransactionRecoveryAction = "none" | "rollback" | "recovery-build" | "commit";
export type TransactionErrorCode =
    | "INVALID_PLAN"
    | "STALE_INSPECTION"
    | "OWNERSHIP_CONFLICT"
    | "SWAP_FAILED"
    | "INVALID_JOURNAL"
    | "RECOVERY_REQUIRED"
    | "INVALID_PHASE"
    | "RECOVERY_BUILD_FAILED";

export interface TransactionSourceCheck {
    sourceId: string;
    stagedRoot: string;
    inspectedRevision: string;
    inspectedDigest: string;
}

export interface TransactionOwnership {
    destination: string;
    sourceId: string;
    contentDigest: string;
}
export interface TransactionAdoption {
    destination: string;
    sourceId: string;
    inspectedDigest: string;
}



export type TransactionExpectedDestination =
    | { state: "absent"; }
    | { state: "owned"; sourceId: string; contentDigest: string; };

export interface TransactionWriteMutation {
    action: "write";
    destination: string;
    sourceId: string;
    stagedPath: string;
    inspectedDigest: string;
    expected: TransactionExpectedDestination;
}

export interface TransactionRemoveMutation {
    action: "remove";
    destination: string;
    sourceId: string;
    expected: TransactionExpectedDestination;
}

export type TransactionMutation = TransactionWriteMutation | TransactionRemoveMutation;

export interface TransactionPlan {
    operationId: string;
    pendingId: string;
    installedRoot: string;
    operationRoot: string;
    journalPath: string;
    sources: TransactionSourceCheck[];
    ownership: TransactionOwnership[];
    adoptions: TransactionAdoption[];
    mutations: TransactionMutation[];
}

interface JournalMutation {
    action: TransactionMutation["action"];
    destination: string;
    sourceId: string;
    destinationPath: string;
    backupPath?: string;
    candidatePath?: string;
    displacedPath: string;
    hadOriginal: boolean;
}

export interface TransactionJournal {
    schemaVersion: 1;
    operationId: string;
    pendingId: string;
    phase: TransactionJournalPhase;
    installedRoot: string;
    operationRoot: string;
    swapRoot?: string;
    mutations: JournalMutation[];
    completedDestinations: string[];
}

export interface TransactionHooks {
    revalidateSource?: (source: TransactionSourceCheck) => Promise<{
        resolvedRevision: string;
        contentDigest: string;
    }>;
    afterEntrySwap?: (completedEntries: number) => void | Promise<void>;
}

export interface TransactionRecoveryStatus {
    action: TransactionRecoveryAction;
    journal?: TransactionJournal;
}

export class TransactionError extends Error {
    constructor(public readonly code: TransactionErrorCode, message: string, options?: ErrorOptions) {
        super(message, options);
        this.name = "TransactionError";
    }
}

export async function computePathDigest(path: string): Promise<string> {
    const root = resolve(path);
    const rootStats = await lstat(root);
    if (rootStats.isSymbolicLink()) {
        throw new TransactionError("INVALID_PLAN", "Transaction inputs cannot be symbolic links");
    }

    const hash = createHash("sha256");
    if (rootStats.isFile()) {
        hash.update("file\0");
        hash.update(await readFile(root));
        return hash.digest("hex");
    }
    if (!rootStats.isDirectory()) {
        throw new TransactionError("INVALID_PLAN", "Transaction inputs must be regular files or directories");
    }

    const pendingDirectories = [root];
    while (pendingDirectories.length !== 0) {
        const current = pendingDirectories.pop()!;
        const entries = await readdir(current, { withFileTypes: true });
        entries.sort((left, right) => left.name.localeCompare(right.name));
        for (const entry of entries) {
            const entryPath = join(current, entry.name);
            const relativePath = relative(root, entryPath).split(sep).join("/");
            if (entry.isSymbolicLink()) {
                throw new TransactionError("INVALID_PLAN", `Transaction input ${relativePath} is a symbolic link`);
            }
            if (entry.isDirectory()) {
                hash.update(`directory\0${relativePath}\0`);
                pendingDirectories.push(entryPath);
                continue;
            }
            if (!entry.isFile()) {
                throw new TransactionError("INVALID_PLAN", `Transaction input ${relativePath} is not a regular file`);
            }
            hash.update(`file\0${relativePath}\0`);
            hash.update(await readFile(entryPath));
            hash.update("\0");
        }
    }
    return hash.digest("hex");
}

export async function applyTransaction(
    plan: TransactionPlan,
    hooks: TransactionHooks = {}
): Promise<TransactionJournal> {
    assertTransactionPlan(plan);
    const existingRecovery = await inspectTransactionRecovery(plan.journalPath);
    if (existingRecovery.action !== "none") {
        throw new TransactionError("RECOVERY_REQUIRED", "A previous User Plugin Manager transaction requires recovery");
    }

    await mkdir(plan.operationRoot, { recursive: true });
    await revalidateTransactionSources(plan.sources, hooks.revalidateSource);
    await assertTransactionPreconditions(plan);
    const journal = await prepareTransactionJournal(plan);
    await writeTransactionJournal(plan.journalPath, journal);

    try {
        for (const mutation of journal.mutations) {
            journal.completedDestinations.push(mutation.destination);
            await writeTransactionJournal(plan.journalPath, journal);
            await rm(mutation.displacedPath, { recursive: true, force: true });
            if (mutation.hadOriginal) await rename(mutation.destinationPath, mutation.displacedPath);
            if (mutation.action === "write") {
                await mkdir(dirname(mutation.destinationPath), { recursive: true });
                await rename(mutation.candidatePath!, mutation.destinationPath);
            }
            await hooks.afterEntrySwap?.(journal.completedDestinations.length);
        }
        journal.phase = "files-swapped";
        await writeTransactionJournal(plan.journalPath, journal);
        journal.phase = "awaiting-build";
        await writeTransactionJournal(plan.journalPath, journal);
        return journal;
    } catch (error) {
        journal.phase = "rolling-back";
        await writeTransactionJournal(plan.journalPath, journal);
        try {
            await restoreCompletedDestinations(journal);
            journal.phase = "awaiting-recovery-build";
            await writeTransactionJournal(plan.journalPath, journal);
        } catch (rollbackError) {
            throw new TransactionError(
                "SWAP_FAILED",
                "Transaction swap failed and rollback could not be completed",
                { cause: new AggregateError([error, rollbackError]) }
            );
        }
        throw new TransactionError("SWAP_FAILED", "Transaction swap failed; the prior tree was restored", { cause: error });
    }
}

export async function acknowledgeTransactionBuild(
    journalPath: string,
    succeeded: boolean
): Promise<TransactionJournal> {
    const journal = await readTransactionJournal(journalPath);
    if (journal.phase !== "awaiting-build") {
        throw new TransactionError("INVALID_PHASE", `Cannot acknowledge a build while transaction is ${journal.phase}`);
    }

    if (succeeded) {
        journal.phase = "committing";
        await writeTransactionJournal(journalPath, journal);
        return journal;
    }

    journal.phase = "rolling-back";
    await writeTransactionJournal(journalPath, journal);
    await restoreCompletedDestinations(journal);
    journal.phase = "awaiting-recovery-build";
    await writeTransactionJournal(journalPath, journal);
    return journal;
}

export async function rollbackTransactionForRecovery(journalPath: string): Promise<TransactionJournal> {
    const journal = await readTransactionJournal(journalPath);
    if (!["prepared", "files-swapped", "awaiting-build", "rolling-back"].includes(journal.phase)) {
        throw new TransactionError("INVALID_PHASE", `Transaction phase ${journal.phase} does not require rollback`);
    }
    journal.phase = "rolling-back";
    await writeTransactionJournal(journalPath, journal);
    await restoreCompletedDestinations(journal);
    journal.phase = "awaiting-recovery-build";
    await writeTransactionJournal(journalPath, journal);
    return journal;
}

export async function completeRecoveryBuild(journalPath: string, succeeded: boolean): Promise<void> {
    const journal = await readTransactionJournal(journalPath);
    if (journal.phase !== "awaiting-recovery-build") {
        throw new TransactionError("INVALID_PHASE", `Transaction phase ${journal.phase} does not require a recovery build`);
    }
    if (!succeeded) {
        throw new TransactionError("RECOVERY_BUILD_FAILED", "Recovery build failed; backups and journal were retained");
    }
    await cleanupCompletedTransaction(journalPath, journal);
}

export async function completeTransactionCommit(journalPath: string): Promise<void> {
    const journal = await readTransactionJournal(journalPath);
    if (journal.phase !== "committing") {
        throw new TransactionError("INVALID_PHASE", `Cannot complete a transaction commit while it is ${journal.phase}`);
    }
    await cleanupCompletedTransaction(journalPath, journal);
}

export async function inspectTransactionRecovery(journalPath: string): Promise<TransactionRecoveryStatus> {
    let journal: TransactionJournal;
    try {
        journal = await readTransactionJournal(journalPath);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return { action: "none" };
        throw error;
    }

    switch (journal.phase) {
        case "prepared":
        case "files-swapped":
        case "awaiting-build":
        case "rolling-back":
            return { action: "rollback", journal };
        case "awaiting-recovery-build":
            return { action: "recovery-build", journal };
        case "committing":
            return { action: "commit", journal };
    }
}

export async function readTransactionJournal(journalPath: string): Promise<TransactionJournal> {
    let parsed: unknown;
    try {
        parsed = JSON.parse(await readFile(journalPath, "utf8"));
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") throw error;
        throw new TransactionError("INVALID_JOURNAL", "Transaction journal is not valid JSON", { cause: error });
    }
    assertTransactionJournal(parsed);
    return parsed;
}

async function revalidateTransactionSources(
    sources: readonly TransactionSourceCheck[],
    revalidateSource?: TransactionHooks["revalidateSource"]
): Promise<void> {
    for (const source of sources) {
        const current = revalidateSource
            ? await revalidateSource(source)
            : { resolvedRevision: source.inspectedRevision, contentDigest: await computePathDigest(source.stagedRoot) };
        if (
            current.resolvedRevision !== source.inspectedRevision
            || current.contentDigest !== source.inspectedDigest
        ) {
            throw new TransactionError("STALE_INSPECTION", `Source ${source.sourceId} changed after inspection`);
        }
    }
}

async function assertTransactionPreconditions(plan: TransactionPlan): Promise<void> {
    const ownershipByDestination = new Map(plan.ownership.map(record => [record.destination, record]));
    const seenDestinations = new Set<string>();

    for (const mutation of plan.mutations) {
        if (seenDestinations.has(mutation.destination)) {
            throw new TransactionError("INVALID_PLAN", `Destination ${mutation.destination} appears more than once`);
        }
        seenDestinations.add(mutation.destination);
        const destinationPath = await resolveContainedDestination(plan.installedRoot, mutation.destination);
        if (!isSupportedInstalledDestination(plan.installedRoot, mutation.destination, destinationPath)) {
            throw new TransactionError("INVALID_PLAN", "Transaction destinations must be plugins or files directly under the reserved _shared directory");
        }

        let currentDigest: string | undefined;
        try {
            currentDigest = await computePathDigest(destinationPath);
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
        const ownership = ownershipByDestination.get(mutation.destination);

        if (mutation.expected.state === "absent") {
            if (currentDigest !== undefined || ownership !== undefined) {
                throw new TransactionError("OWNERSHIP_CONFLICT", `Destination ${mutation.destination} is not absent`);
            }
        } else if (
            currentDigest === undefined
            || ownership === undefined
            || ownership.sourceId !== mutation.expected.sourceId
            || ownership.sourceId !== mutation.sourceId
            || ownership.contentDigest !== mutation.expected.contentDigest
            || currentDigest !== mutation.expected.contentDigest
        ) {
            throw new TransactionError("OWNERSHIP_CONFLICT", `Destination ${mutation.destination} is unmanaged, stale, or owned by another source`);
        }

        if (mutation.action === "write") {
            const stagedPath = await resolveContainedExistingPath(plan.operationRoot, mutation.stagedPath);
            const stagedDigest = await computePathDigest(stagedPath);
            if (stagedDigest !== mutation.inspectedDigest) {
                throw new TransactionError("STALE_INSPECTION", `Staged destination ${mutation.destination} changed after inspection`);
            }
        }
    }

    for (const adoption of plan.adoptions) {
        if (seenDestinations.has(adoption.destination)) {
            throw new TransactionError("INVALID_PLAN", `Destination ${adoption.destination} appears more than once`);
        }
        seenDestinations.add(adoption.destination);
        const destinationPath = await resolveContainedDestination(plan.installedRoot, adoption.destination);
        if (!isSupportedInstalledDestination(plan.installedRoot, adoption.destination, destinationPath)) {
            throw new TransactionError("INVALID_PLAN", "Transaction destinations must be plugins or files directly under the reserved _shared directory");
        }
        if (ownershipByDestination.has(adoption.destination)) {
            throw new TransactionError("OWNERSHIP_CONFLICT", `Destination ${adoption.destination} is already owned`);
        }

        let currentDigest: string;
        try {
            currentDigest = await computePathDigest(destinationPath);
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") {
                throw new TransactionError("OWNERSHIP_CONFLICT", `Destination ${adoption.destination} no longer exists`);
            }
            throw error;
        }
        if (currentDigest !== adoption.inspectedDigest) {
            throw new TransactionError("STALE_INSPECTION", `Destination ${adoption.destination} changed after inspection`);
        }
    }
}

function isSupportedInstalledDestination(installedRoot: string, destination: string, destinationPath: string): boolean {
    if (destination === "_shared") return false;
    const root = resolve(installedRoot);
    const parent = dirname(destinationPath);
    return parent === root || parent === join(root, "_shared");
}

function transactionSwapRoot(installedRoot: string, operationId: string): string {
    const root = resolve(installedRoot);
    const transactionId = createHash("sha256").update(operationId).digest("hex").slice(0, 16);
    return join(dirname(root), `.${basename(root)}-user-plugin-manager-${transactionId}`);
}

async function prepareTransactionJournal(plan: TransactionPlan): Promise<TransactionJournal> {
    const backupRoot = join(plan.operationRoot, "backups");
    const swapRoot = transactionSwapRoot(plan.installedRoot, plan.operationId);
    const candidateRoot = join(swapRoot, "candidates");
    const displacedRoot = join(swapRoot, "displaced");
    await mkdir(backupRoot, { recursive: true });
    await mkdir(swapRoot, { recursive: false, mode: 0o700 });
    await mkdir(candidateRoot);
    await mkdir(displacedRoot);

    const mutations: JournalMutation[] = [];
    for (let index = 0; index < plan.mutations.length; index++) {
        const mutation = plan.mutations[index];
        const destinationPath = await resolveContainedDestination(plan.installedRoot, mutation.destination);
        let hadOriginal = true;
        try {
            await lstat(destinationPath);
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
            hadOriginal = false;
        }

        const backupPath = hadOriginal ? join(backupRoot, `${index}-${basename(mutation.destination)}`) : undefined;
        if (backupPath) await cp(destinationPath, backupPath, { recursive: true, errorOnExist: true, force: false });
        let candidatePath: string | undefined;
        if (mutation.action === "write") {
            candidatePath = join(candidateRoot, `${index}-${basename(mutation.destination)}`);
            await cp(mutation.stagedPath, candidatePath, { recursive: true, errorOnExist: true, force: false });
            if (await computePathDigest(candidatePath) !== mutation.inspectedDigest) {
                throw new TransactionError("STALE_INSPECTION", `Candidate ${mutation.destination} changed while preparing the transaction`);
            }
        }

        mutations.push({
            action: mutation.action,
            destination: mutation.destination,
            sourceId: mutation.sourceId,
            destinationPath,
            backupPath,
            candidatePath,
            displacedPath: join(displacedRoot, `${index}-${basename(mutation.destination)}`),
            hadOriginal
        });
    }

    return {
        schemaVersion: 1,
        operationId: plan.operationId,
        pendingId: plan.pendingId,
        phase: "prepared",
        installedRoot: resolve(plan.installedRoot),
        operationRoot: resolve(plan.operationRoot),
        swapRoot,
        mutations,
        completedDestinations: []
    };
}

async function restoreCompletedDestinations(journal: TransactionJournal): Promise<void> {
    const completed = new Set(journal.completedDestinations);
    for (const mutation of [...journal.mutations].reverse()) {
        if (!completed.has(mutation.destination)) continue;
        await rm(mutation.destinationPath, { recursive: true, force: true });
        if (mutation.hadOriginal) {
            if (!mutation.backupPath) {
                throw new TransactionError("INVALID_JOURNAL", `Destination ${mutation.destination} has no backup path`);
            }
            await mkdir(dirname(mutation.destinationPath), { recursive: true });
            await cp(mutation.backupPath, mutation.destinationPath, { recursive: true, errorOnExist: true, force: false });
        }
    }
}

async function cleanupCompletedTransaction(journalPath: string, journal: TransactionJournal): Promise<void> {
    const managerDataRoot = dirname(resolve(journalPath));
    const operationRoot = await resolveOperationCleanupPath(managerDataRoot, journal.operationRoot, journal.operationRoot);
    await rm(operationRoot, { recursive: true, force: true });
    if (journal.swapRoot) {
        await rm(journal.swapRoot, { recursive: true, force: true });
        await syncDirectory(dirname(journal.swapRoot));
    }
    await rm(journalPath, { force: true });
    await syncDirectory(managerDataRoot);
}

async function writeTransactionJournal(journalPath: string, journal: TransactionJournal): Promise<void> {
    const directory = dirname(journalPath);
    await mkdir(directory, { recursive: true });
    const temporaryPath = join(directory, `.${basename(journalPath)}.${process.pid}.tmp`);
    const handle = await open(temporaryPath, "wx", 0o600);
    try {
        await handle.writeFile(`${JSON.stringify(journal, null, 2)}\n`, "utf8");
        await handle.sync();
    } finally {
        await handle.close();
    }
    try {
        await rename(temporaryPath, journalPath);
        await syncDirectory(directory);
    } catch (error) {
        await rm(temporaryPath, { force: true });
        throw error;
    }
}

async function syncDirectory(path: string): Promise<void> {
    let handle;
    try {
        handle = await open(path, "r");
        await handle.sync();
    } catch (error) {
        if (!["EINVAL", "ENOTSUP", "EISDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
    } finally {
        await handle?.close();
    }
}

function assertTransactionPlan(plan: TransactionPlan): void {
    if (
        plan.operationId === ""
        || plan.pendingId === ""
        || plan.installedRoot === ""
        || plan.operationRoot === ""
        || plan.journalPath === ""
        || (plan.mutations.length === 0 && plan.adoptions.length === 0)
    ) {
        throw new TransactionError("INVALID_PLAN", "Transaction plan is incomplete");
    }
}

function assertTransactionJournal(value: unknown): asserts value is TransactionJournal {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw new TransactionError("INVALID_JOURNAL", "Transaction journal must be an object");
    }
    const journal = value as Partial<TransactionJournal>;
    const phases: TransactionJournalPhase[] = [
        "prepared",
        "files-swapped",
        "awaiting-build",
        "rolling-back",
        "awaiting-recovery-build",
        "committing"
    ];
    if (
        journal.schemaVersion !== 1
        || typeof journal.operationId !== "string"
        || typeof journal.pendingId !== "string"
        || !phases.includes(journal.phase as TransactionJournalPhase)
        || typeof journal.installedRoot !== "string"
        || typeof journal.operationRoot !== "string"
        || (journal.swapRoot !== undefined && (
            typeof journal.swapRoot !== "string"
            || resolve(journal.swapRoot) !== transactionSwapRoot(journal.installedRoot, journal.operationId)
        ))
        || !Array.isArray(journal.mutations)
        || !Array.isArray(journal.completedDestinations)
        || journal.completedDestinations.some(destination => typeof destination !== "string")
    ) {
        throw new TransactionError("INVALID_JOURNAL", "Transaction journal has an invalid shape");
    }
}
