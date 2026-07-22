/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { lstat, realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

export const MAX_ACQUISITION_REDIRECTS = 5;
export const MAX_ACQUISITION_RESPONSE_BYTES = 25 * 1024 * 1024;
export const MAX_ACQUISITION_EXPANDED_BYTES = 100 * 1024 * 1024;
export const MAX_ACQUISITION_FILE_COUNT = 1_000;
export const MAX_ACQUISITION_FILE_BYTES = 10 * 1024 * 1024;
export const MAX_NESTED_ARCHIVE_DEPTH = 0;

export type UserPluginManagerSafetyErrorCode =
    | "UNSAFE_PATH"
    | "PATH_ESCAPE"
    | "INVALID_DESTINATION"
    | "DESTINATION_COLLISION"
    | "LIMIT_EXCEEDED"
    | "UNSAFE_CLEANUP";

export interface AcquisitionLimitsInput {
    redirects?: number;
    responseBytes?: number;
    expandedBytes?: number;
    nestedArchiveDepth?: number;
    files?: readonly {
        path: string;
        bytes: number;
    }[];
}

const SENSITIVE_KEY_PATTERN = /(?:^|[^a-z])(?:access[_-]?token|auth|authorization|credential|key|password|secret|signature|sig|token)(?:$|[^a-z])/i;
const SENSITIVE_COMPACT_KEY_PATTERN = /^(?:accessToken|authToken|apiKey|clientSecret|password|refreshToken|secret|signature|token)$/i;

export class UserPluginManagerSafetyError extends Error {
    constructor(public readonly code: UserPluginManagerSafetyErrorCode, message: string) {
        super(message);
        this.name = "UserPluginManagerSafetyError";
    }
}

export function assertSafeArchiveEntryPath(input: string): string {
    if (input.includes("\0")) {
        throw new UserPluginManagerSafetyError("UNSAFE_PATH", "Archive entry contains a NUL byte");
    }

    let decoded = input;
    for (let attempt = 0; attempt < 3; attempt++) {
        let next: string;
        try {
            next = decodeURIComponent(decoded);
        } catch {
            throw new UserPluginManagerSafetyError("UNSAFE_PATH", "Archive entry contains invalid percent encoding");
        }
        if (next === decoded) break;
        decoded = next;
    }

    const portablePath = decoded.replaceAll("\\", "/");
    if (
        portablePath.startsWith("/")
        || portablePath.startsWith("//")
        || /^[a-z]:\//i.test(portablePath)
        || /^\/?(?:\\\.|\\\?)(?:\/|$)/i.test(decoded)
    ) {
        throw new UserPluginManagerSafetyError("UNSAFE_PATH", "Archive entry uses an absolute or device path");
    }

    const segments = portablePath.split("/");
    if (segments.some(segment => segment === "..")) {
        throw new UserPluginManagerSafetyError("UNSAFE_PATH", "Archive entry traverses outside its root");
    }
    if (segments.every(segment => segment === "" || segment === ".")) {
        throw new UserPluginManagerSafetyError("UNSAFE_PATH", "Archive entry path is empty");
    }

    return segments.filter(segment => segment !== "" && segment !== ".").join("/");
}

export async function resolveContainedExistingPath(root: string, candidate: string): Promise<string> {
    if (candidate.includes("\0")) {
        throw new UserPluginManagerSafetyError("UNSAFE_PATH", "Filesystem path contains a NUL byte");
    }

    const canonicalRoot = await realpath(root);
    const canonicalCandidate = await realpath(isAbsolute(candidate) ? candidate : resolve(root, candidate));
    if (!isContainedPath(canonicalRoot, canonicalCandidate)) {
        throw new UserPluginManagerSafetyError("PATH_ESCAPE", "Filesystem path resolves outside its allowed root");
    }
    return canonicalCandidate;
}

export async function resolveContainedDestination(root: string, candidate: string): Promise<string> {
    if (candidate.includes("\0")) {
        throw new UserPluginManagerSafetyError("UNSAFE_PATH", "Filesystem path contains a NUL byte");
    }

    const canonicalRoot = await realpath(root);
    const absoluteCandidate = resolve(root, candidate);
    const lexicalRelation = relative(resolve(root), absoluteCandidate);
    if (lexicalRelation === ".." || lexicalRelation.startsWith(`..${sep}`) || isAbsolute(lexicalRelation)) {
        throw new UserPluginManagerSafetyError("PATH_ESCAPE", "Destination escapes its allowed root");
    }

    let existingAncestor = absoluteCandidate;
    while (true) {
        try {
            await lstat(existingAncestor);
            break;
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
            const parent = dirname(existingAncestor);
            if (parent === existingAncestor) {
                throw new UserPluginManagerSafetyError("PATH_ESCAPE", "Destination has no existing contained ancestor");
            }
            existingAncestor = parent;
        }
    }

    const canonicalAncestor = await realpath(existingAncestor);
    if (!isContainedPath(canonicalRoot, canonicalAncestor)) {
        throw new UserPluginManagerSafetyError("PATH_ESCAPE", "Destination parent resolves outside its allowed root");
    }
    return absoluteCandidate;
}

export function createDestinationSlug(displayName: string, existingSlugs: readonly string[] = []): string {
    const trimmed = displayName.trim();
    if (trimmed === "" || trimmed === "." || trimmed === ".." || /[\\/]/.test(trimmed)) {
        throw new UserPluginManagerSafetyError("INVALID_DESTINATION", "Destination name is empty, reserved, or contains a separator");
    }

    const slug = trimmed
        .normalize("NFKD")
        .replace(/[\u0300-\u036f]/g, "")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "");
    if (slug === "" || slug === "." || slug === "..") {
        throw new UserPluginManagerSafetyError("INVALID_DESTINATION", "Destination name has no safe normalized characters");
    }

    const normalizedExisting = existingSlugs.map(existing => existing.normalize("NFKC").toLowerCase());
    if (normalizedExisting.includes(slug.normalize("NFKC").toLowerCase())) {
        throw new UserPluginManagerSafetyError("DESTINATION_COLLISION", `Destination ${slug} already exists`);
    }
    return slug;
}

