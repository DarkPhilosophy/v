/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { runUserPluginManagerHostRequest } from "./host";

const MAX_HOST_REQUEST_BYTES = 1024 * 1024;

async function main(): Promise<string> {
    const chunks: Buffer[] = [];
    let bytes = 0;
    for await (const chunk of process.stdin) {
        const buffer = Buffer.from(chunk);
        bytes += buffer.byteLength;
        if (bytes > MAX_HOST_REQUEST_BYTES) {
            return JSON.stringify({
                ok: false,
                error: { message: "User Plugin Manager host request exceeded 1 MiB" }
            });
        }
        chunks.push(buffer);
    }
    return JSON.stringify(
        await runUserPluginManagerHostRequest(Buffer.concat(chunks).toString("utf8"))
    );
}

void main().then(
    output => process.stdout.write(output),
    error => {
        const candidate = error as { code?: unknown; message?: unknown; name?: unknown; };
        process.stdout.write(JSON.stringify({
            ok: false,
            error: {
                code: typeof candidate.code === "string" ? candidate.code : undefined,
                message: typeof candidate.message === "string" ? candidate.message : "User Plugin Manager host operation failed",
                name: typeof candidate.name === "string" ? candidate.name : undefined
            }
        }));
    }
);
