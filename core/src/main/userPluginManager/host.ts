/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { spawn } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { join } from "node:path";

import { resolveContainedExistingPath } from "@shared/userPluginManagerSafety";

import {
    acknowledgeTransactionBuild,
    applyTransaction,
    completeRecoveryBuild,
    completeTransactionCommit,
    computePathDigest,
    inspectTransactionRecovery,
    rollbackTransactionForRecovery,
    type TransactionJournal,
    type TransactionPlan,
    type TransactionRecoveryStatus
} from "./transaction";

const MAX_HOST_RESPONSE_BYTES = 1024 * 1024;
const DEFAULT_HOST_RUNNER_TIMEOUT_MS = 30_000;

export interface HostInventoryEntry {
    destination: string;
    contentDigest: string;
}

export type UserPluginManagerHostRequest =
    | { action: "ensure-installed-root"; installedRoot: string; }
    | { action: "digest-installed-destination"; installedRoot: string; destination: string; }
    | { action: "collect-inventory"; installedRoot: string; }
    | { action: "apply-transaction"; plan: TransactionPlan; }
    | { action: "acknowledge-build"; journalPath: string; succeeded: boolean; }
    | { action: "rollback-for-recovery"; journalPath: string; }
    | { action: "complete-recovery-build"; journalPath: string; succeeded: boolean; }
    | { action: "complete-commit"; journalPath: string; }
    | { action: "inspect-recovery"; journalPath: string; };

export type UserPluginManagerHostResult<TRequest extends UserPluginManagerHostRequest> =
    TRequest extends { action: "digest-installed-destination"; } ? string
        : TRequest extends { action: "collect-inventory"; } ? HostInventoryEntry[]
            : TRequest extends { action: "inspect-recovery"; } ? TransactionRecoveryStatus
                : TRequest extends { action: "apply-transaction" | "acknowledge-build" | "rollback-for-recovery" | "complete-recovery-build"; } ? TransactionJournal
                    : void;

export interface UserPluginManagerHost {
    execute<TRequest extends UserPluginManagerHostRequest>(request: TRequest): Promise<UserPluginManagerHostResult<TRequest>>;
}

export async function executeUserPluginManagerHostRequest<TRequest extends UserPluginManagerHostRequest>(
    request: TRequest
): Promise<UserPluginManagerHostResult<TRequest>> {
    let result: unknown;
    switch (request.action) {
        case "ensure-installed-root":
            await mkdir(request.installedRoot, { recursive: true });
            break;
        case "digest-installed-destination": {
            const path = await resolveContainedExistingPath(request.installedRoot, request.destination);
            result = await computePathDigest(path);
            break;
        }
        case "collect-inventory": {
            const inventory: HostInventoryEntry[] = [];
            for (const entry of await readdir(request.installedRoot, { withFileTypes: true })) {
                if (entry.name === "_shared" || (!entry.isDirectory() && !entry.isFile())) continue;
                inventory.push({
                    destination: entry.name,
                    contentDigest: await computePathDigest(join(request.installedRoot, entry.name))
                });
            }
            result = inventory.sort((left, right) => left.destination.localeCompare(right.destination));
            break;
        }
        case "apply-transaction":
            await mkdir(request.plan.installedRoot, { recursive: true });
            result = await applyTransaction(request.plan);
            break;
        case "acknowledge-build":
            result = await acknowledgeTransactionBuild(request.journalPath, request.succeeded);
            break;
        case "rollback-for-recovery":
            result = await rollbackTransactionForRecovery(request.journalPath);
            break;
        case "complete-recovery-build":
            result = await completeRecoveryBuild(request.journalPath, request.succeeded);
            break;
        case "complete-commit":
            await completeTransactionCommit(request.journalPath);
            break;
        case "inspect-recovery":
            result = await inspectTransactionRecovery(request.journalPath);
            break;
    }
    return result as UserPluginManagerHostResult<TRequest>;
}

export function createLocalUserPluginManagerHost(): UserPluginManagerHost {
    return { execute: executeUserPluginManagerHostRequest };
}

interface HostRunnerError {
    code?: string;
    message: string;
    name?: string;
}

type HostRunnerResponse =
    | { ok: true; value?: unknown; }
    | { ok: false; error: HostRunnerError; };

