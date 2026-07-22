/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { ErrorCard } from "@components/ErrorCard";
import { Heading } from "@components/Heading";
import { Paragraph } from "@components/Paragraph";
import { Span } from "@components/Span";
import { classNameFactory } from "@utils/css";
import { Margins } from "@utils/margins";
import { classes } from "@utils/misc";
import type { ReactNode } from "react";

import type {
    SourceKind,
    SourceShape,
    UpdatePolicy,
    UserPluginManagerInspection
} from "../../../../../shared/userPluginManager";

export const cl = classNameFactory("vc-upm-");

export interface SourceKindMeta {
    label: string;
    locatorLabel: string;
    locatorPlaceholder: string;
    supportsRef: boolean;
    supportsSubpath: boolean;
    hint: string;
}

/** User-facing metadata for every {@link SourceKind} the shared types accept. */
export const SOURCE_KIND_META: Record<SourceKind, SourceKindMeta> = {
    "git": {
        label: "Git repository",
        locatorLabel: "Repository URL",
        locatorPlaceholder: "https://github.com/owner/repo",
        supportsRef: true,
        supportsSubpath: true,
        hint: "Cloned read-only and pinned to a single commit. Submodules and Git LFS payloads are rejected."
    },
    "http-archive": {
        label: "HTTPS archive",
        locatorLabel: "Archive URL",
        locatorPlaceholder: "https://example.com/plugin.zip",
        supportsRef: false,
        supportsSubpath: true,
        hint: "A .zip or .tar downloaded over HTTPS. Nested archives are rejected."
    },
    "http-file": {
        label: "HTTPS file",
        locatorLabel: "File URL",
        locatorPlaceholder: "https://example.com/plugin.ts",
        supportsRef: false,
        supportsSubpath: false,
        hint: "A single .ts or .tsx plugin fetched over HTTPS."
    },
    "local-directory": {
        label: "Local folder",
        locatorLabel: "Folder path",
        locatorPlaceholder: "/home/you/plugins/myPlugin",
        supportsRef: false,
        supportsSubpath: true,
        hint: "An absolute path to a plugin folder already on this machine."
    },
    "local-file": {
        label: "Local file",
        locatorLabel: "File path",
        locatorPlaceholder: "/home/you/plugins/myPlugin.ts",
        supportsRef: false,
        supportsSubpath: false,
        hint: "An absolute path to a single .ts or .tsx plugin file on this machine."
    }
};

/** Order the source kinds are offered in the Add Source picker. */
export const SOURCE_KIND_ORDER: SourceKind[] = ["git", "http-archive", "http-file", "local-directory", "local-file"];

export const SHAPE_LABEL: Record<SourceShape, string> = {
    "plugin-root": "Plugin folder",
    "collection": "Collection of plugins",
    "single-file": "Single file"
};

export const UPDATE_POLICY_LABEL: Record<UpdatePolicy, string> = {
    "manual": "Manual — only when I check",
    "check-on-open": "Check automatically when settings open"
};

const ERROR_CODE_TITLE: Record<string, string> = {
    "INACTIVE": "Manager is disabled",
    "PENDING_CHANGES": "Pending changes remain",
    "PENDING_CHANGE_CONFLICT": "Conflicting pending change",
    "RECOVERY_REQUIRED": "Recovery required",
    "PROTECTED_INFRASTRUCTURE": "Protected component",
    "UNKNOWN_SOURCE": "Source not found",
    "UNKNOWN_INSPECTION": "Inspection expired",
    "EXPIRED_INSPECTION": "Inspection expired",
    "STALE_INSPECTION": "Inspection expired",
    "INVALID_OPERATION": "Operation not allowed",
    "BUILD_FAILED": "Build failed",
    "RECOVERY_BUILD_FAILED": "Recovery build failed",
    "UNSUPPORTED_SCHEMA_VERSION": "Unsupported manager data",
    "UNSAFE_SOURCE": "Unsafe source",
    "UNSUPPORTED_SOURCE_SHAPE": "Unsupported source layout",
    "UNSUPPORTED_ARCHIVE": "Unsupported archive",
    "HTTP_ERROR": "Download failed",
    "LIMIT_EXCEEDED": "Source too large",
    "ACQUISITION_FAILED": "Could not fetch source"
};

export interface ManagerError {
    message: string;
    code?: string;
}

