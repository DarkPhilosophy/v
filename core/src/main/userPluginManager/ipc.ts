/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { join } from "node:path";

import { DATA_DIR } from "@main/utils/constants";
import { IpcEvents } from "@shared/IpcEvents";
import type { UserPluginManagerIpcResult } from "@shared/userPluginManager";
import { redactSensitiveData } from "@shared/userPluginManagerSafety";
import { ipcMain } from "electron";

import { createUserPluginManagerService } from ".";
import { createFlatpakUserPluginManagerHost } from "./host";

function serializeManagerCall<TArgs extends unknown[], TResult>(
    call: (...args: TArgs) => Promise<TResult>
): (_event: Electron.IpcMainInvokeEvent, ...args: TArgs) => Promise<UserPluginManagerIpcResult<TResult>> {
    return async (_event, ...args) => {
        try {
            return { ok: true, value: await call(...args) };
        } catch (error) {
            const candidate = error as { code?: unknown; message?: unknown; };
            return {
                ok: false,
                error: {
                    code: typeof candidate.code === "string" ? candidate.code : "INTERNAL_ERROR",
                    message: redactSensitiveData(typeof candidate.message === "string" ? candidate.message : "User Plugin Manager operation failed")
                }
            };
        }
    };
}

export function registerUserPluginManagerIpcHandlers(build: () => Promise<boolean>): void {
    const dataRoot = join(DATA_DIR, "userPluginManager");
    const service = createUserPluginManagerService({
        dataRoot,
        installedRoot: join(__dirname, "..", "src", "userplugins"),
        host: process.platform === "linux" && Boolean(process.env.FLATPAK_ID)
            ? createFlatpakUserPluginManagerHost(dataRoot, join(__dirname, "userPluginManagerHost.cjs"))
            : undefined,
        build
    });

    // Initialization starts eagerly, but the first IPC request may arrive after a startup failure.
    // Mark the rejection handled now; handlers still await the original promise and serialize its error.
    void service.catch(() => undefined);

    ipcMain.handle(IpcEvents.USER_PLUGIN_MANAGER_GET_SNAPSHOT, serializeManagerCall(async () => (await service).getSnapshot()));
    ipcMain.handle(IpcEvents.USER_PLUGIN_MANAGER_ACKNOWLEDGE_RISK, serializeManagerCall(async () => (await service).acknowledgeRisk()));
    ipcMain.handle(IpcEvents.USER_PLUGIN_MANAGER_DEACTIVATE, serializeManagerCall(async () => (await service).deactivate()));
    ipcMain.handle(IpcEvents.USER_PLUGIN_MANAGER_INSPECT_SOURCE, serializeManagerCall(async input => (await service).inspectSource(input)));
    ipcMain.handle(IpcEvents.USER_PLUGIN_MANAGER_CHECK_SOURCE, serializeManagerCall(async sourceId => (await service).checkSource(sourceId)));
    ipcMain.handle(IpcEvents.USER_PLUGIN_MANAGER_STAGE_INSTALL, serializeManagerCall(async input => (await service).stageInstall(input)));
    ipcMain.handle(IpcEvents.USER_PLUGIN_MANAGER_STAGE_UPDATE, serializeManagerCall(async input => (await service).stageUpdate(input)));
    ipcMain.handle(IpcEvents.USER_PLUGIN_MANAGER_STAGE_ADOPT, serializeManagerCall(async input => (await service).stageAdopt(input)));
    ipcMain.handle(IpcEvents.USER_PLUGIN_MANAGER_STAGE_REMOVE, serializeManagerCall(async sourceId => (await service).stageRemove(sourceId)));
    ipcMain.handle(IpcEvents.USER_PLUGIN_MANAGER_DISCARD_PENDING, serializeManagerCall(async () => (await service).discardPending()));
    ipcMain.handle(IpcEvents.USER_PLUGIN_MANAGER_APPLY_PENDING, serializeManagerCall(async () => (await service).applyPending()));
    ipcMain.handle(IpcEvents.USER_PLUGIN_MANAGER_RECOVER, serializeManagerCall(async () => (await service).recover()));
}