function parseHostRunnerResponse(stdout: string): HostRunnerResponse {
    let candidate: unknown;
    try {
        candidate = JSON.parse(stdout);
    } catch {
        throw new Error("Malformed User Plugin Manager host response");
    }

    if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate)) {
        throw new Error("Malformed User Plugin Manager host response");
    }

    const response = candidate as Record<string, unknown>;
    if (response.ok === true) return { ok: true, value: response.value };
    if (response.ok !== false || response.error === null || typeof response.error !== "object" || Array.isArray(response.error)) {
        throw new Error("Malformed User Plugin Manager host response");
    }

    const error = response.error as Record<string, unknown>;
    if (
        typeof error.message !== "string"
        || (error.code !== undefined && typeof error.code !== "string")
        || (error.name !== undefined && typeof error.name !== "string")
    ) {
        throw new Error("Malformed User Plugin Manager host response");
    }

    return {
        ok: false,
        error: {
            code: error.code as string | undefined,
            message: error.message,
            name: error.name as string | undefined
        }
    };
}

export function createFlatpakUserPluginManagerHost(
    dataRoot: string,
    runnerPath: string,
    timeoutMs = DEFAULT_HOST_RUNNER_TIMEOUT_MS
): UserPluginManagerHost {
    return {
        async execute<TRequest extends UserPluginManagerHostRequest>(request: TRequest): Promise<UserPluginManagerHostResult<TRequest>> {
            await mkdir(dataRoot, { recursive: true });
            const runnerRoot = await mkdtemp(join(dataRoot, ".host-runner-"));
            const materializedRunnerPath = join(runnerRoot, "userPluginManagerHost.cjs");
            try {
                await copyFile(runnerPath, materializedRunnerPath);
                const stdout = await executeFlatpakHostRunner(materializedRunnerPath, JSON.stringify(request), timeoutMs);
                const response = parseHostRunnerResponse(stdout);
                if (!response.ok) {
                    const error = new Error(response.error.message);
                    error.name = response.error.name ?? "UserPluginManagerHostError";
                    if (response.error.code) Object.assign(error, { code: response.error.code });
                    throw error;
                }
                return response.value as UserPluginManagerHostResult<TRequest>;
            } finally {
                await rm(runnerRoot, { recursive: true, force: true });
            }
        }
    };
}

export async function runUserPluginManagerHostRequest(input: string): Promise<HostRunnerResponse> {
    try {
        const request = JSON.parse(input) as UserPluginManagerHostRequest;
        return { ok: true, value: await executeUserPluginManagerHostRequest(request) };
    } catch (error) {
        const candidate = error as { code?: unknown; message?: unknown; name?: unknown; };
        return {
            ok: false,
            error: {
                code: typeof candidate.code === "string" ? candidate.code : undefined,
                message: typeof candidate.message === "string" ? candidate.message : "User Plugin Manager host operation failed",
                name: typeof candidate.name === "string" ? candidate.name : undefined
            }
        };
    }
}

function executeFlatpakHostRunner(runnerPath: string, input: string, timeoutMs: number): Promise<string> {
    const { promise, resolve, reject } = Promise.withResolvers<string>();
    const child = spawn(
        "flatpak-spawn",
        ["--host", "node", runnerPath],
        { stdio: ["pipe", "pipe", "pipe"] }
    );
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;

    const fail = (error: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        child.kill();
        reject(error);
    };
    const timeout = setTimeout(
        () => fail(new Error("User Plugin Manager host process timed out")),
        timeoutMs
    );
    timeout.unref();

    child.stdout.on("data", (chunk: Buffer) => {
        stdoutBytes += chunk.byteLength;
        if (stdoutBytes > MAX_HOST_RESPONSE_BYTES) {
            fail(new Error("User Plugin Manager host response exceeded 1 MiB"));
            return;
        }
        stdout.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
        stderrBytes += chunk.byteLength;
        if (stderrBytes > MAX_HOST_RESPONSE_BYTES) {
            fail(new Error("User Plugin Manager host error output exceeded 1 MiB"));
            return;
        }
        stderr.push(chunk);
    });
    child.once("error", fail);
    child.stdin.once("error", fail);
    child.once("close", (code, signal) => {
        if (settled) return;
        clearTimeout(timeout);
        settled = true;
        if (code !== 0) {
            const detail = Buffer.concat(stderr).toString("utf8").trim();
            reject(new Error(
                `User Plugin Manager host process failed (${signal ?? `exit ${code ?? "unknown"}`})${detail ? `: ${detail}` : ""}`
            ));
            return;
        }
        resolve(Buffer.concat(stdout).toString("utf8"));
    });
    child.stdin.end(input);
    return promise;
}
