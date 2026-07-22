import assert from "node:assert/strict";
import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
    MAX_ACQUISITION_FILE_BYTES,
    MAX_ACQUISITION_FILE_COUNT,
    MAX_ACQUISITION_RESPONSE_BYTES,
    UserPluginManagerSafetyError,
    assertAcquisitionLimits,
    assertSafeArchiveEntryPath,
    createDestinationSlug,
    redactSensitiveData,
    resolveContainedDestination,
    resolveContainedExistingPath,
    resolveOperationCleanupPath
} from "../../core/src/shared/userPluginManagerSafety.ts";

test("traversal, absolute, encoded, device, and NUL archive paths are rejected", () => {
    for (const path of [
        "../escape.ts",
        "/absolute.ts",
        "%2e%2e/encoded.ts",
        "nested/%2E%2E/escape.ts",
        "C:\\device.ts",
        "\\\\.\\C:\\device.ts",
        "safe/evil\0.ts"
    ]) {
        assert.throws(() => assertSafeArchiveEntryPath(path), (error: unknown) => {
            return error instanceof UserPluginManagerSafetyError && error.code === "UNSAFE_PATH";
        }, path);
    }

    assert.equal(assertSafeArchiveEntryPath("folder/plugin.ts"), "folder/plugin.ts");
});

test("canonical containment rejects existing and not-yet-created symlink escapes", async () => {
    const fixture = await mkdtemp(join(tmpdir(), "upm-safety-"));
    const staging = join(fixture, "staging");
    const outside = join(fixture, "outside");
    await mkdir(join(staging, "safe"), { recursive: true });
    await mkdir(outside);
    await writeFile(join(outside, "secret.ts"), "export default 1;");
    await symlink(outside, join(staging, "escape"));

    await assert.rejects(resolveContainedExistingPath(staging, join(staging, "escape", "secret.ts")), (error: unknown) => {
        return error instanceof UserPluginManagerSafetyError && error.code === "PATH_ESCAPE";
    });
    await assert.rejects(resolveContainedDestination(staging, join(staging, "escape", "future.ts")), (error: unknown) => {
        return error instanceof UserPluginManagerSafetyError && error.code === "PATH_ESCAPE";
    });
    assert.equal(
        await resolveContainedDestination(staging, join(staging, "safe", "future.ts")),
        join(staging, "safe", "future.ts")
    );
});

test("destination slug collisions fail instead of overwriting", () => {
    assert.equal(createDestinationSlug("My Useful Plugin"), "my-useful-plugin");
    assert.throws(() => createDestinationSlug("my--useful_plugin", ["my-useful-plugin"]), (error: unknown) => {
        return error instanceof UserPluginManagerSafetyError && error.code === "DESTINATION_COLLISION";
    });

    for (const invalid of ["", ".", "..", "folder/plugin", "folder\\plugin"])
        assert.throws(() => createDestinationSlug(invalid), UserPluginManagerSafetyError);
});

test("URL credentials and token-like values are redacted recursively", () => {
    const secretLocator = "https://alice:password@example.com/plugin.ts?token=secret&safe=yes&signature=signed";
    const redacted = redactSensitiveData({
        locator: secretLocator,
        nested: [secretLocator],
        accessToken: "raw-access-token",
        safe: "visible"
    });
    const serialized = JSON.stringify(redacted);

    assert.equal(redacted.safe, "visible");
    assert.match(redacted.locator, /^https:\/\/example\.com\/plugin\.ts\?/);
    assert.match(redacted.locator, /safe=yes/);
    for (const secret of ["alice", "password", "secret", "signed", "raw-access-token"])
        assert.equal(serialized.includes(secret), false, secret);
    assert.match(serialized, /REDACTED/);
});

test("acquisition maximums reject oversized input before destination mutation", () => {
    const destination = { mutated: false };
    assert.throws(() => {
        assertAcquisitionLimits({ responseBytes: MAX_ACQUISITION_RESPONSE_BYTES + 1 });
        destination.mutated = true;
    }, (error: unknown) => error instanceof UserPluginManagerSafetyError && error.code === "LIMIT_EXCEEDED");
    assert.equal(destination.mutated, false);

    assert.throws(() => assertAcquisitionLimits({
        responseBytes: 1,
        expandedBytes: MAX_ACQUISITION_FILE_BYTES * 2,
        files: Array.from({ length: MAX_ACQUISITION_FILE_COUNT + 1 }, (_, index) => ({
            path: `plugin-${index}.ts`,
            bytes: 1
        }))
    }), (error: unknown) => error instanceof UserPluginManagerSafetyError && error.code === "LIMIT_EXCEEDED");

    assert.throws(() => assertAcquisitionLimits({
        responseBytes: 1,
        expandedBytes: MAX_ACQUISITION_FILE_BYTES + 1,
        files: [{ path: "large.ts", bytes: MAX_ACQUISITION_FILE_BYTES + 1 }]
    }), (error: unknown) => error instanceof UserPluginManagerSafetyError && error.code === "LIMIT_EXCEEDED");
});

test("cleanup accepts only operation-owned paths below manager data", async () => {
    const fixture = await mkdtemp(join(tmpdir(), "upm-cleanup-"));
    const managerData = join(fixture, "manager");
    const operationRoot = join(managerData, "operations", "operation-1");
    const outside = join(fixture, "outside");
    await mkdir(join(operationRoot, "staging"), { recursive: true });
    await mkdir(outside);

    assert.equal(
        await resolveOperationCleanupPath(managerData, operationRoot, join(operationRoot, "staging")),
        join(operationRoot, "staging")
    );
    await assert.rejects(resolveOperationCleanupPath(managerData, operationRoot, outside), (error: unknown) => {
        return error instanceof UserPluginManagerSafetyError && error.code === "UNSAFE_CLEANUP";
    });
    await assert.rejects(resolveOperationCleanupPath(managerData, outside, outside), (error: unknown) => {
        return error instanceof UserPluginManagerSafetyError && error.code === "UNSAFE_CLEANUP";
    });
});
