/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, sep } from "node:path";
import test from "node:test";

import {
    acknowledgeTransactionBuild,
    applyTransaction,
    completeRecoveryBuild,
    completeTransactionCommit,
    computePathDigest,
    inspectTransactionRecovery,
    readTransactionJournal,
    TransactionError,
    type TransactionJournalPhase,
    type TransactionPlan
} from "../../core/src/main/userPluginManager/transaction.ts";

async function fixture(t: test.TestContext) {
    const root = await mkdtemp(join(tmpdir(), "vencord-manager-transaction-"));
    const managerDataRoot = join(root, "manager");
    const installedRoot = join(root, "installed");
    const operationRoot = join(managerDataRoot, "operations", "operation");
    const journalPath = join(managerDataRoot, "journal.json");
    await mkdir(installedRoot);
    await mkdir(operationRoot, { recursive: true });
    t.after(() => rm(root, { recursive: true, force: true }));
    return { root, installedRoot, operationRoot, journalPath };
}

async function plugin(path: string, marker: string) {
    await mkdir(path, { recursive: true });
    await writeFile(join(path, "index.ts"), `export default ${JSON.stringify(marker)};\n`);
}

async function marker(path: string) {
    return readFile(join(path, "index.ts"), "utf8");
}

test("several writes and removals become one awaiting-build transaction", async t => {
    const paths = await fixture(t);
    await plugin(join(paths.installedRoot, "alpha"), "alpha-old");
    await plugin(join(paths.installedRoot, "obsolete"), "obsolete");
    await plugin(join(paths.operationRoot, "staged", "alpha"), "alpha-new");
    await plugin(join(paths.operationRoot, "staged", "beta"), "beta");

    const alphaOldDigest = await computePathDigest(join(paths.installedRoot, "alpha"));
    const obsoleteDigest = await computePathDigest(join(paths.installedRoot, "obsolete"));
    const alphaNewDigest = await computePathDigest(join(paths.operationRoot, "staged", "alpha"));
    const betaDigest = await computePathDigest(join(paths.operationRoot, "staged", "beta"));
    const plan: TransactionPlan = {
        operationId: "batch-success",
        pendingId: "pending-1",
        ...paths,
        sources: [
            { sourceId: "alpha-source", stagedRoot: join(paths.operationRoot, "staged", "alpha"), inspectedRevision: "alpha-r2", inspectedDigest: alphaNewDigest },
            { sourceId: "beta-source", stagedRoot: join(paths.operationRoot, "staged", "beta"), inspectedRevision: "beta-r1", inspectedDigest: betaDigest }
        ],
        ownership: [
            { destination: "alpha", sourceId: "alpha-source", contentDigest: alphaOldDigest },
            { destination: "obsolete", sourceId: "obsolete-source", contentDigest: obsoleteDigest }
        ],
        adoptions: [],
        mutations: [
            { action: "write", destination: "alpha", sourceId: "alpha-source", stagedPath: join(paths.operationRoot, "staged", "alpha"), inspectedDigest: alphaNewDigest, expected: { state: "owned", sourceId: "alpha-source", contentDigest: alphaOldDigest } },
            { action: "write", destination: "beta", sourceId: "beta-source", stagedPath: join(paths.operationRoot, "staged", "beta"), inspectedDigest: betaDigest, expected: { state: "absent" } },
            { action: "remove", destination: "obsolete", sourceId: "obsolete-source", expected: { state: "owned", sourceId: "obsolete-source", contentDigest: obsoleteDigest } }
        ]
    };

    const journal = await applyTransaction(plan, {
        revalidateSource: async source => ({ resolvedRevision: source.inspectedRevision, contentDigest: source.inspectedDigest })
    });
    assert.equal(journal.phase, "awaiting-build");
    assert.equal(journal.completedDestinations.length, 3);
    assert.match(await marker(join(paths.installedRoot, "alpha")), /alpha-new/);
    assert.match(await marker(join(paths.installedRoot, "beta")), /beta/);
    await assert.rejects(marker(join(paths.installedRoot, "obsolete")));

    const committing = await acknowledgeTransactionBuild(paths.journalPath, true);
    assert.equal(committing.phase, "committing");
    await completeTransactionCommit(paths.journalPath);
    assert.equal((await inspectTransactionRecovery(paths.journalPath)).action, "none");
});

