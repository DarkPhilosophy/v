/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { Heading } from "@components/Heading";
import { Paragraph } from "@components/Paragraph";
import { Span } from "@components/Span";
import type {
    ManagedSourceV1,
    SourceKind,
    UpdatePolicy,
    UserPluginInventoryEntry,
    UserPluginManagerInspection,
    UserPluginManagerInspectionInput
} from "@shared/userPluginManager";
import { Margins } from "@utils/margins";
import type { ModalAction, RenderModalProps } from "@vencord/discord-types";
import { Modal, openModal, Select, TextInput, Toasts, useEffect, useState } from "@webpack/common";

import type { UserPluginManagerController } from "./controller";
import {
    cl,
    ErrorDisplay,
    InspectionReview,
    type ManagerError,
    SOURCE_KIND_META,
    SOURCE_KIND_ORDER,
    toManagerError,
    UPDATE_POLICY_LABEL,
    validateLocator
} from "./shared";

function toast(message: string): void {
    Toasts.show({
        message,
        id: Toasts.genId(),
        type: Toasts.Type.SUCCESS,
        options: { position: Toasts.Position.BOTTOM }
    });
}

const KIND_OPTIONS = SOURCE_KIND_ORDER.map(kind => ({ label: SOURCE_KIND_META[kind].label, value: kind }));
const POLICY_OPTIONS = (Object.keys(UPDATE_POLICY_LABEL) as UpdatePolicy[]).map(policy => ({
    label: UPDATE_POLICY_LABEL[policy],
    value: policy
}));

interface AddSourceModalProps extends RenderModalProps {
    controller: UserPluginManagerController;
    onQueued(): void;
}

function AddSourceModal({ controller, onQueued, ...modalProps }: AddSourceModalProps) {
    const [kind, setKind] = useState<SourceKind>("git");
    const [locator, setLocator] = useState("");
    const [ref, setRef] = useState("");
    const [subpath, setSubpath] = useState("");
    const [displayName, setDisplayName] = useState("");
    const [updatePolicy, setUpdatePolicy] = useState<UpdatePolicy>("manual");

    const [inspection, setInspection] = useState<UserPluginManagerInspection | null>(null);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<ManagerError | null>(null);

    const meta = SOURCE_KIND_META[kind];
    const trimmedLocator = locator.trim();
    const locatorError = validateLocator(kind, trimmedLocator);
    const suggestedName = inspection
        ? inspection.locator.split(/[/\\]/).filter(Boolean).pop() || inspection.locator
        : "";

    async function inspect() {
        setBusy(true);
        setError(null);
        try {
            const input: UserPluginManagerInspectionInput = {
                kind,
                locator: trimmedLocator,
                requestedRef: meta.supportsRef && ref.trim() ? ref.trim() : undefined,
                subpath: meta.supportsSubpath && subpath.trim() ? subpath.trim() : undefined
            };
            setInspection(await controller.inspect(input));
        } catch (e) {
            setError(toManagerError(e));
        } finally {
            setBusy(false);
        }
    }

    async function queue() {
        if (!inspection) return;
        setBusy(true);
        setError(null);
        try {
            await controller.queueInstall(inspection.inspectionId, displayName.trim(), updatePolicy);
            toast("Queued install — review the batch and Apply to finish.");
            onQueued();
            modalProps.onClose();
        } catch (e) {
            setError(toManagerError(e));
        } finally {
            setBusy(false);
        }
    }

    const actions: ModalAction[] = inspection
        ? [
            { text: "Queue install", variant: "primary", onClick: queue, loading: busy },
            { text: "Re-inspect", variant: "secondary", onClick: () => setInspection(null), disabled: busy }
        ]
        : [
            { text: "Inspect", variant: "primary", onClick: inspect, loading: busy, disabled: Boolean(locatorError) },
            { text: "Cancel", variant: "secondary", onClick: modalProps.onClose, disabled: busy }
        ];

    return (
        <Modal
            {...modalProps}
            size="lg"
            title="Add plugin source"
            subtitle={inspection
                ? "Review exactly what will be staged, then queue it."
                : "A source is fetched and inspected first — nothing is written to disk yet."}
            actions={actions}
        >
            <div className={cl("modal")} aria-busy={busy}>
                {error ? <ErrorDisplay error={error} /> : null}

                {inspection ? (
                    <>
                        <div className={cl("field")}>
                            <Heading tag="h5">Display name</Heading>
                            <TextInput value={displayName} onChange={setDisplayName} placeholder={suggestedName} />
                            <Span className={cl("meta")}>Leave blank to use “{suggestedName}”.</Span>
                        </div>
                        <div className={cl("field")}>
                            <Heading tag="h5">Updates</Heading>
                            <Select
                                options={POLICY_OPTIONS}
                                isSelected={value => value === updatePolicy}
                                select={value => setUpdatePolicy(value)}
                                serialize={String}
                                closeOnSelect
                            />
                        </div>
                        <InspectionReview inspection={inspection} />
                    </>
                ) : (
                    <>
                        <div className={cl("field")}>
                            <Heading tag="h5">Source type</Heading>
                            <Select
                                options={KIND_OPTIONS}
                                isSelected={value => value === kind}
                                select={value => setKind(value)}
                                serialize={String}
                                closeOnSelect
                            />
                            <Span className={cl("meta")}>{meta.hint}</Span>
                        </div>
                        <div className={cl("field")}>
                            <Heading tag="h5">{meta.locatorLabel}</Heading>
                            <TextInput
                                value={locator}
                                onChange={setLocator}
                                placeholder={meta.locatorPlaceholder}
                                error={trimmedLocator ? locatorError ?? undefined : undefined}
                            />
                        </div>
                        {meta.supportsRef ? (
                            <div className={cl("field")}>
                                <Heading tag="h5">Branch, tag, or commit (optional)</Heading>
                                <TextInput value={ref} onChange={setRef} placeholder="main" />
                            </div>
                        ) : null}
                        {meta.supportsSubpath ? (
                            <div className={cl("field")}>
                                <Heading tag="h5">Subfolder (optional)</Heading>
                                <TextInput value={subpath} onChange={setSubpath} placeholder="plugins/myPlugin" />
                            </div>
                        ) : null}
                    </>
                )}
            </div>
        </Modal>
    );
}

