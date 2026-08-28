/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { app, dialog, IpcMainInvokeEvent, safeStorage } from "electron";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

import { getUploadError, parseUploadFile, POO_WANG_BASE_URL, type PooWangUploadResult } from "./shared";

const TOKEN_PATH = () => join(app.getPath("userData"), "Vencord", "poo-wang-token.bin");
const uploadProgress = new Map<string, UploadProgress>();

export interface UploadInput {
    uploadId: string;
    name: string;
    type: string;
    data: Uint8Array;
    burnMode: string;
}

export interface UploadProgress {
    uploaded: number;
    total: number;
    state: "uploading" | "complete" | "error";
}

export interface PickedUploadFile {
    name: string;
    data: Uint8Array;
}

async function readAccessToken(): Promise<string | undefined> {
    const environmentToken = process.env.POO_WANG_ACCESS_TOKEN?.trim();
    if (environmentToken) return environmentToken;
    if (!safeStorage.isEncryptionAvailable()) return;

    try {
        const encrypted = await readFile(TOKEN_PATH());
        const token = safeStorage.decryptString(encrypted).trim();
        return token || undefined;
    } catch {
        return;
    }
}

export async function hasAccessToken(_: IpcMainInvokeEvent): Promise<boolean> {
    return Boolean(await readAccessToken());
}

export async function pickUploadFiles(_: IpcMainInvokeEvent): Promise<PickedUploadFile[]> {
    const result = await dialog.showOpenDialog({
        properties: ["openFile", "multiSelections"]
    });
    if (result.canceled) return [];

    return Promise.all(result.filePaths.map(async path => ({
        name: basename(path),
        data: new Uint8Array(await readFile(path))
    })));
}

export async function setAccessToken(_: IpcMainInvokeEvent, rawToken: string): Promise<{ ok: boolean; error?: string; }> {
    const token = rawToken.trim();
    try {
        if (!token) {
            await rm(TOKEN_PATH(), { force: true });
            return { ok: true };
        }
        if (!safeStorage.isEncryptionAvailable()) {
            return { ok: false, error: "Electron secure storage is unavailable on this system." };
        }

        const path = TOKEN_PATH();
        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, safeStorage.encryptString(token), { mode: 0o600 });
        await chmod(path, 0o600);
        return { ok: true };
    } catch (error) {
        return { ok: false, error: String(error) };
    }
}

export function getUploadProgress(_: IpcMainInvokeEvent, uploadId: string): UploadProgress | undefined {
    return uploadProgress.get(uploadId);
}

function quotedFilename(name: string): string {
    return name.replace(/["\\\r\n]/g, "_");
}

function safeContentType(type: string): string {
    return /^[A-Za-z0-9!#$&^_.+-]+\/[A-Za-z0-9!#$&^_.+-]+$/.test(type)
        ? type
        : "application/octet-stream";
}

async function uploadMultipart(input: UploadInput, token: string): Promise<{ status: number; payload: unknown; }> {
    const sourceSize = input.data.byteLength;
    if (sourceSize <= 0) throw new Error("The selected file is empty or unavailable.");

    const boundary = `----VencordPooWang${randomBytes(16).toString("hex")}`;
    const prefix = Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="files"; filename="${quotedFilename(input.name)}"\r\n`
        + `Content-Type: ${safeContentType(input.type)}\r\n\r\n`
    );
    const suffix = Buffer.from(
        `\r\n--${boundary}\r\nContent-Disposition: form-data; name="burnMode"\r\n\r\n${input.burnMode}`
        + `\r\n--${boundary}--\r\n`
    );
    const total = prefix.length + sourceSize + suffix.length;
    uploadProgress.set(input.uploadId, { uploaded: 0, total: sourceSize, state: "uploading" });

    const { promise, resolve, reject } = Promise.withResolvers<{ status: number; payload: unknown; }>();
    const req = request(new URL("/api/upload", POO_WANG_BASE_URL), {
        method: "POST",
        headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": `multipart/form-data; boundary=${boundary}`,
            "Content-Length": total
        }
    }, response => {
        const chunks: Buffer[] = [];
        let responseBytes = 0;
        response.on("data", (chunk: Buffer) => {
            responseBytes += chunk.length;
            if (responseBytes <= 1024 * 1024) chunks.push(chunk);
        });
        response.on("end", () => {
            try {
                const payload = responseBytes <= 1024 * 1024
                    ? JSON.parse(Buffer.concat(chunks).toString("utf8"))
                    : { error: "poo.wang returned an unexpectedly large response." };
                resolve({ status: response.statusCode ?? 0, payload });
            } catch {
                resolve({ status: response.statusCode ?? 0, payload: undefined });
            }
        });
    });
    req.on("error", reject);
    req.write(prefix);

    req.setTimeout(120_000, () => req.destroy(new Error("poo.wang upload timed out.")));
    const bytes = Buffer.from(input.data);
    const chunkSize = 256 * 1024;
    let uploaded = 0;
    for (let offset = 0; offset < bytes.length; offset += chunkSize) {
        const chunk = bytes.subarray(offset, Math.min(offset + chunkSize, bytes.length));
        if (!req.write(chunk)) await once(req, "drain");
        uploaded += chunk.length;
        uploadProgress.set(input.uploadId, { uploaded, total: sourceSize, state: "uploading" });
    }
    req.end(suffix);

    return promise;
}

export async function uploadFile(_: IpcMainInvokeEvent, input: UploadInput): Promise<PooWangUploadResult> {
    const token = await readAccessToken();
    if (!token) return { ok: false, status: 401, error: "Configure a poo.wang machine access token first." };

    try {
        const response = await uploadMultipart(input, token);
        if (response.status < 200 || response.status >= 300) {
            uploadProgress.set(input.uploadId, { ...uploadProgress.get(input.uploadId)!, state: "error" });
            return {
                ok: false,
                status: response.status,
                error: getUploadError(response.payload, `poo.wang upload failed (HTTP ${response.status}).`)
            };
        }

        const file = parseUploadFile(response.payload);
        uploadProgress.set(input.uploadId, { ...uploadProgress.get(input.uploadId)!, state: file ? "complete" : "error" });
        return file
            ? { ok: true, status: response.status, file }
            : { ok: false, status: response.status, error: "poo.wang returned an invalid upload response." };
    } catch (error) {
        const current = uploadProgress.get(input.uploadId) ?? { uploaded: 0, total: 0, state: "error" as const };
        uploadProgress.set(input.uploadId, { ...current, state: "error" });
        return { ok: false, status: 0, error: String(error) };
    } finally {
        setTimeout(() => uploadProgress.delete(input.uploadId), 5 * 60_000);
    }
}
