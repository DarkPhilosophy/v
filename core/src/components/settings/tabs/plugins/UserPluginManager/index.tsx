/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import "./styles.css";

import { Button } from "@components/Button";
import { Card } from "@components/Card";
import ErrorBoundary from "@components/ErrorBoundary";
import { HeadingSecondary, HeadingTertiary } from "@components/Heading";
import { Paragraph } from "@components/Paragraph";
import { Span } from "@components/Span";
import { relaunch } from "@utils/native";
import type { ModalActionVariant } from "@vencord/discord-types";
import { ConfirmModal, openModal, useCallback, useEffect, useRef, useState } from "@webpack/common";
import type { ReactNode } from "react";

import type {
    ManagedSourceV1,
    PendingChangeV1,
    UserPluginManagerSnapshot
} from "../../../../../shared/userPluginManager";
import { UserPluginManagerController } from "./controller";
import { openAddSourceModal, openAdoptModal, openUpdateSourceModal } from "./modals";
import { Badge, type BadgeTone, cl, ErrorDisplay, type ManagerError, SOURCE_KIND_META, toManagerError } from "./shared";

const RECOVERY_MESSAGE: Record<string, string> = {
    "rollback": "A change was interrupted partway through. Recovering rolls back the partial write and rebuilds Vencord.",
    "recovery-build": "Files were changed but the rebuild did not finish. Recovering rebuilds Vencord to match what is on disk.",
    "commit": "A change finished on disk but was not recorded. Recovering finalises the bookkeeping.",
    "none": "No recovery is needed."
};

function confirmAction(options: {
    title: string;
    body: ReactNode;
    confirmText: string;
    variant?: ModalActionVariant;
    onConfirm(): void;
}): void {
    openModal(props => (
        <ConfirmModal
            {...props}
            title={options.title}
            confirmText={options.confirmText}
            cancelText="Cancel"
            variant={options.variant ?? "primary"}
            onConfirm={options.onConfirm}
        >
            {options.body}
        </ConfirmModal>
    ));
}

/** Summarise a pending change into the tone/label/target shown in the batch review. */
function describePending(change: PendingChangeV1, sources: readonly ManagedSourceV1[]): {
    tone: BadgeTone;
    label: string;
    title: string;
    detail?: string;
} {
    switch (change.kind) {
        case "install":
            return { tone: "success", label: "install", title: change.source.displayName, detail: `${change.entries.length} file(s)` };
        case "adopt":
            return { tone: "brand", label: "adopt", title: change.source.displayName, detail: change.source.entries.map(entry => entry.destination).join(", ") };
        case "update":
        case "resync": {
            const source = sources.find(candidate => candidate.id === change.sourceId);
            return { tone: "warning", label: change.kind, title: source?.displayName ?? change.sourceId, detail: `→ ${change.inspectedRevision.slice(0, 12)}` };
        }
        case "remove": {
            const source = sources.find(candidate => candidate.id === change.sourceId);
            return { tone: "danger", label: "remove", title: source?.displayName ?? change.sourceId, detail: change.destinations.join(", ") };
        }
    }
}

interface ManagerBinding {
    controller: UserPluginManagerController;
    snapshot: UserPluginManagerSnapshot | null;
    busy: boolean;
    error: ManagerError | null;
    run(action: (controller: UserPluginManagerController) => Promise<unknown>): Promise<boolean>;
}

function useUserPluginManager(): ManagerBinding {
    const controllerRef = useRef<UserPluginManagerController | null>(null);
    controllerRef.current ??= new UserPluginManagerController(VencordNative.userPluginManager);
    const controller = controllerRef.current;

    const [snapshot, setSnapshot] = useState<UserPluginManagerSnapshot | null>(() => controller.current);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<ManagerError | null>(null);

    const run = useCallback(async (action: (controller: UserPluginManagerController) => Promise<unknown>): Promise<boolean> => {
        setBusy(true);
        setError(null);
        try {
            await action(controller);
            return true;
        } catch (e) {
            setError(toManagerError(e));
            // A failed mutation may have left the service locked or mid-recovery.
            // Refresh so the UI reflects the post-failure state instead of a stale one.
            await controller.load().catch(() => undefined);
            return false;
        } finally {
            setBusy(false);
        }
    }, [controller]);

    useEffect(() => {
        const unsubscribe = controller.subscribe(setSnapshot);
        void run(c => c.load());
        return unsubscribe;
    }, [controller, run]);

    return { controller, snapshot, busy, error, run };
}

