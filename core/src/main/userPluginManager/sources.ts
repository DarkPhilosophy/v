/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
    copyFile,
    lstat,
    mkdir,
    readdir,
    readFile,
    rm,
    stat,
    writeFile
} from "node:fs/promises";
import { basename, dirname, extname, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";

import type { SourceKind } from "@shared/userPluginManager";
import {
    assertAcquisitionLimits,
    assertSafeArchiveEntryPath,
    createDestinationSlug,
    MAX_ACQUISITION_EXPANDED_BYTES,
    MAX_ACQUISITION_REDIRECTS,
    redactSourceLocator,
    resolveContainedExistingPath,
    UserPluginManagerSafetyError
} from "@shared/userPluginManagerSafety";
import { gunzipSync, strFromU8, unzipSync } from "fflate";

import { computePathDigest } from "./transaction";

const execFileAsync = promisify(execFile);
const TEXT_DECODER = new TextDecoder("utf-8", { fatal: true });
const NESTED_ARCHIVE_EXTENSION = /\.(?:zip|tar|tgz|tar\.gz|gz)$/i;
const RELATIVE_IMPORT = /(?:\bfrom\s*|\bimport\s*\(|\brequire\s*\()\s*["']\.{1,2}\/(?:[^"']*)["']|\bimport\s*["']\.{1,2}\//;

export type SourceAcquisitionErrorCode =
    | "ACQUISITION_FAILED"
    | "HTTP_ERROR"
    | "LIMIT_EXCEEDED"
    | "STALE_INSPECTION"
    | "UNSAFE_SOURCE"
    | "UNSUPPORTED_ARCHIVE"
    | "UNSUPPORTED_SOURCE_SHAPE";

export type InspectedSourceShape = "single-file" | "plugin-root" | "collection";
export type InspectedEntryKind = "plugin" | "shared";

export interface SourceAcquisitionRequest {
    kind: SourceKind;
    locator: string;
    requestedRef?: string;
    subpath?: string;
    selectedSharedEntries?: readonly string[];
}

export interface SourceAcquisitionOptions {
    operationRoot: string;
    fetchImpl?: typeof fetch;
}

export interface InspectedSourceEntry {
    kind: InspectedEntryKind;
    sourcePath: string;
    destination: string;
    contentDigest: string;
}

export interface SourceInspection {
    kind: SourceKind;
    locator: string;
    requestedRef?: string;
    resolvedRevision: string;
    stagedRoot: string;
    shape: InspectedSourceShape;
    entries: InspectedSourceEntry[];
    contentDigest: string;
    inspectionToken: string;
}

interface StagedAcquisition {
    root: string;
    resolvedRevision?: string;
    rootDisplayName?: string;
    flattenArchiveWrapper: boolean;
}

interface FileManifestEntry {
    absolutePath: string;
    relativePath: string;
    bytes: number;
}

interface ArchiveEntry {
    path: string;
    data: Uint8Array;
}

export class SourceAcquisitionError extends Error {
    constructor(public readonly code: SourceAcquisitionErrorCode, message: string) {
        super(message);
        this.name = "SourceAcquisitionError";
    }
}

export async function acquireAndInspectSource(
    request: SourceAcquisitionRequest,
    options: SourceAcquisitionOptions
): Promise<SourceInspection> {
    const operationRoot = await resolveContainedExistingPath(options.operationRoot, options.operationRoot);
    const acquisitionRoot = join(operationRoot, `source-${randomUUID()}`);
    await mkdir(acquisitionRoot);

    try {
        const acquisition = await acquireSource(request, acquisitionRoot, options.fetchImpl ?? fetch);
        let inspectionRoot = request.subpath
            ? await resolveContainedExistingPath(acquisition.root, request.subpath)
            : acquisition.root;
        if (acquisition.flattenArchiveWrapper) inspectionRoot = await stripArchiveWrapper(inspectionRoot);

        const inspection = await inspectStagedSource(
            inspectionRoot,
            request.selectedSharedEntries ?? [],
            acquisition.rootDisplayName
        );
        const contentDigest = await digestTree(inspectionRoot);
        return {
            kind: request.kind,
            locator: redactSourceLocator(request.locator),
            requestedRef: request.requestedRef,
            resolvedRevision: acquisition.resolvedRevision ?? contentDigest,
            stagedRoot: inspectionRoot,
            shape: inspection.shape,
            entries: inspection.entries,
            contentDigest,
            inspectionToken: contentDigest
        };
    } catch (error) {
        await rm(acquisitionRoot, { recursive: true, force: true });
        if (error instanceof SourceAcquisitionError) throw error;
        if (error instanceof UserPluginManagerSafetyError) {
            const code = error.code === "LIMIT_EXCEEDED" ? "LIMIT_EXCEEDED" : "UNSAFE_SOURCE";
            throw new SourceAcquisitionError(code, error.message);
        }
        throw new SourceAcquisitionError("ACQUISITION_FAILED", "Source acquisition failed");
    }
}

export async function verifyInspectionToken(inspection: SourceInspection): Promise<void> {
    let currentDigest: string;
    try {
        currentDigest = await digestTree(inspection.stagedRoot);
    } catch {
        throw new SourceAcquisitionError("STALE_INSPECTION", "Inspected source staging is no longer available");
    }
    if (currentDigest !== inspection.inspectionToken || currentDigest !== inspection.contentDigest) {
        throw new SourceAcquisitionError("STALE_INSPECTION", "Inspected source content changed before Apply");
    }
}

async function acquireSource(
    request: SourceAcquisitionRequest,
    acquisitionRoot: string,
    fetchImpl: typeof fetch
): Promise<StagedAcquisition> {
    switch (request.kind) {
        case "local-file":
        case "local-directory":
            return acquireLocalSource(request, acquisitionRoot);
        case "git":
            return acquireGitSource(request, acquisitionRoot);
        case "http-file":
        case "http-archive":
            return acquireHttpSource(request, acquisitionRoot, fetchImpl);
    }
}

async function acquireLocalSource(
    request: SourceAcquisitionRequest,
    acquisitionRoot: string
): Promise<StagedAcquisition> {
    const sourcePath = resolve(request.locator);
    const sourceStats = await lstat(sourcePath);
    const payloadRoot = join(acquisitionRoot, "payload");
    await mkdir(payloadRoot);

    if (request.kind === "local-file") {
        if (!sourceStats.isFile()) {
            throw new SourceAcquisitionError("UNSUPPORTED_SOURCE_SHAPE", "Local file source is not a regular file");
        }
        if (!/\.tsx?$/i.test(sourcePath)) {
            throw new SourceAcquisitionError("UNSUPPORTED_SOURCE_SHAPE", "Direct plugin sources must be .ts or .tsx files");
        }
        assertAcquisitionLimits({ files: [{ path: basename(sourcePath), bytes: sourceStats.size }] });
        await copyFile(sourcePath, join(payloadRoot, basename(sourcePath)));
        return { root: join(payloadRoot, basename(sourcePath)), flattenArchiveWrapper: false };
    }

    if (!sourceStats.isDirectory()) {
        throw new SourceAcquisitionError("UNSUPPORTED_SOURCE_SHAPE", "Local directory source is not a directory");
    }
    await copySourceTree(sourcePath, payloadRoot);
    return { root: payloadRoot, rootDisplayName: basename(sourcePath), flattenArchiveWrapper: false };
}

async function execGit(
    operation: string,
    args: string[],
    env?: NodeJS.ProcessEnv
) {
    const useFlatpakHost = process.platform === "linux" && Boolean(process.env.FLATPAK_ID);
    const command = useFlatpakHost ? "flatpak-spawn" : "git";
    const commandArgs = useFlatpakHost ? ["--host", "git", ...args] : args;
    try {
        return await execFileAsync(command, commandArgs, { encoding: "utf8", ...(env == null ? {} : { env }) });
    } catch (error) {
        const { code } = (error as NodeJS.ErrnoException & { code?: string | number; });
        if (code === "ENOENT") {
            throw new SourceAcquisitionError(
                "ACQUISITION_FAILED",
                useFlatpakHost ? "Flatpak host bridge is unavailable" : "Git executable is unavailable"
            );
        }
        const exitSuffix = typeof code === "number" ? ` (exit ${code})` : "";
        throw new SourceAcquisitionError(
            "ACQUISITION_FAILED",
            `${useFlatpakHost ? "Flatpak host Git" : "Git"} ${operation} failed${exitSuffix}`
        );
    }
}

function deriveGitSourceDisplayName(locator: string): string {
    let sourcePath = locator;
    try {
        sourcePath = new URL(locator).pathname;
    } catch {
        // Local paths and scp-style Git locators are handled below.
    }
    const segment = sourcePath
        .replace(/[\\/]+$/, "")
        .split(/[\\/:]/)
        .filter(Boolean)
        .at(-1)
        ?.replace(/\.git$/i, "");
    return segment || "repository";
}

async function acquireGitSource(
    request: SourceAcquisitionRequest,
    acquisitionRoot: string
): Promise<StagedAcquisition> {
    const repositoryRoot = join(acquisitionRoot, "repository");
    await execGit("clone", [
        "-c", "protocol.file.allow=always",
        "clone",
        "--no-checkout",
        "--no-recurse-submodules",
        "--config", "core.hooksPath=/dev/null",
        "--",
        request.locator,
        repositoryRoot
    ], { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_LFS_SKIP_SMUDGE: "1" });

    const requestedRef = request.requestedRef ?? "HEAD";
    const { stdout } = await execGit("resolve ref", [
        "-C", repositoryRoot,
        "rev-parse", "--verify", "--end-of-options", `${requestedRef}^{commit}`
    ]);
    const resolvedRevision = stdout.trim();
    if (!/^[0-9a-f]{40,64}$/i.test(resolvedRevision)) {
        throw new SourceAcquisitionError("ACQUISITION_FAILED", "Git source did not resolve to a commit");
    }
    await execGit("checkout", [
        "-C", repositoryRoot,
        "-c", "core.hooksPath=/dev/null",
        "checkout", "--detach", "--force", resolvedRevision, "--"
    ], { ...process.env, GIT_LFS_SKIP_SMUDGE: "1" });

    try {
        await stat(join(repositoryRoot, ".gitmodules"));
        throw new SourceAcquisitionError("UNSUPPORTED_SOURCE_SHAPE", "Git submodules are unsupported");
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await rejectGitLfsPointers(repositoryRoot);
    await rm(join(repositoryRoot, ".git"), { recursive: true, force: true });
    const manifest = await collectSourceManifest(repositoryRoot);
    assertAcquisitionLimits({ files: manifest.map(file => ({ path: file.relativePath, bytes: file.bytes })) });
    return {
        root: repositoryRoot,
        resolvedRevision,
        rootDisplayName: deriveGitSourceDisplayName(request.locator),
        flattenArchiveWrapper: false
    };
}

async function acquireHttpSource(
    request: SourceAcquisitionRequest,
    acquisitionRoot: string,
    fetchImpl: typeof fetch
): Promise<StagedAcquisition> {
    const response = await fetchWithRedirectLimit(request.locator, fetchImpl);
    const payload = await readBoundedResponse(response);
    const payloadRoot = join(acquisitionRoot, "payload");
    await mkdir(payloadRoot);

    if (request.kind === "http-file") {
        const urlPath = new URL(response.url || redactSourceLocator(request.locator)).pathname;
        const filename = basename(urlPath);
        if (!/\.tsx?$/i.test(filename)) {
            throw new SourceAcquisitionError("UNSUPPORTED_SOURCE_SHAPE", "HTTP file sources must resolve to a .ts or .tsx file");
        }
        assertAcquisitionLimits({ responseBytes: payload.byteLength, files: [{ path: filename, bytes: payload.byteLength }] });
        const destination = join(payloadRoot, filename);
        await writeFile(destination, payload);
        return { root: destination, flattenArchiveWrapper: false };
    }

    const entries = extractArchive(payload, response.url || request.locator, response.headers.get("content-type"));
    assertAcquisitionLimits({
        responseBytes: payload.byteLength,
        files: entries.map(entry => ({ path: entry.path, bytes: entry.data.byteLength }))
    });
    rejectNestedArchives(entries);
    for (const entry of entries) {
        const destination = join(payloadRoot, ...entry.path.split("/"));
        await mkdir(dirname(destination), { recursive: true });
        await writeFile(destination, entry.data);
    }
    return { root: payloadRoot, flattenArchiveWrapper: true };
}

async function fetchWithRedirectLimit(locator: string, fetchImpl: typeof fetch): Promise<Response> {
    const initial = new URL(locator);
    const { username } = initial;
    const { password } = initial;
    initial.username = "";
    initial.password = "";
    let current = initial;
    let authorization = username || password
        ? `Basic ${Buffer.from(`${decodeURIComponent(username)}:${decodeURIComponent(password)}`).toString("base64")}`
        : undefined;

    for (let redirects = 0; ; redirects++) {
        assertAcquisitionLimits({ redirects });
        let response: Response;
        try {
            response = await fetchImpl(current, {
                redirect: "manual",
                headers: authorization ? { authorization } : undefined
            });
        } catch {
            throw new SourceAcquisitionError("HTTP_ERROR", "HTTP source request failed");
        }
        if (![301, 302, 303, 307, 308].includes(response.status)) {
            if (!response.ok) throw new SourceAcquisitionError("HTTP_ERROR", `HTTP source returned status ${response.status}`);
            return response;
        }

        if (redirects >= MAX_ACQUISITION_REDIRECTS) {
            throw new SourceAcquisitionError("LIMIT_EXCEEDED", `Redirect limit is ${MAX_ACQUISITION_REDIRECTS}`);
        }
        const location = response.headers.get("location");
        if (!location) throw new SourceAcquisitionError("HTTP_ERROR", "HTTP redirect did not include a location");
        const next = new URL(location, current);
        if (next.origin !== current.origin) authorization = undefined;
        current = next;
    }
}

async function readBoundedResponse(response: Response): Promise<Uint8Array> {
    const declaredLength = response.headers.get("content-length");
    if (declaredLength !== null) {
        const bytes = Number(declaredLength);
        assertAcquisitionLimits({ responseBytes: bytes });
    }
    if (!response.body) return new Uint8Array();

    const chunks: Uint8Array[] = [];
    let total = 0;
    const reader = response.body.getReader();
    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        assertAcquisitionLimits({ responseBytes: total });
        chunks.push(value);
    }
    const payload = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
        payload.set(chunk, offset);
        offset += chunk.byteLength;
    }
    return payload;
}

function extractArchive(payload: Uint8Array, locator: string, contentType: string | null): ArchiveEntry[] {
    if (isZip(payload) || /(?:\.zip)(?:$|[?#])/i.test(locator) || /^(?:application|multipart)\/(?:[^;]+\+)?zip(?:;|$)/i.test(contentType ?? "")) {
        validateZipCentralDirectory(payload);
        let unzipped: Record<string, Uint8Array>;
        try {
            unzipped = unzipSync(payload);
        } catch {
            throw new SourceAcquisitionError("UNSUPPORTED_ARCHIVE", "ZIP archive is malformed or unsupported");
        }
        const entries = Object.entries(unzipped)
            .filter(([path]) => !path.endsWith("/"))
            .map(([path, data]) => ({ path: assertSafeArchiveEntryPath(path), data }));
        assertAcquisitionLimits({ files: entries.map(entry => ({ path: entry.path, bytes: entry.data.byteLength })) });
        return entries;
    }

    let tarPayload = payload;
    if (isGzip(payload) || /(?:\.tar\.gz|\.tgz|\.gz)(?:$|[?#])/i.test(locator) || contentType?.includes("gzip")) {
        if (payload.byteLength < 18) {
            throw new SourceAcquisitionError("UNSUPPORTED_ARCHIVE", "GZIP archive is truncated");
        }
        const declaredExpandedBytes = new DataView(payload.buffer, payload.byteOffset, payload.byteLength)
            .getUint32(payload.byteLength - 4, true);
        if (declaredExpandedBytes > MAX_ACQUISITION_EXPANDED_BYTES) {
            throw new SourceAcquisitionError("LIMIT_EXCEEDED", "GZIP expanded size exceeds the acquisition limit");
        }
        try {
            tarPayload = gunzipSync(payload);
        } catch {
            throw new SourceAcquisitionError("UNSUPPORTED_ARCHIVE", "GZIP archive is malformed or unsupported");
        }
        assertAcquisitionLimits({ expandedBytes: tarPayload.byteLength });
    }
    if (isTar(tarPayload) || /(?:\.tar)(?:$|[?#])/i.test(locator)) return extractTar(tarPayload);
    throw new SourceAcquisitionError("UNSUPPORTED_ARCHIVE", "Archive format is unsupported");
}

function validateZipCentralDirectory(payload: Uint8Array): void {
    const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
    let endOffset = -1;
    const minimum = Math.max(0, payload.byteLength - 65_557);
    for (let offset = payload.byteLength - 22; offset >= minimum; offset--) {
        if (view.getUint32(offset, true) === 0x06054b50) {
            endOffset = offset;
            break;
        }
    }
    if (endOffset < 0) throw new SourceAcquisitionError("UNSUPPORTED_ARCHIVE", "ZIP end record is missing");

    const entryCount = view.getUint16(endOffset + 10, true);
    const centralSize = view.getUint32(endOffset + 12, true);
    const centralOffset = view.getUint32(endOffset + 16, true);
    if (centralOffset + centralSize > endOffset) {
        throw new SourceAcquisitionError("UNSUPPORTED_ARCHIVE", "ZIP central directory is out of bounds");
    }
    assertAcquisitionLimits({ files: Array.from({ length: entryCount }, (_, index) => ({ path: String(index), bytes: 0 })) });

    let offset = centralOffset;
    const limits: { path: string; bytes: number; }[] = [];
    for (let index = 0; index < entryCount; index++) {
        if (offset + 46 > payload.byteLength || view.getUint32(offset, true) !== 0x02014b50) {
            throw new SourceAcquisitionError("UNSUPPORTED_ARCHIVE", "ZIP central entry is malformed");
        }
        const flags = view.getUint16(offset + 8, true);
        const compression = view.getUint16(offset + 10, true);
        const expandedBytes = view.getUint32(offset + 24, true);
        const filenameLength = view.getUint16(offset + 28, true);
        const extraLength = view.getUint16(offset + 30, true);
        const commentLength = view.getUint16(offset + 32, true);
        const externalAttributes = view.getUint32(offset + 38, true);
        const nextOffset = offset + 46 + filenameLength + extraLength + commentLength;
        if (nextOffset > payload.byteLength || (flags & 1) !== 0 || ![0, 8].includes(compression)) {
            throw new SourceAcquisitionError("UNSUPPORTED_ARCHIVE", "Encrypted or unsupported ZIP entry detected");
        }
        if (((externalAttributes >>> 16) & 0o170000) === 0o120000) {
            throw new SourceAcquisitionError("UNSAFE_SOURCE", "ZIP symlink entries are unsupported");
        }
        let filename: string;
        try {
            filename = TEXT_DECODER.decode(payload.subarray(offset + 46, offset + 46 + filenameLength));
        } catch {
            throw new SourceAcquisitionError("UNSUPPORTED_ARCHIVE", "ZIP filename is not valid UTF-8");
        }
        const path = assertSafeArchiveEntryPath(filename);
        if (!filename.endsWith("/")) limits.push({ path, bytes: expandedBytes });
        offset = nextOffset;
    }
    if (offset !== centralOffset + centralSize) {
        throw new SourceAcquisitionError("UNSUPPORTED_ARCHIVE", "ZIP central directory length is inconsistent");
    }
    assertAcquisitionLimits({ files: limits });
}

function extractTar(payload: Uint8Array): ArchiveEntry[] {
    const entries: ArchiveEntry[] = [];
    let offset = 0;
    while (offset + 512 <= payload.byteLength) {
        const header = payload.subarray(offset, offset + 512);
        if (header.every(byte => byte === 0)) break;
        const storedChecksum = parseTarOctal(header.subarray(148, 156));
        const checksum = header.reduce((total, byte, index) => {
            return total + (index >= 148 && index < 156 ? 0x20 : byte);
        }, 0);
        if (storedChecksum !== checksum) {
            throw new SourceAcquisitionError("UNSUPPORTED_ARCHIVE", "TAR header checksum is invalid");
        }
        const name = readTarString(header.subarray(0, 100));
        const prefix = readTarString(header.subarray(345, 500));
        const path = assertSafeArchiveEntryPath(prefix ? `${prefix}/${name}` : name);
        const bytes = parseTarOctal(header.subarray(124, 136));
        const type = header[156];
        const dataOffset = offset + 512;
        const nextOffset = dataOffset + Math.ceil(bytes / 512) * 512;
        if (nextOffset > payload.byteLength) {
            throw new SourceAcquisitionError("UNSUPPORTED_ARCHIVE", "TAR entry exceeds archive bounds");
        }
        if (type === 0 || type === 0x30) entries.push({ path, data: payload.slice(dataOffset, dataOffset + bytes) });
        else if (type !== 0x35) {
            throw new SourceAcquisitionError("UNSAFE_SOURCE", "TAR links and extended entry types are unsupported");
        }
        offset = nextOffset;
    }
    assertAcquisitionLimits({ files: entries.map(entry => ({ path: entry.path, bytes: entry.data.byteLength })) });
    return entries;
}

async function copySourceTree(sourceRoot: string, destinationRoot: string): Promise<void> {
    const manifest = await collectSourceManifest(sourceRoot);
    assertAcquisitionLimits({ files: manifest.map(file => ({ path: file.relativePath, bytes: file.bytes })) });
    rejectNestedArchives(await Promise.all(manifest.map(async file => ({
        path: file.relativePath,
        data: await readFile(file.absolutePath)
    }))));
    for (const file of manifest) {
        const destination = join(destinationRoot, ...file.relativePath.split("/"));
        await mkdir(dirname(destination), { recursive: true });
        await copyFile(file.absolutePath, destination);
    }
}

async function collectSourceManifest(root: string): Promise<FileManifestEntry[]> {
    const rootStats = await lstat(root);
    if (rootStats.isSymbolicLink()) throw new SourceAcquisitionError("UNSAFE_SOURCE", "Source symlinks are unsupported");
    if (rootStats.isFile()) return [{ absolutePath: root, relativePath: basename(root), bytes: rootStats.size }];
    if (!rootStats.isDirectory()) throw new SourceAcquisitionError("UNSAFE_SOURCE", "Source contains a special filesystem entry");

    const manifest: FileManifestEntry[] = [];
    const pending = [root];
    while (pending.length) {
        const directory = pending.pop()!;
        const entries = await readdir(directory, { withFileTypes: true });
        entries.sort((left, right) => left.name.localeCompare(right.name));
        for (const entry of entries) {
            if (entry.name === ".git" || entry.name === "node_modules") continue;
            const absolutePath = join(directory, entry.name);
            const entryStats = await lstat(absolutePath);
            if (entryStats.isSymbolicLink()) {
                throw new SourceAcquisitionError("UNSAFE_SOURCE", "Source symlinks are unsupported");
            }
            if (entryStats.isDirectory()) pending.push(absolutePath);
            else if (entryStats.isFile()) {
                manifest.push({
                    absolutePath,
                    relativePath: relative(root, absolutePath).split(sep).join("/"),
                    bytes: entryStats.size
                });
            } else {
                throw new SourceAcquisitionError("UNSAFE_SOURCE", "Source contains a special filesystem entry");
            }
        }
    }
    manifest.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
    return manifest;
}

async function inspectStagedSource(
    root: string,
    selectedSharedEntries: readonly string[],
    rootDisplayName?: string
): Promise<{ shape: InspectedSourceShape; entries: InspectedSourceEntry[]; }> {
    const rootStats = await lstat(root);
    if (rootStats.isFile()) {
        if (!/\.tsx?$/i.test(root)) throw new SourceAcquisitionError("UNSUPPORTED_SOURCE_SHAPE", "Direct source is not TypeScript");
        const source = await readFile(root, "utf8");
        if (RELATIVE_IMPORT.test(source)) {
            throw new SourceAcquisitionError("UNSUPPORTED_SOURCE_SHAPE", "Direct file source contains a relative import");
        }
        const destination = createDestinationSlug(basename(root, extname(root)));
        return {
            shape: "single-file",
            entries: [{ kind: "plugin", sourcePath: basename(root), destination, contentDigest: digestBytes(Buffer.from(source)) }]
        };
    }

    const rootIndex = await findPluginIndex(root);
    if (rootIndex) {
        const destination = createDestinationSlug(rootDisplayName ?? basename(root));
        return {
            shape: "plugin-root",
            entries: [{ kind: "plugin", sourcePath: ".", destination, contentDigest: await digestTree(root) }]
        };
    }

    const children = await readdir(root, { withFileTypes: true });
    const pluginDirectories: string[] = [];
    for (const child of children) {
        if (child.name === "_shared" || !child.isDirectory()) continue;
        if (await findPluginIndex(join(root, child.name))) pluginDirectories.push(child.name);
    }
    pluginDirectories.sort((left, right) => left.localeCompare(right));
    if (pluginDirectories.length === 0) {
        throw new SourceAcquisitionError("UNSUPPORTED_SOURCE_SHAPE", "Source contains neither a plugin root nor a plugin collection");
    }

    const destinations: string[] = [];
    const entries: InspectedSourceEntry[] = [];
    for (const pluginDirectory of pluginDirectories) {
        const destination = createDestinationSlug(pluginDirectory, destinations);
        destinations.push(destination);
        entries.push({
            kind: "plugin",
            sourcePath: pluginDirectory,
            destination,
            contentDigest: await digestTree(join(root, pluginDirectory))
        });
    }

    for (const selected of [...selectedSharedEntries].sort((left, right) => left.localeCompare(right))) {
        if (selected === "" || selected.includes("/") || selected.includes("\\") || selected === "." || selected === "..") {
            throw new SourceAcquisitionError("UNSAFE_SOURCE", "Selected shared entry must be a direct child of _shared");
        }
        const sharedPath = await resolveContainedExistingPath(join(root, "_shared"), selected);
        entries.push({
            kind: "shared",
            sourcePath: `_shared/${selected}`,
            destination: `_shared/${selected}`,
            contentDigest: await digestTree(sharedPath)
        });
    }
    return { shape: "collection", entries };
}

async function findPluginIndex(root: string): Promise<string | undefined> {
    const matches: string[] = [];
    for (const filename of ["index.ts", "index.tsx"]) {
        try {
            const fileStats = await lstat(join(root, filename));
            if (fileStats.isSymbolicLink()) throw new SourceAcquisitionError("UNSAFE_SOURCE", "Plugin index symlinks are unsupported");
            if (fileStats.isFile()) matches.push(filename);
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
    }
    if (matches.length > 1) {
        throw new SourceAcquisitionError("UNSUPPORTED_SOURCE_SHAPE", "Plugin root has both index.ts and index.tsx");
    }
    return matches[0];
}

async function stripArchiveWrapper(root: string): Promise<string> {
    const entries = await readdir(root, { withFileTypes: true });
    if (entries.length === 1 && entries[0].isDirectory()) {
        return resolveContainedExistingPath(root, entries[0].name);
    }
    return root;
}

async function digestTree(root: string): Promise<string> {
    const rootStats = await lstat(root);
    if (rootStats.isSymbolicLink()) throw new SourceAcquisitionError("UNSAFE_SOURCE", "Staged symlinks are unsupported");
    if (rootStats.isFile()) return digestBytes(await readFile(root));

    const manifest = await collectSourceManifest(root);
    assertAcquisitionLimits({ files: manifest.map(file => ({ path: file.relativePath, bytes: file.bytes })) });
    return computePathDigest(root);
}

async function rejectGitLfsPointers(root: string): Promise<void> {
    const manifest = await collectSourceManifest(root);
    for (const file of manifest) {
        if (file.bytes > 1_024) continue;
        const prefix = await readFile(file.absolutePath, "utf8");
        if (prefix.startsWith("version https://git-lfs.github.com/spec/v1\n")) {
            throw new SourceAcquisitionError("UNSUPPORTED_SOURCE_SHAPE", "Git LFS sources are unsupported");
        }
    }
}

function rejectNestedArchives(entries: readonly ArchiveEntry[]): void {
    for (const entry of entries) {
        if (NESTED_ARCHIVE_EXTENSION.test(entry.path) || isZip(entry.data) || isGzip(entry.data) || isTar(entry.data)) {
            throw new SourceAcquisitionError("UNSUPPORTED_ARCHIVE", "Nested archives are unsupported");
        }
    }
}

function digestBytes(bytes: Uint8Array): string {
    return createHash("sha256").update("file\0").update(bytes).digest("hex");
}

function isZip(payload: Uint8Array): boolean {
    return payload.byteLength >= 4
        && payload[0] === 0x50
        && payload[1] === 0x4b
        && [0x03, 0x05, 0x07].includes(payload[2])
        && [0x04, 0x06, 0x08].includes(payload[3]);
}

function isGzip(payload: Uint8Array): boolean {
    return payload.byteLength >= 2 && payload[0] === 0x1f && payload[1] === 0x8b;
}

function isTar(payload: Uint8Array): boolean {
    return payload.byteLength >= 512 && strFromU8(payload.subarray(257, 262)) === "ustar";
}

function parseTarOctal(bytes: Uint8Array): number {
    const value = readTarString(bytes).trim();
    if (!/^[0-7]*$/.test(value)) throw new SourceAcquisitionError("UNSUPPORTED_ARCHIVE", "TAR numeric field is invalid");
    const parsed = value === "" ? 0 : Number.parseInt(value, 8);
    if (!Number.isSafeInteger(parsed)) throw new SourceAcquisitionError("LIMIT_EXCEEDED", "TAR numeric field exceeds safe limits");
    return parsed;
}

function readTarString(bytes: Uint8Array): string {
    const end = bytes.indexOf(0);
    const content = end < 0 ? bytes : bytes.subarray(0, end);
    try {
        return TEXT_DECODER.decode(content);
    } catch {
        throw new SourceAcquisitionError("UNSUPPORTED_ARCHIVE", "TAR text field is not valid UTF-8");
    }
}
