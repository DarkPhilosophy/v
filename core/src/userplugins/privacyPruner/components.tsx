import { Button } from "@components/Button";
import { Switch } from "@components/Switch";
import ErrorBoundary from "@components/ErrorBoundary";
import { Margins } from "@utils/margins";
import type { RenderModalProps } from "@vencord/discord-types";
import type { ReactNode } from "react";
import { Forms, Modal, NavigationRouter, openModal, Select, TextInput, useEffect, useMemo, useRef, useState } from "@webpack/common";
import { fetchMessageDetail } from "./api";
import { durationFromParts, durationToParts, formatElapsedDuration, type DurationUnit } from "./duration";
import { DEFAULT_PRUNING_TEMPLATE, type PruningTemplate } from "./defaults";
import type { CollectionProgress, PreviewResult, PrunableMessage } from "./engine";
import { formatUnknownError } from "./guards";
import { saveChannelPolicySettings, setChannelPolicy, setMessageKept, validatePolicy, type ChannelPolicy, type KeptMessageRecord } from "./model";
import { confirmChannelPolicy, deleteMessageNow, enableChannelPolicy, getChannelProgress, pauseChannelPruning, previewChannel, resumeChannelPruning } from "./runtime";
import { readSyncedState, settings, writeSyncedState } from "./settings";

const DAY = 86_400_000;
const DEFAULT_POLICY: ChannelPolicy = {
    enabled: false,
    retentionMs: DAY,
    maximumLookbackMs: 365 * DAY,
    scanIntervalMs: 2 * 60 * 60 * 1000,
    includeThreads: true,
};

interface ChannelModalInput {
    channelId: string;
    guildId: string | null;
    channelName: string;
}

function MessageRow(props: {
    message: PrunableMessage;
    guildId: string | null;
    onKeep?(): void;
}) {
    const jump = () => NavigationRouter.transitionTo(
        `/channels/${props.guildId ?? "@me"}/${props.message.channelId}/${props.message.id}`
    );
    return (
        <div className="vc-privacy-pruner-message-row">
            <div className="vc-privacy-pruner-message-copy">
                <Forms.FormText>{new Date(props.message.timestamp).toLocaleString()}</Forms.FormText>
                <Forms.FormText>{props.message.content || "(message has no text content)"}</Forms.FormText>
            </div>
            <div className="vc-privacy-pruner-row-actions">
                {props.onKeep && <Button onClick={props.onKeep}>Keep</Button>}
                <Button onClick={jump}>Jump</Button>
            </div>
        </div>
    );
}

function PreviewSummary(props: {
    preview: PreviewResult;
    guildId: string | null;
    onKeep(message: PrunableMessage): void;
}) {
    const [page, setPage] = useState(0);
    const pageSize = 25;
    const pageCount = Math.max(1, Math.ceil(props.preview.messages.length / pageSize));
    const visible = props.preview.messages.slice(page * pageSize, (page + 1) * pageSize);
    const oldest = props.preview.messages.reduce<number | undefined>(
        (value, message) => value == null || message.timestamp < value ? message.timestamp : value,
        undefined
    );
    const newest = props.preview.messages.reduce<number | undefined>(
        (value, message) => value == null || message.timestamp > value ? message.timestamp : value,
        undefined
    );
    return (
        <div className="vc-privacy-pruner-preview">
            <Forms.FormTitle tag="h3">Deletion preview</Forms.FormTitle>
            <Forms.FormText>Eligible messages: {props.preview.messages.length}</Forms.FormText>
            <Forms.FormText>Protected by Keep: {props.preview.keptCount}</Forms.FormText>
            <Forms.FormText>
                Affected range: {oldest ? new Date(oldest).toLocaleString() : "None"} — {newest ? new Date(newest).toLocaleString() : "None"}
            </Forms.FormText>
            {visible.map(message => (
                <MessageRow
                    key={message.id}
                    message={message}
                    guildId={props.guildId}
                    onKeep={() => props.onKeep(message)}
                />
            ))}
            {pageCount > 1 && (
                <div className="vc-privacy-pruner-actions">
                    <Button disabled={page === 0} onClick={() => setPage(value => value - 1)}>Previous</Button>
                    <Forms.FormText>Page {page + 1} of {pageCount}</Forms.FormText>
                    <Button disabled={page + 1 >= pageCount} onClick={() => setPage(value => value + 1)}>Next</Button>
                </div>
            )}
            <Forms.FormText className="vc-privacy-pruner-danger">
                Confirming permanently deletes every eligible message still listed above. This cannot be undone.
            </Forms.FormText>
        </div>
    );
}

