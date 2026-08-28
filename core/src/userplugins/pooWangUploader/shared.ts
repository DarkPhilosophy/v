export const POO_WANG_BASE_URL = "https://poo.wang";

export type PooWangMediaKind = "image" | "video" | "audio" | "unsafe-image" | "file";

export interface PooWangUploadFile {
    id: string;
    name: string;
    url: string;
    contentType?: string;
    mediaKind?: PooWangMediaKind;
}

export interface PooWangUploadResult {
    ok: boolean;
    status: number;
    file?: PooWangUploadFile;
    error?: string;
}

export type UploadRoute = "discord" | "prompt" | "poo-wang";

type UnknownRecord = Record<string, unknown>;

function asRecord(value: unknown): UnknownRecord | undefined {
    return value != null && typeof value === "object" && !Array.isArray(value)
        ? value as UnknownRecord
        : undefined;
}

export function parseUploadFile(payload: unknown, baseUrl = POO_WANG_BASE_URL): PooWangUploadFile | undefined {
    const response = asRecord(payload);
    const first = Array.isArray(response?.files) ? asRecord(response.files[0]) : undefined;
    if (
        !first
        || typeof first.id !== "string"
        || typeof first.name !== "string"
        || typeof first.url !== "string"
        || (first.contentType != null && typeof first.contentType !== "string")
        || (first.mediaKind != null && !["image", "video", "audio", "unsafe-image", "file"].includes(String(first.mediaKind)))
    ) return;

    try {
        const expectedOrigin = new URL(baseUrl).origin;
        const url = new URL(first.url);
        if (url.origin !== expectedOrigin || !url.pathname.startsWith("/f/")) return;
        return {
            id: first.id,
            name: first.name,
            url: url.href,
            contentType: first.contentType as string | undefined,
            mediaKind: first.mediaKind as PooWangMediaKind | undefined
        };
    } catch {
        return;
    }
}

export function getUploadError(payload: unknown, fallback: string): string {
    const response = asRecord(payload);
    return typeof response?.error === "string" && response.error.trim()
        ? response.error.trim()
        : fallback;
}

const DISCORD_PREVIEWABLE_CONTENT_TYPES = new Set([
    "image/avif",
    "image/gif",
    "image/jpeg",
    "image/png",
    "image/webp",
    "video/mp4",
    "video/quicktime",
    "video/webm",
    "video/x-m4v"
]);


export function formatUploadLinks(files: readonly PooWangUploadFile[]): string {
    return files.map(file => {
        const contentType = file.contentType?.toLowerCase();
        const previewable = (file.mediaKind === "image" || file.mediaKind === "video")
            && contentType != null
            && DISCORD_PREVIEWABLE_CONTENT_TYPES.has(contentType);
        return previewable ? `[${file.mediaKind}](${file.url})` : file.url;
    }).join("\n");
}

export function composeUploadMessage(content: string, links: string): string {
    const existing = content.trimEnd();
    return existing ? `${existing}\n${links}` : links;
}

export function selectUploadRoute(input: {
    enabled: boolean;
    tokenConfigured: boolean;
    isThumbnail: boolean;
    fileSizes: readonly number[];
    rerouteByDefault: boolean;
    autoRerouteLargeFiles: boolean;
    largeFileThresholdBytes: number;
}): UploadRoute {
    if (!input.enabled || input.isThumbnail || input.fileSizes.length === 0) return "discord";
    if (!input.tokenConfigured) return "prompt";
    if (input.rerouteByDefault) return "poo-wang";
    if (
        input.autoRerouteLargeFiles
        && input.fileSizes.some(size => size >= input.largeFileThresholdBytes)
    ) return "poo-wang";
    return "prompt";
}
export function isAttachmentPlusClassName(className: string): boolean {
    return className.includes("attachButtonPlus") || className.includes("attachButton_");
}

const TAR_EXTENSION = /\.tar\.[^.]+$/i;

export function randomizeUploadName(
    originalName: string,
    length: number,
    configuredCharacters: string,
    randomIndex: (upperBound: number) => number
): string {
    const characters = [...new Set(configuredCharacters)].filter(character =>
        /^[\x20-\x7E]$/.test(character) && !/[\/\\:"*?<>|]/.test(character)
    );
    if (characters.length === 0) throw new Error("Random filename characters must include at least one safe printable ASCII character.");

    const boundedLength = Math.min(64, Math.max(3, Math.floor(length)));
    const tarMatch = TAR_EXTENSION.exec(originalName);
    const extensionIndex = tarMatch?.index ?? originalName.lastIndexOf(".");
    const extension = extensionIndex > 0 ? originalName.slice(extensionIndex) : "";
    let name = "";
    for (let index = 0; index < boundedLength; index++) {
        const selected = Math.min(characters.length - 1, Math.max(0, Math.floor(randomIndex(characters.length))));
        name += characters[selected];
    }
    return name + extension;
}

export function secureRandomIndex(upperBound: number): number {
    if (upperBound <= 1) return 0;
    const sample = new Uint32Array(1);
    crypto.getRandomValues(sample);
    return sample[0] % upperBound;
}