/** Normalise a rejected IPC call (an `Error` carrying a `code`) into a display shape. */
export function toManagerError(error: unknown): ManagerError {
    if (error instanceof Error) {
        const { code } = error as { code?: unknown; };
        return { message: error.message, code: typeof code === "string" ? code : undefined };
    }
    return { message: "The User Plugin Manager operation failed." };
}

/** Validate a locator against its source kind before an inspection is attempted. */
export function validateLocator(kind: SourceKind, locator: string): string | null {
    if (!locator) return `${SOURCE_KIND_META[kind].locatorLabel} is required.`;

    if (kind === "http-archive" || kind === "http-file") {
        let url: URL;
        try {
            url = new URL(locator);
        } catch {
            return "Enter a full URL, e.g. https://example.com/plugin.ts";
        }
        if (url.protocol !== "https:") return "Only https:// URLs are allowed.";
        if (kind === "http-file" && !/\.tsx?$/i.test(url.pathname)) return "The URL must point to a .ts or .tsx file.";
        return null;
    }

    if (kind === "local-directory" || kind === "local-file") {
        if (!locator.startsWith("/")) return "Enter an absolute path starting with “/”.";
        if (kind === "local-file" && !/\.tsx?$/i.test(locator)) return "Plugin files must end in .ts or .tsx.";
        return null;
    }

    return null;
}

export type BadgeTone = "brand" | "danger" | "warning" | "success" | "muted";

export function Badge({ tone = "muted", children }: { tone?: BadgeTone; children: ReactNode; }) {
    return (
        <span className={classes(cl("badge"), tone !== "muted" && cl(`badge--${tone}`))}>
            {children}
        </span>
    );
}

export function ErrorDisplay({ error }: { error: ManagerError; }) {
    return (
        <ErrorCard className={classes(cl("error"), Margins.bottom8)}>
            <Span weight="semibold">{(error.code && ERROR_CODE_TITLE[error.code]) || "Something went wrong"}</Span>
            <Span>{error.message}</Span>
            {error.code ? <Span className={cl("meta")}>Error code: {error.code}</Span> : null}
        </ErrorCard>
    );
}

export function InspectionReview({ inspection, installedRevision }: {
    inspection: UserPluginManagerInspection;
    installedRevision?: string;
}) {
    const upToDate = installedRevision != null && installedRevision === inspection.resolvedRevision;

    return (
        <div className={cl("review")}>
            <dl className={cl("review-grid")}>
                <dt>Type</dt>
                <dd><Span>{SOURCE_KIND_META[inspection.kind].label}</Span></dd>
                <dt>Layout</dt>
                <dd><Span>{SHAPE_LABEL[inspection.shape]}</Span></dd>
                {inspection.requestedRef ? (
                    <>
                        <dt>Requested ref</dt>
                        <dd><span className={cl("code")}>{inspection.requestedRef}</span></dd>
                    </>
                ) : null}
                <dt>Resolved revision</dt>
                <dd><span className={cl("code")}>{inspection.resolvedRevision}</span></dd>
                {installedRevision != null ? (
                    <>
                        <dt>Installed revision</dt>
                        <dd><span className={cl("code")}>{installedRevision}</span></dd>
                    </>
                ) : null}
                <dt>Source</dt>
                <dd><span className={cl("code")}>{inspection.locator}</span></dd>
            </dl>

            {upToDate ? (
                <Paragraph className={Margins.top8}>
                    This source already matches the installed revision. Queueing will re-sync the files on disk.
                </Paragraph>
            ) : null}

            <Heading tag="h5" className={Margins.top8}>Files ({inspection.entries.length})</Heading>
            {inspection.entries.length === 0 ? (
                <Paragraph className={cl("meta")}>The source contains no installable plugin files.</Paragraph>
            ) : (
                <div className={cl("entries")}>
                    {inspection.entries.map(entry => (
                        <div className={cl("entry")} key={`${entry.kind}:${entry.destination}:${entry.sourcePath}`}>
                            <Badge tone={entry.kind === "shared" ? "warning" : "brand"}>{entry.kind}</Badge>
                            <span className={cl("code")}>{entry.destination}</span>
                            <span className={cl("entry-path")}>{entry.sourcePath}</span>
                        </div>
                    ))}
                </div>
            )}
        </div>
    );
}