interface UpdateSourceModalProps extends RenderModalProps {
    controller: UserPluginManagerController;
    source: ManagedSourceV1;
    onQueued(): void;
    initialMode?: "update" | "resync";
}

function UpdateSourceModal({
    controller,
    source,
    onQueued,
    initialMode = "update",
    ...modalProps
}: UpdateSourceModalProps) {
    const [inspection, setInspection] = useState<UserPluginManagerInspection | null>(null);
    const [busy, setBusy] = useState(true);
    const [error, setError] = useState<ManagerError | null>(null);
    const [mode, setMode] = useState<"update" | "resync">(initialMode);

    useEffect(() => {
        let cancelled = false;
        (async () => {
            try {
                const result = await controller.checkUpdate(source.id);
                if (!cancelled) setInspection(result);
            } catch (e) {
                if (!cancelled) setError(toManagerError(e));
            } finally {
                if (!cancelled) setBusy(false);
            }
        })();
        return () => { cancelled = true; };
    }, []);

    const upToDate = inspection != null && inspection.resolvedRevision === source.resolvedRevision;

    async function queue() {
        if (!inspection) return;
        setBusy(true);
        setError(null);
        try {
            await controller.queueUpdate(source.id, inspection.inspectionId, mode);
            toast(mode === "resync" ? "Queued re-sync — Apply to finish." : "Queued update — Apply to finish.");
            onQueued();
            modalProps.onClose();
        } catch (e) {
            setError(toManagerError(e));
        } finally {
            setBusy(false);
        }
    }

    const actions: ModalAction[] = [];
    if (inspection) {
        actions.push({
            text: mode === "resync" ? "Queue re-sync" : upToDate ? "Queue re-sync anyway" : "Queue update",
            variant: "primary",
            onClick: queue,
            loading: busy
        });
    }
    actions.push({ text: "Close", variant: "secondary", onClick: modalProps.onClose, disabled: busy });

    return (
        <Modal
            {...modalProps}
            size="lg"
            title={`Check “${source.displayName}” for updates`}
            subtitle="The source is re-inspected. Nothing is written until you Apply the batch."
            actions={actions}
        >
            <div className={cl("modal")} aria-busy={busy}>
                {error ? <ErrorDisplay error={error} /> : null}

                {inspection ? (
                    <>
                        <div className={cl("field")}>
                            <Heading tag="h5">Mode</Heading>
                            <Select
                                options={[
                                    { label: "Update to the inspected revision", value: "update" },
                                    { label: "Re-sync (repair the installed files)", value: "resync" }
                                ]}
                                isSelected={value => value === mode}
                                select={value => setMode(value)}
                                serialize={String}
                                closeOnSelect
                            />
                        </div>
                        <InspectionReview inspection={inspection} installedRevision={source.resolvedRevision} />
                    </>
                ) : busy ? (
                    <Paragraph aria-busy>Inspecting the source…</Paragraph>
                ) : null}
            </div>
        </Modal>
    );
}

interface AdoptModalProps extends RenderModalProps {
    controller: UserPluginManagerController;
    entry: UserPluginInventoryEntry;
    onQueued(): void;
}

