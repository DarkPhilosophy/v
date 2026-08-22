export interface DeferredHandler {
    (): void;
    cancel(): void;
}

export function createDeferredHandler(
    action: () => void | Promise<void>,
    onError: (error: unknown) => void = () => undefined,
): DeferredHandler {
    let generation = 0;
    let scheduled = false;
    let pending = false;
    let running = false;

    const schedule = () => {
        pending = true;
        if (scheduled || running) return;
        scheduled = true;
        const current = generation;
        queueMicrotask(() => {
            scheduled = false;
            if (current !== generation || !pending) return;
            pending = false;
            running = true;
            Promise.resolve().then(action).catch(onError).finally(() => {
                running = false;
                if (current === generation && pending) schedule();
            });
        });
    };

    schedule.cancel = () => {
        generation++;
        pending = false;
        scheduled = false;
    };
    return schedule;
}
