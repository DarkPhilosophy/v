import assert from "node:assert/strict";
import test from "node:test";

import { installNoopSentryIpc, SENTRY_IPC_NAMESPACE } from "../core/src/sentryIpc.ts";

test("NoTrack preload installs an inert Sentry IPC bridge", () => {
    const target: Record<string, unknown> = {};
    installNoopSentryIpc(target);

    const bridge = target.__SENTRY_IPC__ as Record<string, Record<string, (...args: unknown[]) => void>>;
    const channel = bridge[SENTRY_IPC_NAMESPACE];
    assert.ok(channel);
    for (const method of ["sendRendererStart", "sendScope", "sendEnvelope", "sendStatus", "sendStructuredLog", "sendMetric"]) {
        assert.equal(typeof channel[method], "function");
        assert.equal(channel[method](), undefined);
    }
});

test("NoTrack preload preserves a real Sentry IPC bridge", () => {
    const realChannel = { sendRendererStart() { return "real"; } };
    const target: Record<string, unknown> = {
        __SENTRY_IPC__: { [SENTRY_IPC_NAMESPACE]: realChannel }
    };

    installNoopSentryIpc(target);
    assert.equal((target.__SENTRY_IPC__ as Record<string, unknown>)[SENTRY_IPC_NAMESPACE], realChannel);
});
