const AUTOMATABLE_TASKS: Record<string, true> = {
    WATCH_VIDEO: true,
    WATCH_VIDEO_ON_MOBILE: true,
    PLAY_ON_DESKTOP: true,
    STREAM_ON_DESKTOP: true,
};

export function isAutomatableQuest(tasks: Record<string, unknown>): boolean {
    return Object.keys(tasks).some(task => AUTOMATABLE_TASKS[task]);
}