const DURATION_UNIT_OPTIONS: Array<{ label: string; value: DurationUnit; }> = [
    { label: "Seconds", value: "seconds" },
    { label: "Minutes", value: "minutes" },
    { label: "Hours", value: "hours" },
    { label: "Days", value: "days" },
    { label: "Weeks", value: "weeks" },
    { label: "Months", value: "months" },
    { label: "Years", value: "years" },
];

function DurationField(props: {
    title: string;
    description: string;
    value: { value: string; unit: DurationUnit; };
    onChange(value: { value: string; unit: DurationUnit; }): void;
}) {
    return (
        <div className={Margins.bottom16}>
            <Forms.FormTitle tag="h3">{props.title}</Forms.FormTitle>
            <Forms.FormText className={Margins.bottom8}>{props.description}</Forms.FormText>
            <div className="vc-privacy-pruner-duration">
                <TextInput
                    type="number"
                    min="0"
                    value={props.value.value}
                    onChange={value => props.onChange({ ...props.value, value })}
                    placeholder="Enter a number"
                />
                <Select
                    options={DURATION_UNIT_OPTIONS}
                    select={(unit: DurationUnit) => props.onChange({ ...props.value, unit })}
                    isSelected={(unit: DurationUnit) => unit === props.value.unit}
                    serialize={(unit: DurationUnit) => unit}
                    closeOnSelect={true}
                />
            </div>
        </div>
    );
}

function readDefaultTemplate(): PruningTemplate {
    try {
        const parsed = JSON.parse(settings.store.defaultTemplate) as Partial<PruningTemplate>;
        if (
            typeof parsed.retentionMs === "number" &&
            typeof parsed.maximumLookbackMs === "number" &&
            typeof parsed.scanIntervalMs === "number"
        ) return { ...DEFAULT_PRUNING_TEMPLATE, ...parsed };
    } catch {
        // Fall through to the stable defaults.
    }
    return DEFAULT_PRUNING_TEMPLATE;
}

