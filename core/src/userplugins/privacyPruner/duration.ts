const UNIT_MS: Record<string, number> = {
    s: 1_000,
    m: 60_000,
    h: 3_600_000,
    d: 86_400_000,
    w: 604_800_000,
    mo: 2_592_000_000,
    y: 31_536_000_000,
};

export type DurationUnit = "seconds" | "minutes" | "hours" | "days" | "weeks" | "months" | "years";

const STRUCTURED_UNIT_MS: Record<DurationUnit, number> = {
    seconds: UNIT_MS.s,
    minutes: UNIT_MS.m,
    hours: UNIT_MS.h,
    days: UNIT_MS.d,
    weeks: UNIT_MS.w,
    months: UNIT_MS.mo,
    years: UNIT_MS.y,
};

export function durationFromParts(value: string, unit: DurationUnit): number | undefined {
    const numericValue = Number(value);
    const milliseconds = numericValue * STRUCTURED_UNIT_MS[unit];
    return Number.isFinite(milliseconds) && milliseconds > 0 ? milliseconds : undefined;
}

export function durationToParts(milliseconds: number): { value: string; unit: DurationUnit; } {
    for (const unit of ["years", "months", "weeks", "days", "hours", "minutes", "seconds"] as const) {
        const size = STRUCTURED_UNIT_MS[unit];
        if (milliseconds >= size && milliseconds % size === 0)
            return { value: String(milliseconds / size), unit };
    }
    return { value: String(milliseconds / STRUCTURED_UNIT_MS.seconds), unit: "seconds" };
}

export function parseDuration(input: string): number | undefined {
    const match = /^\s*(\d+(?:\.\d+)?)\s*(s|m|h|d|w|mo|y)\s*$/i.exec(input);
    if (!match) return;
    const value = Number(match[1]);
    const unit = UNIT_MS[match[2].toLowerCase()];
    const milliseconds = value * unit;
    return Number.isFinite(milliseconds) && milliseconds > 0 ? milliseconds : undefined;
}

export function formatDuration(milliseconds: number): string {
    for (const unit of ["y", "w", "d", "h", "m", "s"]) {
        const size = UNIT_MS[unit];
        if (milliseconds >= size && milliseconds % size === 0)
            return `${milliseconds / size}${unit}`;
    }
    return `${milliseconds}ms`;
}

export function formatElapsedDuration(milliseconds: number): string {
    const parts: string[] = [];
    let remaining = Math.max(0, Math.floor(milliseconds));
    for (const unit of ["y", "w", "d", "h", "m", "s"]) {
        const size = UNIT_MS[unit];
        const count = Math.floor(remaining / size);
        if (count > 0) {
            parts.push(`${count}${unit}`);
            remaining -= count * size;
        }
        if (parts.length === 3) break;
    }
    return parts.length > 0 ? parts.join(" ") : "0s";
}