export function redactSourceLocator(locator: string): string {
    let url: URL;
    try {
        url = new URL(locator);
    } catch {
        return locator;
    }

    if (url.username !== "" || url.password !== "") {
        url.username = "";
        url.password = "";
    }
    for (const key of Array.from(url.searchParams.keys())) {
        if (SENSITIVE_KEY_PATTERN.test(key) || SENSITIVE_COMPACT_KEY_PATTERN.test(key)) {
            url.searchParams.set(key, "[REDACTED]");
        }
    }
    return url.toString();
}

export function redactSensitiveData<T>(value: T): T {
    if (typeof value === "string") return redactSourceLocator(value) as T;
    if (Array.isArray(value)) return value.map(item => redactSensitiveData(item)) as T;
    if (typeof value !== "object" || value === null) return value;

    const redacted: Record<string, unknown> = {};
    for (const [key, nestedValue] of Object.entries(value)) {
        redacted[key] = SENSITIVE_KEY_PATTERN.test(key) || SENSITIVE_COMPACT_KEY_PATTERN.test(key)
            ? "[REDACTED]"
            : redactSensitiveData(nestedValue);
    }
    return redacted as T;
}

export function assertAcquisitionLimits(input: AcquisitionLimitsInput): void {
    const redirects = input.redirects ?? 0;
    const responseBytes = input.responseBytes ?? 0;
    const files = input.files ?? [];
    const expandedBytes = input.expandedBytes ?? files.reduce((total, file) => total + file.bytes, 0);
    const nestedArchiveDepth = input.nestedArchiveDepth ?? 0;

    const observed = [redirects, responseBytes, expandedBytes, nestedArchiveDepth, ...files.map(file => file.bytes)];
    if (observed.some(value => !Number.isSafeInteger(value) || value < 0)) {
        throw new UserPluginManagerSafetyError("LIMIT_EXCEEDED", "Acquisition counters must be non-negative safe integers");
    }
    if (redirects > MAX_ACQUISITION_REDIRECTS) {
        throw new UserPluginManagerSafetyError("LIMIT_EXCEEDED", `Redirect limit is ${MAX_ACQUISITION_REDIRECTS}`);
    }
    if (responseBytes > MAX_ACQUISITION_RESPONSE_BYTES) {
        throw new UserPluginManagerSafetyError("LIMIT_EXCEEDED", `Response byte limit is ${MAX_ACQUISITION_RESPONSE_BYTES}`);
    }
    if (expandedBytes > MAX_ACQUISITION_EXPANDED_BYTES) {
        throw new UserPluginManagerSafetyError("LIMIT_EXCEEDED", `Expanded byte limit is ${MAX_ACQUISITION_EXPANDED_BYTES}`);
    }
    if (files.length > MAX_ACQUISITION_FILE_COUNT) {
        throw new UserPluginManagerSafetyError("LIMIT_EXCEEDED", `Expanded file-count limit is ${MAX_ACQUISITION_FILE_COUNT}`);
    }
    const oversizedFile = files.find(file => file.bytes > MAX_ACQUISITION_FILE_BYTES);
    if (oversizedFile) {
        throw new UserPluginManagerSafetyError(
            "LIMIT_EXCEEDED",
            `Expanded file ${oversizedFile.path} exceeds the per-file byte limit ${MAX_ACQUISITION_FILE_BYTES}`
        );
    }
    if (nestedArchiveDepth > MAX_NESTED_ARCHIVE_DEPTH) {
        throw new UserPluginManagerSafetyError("LIMIT_EXCEEDED", "Nested archives are unsupported");
    }
}

export async function resolveOperationCleanupPath(
    managerDataDirectory: string,
    operationRoot: string,
    target: string
): Promise<string> {
    const canonicalManagerData = await realpath(managerDataDirectory);
    const canonicalOperationRoot = await realpath(operationRoot);
    const operationRelation = relative(canonicalManagerData, canonicalOperationRoot);
    if (
        !operationRelation.startsWith(`operations${sep}`)
        || !isContainedPath(canonicalManagerData, canonicalOperationRoot)
    ) {
        throw new UserPluginManagerSafetyError("UNSAFE_CLEANUP", "Cleanup operation root is not manager-owned");
    }

    const canonicalTarget = await realpath(target);
    if (!isContainedPath(canonicalOperationRoot, canonicalTarget)) {
        throw new UserPluginManagerSafetyError("UNSAFE_CLEANUP", "Cleanup target is outside its operation root");
    }
    return canonicalTarget;
}

function isContainedPath(root: string, candidate: string): boolean {
    const relation = relative(root, candidate);
    return relation === "" || (!relation.startsWith(`..${sep}`) && relation !== ".." && !isAbsolute(relation));
}