export function GlobalDefaultsSettings(): ReactNode {
    settings.use(["defaultTemplate", "autoApplyGuilds", "autoApplyDms", "autoApplyGroupDms"]);
    const template = readDefaultTemplate();
    const [retention, setRetention] = useState(() => durationToParts(template.retentionMs));
    const [lookback, setLookback] = useState(() => durationToParts(template.maximumLookbackMs));
    const [interval, setInterval] = useState(() => durationToParts(template.scanIntervalMs));

    function save(next: {
        retention: typeof retention;
        lookback: typeof lookback;
        interval: typeof interval;
    }): void {
        const retentionMs = durationFromParts(next.retention.value, next.retention.unit);
        const maximumLookbackMs = durationFromParts(next.lookback.value, next.lookback.unit);
        const scanIntervalMs = durationFromParts(next.interval.value, next.interval.unit);
        if (retentionMs == null || maximumLookbackMs == null || scanIntervalMs == null) return;
        const candidate = { enabled: true, retentionMs, maximumLookbackMs, scanIntervalMs, includeThreads: true };
        if (validatePolicy(candidate).length > 0) return;
        settings.store.defaultTemplate = JSON.stringify({
            retentionMs,
            maximumLookbackMs,
            scanIntervalMs,
            includeThreads: true,
        });
    }

    return (
        <div className="vc-privacy-pruner-defaults">
            <Forms.FormTitle tag="h2">Defaults for new conversations</Forms.FormTitle>
            <Forms.FormText className={Margins.bottom16}>
                These values are copied once only when an enabled destination is newly joined or created. Existing policies are never changed.
            </Forms.FormText>
            <DurationField title="Default retention" description="Copied to new destinations." value={retention} onChange={value => {
                setRetention(value);
                save({ retention: value, lookback, interval });
            }} />
            <DurationField title="Default maximum search history" description="Must be longer than retention." value={lookback} onChange={value => {
                setLookback(value);
                save({ retention, lookback: value, interval });
            }} />
            <DurationField title="Default scan interval" description="Copied to each new destination's independent schedule." value={interval} onChange={value => {
                setInterval(value);
                save({ retention, lookback, interval: value });
            }} />
            <Forms.FormTitle tag="h3">Automatically apply these defaults to new</Forms.FormTitle>
            <label className="vc-privacy-pruner-switch-row">
                <Forms.FormText>Guilds and their message-capable channels</Forms.FormText>
                <Switch checked={settings.store.autoApplyGuilds} onChange={value => settings.store.autoApplyGuilds = value} />
            </label>
            <label className="vc-privacy-pruner-switch-row">
                <Forms.FormText>Direct Messages</Forms.FormText>
                <Switch checked={settings.store.autoApplyDms} onChange={value => settings.store.autoApplyDms = value} />
            </label>
            <label className="vc-privacy-pruner-switch-row">
                <Forms.FormText>Group Direct Messages</Forms.FormText>
                <Switch checked={settings.store.autoApplyGroupDms} onChange={value => settings.store.autoApplyGroupDms = value} />
            </label>
        </div>
    );
}