function UserPluginManagerView() {
    const { controller, snapshot, busy, error, run } = useUserPluginManager();

    if (!snapshot) {
        return (
            <div className={cl("root")} aria-busy="true">
                <Paragraph className={cl("meta")} role="status">Loading the User Plugin Manager…</Paragraph>
            </div>
        );
    }

    const view = UserPluginManagerController.deriveViewState(snapshot, busy);
    const { state, inventory, conflicts, recovery } = snapshot;
    const sources = state.sources;
    const pending = state.pending?.changes ?? [];
    const canStage = snapshot.active && !snapshot.locked && !busy;

    const refresh = () => void run(c => c.load());

    const applyBatch = () => confirmAction({
        title: `Apply ${pending.length} change${pending.length === 1 ? "" : "s"}?`,
        confirmText: "Apply & rebuild",
        variant: "primary",
        body: <Paragraph>The staged changes are written to disk and Vencord is rebuilt in a single step. A restart is needed afterwards to load them.</Paragraph>,
        onConfirm: () => void run(c => c.applyPending()).then(ok => {
            if (ok) confirmAction({
                title: "Applied — restart to load changes?",
                confirmText: "Restart",
                variant: "primary",
                body: <Paragraph>Your plugin changes were applied and Vencord was rebuilt. Restart now to load them.</Paragraph>,
                onConfirm: () => relaunch()
            });
        })
    });

    const discard = () => confirmAction({
        title: `Discard ${pending.length} pending change${pending.length === 1 ? "" : "s"}?`,
        confirmText: "Discard",
        variant: "critical-primary",
        body: <Paragraph>Nothing has been written yet, so this only clears the staged plan.</Paragraph>,
        onConfirm: () => void run(c => c.discardPending())
    });

    const removeSource = (source: ManagedSourceV1) => confirmAction({
        title: `Remove “${source.displayName}”?`,
        confirmText: "Queue removal",
        variant: "critical-primary",
        body: <Paragraph>Its files are deleted from disk when you Apply the batch. This is staged, not immediate.</Paragraph>,
        onConfirm: () => void run(c => c.queueRemove(source.id))
    });

    const deactivate = () => confirmAction({
        title: "Disable the User Plugin Manager?",
        confirmText: "Disable",
        variant: "critical-primary",
        body: <Paragraph>Installed plugins stay on disk and keep working. You can re-enable the manager at any time.</Paragraph>,
        onConfirm: () => void run(c => c.deactivate())
    });

    return (
        <div className={cl("root")} aria-busy={busy ? "true" : undefined}>
            <div className={cl("section")}>
                <div className={cl("heading")}>
                    <HeadingSecondary>User Plugin Manager</HeadingSecondary>
                    <Badge tone={snapshot.active ? "success" : "muted"}>{snapshot.active ? "Enabled" : "Disabled"}</Badge>
                    {snapshot.locked ? <Badge tone="danger">Locked</Badge> : null}
                </div>
                <Paragraph>
                    Install, update, and remove third-party user plugins from Git, HTTPS, or local sources.
                    Every source is inspected and reviewed first; changes are staged and then applied together in one rebuild.
                </Paragraph>
            </div>

            {error ? <ErrorDisplay error={error} /> : null}

            {!snapshot.active ? (
                <Card variant="danger" className={cl("callout")}>
                    <HeadingTertiary>Enable at your own risk</HeadingTertiary>
                    <Paragraph>
                        User plugins are third-party code that runs with the same access as Vencord and your Discord client.
                        Only add sources you fully trust — malicious code could read your messages, token, or files.
                    </Paragraph>
                    <Paragraph>
                        Each source is fetched into an isolated staging area and shown to you for review before anything is written.
                        Applying a batch rebuilds Vencord and needs a restart. You can disable the manager at any time.
                    </Paragraph>
                    <div className={cl("callout-actions")}>
                        <Button variant="dangerPrimary" disabled={busy} onClick={() => void run(c => c.activate(true))}>
                            I understand the risks — enable
                        </Button>
                    </div>
                </Card>
            ) : (
                <>
                    {snapshot.locked ? (
                        <Card variant="danger" className={cl("callout")}>
                            <div className={cl("heading")}>
                                <HeadingTertiary>Recovery required</HeadingTertiary>
                                <Badge tone="danger">locked</Badge>
                            </div>
                            <Paragraph>{RECOVERY_MESSAGE[recovery.action] ?? RECOVERY_MESSAGE.rollback}</Paragraph>
                            <Paragraph className={cl("meta")}>Mutations are blocked until recovery completes.</Paragraph>
                            <div className={cl("callout-actions")}>
                                <Button variant="dangerPrimary" size="small" disabled={!view.canRecover} onClick={() => void run(c => c.recover())}>
                                    Recover now
                                </Button>
                            </div>
                        </Card>
                    ) : null}

                    {conflicts.length ? (
                        <Card variant="danger" className={cl("callout")}>
                            <HeadingTertiary>Destination conflicts</HeadingTertiary>
                            <Paragraph>
                                More than one managed source installs to the same location. Remove or update a source to resolve this before applying.
                            </Paragraph>
                            <div className={cl("list")}>
                                {conflicts.map(conflict => (
                                    <div className={cl("pending-item")} key={conflict.destination}>
                                        <span className={cl("code")}>{conflict.destination}</span>
                                        <span className={cl("meta")}>
                                            {conflict.sourceIds.map(id => sources.find(source => source.id === id)?.displayName ?? id).join(" ↔ ")}
                                        </span>
                                    </div>
                                ))}
                            </div>
                        </Card>
                    ) : null}

                    <div className={cl("toolbar")}>
                        <Button variant="primary" size="small" disabled={!view.canAdd} onClick={() => openAddSourceModal(controller, refresh)}>
                            Add source
                        </Button>
                        <Button variant="secondary" size="small" disabled={busy} onClick={refresh}>
                            Refresh
                        </Button>
                        <Button variant="secondary" size="small" disabled={!canStage || pending.length > 0} onClick={deactivate}>
                            Disable manager
                        </Button>
                        {busy ? <span className={cl("toolbar-status")} role="status">Working…</span> : null}
                    </div>

                    {pending.length ? (
                        <Card variant="warning" className={cl("callout")}>
                            <div className={cl("heading")}>
                                <HeadingTertiary>Pending changes</HeadingTertiary>
                                <Badge tone="warning">{pending.length}</Badge>
                            </div>
                            <Paragraph>
                                These changes are staged but not yet written. Apply them together to rebuild Vencord, or discard them.
                            </Paragraph>
                            <div>
                                {pending.map((change, index) => {
                                    const described = describePending(change, sources);
                                    return (
                                        <div className={cl("pending-item")} key={`${described.label}:${described.title}:${index}`}>
                                            <Badge tone={described.tone}>{described.label}</Badge>
                                            <Span weight="medium">{described.title}</Span>
                                            {described.detail ? <span className={cl("meta")}>{described.detail}</span> : null}
                                        </div>
                                    );
                                })}
                            </div>
                            <div className={cl("callout-actions")}>
                                <Button variant="primary" size="small" disabled={!view.canApply} onClick={applyBatch}>
                                    Apply {pending.length} change{pending.length === 1 ? "" : "s"}
                                </Button>
                                <Button variant="secondary" size="small" disabled={!canStage} onClick={discard}>
                                    Discard
                                </Button>
                            </div>
                        </Card>
                    ) : null}

                    <div className={cl("section")}>
                        <div className={cl("heading")}>
                            <HeadingTertiary>Managed sources</HeadingTertiary>
                            <Badge tone="muted">{sources.length}</Badge>
                        </div>
                        {sources.length ? (
                            <div className={cl("list")}>
                                {sources.map(source => (
                                    <div className={cl("row")} key={source.id}>
                                        <div className={cl("row-main")}>
                                            <div className={cl("title-line")}>
                                                <Span weight="semibold">{source.displayName}</Span>
                                                <Badge tone="muted">{SOURCE_KIND_META[source.kind].label}</Badge>
                                                <Badge tone="muted">{source.updatePolicy === "check-on-open" ? "auto-check" : "manual"}</Badge>
                                            </div>
                                            <span className={cl("meta")}>{source.locator}</span>
                                            <span className={cl("meta")}>rev {source.resolvedRevision.slice(0, 12)} · {source.entries.length} file(s)</span>
                                        </div>
                                        <div className={cl("row-actions")}>
                                            <Button variant="secondary" size="small" disabled={!canStage} onClick={() => openUpdateSourceModal(controller, source, refresh)}>
                                                Check
                                            </Button>
                                            <Button variant="dangerSecondary" size="small" disabled={!canStage} onClick={() => removeSource(source)}>
                                                Remove
                                            </Button>
                                        </div>
                                    </div>
                                ))}
                            </div>
                        ) : (
                            <div className={cl("empty")}>
                                <Paragraph className={cl("meta")}>No managed sources yet. Use “Add source” to install a user plugin.</Paragraph>
                            </div>
                        )}
                    </div>

                    <div className={cl("section")}>
                        <div className={cl("heading")}>
                            <HeadingTertiary>Installed on disk</HeadingTertiary>
                            <Badge tone="muted">{inventory.length}</Badge>
                        </div>
                        {inventory.length ? (
                            <div className={cl("list")}>
                                {inventory.map(entry => {
                                    const owners = entry.sourceIds.map(id => sources.find(source => source.id === id)?.displayName ?? id);
                                    return (
                                        <div className={cl("row")} key={entry.destination}>
                                            <div className={cl("row-main")}>
                                                <div className={cl("title-line")}>
                                                    <span className={cl("code")}>{entry.destination}</span>
                                                    <Badge tone={entry.state === "unmanaged" ? "warning" : entry.state === "conflict" ? "danger" : "success"}>
                                                        {entry.state}
                                                    </Badge>
                                                </div>
                                                <span className={cl("meta")}>
                                                    {owners.length ? `Managed by ${owners.join(", ")}` : "Not tracked by the manager"}
                                                </span>
                                            </div>
                                            {entry.state === "unmanaged" ? (
                                                <div className={cl("row-actions")}>
                                                    <Button variant="secondary" size="small" disabled={!canStage} onClick={() => openAdoptModal(controller, entry, refresh)}>
                                                        Adopt
                                                    </Button>
                                                </div>
                                            ) : null}
                                        </div>
                                    );
                                })}
                            </div>
                        ) : (
                            <div className={cl("empty")}>
                                <Paragraph className={cl("meta")}>No user plugins were found on disk.</Paragraph>
                            </div>
                        )}
                    </div>
                </>
            )}
        </div>
    );
}

export default ErrorBoundary.wrap(UserPluginManagerView, { message: "Failed to render the User Plugin Manager." });