test("an injected failure between swaps restores the complete prior tree", async t => {
    const paths = await fixture(t);
    await plugin(join(paths.installedRoot, "alpha"), "alpha-old");
    await plugin(join(paths.operationRoot, "staged", "alpha"), "alpha-new");
    await plugin(join(paths.operationRoot, "staged", "beta"), "beta");
    const oldDigest = await computePathDigest(join(paths.installedRoot, "alpha"));
    const alphaDigest = await computePathDigest(join(paths.operationRoot, "staged", "alpha"));
    const betaDigest = await computePathDigest(join(paths.operationRoot, "staged", "beta"));
    const plan: TransactionPlan = {
        operationId: "batch-failure",
        pendingId: "pending-2",
        ...paths,
        sources: [],
        ownership: [{ destination: "alpha", sourceId: "alpha-source", contentDigest: oldDigest }],
        adoptions: [],
        mutations: [
            { action: "write", destination: "alpha", sourceId: "alpha-source", stagedPath: join(paths.operationRoot, "staged", "alpha"), inspectedDigest: alphaDigest, expected: { state: "owned", sourceId: "alpha-source", contentDigest: oldDigest } },
            { action: "write", destination: "beta", sourceId: "beta-source", stagedPath: join(paths.operationRoot, "staged", "beta"), inspectedDigest: betaDigest, expected: { state: "absent" } }
        ]
    };

    await assert.rejects(applyTransaction(plan, {
        afterEntrySwap: completed => {
            if (completed === 1) throw new Error("injected swap failure");
        }
    }), (error: unknown) => error instanceof TransactionError && error.code === "SWAP_FAILED");
    assert.match(await marker(join(paths.installedRoot, "alpha")), /alpha-old/);
    await assert.rejects(marker(join(paths.installedRoot, "beta")));
    assert.equal((await readTransactionJournal(paths.journalPath)).phase, "awaiting-recovery-build");
});

test("a failed build restores every destination and requires one recovery build", async t => {
    const paths = await fixture(t);
    await plugin(join(paths.installedRoot, "alpha"), "alpha-old");
    await plugin(join(paths.operationRoot, "staged", "alpha"), "alpha-new");
    const oldDigest = await computePathDigest(join(paths.installedRoot, "alpha"));
    const newDigest = await computePathDigest(join(paths.operationRoot, "staged", "alpha"));
    const plan: TransactionPlan = {
        operationId: "build-failure",
        pendingId: "pending-retained",
        ...paths,
        sources: [],
        ownership: [{ destination: "alpha", sourceId: "alpha-source", contentDigest: oldDigest }],
        adoptions: [],
        mutations: [{ action: "write", destination: "alpha", sourceId: "alpha-source", stagedPath: join(paths.operationRoot, "staged", "alpha"), inspectedDigest: newDigest, expected: { state: "owned", sourceId: "alpha-source", contentDigest: oldDigest } }]
    };

    await applyTransaction(plan);
    const rolledBack = await acknowledgeTransactionBuild(paths.journalPath, false);
    assert.equal(rolledBack.phase, "awaiting-recovery-build");
    assert.equal(rolledBack.pendingId, "pending-retained");
    assert.match(await marker(join(paths.installedRoot, "alpha")), /alpha-old/);
    await assert.rejects(completeRecoveryBuild(paths.journalPath, false), (error: unknown) => error instanceof TransactionError && error.code === "RECOVERY_BUILD_FAILED");
    await completeRecoveryBuild(paths.journalPath, true);
    assert.equal((await inspectTransactionRecovery(paths.journalPath)).action, "none");
});

test("every journal phase maps to one deterministic startup recovery action", async t => {
    const paths = await fixture(t);
    const expected: Record<TransactionJournalPhase, string> = {
        prepared: "rollback",
        "files-swapped": "rollback",
        "awaiting-build": "rollback",
        "rolling-back": "rollback",
        "awaiting-recovery-build": "recovery-build",
        committing: "commit"
    };
    for (const [phase, action] of Object.entries(expected)) {
        await writeFile(paths.journalPath, JSON.stringify({
            schemaVersion: 1,
            operationId: "recovery",
            pendingId: "pending",
            phase,
            installedRoot: paths.installedRoot,
            operationRoot: paths.operationRoot,
            mutations: [],
            completedDestinations: []
        }));
        assert.equal((await inspectTransactionRecovery(paths.journalPath)).action, action, phase);
    }
});

test("stale source checks stop before any installed destination mutation", async t => {
    const paths = await fixture(t);
    await plugin(join(paths.operationRoot, "staged", "alpha"), "alpha");
    const digest = await computePathDigest(join(paths.operationRoot, "staged", "alpha"));
    const plan: TransactionPlan = {
        operationId: "stale",
        pendingId: "pending-stale",
        ...paths,
        sources: [{ sourceId: "alpha-source", stagedRoot: join(paths.operationRoot, "staged", "alpha"), inspectedRevision: "r1", inspectedDigest: digest }],
        ownership: [],
        adoptions: [],
        mutations: [{ action: "write", destination: "alpha", sourceId: "alpha-source", stagedPath: join(paths.operationRoot, "staged", "alpha"), inspectedDigest: digest, expected: { state: "absent" } }]
    };
    await assert.rejects(applyTransaction(plan, {
        revalidateSource: async () => ({ resolvedRevision: "r2", contentDigest: digest })
    }), (error: unknown) => error instanceof TransactionError && error.code === "STALE_INSPECTION");
    await assert.rejects(marker(join(paths.installedRoot, "alpha")));
    assert.equal((await inspectTransactionRecovery(paths.journalPath)).action, "none");
});