function ChannelPruningModal({ rootProps, input }: { rootProps: RenderModalProps; input: ChannelModalInput; }) {
    settings.use(["syncedState"]);
    const existing = readSyncedState().channels[input.channelId];
    const initialPolicy = existing?.policy ?? DEFAULT_POLICY;
    const [retention, setRetention] = useState(() => durationToParts(initialPolicy.retentionMs));
    const [lookback, setLookback] = useState(() => durationToParts(initialPolicy.maximumLookbackMs));
    const [interval, setInterval] = useState(() => durationToParts(initialPolicy.scanIntervalMs));
    const [includeThreads, setIncludeThreads] = useState(initialPolicy.includeThreads ?? true);
    const [preview, setPreview] = useState<PreviewResult | undefined>();
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | undefined>();
    const [result, setResult] = useState<string | undefined>();
    const [scanProgress, setScanProgress] = useState<CollectionProgress | undefined>();
    const scanController = useRef<AbortController | undefined>();


    const candidate = useMemo<ChannelPolicy | undefined>(() => {
        const retentionMs = durationFromParts(retention.value, retention.unit);
        const maximumLookbackMs = durationFromParts(lookback.value, lookback.unit);
        const scanIntervalMs = durationFromParts(interval.value, interval.unit);
        if (retentionMs == null || maximumLookbackMs == null || scanIntervalMs == null) return;
        return { enabled: true, retentionMs, maximumLookbackMs, scanIntervalMs, includeThreads };
    }, [retention, lookback, interval, includeThreads]);
    const validation = candidate ? validatePolicy(candidate) : ["Enter a positive number and choose a unit for every duration."];
    const latestValidPolicy = useRef<ChannelPolicy | undefined>();
    latestValidPolicy.current = validation.length === 0 ? candidate : undefined;
    useEffect(() => {
        pauseChannelPruning(input.channelId);
        return () => {
            scanController.current?.abort();
            const editedPolicy = latestValidPolicy.current;
            if (editedPolicy) {
                writeSyncedState(saveChannelPolicySettings(
                    readSyncedState(),
                    input.channelId,
                    input.guildId,
                    editedPolicy,
                ));
            }
            resumeChannelPruning(input.channelId);
        };
    }, [input.channelId, input.guildId]);

    const guildEnabled = input.guildId == null || readSyncedState().guilds[input.guildId]?.enabled === true;
    const progress = getChannelProgress(input.channelId);

    async function createPreview() {
        if (!candidate || validation.length) return;
        const controller = new AbortController();
        let latestProgress: CollectionProgress | undefined;
        scanController.current = controller;
        setBusy(true);
        setError(undefined);
        setResult(undefined);
        setPreview(undefined);
        setScanProgress({
            pagesScanned: 0,
            messagesInspected: 0,
            ownedMessagesFound: 0,
            eligibleMessagesFound: 0,
        });
        try {
            const nextPreview = await previewChannel(input.channelId, input.guildId, candidate, Date.now(), {
                signal: controller.signal,
                onProgress(nextProgress) {
                    latestProgress = nextProgress;
                    setScanProgress(nextProgress);
                },
                onPartialResult(partialPreview) {
                    setPreview(partialPreview);
                },
            });
            setPreview(nextPreview);
            setResult(nextPreview.stopped
                ? `Scan stopped. Preserved ${nextPreview.messages.length} eligible messages already found.`
                : nextPreview.completedBy === "channel-start"
                    ? `Scan completed at the beginning of this channel. Found ${nextPreview.messages.length} messages eligible for deletion.`
                    : `Scan completed at the configured history limit. Found ${nextPreview.messages.length} messages eligible for deletion.`);
        } catch (previewError) {
            const detail = formatUnknownError(previewError);
            console.error("[PrivacyPruner] Preview failed", previewError);
            setError(`Scan failed after ${latestProgress?.messagesInspected ?? 0} inspected messages: ${detail}`);
        } finally {
            if (scanController.current === controller) scanController.current = undefined;
            setBusy(false);
        }
    }

    function stopPreview() {
        scanController.current?.abort();
        setResult("Stopping after the current Discord history request…");
    }

    function enableWithoutPreview() {
        if (!candidate) return;
        enableChannelPolicy(input.channelId, input.guildId, candidate);
        setResult("Channel pruning enabled. Eligible messages will be deleted page by page at this channel's next scheduled run.");
    }

    async function confirmDeletion() {
        if (!candidate || !preview) return;
        setBusy(true);
        setError(undefined);
        try {
            const deletion = await confirmChannelPolicy(input.channelId, input.guildId, candidate, preview);
            setResult(`Enabled. Deleted ${deletion.deletedCount} messages; ${deletion.failureCount} will be retried.`);
            setPreview(undefined);
        } catch (deletionError) {
            setError(formatUnknownError(deletionError));
        } finally {
            setBusy(false);
        }
    }

    function disableChannel() {
        const state = readSyncedState();
        const record = state.channels[input.channelId];
        if (!record) return;
        writeSyncedState(setChannelPolicy(state, input.channelId, input.guildId, { ...record.policy, enabled: false }));
        setPreview(undefined);
        setResult("Channel pruning disabled. Keep markers were preserved.");
    }

    function keepPreviewMessage(message: PrunableMessage) {
        const state = readSyncedState();
        writeSyncedState(setMessageKept(state, {
            messageId: message.id,
            channelId: message.channelId,
            guildId: input.guildId ?? undefined,
        }, true));
        setPreview(current => current && ({
            ...current,
            messages: current.messages.filter(candidateMessage => candidateMessage.id !== message.id),
            keptCount: current.keptCount + 1,
        }));
    }

    return (
        <Modal {...rootProps} title={`Privacy Pruning — ${input.channelName}`}>
            <Forms.FormText className={Margins.bottom16}>
                Guild gate: {guildEnabled ? "enabled" : "disabled"}. Channel pruning runs only when both switches are enabled.
            </Forms.FormText>
            {existing?.policy.enabled && (
                <Forms.FormText className="vc-privacy-pruner-warning" role="status">
                    Automatic pruning is paused while these channel settings are open. This channel&apos;s timer is stopped now and will be scheduled once when you close this window.
                </Forms.FormText>
            )}
            {!guildEnabled && input.guildId && (
                <Forms.FormText className="vc-privacy-pruner-warning">
                    You can configure this channel now, but pruning remains paused until Privacy Pruning is enabled for the guild.
                </Forms.FormText>
            )}
            <DurationField title="Retention" description="Unmarked messages older than this are eligible for deletion." value={retention} onChange={setRetention} />
            <DurationField title="Maximum search history" description="Must be strictly longer than retention." value={lookback} onChange={setLookback} />
            <DurationField title="Scan interval" description="How often this channel is checked while Discord is running." value={interval} onChange={setInterval} />
            {input.guildId && (
                <label className="vc-privacy-pruner-switch-row">
                    <div>
                        <Forms.FormTitle tag="h3">Include fires/threads</Forms.FormTitle>
                        <Forms.FormText>
                            Treat messages in this channel&apos;s threads as part of the channel. Archived threads are handled automatically.
                        </Forms.FormText>
                    </div>
                    <Switch checked={includeThreads} onChange={setIncludeThreads} />
                </label>
            )}
            {validation.map(message => <Forms.FormText key={message} className="vc-privacy-pruner-danger">{message}</Forms.FormText>)}
            {progress?.lastScanAt && <Forms.FormText>Last scan: {new Date(progress.lastScanAt).toLocaleString()}</Forms.FormText>}
            {busy && scanProgress && (
                <div className="vc-privacy-pruner-scan-status" role="status" aria-live="polite">
                    <span className="vc-privacy-pruner-spinner" aria-hidden="true" />
                    <div>
                        <Forms.FormTitle tag="h3">Scanning channel history…</Forms.FormTitle>
                        <Forms.FormText>
                            Reached {scanProgress.oldestInspectedTimestamp == null
                                ? "the newest messages"
                                : `${formatElapsedDuration(Date.now() - scanProgress.oldestInspectedTimestamp)} ago`}
                            {" · "}{scanProgress.messagesInspected} inspected
                            {" · "}{scanProgress.ownedMessagesFound} yours
                            {" · "}{scanProgress.eligibleMessagesFound} eligible
                        </Forms.FormText>
                    </div>
                </div>
            )}
            {error && <Forms.FormText className="vc-privacy-pruner-danger">{error}</Forms.FormText>}
            {result && <Forms.FormText className="vc-privacy-pruner-success">{result}</Forms.FormText>}
            {preview && <PreviewSummary preview={preview} guildId={input.guildId} onKeep={keepPreviewMessage} />}
            <div className="vc-privacy-pruner-actions">
                <Button disabled={busy || validation.length > 0} onClick={createPreview}>
                    Preview messages eligible for deletion
                </Button>
                {!existing?.policy.enabled && (
                    <Button disabled={busy || validation.length > 0} onClick={enableWithoutPreview}>
                        Enable pruning without preview
                    </Button>
                )}
                {busy && <Button onClick={stopPreview}>Stop scan</Button>}
                {preview && (
                    <Button variant="dangerPrimary" disabled={busy} onClick={confirmDeletion}>
                        Confirm deletion and enable
                    </Button>
                )}
                {existing?.policy.enabled && <Button variant="dangerPrimary" disabled={busy} onClick={disableChannel}>Disable channel pruning</Button>}
            </div>
        </Modal>
    );
}