function AdoptModal({ controller, entry, onQueued, ...modalProps }: AdoptModalProps) {
    const [displayName, setDisplayName] = useState(entry.destination);
    const [kind, setKind] = useState<SourceKind>("git");
    const [locator, setLocator] = useState("");
    const [ref, setRef] = useState("");
    const [resolvedRevision, setResolvedRevision] = useState(entry.contentDigest ?? "");
    const [updatePolicy, setUpdatePolicy] = useState<UpdatePolicy>("manual");
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<ManagerError | null>(null);

    const meta = SOURCE_KIND_META[kind];
    const trimmedLocator = locator.trim();
    const locatorError = trimmedLocator ? validateLocator(kind, trimmedLocator) : `${meta.locatorLabel} is required.`;
    const nameMissing = displayName.trim().length === 0;
    const revisionMissing = resolvedRevision.trim().length === 0;
    const canQueue = !busy && !locatorError && !nameMissing && !revisionMissing;

    async function queue() {
        setBusy(true);
        setError(null);
        try {
            await controller.queueAdopt({
                sourceId: crypto.randomUUID(),
                displayName: displayName.trim(),
                kind,
                locator: trimmedLocator,
                requestedRef: meta.supportsRef && ref.trim() ? ref.trim() : undefined,
                resolvedRevision: resolvedRevision.trim(),
                destinations: [entry.destination],
                updatePolicy
            });
            toast("Queued adoption — Apply to finish.");
            onQueued();
            modalProps.onClose();
        } catch (e) {
            setError(toManagerError(e));
        } finally {
            setBusy(false);
        }
    }

    return (
        <Modal
            {...modalProps}
            size="lg"
            title={`Adopt “${entry.destination}”`}
            subtitle="Register an existing plugin so the manager can track and update it."
            actions={[
                { text: "Queue adoption", variant: "primary", onClick: queue, loading: busy, disabled: !canQueue },
                { text: "Cancel", variant: "secondary", onClick: modalProps.onClose, disabled: busy }
            ]}
        >
            <div className={cl("modal")} aria-busy={busy}>
                {error ? <ErrorDisplay error={error} /> : null}

                <Paragraph className={Margins.bottom8}>
                    The files already installed at <span className={cl("code")}>{entry.destination}</span> are kept as-is.
                    Describe where they came from so future checks and updates can resolve a revision.
                </Paragraph>

                <div className={cl("field")}>
                    <Heading tag="h5">Display name</Heading>
                    <TextInput value={displayName} onChange={setDisplayName} error={nameMissing ? "A display name is required." : undefined} />
                </div>
                <div className={cl("field")}>
                    <Heading tag="h5">Origin type</Heading>
                    <Select
                        options={KIND_OPTIONS}
                        isSelected={value => value === kind}
                        select={value => setKind(value)}
                        serialize={String}
                        closeOnSelect
                    />
                </div>
                <div className={cl("field")}>
                    <Heading tag="h5">{meta.locatorLabel}</Heading>
                    <TextInput
                        value={locator}
                        onChange={setLocator}
                        placeholder={meta.locatorPlaceholder}
                        error={trimmedLocator ? validateLocator(kind, trimmedLocator) ?? undefined : undefined}
                    />
                    <Span className={cl("meta")}>Stored redacted — credentials embedded in URLs are stripped.</Span>
                </div>
                {meta.supportsRef ? (
                    <div className={cl("field")}>
                        <Heading tag="h5">Branch, tag, or commit (optional)</Heading>
                        <TextInput value={ref} onChange={setRef} placeholder="main" />
                    </div>
                ) : null}
                <div className={cl("field")}>
                    <Heading tag="h5">Installed revision</Heading>
                    <TextInput value={resolvedRevision} onChange={setResolvedRevision} error={revisionMissing ? "An installed revision is required." : undefined} />
                    <Span className={cl("meta")}>Defaults to the current on-disk digest; replace it with the built commit or version if you know it.</Span>
                </div>
                <div className={cl("field")}>
                    <Heading tag="h5">Updates</Heading>
                    <Select
                        options={POLICY_OPTIONS}
                        isSelected={value => value === updatePolicy}
                        select={value => setUpdatePolicy(value)}
                        serialize={String}
                        closeOnSelect
                    />
                </div>
            </div>
        </Modal>
    );
}

export function openAddSourceModal(controller: UserPluginManagerController, onQueued: () => void): void {
    openModal(props => <AddSourceModal {...props} controller={controller} onQueued={onQueued} />);
}

export function openUpdateSourceModal(
    controller: UserPluginManagerController,
    source: ManagedSourceV1,
    onQueued: () => void,
    initialMode: "update" | "resync" = "update"
): void {
    openModal(props => (
        <UpdateSourceModal
            {...props}
            controller={controller}
            source={source}
            onQueued={onQueued}
            initialMode={initialMode}
        />
    ));
}

export function openAdoptModal(
    controller: UserPluginManagerController,
    entry: UserPluginInventoryEntry,
    onQueued: () => void
): void {
    openModal(props => <AdoptModal {...props} controller={controller} entry={entry} onQueued={onQueued} />);
}