test("unmanaged and cross-source destinations remain untouched", async t => {
    const paths = await fixture(t);
    await plugin(join(paths.installedRoot, "occupied"), "do-not-touch");
    await plugin(join(paths.operationRoot, "staged", "replacement"), "replacement");
    const installedDigest = await computePathDigest(join(paths.installedRoot, "occupied"));
    const stagedDigest = await computePathDigest(join(paths.operationRoot, "staged", "replacement"));

    for (const ownership of [[], [{ destination: "occupied", sourceId: "other-source", contentDigest: installedDigest }]]) {
        const plan: TransactionPlan = {
            operationId: `collision-${ownership.length}`,
            pendingId: "pending-collision",
            ...paths,
            sources: [],
            ownership,
            adoptions: [],
            mutations: [{ action: "write", destination: "occupied", sourceId: "new-source", stagedPath: join(paths.operationRoot, "staged", "replacement"), inspectedDigest: stagedDigest, expected: { state: "owned", sourceId: "new-source", contentDigest: installedDigest } }]
        };
        await assert.rejects(applyTransaction(plan), (error: unknown) => error instanceof TransactionError && error.code === "OWNERSHIP_CONFLICT");
        assert.match(await marker(join(paths.installedRoot, "occupied")), /do-not-touch/);
    }
});

test("metadata-only adoption validates an unmanaged destination without replacing it", async t => {
    const paths = await fixture(t);
    const destination = join(paths.installedRoot, "adopt-me");
    await plugin(destination, "original");
    const inspectedDigest = await computePathDigest(destination);
    const plan: TransactionPlan = {
        operationId: "adopt-only",
        pendingId: "pending-adopt",
        installedRoot: paths.installedRoot,
        operationRoot: paths.operationRoot,
        journalPath: paths.journalPath,
        sources: [],
        ownership: [],
        adoptions: [{ destination: "adopt-me", sourceId: "adopted-source", inspectedDigest }],
        mutations: []
    };

    const journal = await applyTransaction(plan);

    assert.equal(journal.phase, "awaiting-build");
    assert.match(await marker(destination), /original/);
    await acknowledgeTransactionBuild(paths.journalPath, true);
    await completeTransactionCommit(paths.journalPath);
    assert.equal((await inspectTransactionRecovery(paths.journalPath)).action, "none");
});

test("swap staging stays beside the installed root instead of the operation filesystem", async t => {
    const paths = await fixture(t);
    const destination = join(paths.installedRoot, "alpha");
    const stagedPath = join(paths.operationRoot, "staged", "alpha");
    await plugin(destination, "old");
    await plugin(stagedPath, "new");
    const installedDigest = await computePathDigest(destination);
    const inspectedDigest = await computePathDigest(stagedPath);
    const plan: TransactionPlan = {
        operationId: "cross-device-safe",
        pendingId: "pending-cross-device-safe",
        ...paths,
        sources: [],
        ownership: [{ destination: "alpha", sourceId: "source-a", contentDigest: installedDigest }],
        adoptions: [],
        mutations: [{
            action: "write",
            destination: "alpha",
            sourceId: "source-a",
            stagedPath,
            inspectedDigest,
            expected: { state: "owned", sourceId: "source-a", contentDigest: installedDigest }
        }]
    };

    const journal = await applyTransaction(plan);
    const mutation = journal.mutations[0];

    assert.ok(journal.swapRoot);
    assert.equal(dirname(journal.swapRoot), dirname(paths.installedRoot));
    assert.equal(relative(paths.operationRoot, journal.swapRoot).split(sep)[0], "..");
    assert.equal(dirname(mutation.candidatePath!), join(journal.swapRoot, "candidates"));
    assert.equal(dirname(mutation.displacedPath), join(journal.swapRoot, "displaced"));
    assert.match(await marker(destination), /new/);
    await acknowledgeTransactionBuild(paths.journalPath, true);
    await completeTransactionCommit(paths.journalPath);
});

test("transactions install selected shared files under the reserved _shared directory", async t => {
    const paths = await fixture(t);
    const stagedPath = join(paths.operationRoot, "staged", "author.ts");
    await mkdir(join(paths.operationRoot, "staged"), { recursive: true });
    await writeFile(stagedPath, "export const author = true;\n");
    const inspectedDigest = await computePathDigest(stagedPath);
    const plan: TransactionPlan = {
        operationId: "shared-install",
        pendingId: "pending-shared",
        ...paths,
        sources: [],
        ownership: [],
        adoptions: [],
        mutations: [{
            action: "write",
            destination: "_shared/author.ts",
            sourceId: "collection-source",
            stagedPath,
            inspectedDigest,
            expected: { state: "absent" }
        }]
    };

    const journal = await applyTransaction(plan);

    assert.equal(journal.phase, "awaiting-build");
    assert.match(await readFile(join(paths.installedRoot, "_shared", "author.ts"), "utf8"), /author = true/);
    await acknowledgeTransactionBuild(paths.journalPath, true);
    await completeTransactionCommit(paths.journalPath);
});