export function openDeleteConfirmation(
    channelId: string,
    messageId: string,
    onDeleted: () => void,
    message?: PrunableMessage,
) {
    openModal(rootProps => (
        <Modal {...rootProps} title="Permanently delete message?">
            <Forms.FormText>
                This deletes the Discord message immediately. It cannot be restored.
            </Forms.FormText>
            {message && (
                <div className="vc-privacy-pruner-delete-preview">
                    <Forms.FormText>{new Date(message.timestamp).toLocaleString()}</Forms.FormText>
                    <div className="vc-privacy-pruner-message-content">
                        {message.content || "(message has no text content)"}
                    </div>
                </div>
            )}
            <div className="vc-privacy-pruner-actions">
                <Button onClick={rootProps.onClose}>Cancel</Button>
                <Button
                    variant="dangerPrimary"
                    onClick={async () => {
                        await deleteMessageNow(channelId, messageId);
                        onDeleted();
                        rootProps.onClose();
                    }}
                >
                    Delete permanently
                </Button>
            </div>
        </Modal>
    ));
}

const SafePrivacyManagerModal = ErrorBoundary.wrap(PrivacyManagerModal, {
    message: "Privacy Manager failed to render. Check DevTools for the PrivacyPruner error.",
});

function removeKeptMessage(messageId: string): void {
    const current = readSyncedState();
    const next = { ...current, kept: { ...current.kept } };
    delete next.kept[messageId];
    writeSyncedState(next);
}

