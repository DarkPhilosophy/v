/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { join } from "node:path";

import { DATA_DIR } from "@main/utils/constants";
import { IpcEvents } from "@shared/IpcEvents";
import { getUserPluginManagerRelaunchOptions, type UserPluginManagerBuildStage, type UserPluginManagerIpcResult } from "@shared/userPluginManager";
import { redactSensitiveData } from "@shared/userPluginManagerSafety";
import { app, ipcMain } from "electron";

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

function serializeManagerEventCall<TResult>(
    call: (event: Electron.IpcMainInvokeEvent) => Promise<TResult>
): (event: Electron.IpcMainInvokeEvent) => Promise<UserPluginManagerIpcResult<TResult>> {
    return async event => {
        try {
            return { ok: true, value: await call(event) };
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

export function registerUserPluginManagerIpcHandlers(
    build: (userpluginsRoot: string, report?: (stage: UserPluginManagerBuildStage) => void) => Promise<boolean>
): void {
    const dataRoot = join(DATA_DIR, "userPluginManager");
    const isFlatpak = process.platform === "linux" && Boolean(process.env.FLATPAK_ID);
    const service = createUserPluginManagerService({
        dataRoot,
        isFlatpak,
        host: isFlatpak
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
    ipcMain.handle(IpcEvents.USER_PLUGIN_MANAGER_APPLY_PENDING, serializeManagerEventCall(async event => {
        const report = (stage: UserPluginManagerBuildStage) => event.sender.send(IpcEvents.USER_PLUGIN_MANAGER_PROGRESS, stage);
        return (await service).applyPending(report);
    }));
    ipcMain.handle(IpcEvents.USER_PLUGIN_MANAGER_RESTART, () => {
        app.relaunch(getUserPluginManagerRelaunchOptions(isFlatpak));
        app.exit(0);
    });
    ipcMain.handle(IpcEvents.USER_PLUGIN_MANAGER_RECOVER, serializeManagerEventCall(async event => {
        const report = (stage: UserPluginManagerBuildStage) => event.sender.send(IpcEvents.USER_PLUGIN_MANAGER_PROGRESS, stage);
        return (await service).recover(report);
    }));
}
