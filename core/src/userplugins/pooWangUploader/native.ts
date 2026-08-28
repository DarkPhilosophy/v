/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { app, IpcMainInvokeEvent, safeStorage } from "electron";
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { request } from "node:https";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { getUploadError, parseUploadFile, POO_WANG_BASE_URL, type PooWangUploadResult } from "./shared";

const TOKEN_PATH = () => join(app.getPath("userData"), "Vencord", "poo-wang-token.bin");
const SECRET_SERVICE_ATTRIBUTES = ["service", "poo.wang", "account", "vencord-uploader"];

function runSecretTool(args: string[], input?: string): Promise<string> {
    const { promise, resolve, reject } = Promise.withResolvers<string>();
    const isFlatpak = Boolean(process.env.FLATPAK_ID) || existsSync("/.flatpak-info");
    const command = isFlatpak ? "flatpak-spawn" : "secret-tool";
    const commandArgs = isFlatpak ? ["--host", "secret-tool", ...args] : args;
    const runtimeDirectory = process.env.XDG_RUNTIME_DIR ?? `/run/user/${process.getuid()}`;
    const child = spawn(command, commandArgs, {
        env: {
            ...process.env,
            DBUS_SESSION_BUS_ADDRESS: process.env.DBUS_SESSION_BUS_ADDRESS ?? `unix:path=${runtimeDirectory}/bus`
        },
        stdio: ["pipe", "pipe", "pipe"]
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", chunk => stdout.push(chunk));
    child.stderr.on("data", chunk => stderr.push(chunk));
    child.once("error", reject);
    child.once("close", code => {
        if (code === 0) resolve(Buffer.concat(stdout).toString("utf8"));
        else reject(new Error(Buffer.concat(stderr).toString("utf8").trim() || `${command} exited with ${code}`));
    });
    child.stdin.end(input);
    return promise;
}

async function readSecretServiceToken(): Promise<string | undefined> {
    try {
        const token = (await runSecretTool(["lookup", ...SECRET_SERVICE_ATTRIBUTES])).trim();
        return token || undefined;
    } catch {
        return;
    }
}

async function storeSecretServiceToken(token: string): Promise<void> {
    if (!token) {
        await runSecretTool(["clear", ...SECRET_SERVICE_ATTRIBUTES]).catch(() => undefined);
        return;
    }
    await runSecretTool(["store", "--label=poo.wang Vencord uploader", ...SECRET_SERVICE_ATTRIBUTES], token);
}
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

async function readAccessToken(): Promise<string | undefined> {
    const environmentToken = process.env.POO_WANG_ACCESS_TOKEN?.trim();
    if (environmentToken) return environmentToken;
    if (safeStorage.isEncryptionAvailable()) {
        try {
            const encrypted = await readFile(TOKEN_PATH());
            const token = safeStorage.decryptString(encrypted).trim();
            if (token) return token;
        } catch {
            // Fall through to the desktop Secret Service.
        }
    }
    return readSecretServiceToken();
}

export async function hasAccessToken(_: IpcMainInvokeEvent): Promise<boolean> {
    return Boolean(await readAccessToken());
}

export async function setAccessToken(_: IpcMainInvokeEvent, rawToken: string): Promise<{ ok: boolean; error?: string; }> {
    const token = rawToken.trim();
    try {
        if (!token) {
            await rm(TOKEN_PATH(), { force: true });
            await storeSecretServiceToken("");
            return { ok: true };
        }
        if (safeStorage.isEncryptionAvailable()) {
            const path = TOKEN_PATH();
            await mkdir(dirname(path), { recursive: true });
            await writeFile(path, safeStorage.encryptString(token), { mode: 0o600 });
            await chmod(path, 0o600);
        } else {
            await storeSecretServiceToken(token);
        }
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