function KeptMessageRow({ messageId, record }: { messageId: string; record: KeptMessageRecord; }) {
    const [message, setMessage] = useState<PrunableMessage>();
    const [error, setError] = useState<string>();

    useEffect(() => {
        let active = true;
        void fetchMessageDetail(record.channelId, messageId).then(
            detail => {
                if (active) setMessage(detail);
            },
            detailError => {
                console.error("[PrivacyPruner] Failed to load kept message", { messageId, detailError });
                if (active) setError(formatUnknownError(detailError));
            },
        );
        return () => {
            active = false;
        };
    }, [messageId, record.channelId]);

    return (
        <div className="vc-privacy-pruner-kept">
            <div className="vc-privacy-pruner-kept-copy">
                {message ? (
                    <>
                        <div className="vc-privacy-pruner-message-content">
                            {message.content || "(message has no text content)"}
                        </div>
                        <Forms.FormText className="vc-privacy-pruner-kept-meta">
                            {new Date(message.timestamp).toLocaleString()}
                        </Forms.FormText>
                    </>
                ) : error ? (
                    <Forms.FormText className="vc-privacy-pruner-danger">
                        Message unavailable: {error}
                    </Forms.FormText>
                ) : (
                    <Forms.FormText>Loading message…</Forms.FormText>
                )}
            </div>
            <div className="vc-privacy-pruner-row-actions">
                <Button size="small" onClick={() => NavigationRouter.transitionTo(
                    `/channels/${record.guildId ?? "@me"}/${record.channelId}/${messageId}`
                )}>Jump</Button>
                <Button size="small" onClick={() => removeKeptMessage(messageId)}>Remove Keep</Button>
                <Button
                    size="small"
                    variant="dangerPrimary"
                    disabled={!message}
                    onClick={() => openDeleteConfirmation(
                        record.channelId,
                        messageId,
                        () => removeKeptMessage(messageId),
                        message,
                    )}
                >
                    Delete
                </Button>
            </div>
        </div>
    );
}

function PrivacyManagerModal({ rootProps }: { rootProps: RenderModalProps; }) {
    settings.use(["syncedState"]);
    const kept = Object.entries(readSyncedState().kept);
    return (
        <Modal {...rootProps} title="Privacy Pruner — Kept Messages">
            {kept.length === 0 ? (
                <Forms.FormText>No messages are protected with Keep.</Forms.FormText>
            ) : kept.map(([messageId, record]) => (
                <KeptMessageRow key={messageId} messageId={messageId} record={record} />
            ))}
        </Modal>
    );
}

export function openChannelPruningModal(input: ChannelModalInput): void {
    openModal(rootProps => <ChannelPruningModal rootProps={rootProps} input={input} />);
}

export function openPrivacyManager(): void {
    openModal(rootProps => <SafePrivacyManagerModal rootProps={rootProps} />);
}
