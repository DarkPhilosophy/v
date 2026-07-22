/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { runUserPluginManagerHostRequest } from "./host";

const MAX_HOST_REQUEST_BYTES = 1024 * 1024;

async function main(): Promise<void> {
    const chunks: Buffer[] = [];
    let bytes = 0;
    for await (const chunk of process.stdin) {
        const buffer = Buffer.from(chunk);
        bytes += buffer.byteLength;
        if (bytes > MAX_HOST_REQUEST_BYTES) {
            process.stdout.write(JSON.stringify({
                ok: false,
                error: { message: "User Plugin Manager host request exceeded 1 MiB" }
            }));
            return;
        }
        chunks.push(buffer);
    }
    process.stdout.write(JSON.stringify(
        await runUserPluginManagerHostRequest(Buffer.concat(chunks).toString("utf8"))
    ));
}

void main();
