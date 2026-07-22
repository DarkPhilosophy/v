# UserPlugin Manager — implementation plan

## Status

Approved design: [`USERPLUGIN_MANAGER_DESIGN.md`](./USERPLUGIN_MANAGER_DESIGN.md).

This document plans the implementation only. It does not authorize changes to the live `~/.config/Vencord` installation, commits, pushes, or external writes. Before the live-install verification step, preserve the existing modified Vencord checkout and request explicit confirmation because that step overwrites installed userplugin files and rebuilds Discord's loaded bundle.

## Delivery boundary

Implement the manager as core Vencord functionality integrated into the existing Plugins page.

Repository-owned sources:

```text
core/src/
├── components/settings/tabs/plugins/UserPluginManager/
│   ├── index.tsx
│   ├── ActivationGate.tsx
│   ├── AddSourceModal.tsx
│   ├── SourceManagerModal.tsx
│   ├── PendingChangesBar.tsx
│   ├── PendingChangesModal.tsx
│   ├── UserPluginCardDetails.tsx
│   └── styles.css
├── main/userPluginManager/
│   ├── index.ts
│   ├── sources.ts
│   └── transaction.ts
└── shared/
    ├── userPluginManager.ts
    └── userPluginManagerSafety.ts

patches/userplugin-manager.patch
tests/userPluginManager/
install.sh
patches/update.patch
.github/README.md
```

`install.sh` copies `core/src/*` into the matching Vencord source paths. `patches/userplugin-manager.patch` changes only tracked upstream integration points: render the core control in the Plugins page, declare/bind IPC, and register the main-process handlers. `patches/update.patch` reapplies this required patch after upstream pulls.

The manager is not in `src/userplugins`, does not appear as a plugin card, and cannot be removed through source-management operations.
## Fixed contracts

### Persistent state

Store schema-versioned state under Vencord's authoritative `DATA_DIR`:

```text
<DATA_DIR>/userPluginManager/
├── state.json
├── journal.json
├── staging/<inspection-or-operation-id>/
└── backups/<operation-id>/
```

`state.json` contains only normalized, non-secret data:

```ts
interface ManagerStateV1 {
    schemaVersion: 1;
    riskAcknowledgedAt?: string;
    sources: ManagedSourceV1[];
    pending?: PendingChangeSetV1;
    lastApply?: ApplyResultV1;
}

interface ManagedSourceV1 {
    id: string;
    displayName: string;
    kind: "git" | "http-archive" | "http-file" | "local-file" | "local-directory";
    locator: string;
    requestedRef?: string;
    resolvedRevision: string;
    sourceSubpath?: string;
    contentDigest: string;
    entries: ManagedEntryV1[];
    installedAt: string;
    updatedAt: string;
}

interface ManagedEntryV1 {
    sourcePath: string;
    destination: string;
    contentDigest: string;
}

interface PendingChangeSetV1 {
    id: string;
    createdAt: string;
    updatedAt: string;
    changes: PendingChangeV1[];
}
```

`PendingChangeV1` is a discriminated union for install, update/resync, remove, and adopt. Each change records the inspected revision/digest, selected destinations, and preconditions needed to detect a stale preview at Apply time. It never stores credentials or mutates `src/userplugins`.

The normalized locator persists credential-redacted URLs only. Raw credentials may exist only in process memory for the active acquisition operation.

### IPC contract

The `VencordNative.userPluginManager` API implemented by `core/src/main/userPluginManager` exposes:

- `getSnapshot()` — committed sources, persistent pending changes, journal/recovery status, and inventory conflicts;
- `acknowledgeRisk()` / `deactivate()` — explicit activation state; deactivation rejects a non-empty pending set;
- `inspectSource(input)` / `checkSource(sourceId)` — read-only inspection tokens and content summaries;
- `stageInstall(token, selection)`, `stageUpdate(token, sourceId)`, `stageRemove(sourceId)`, and `stageAdopt(input)` — update only the pending change set;
- `discardPending(pendingId)` — delete only pending metadata and its private staging;
- `prepareApply(pendingId)` — revalidate the complete set, snapshot affected paths, swap all entries, and leave one journal in `awaiting-build`;
- `commitApplyAfterBuild(operationId)` — commit all source/ownership changes, clear pending state, then release staging/backups;
- `rollbackApplyAfterBuildFailure(operationId)` — restore the full pre-Apply tree and enter `awaiting-recovery-build`;
- `completeRollback(operationId)` — clear the journal only after the recovery build succeeds;
- `recoverInterruptedOperation()` — report or continue deterministic recovery without guessing success.

Every inspection and apply token is process-issued, expires, and is bound to the staged digest. Every mutating call is serialized by a process-local mutex cross-checked against `journal.json`; UI disablement is not the concurrency boundary.

### Renderer orchestration

The core `UserPluginManager` control is rendered directly by `src/components/settings/tabs/plugins/index.tsx`, above the existing plugin grid.

Staging flow:

1. Inspect/check in native code.
2. Queue install/update/remove/adopt in the persistent pending set.
3. Refresh card badges and show one page-level **Review changes / Apply changes / Discard** bar.
4. Do not touch `src/userplugins`, rebuild, or prompt for reload.

Apply flow:

1. Call `prepareApply(pendingId)` once for the complete reviewed set.
2. Invoke `VencordNative.updater.rebuild()` once through the existing updater IPC contract.
3. On success, call `commitApplyAfterBuild()`, clear the bar, and offer one **Reload Discord** action.
4. On failure, call `rollbackApplyAfterBuildFailure()`.
5. Rebuild the restored previous tree once.
6. Call `completeRollback()` only if the recovery build succeeds; otherwise retain the journal/backups and disable further mutations.

The UI must not report source changes as installed before step 3. Rebuild success means the new bundle exists; activation still requires Discord reload. A failed Apply retains the pending set for review/retry while restoring the last committed source tree.

## Implementation sequence

### Task 1 — State, pending-plan model, and baseline tests

Files:

- Create `core/src/shared/userPluginManager.ts`.
- Create `tests/userPluginManager/model.test.ts`.

Work:

1. Define the persistent schema above, source input/result unions, `PendingChangeV1`, structured error codes, operation journal phases, and runtime type guards.
2. Implement migration dispatch keyed by `schemaVersion`; version 1 rejects unknown future versions instead of silently rewriting them.
3. Implement deterministic JSON serialization and atomic state writes through a temporary file plus same-directory rename.
4. Implement entry ownership lookup, destination conflict reporting, and deterministic pending-change coalescing.
5. Reject contradictory drafts such as install and remove of the same destination; a newer compatible edit of one source replaces its earlier draft.
6. Keep the module free of Vencord aliases, Electron, React, and third-party dependencies so Node's test runner can exercise it directly.

Behavioral tests:

- Valid v1 state with a pending set round-trips without losing fields.
- A future schema version is rejected and the original file remains unchanged.
- Duplicate destination ownership and contradictory pending operations are rejected.
- Replacing an earlier compatible draft produces one deterministic final operation.
- The protected manager infrastructure cannot enter a remove operation.
- A failed temporary write/rename does not truncate the previous valid state.

Planned gate:

```sh
node --import tsx --test tests/userPluginManager/model.test.ts
```

Run this exact command from the workspace where `tsx` is resolvable; prove the first command itself before relying on the remaining test plan.

### Task 2 — Filesystem safety and secret redaction

Files:

- Create `core/src/shared/userPluginManagerSafety.ts`.
- Create `tests/userPluginManager/safety.test.ts`.

Work:

1. Implement canonical containment checks with `realpath` for existing paths and parent canonicalization for destinations that do not exist yet.
2. Reject absolute archive entry paths, `..` traversal, NUL bytes, device paths, and symlinks that resolve outside staging.
3. Generate destination slugs without allowing separators, empty names, reserved `.`/`..`, or collisions after normalization.
4. Redact URL userinfo and known credential-bearing query values before logging, rendering, error creation, or persistence.
5. Add deterministic maximums for redirect count, response bytes, expanded bytes, file count, per-file bytes, and nested archive depth. Export the constants so UI confirmation can describe a limit failure accurately.
6. Ensure cleanup accepts only operation-owned paths below the manager data directory; never accept arbitrary deletion targets from renderer input.

Behavioral tests:

- `../`, absolute, encoded traversal, and symlink escape fixtures are rejected.
- Two names normalizing to one destination conflict instead of overwriting.
- URLs with username/password or token-like query values are redacted in all returned structures.
- Oversized byte/file-count fixtures fail before destination mutation.
- Cleanup rejects a path outside its operation root.

Gate:

```sh
node --import tsx --test tests/userPluginManager/safety.test.ts
```

### Task 3 — Source acquisition and shape inspection

Files:

- Create `core/src/main/userPluginManager/sources.ts`.
- Create `tests/userPluginManager/sources.test.ts`.

Work:

1. Implement all acquisition into operation-specific staging directories.
2. Git source:
   - invoke `git` with `execFile` argument arrays;
   - use `--no-recurse-submodules` and never execute repository scripts;
   - resolve and record the actual commit;
   - support a requested ref and selected repository subdirectory;
   - do not initialize submodules, Git LFS, or hooks.
3. HTTP source:
   - follow only bounded redirects;
   - enforce compressed and expanded size limits;
   - support direct `.ts`/`.tsx` files and archive payloads;
   - use Vencord's existing `fflate` dependency for ZIP/GZIP data and a strict TAR reader for `.tar`/`.tar.gz` payloads;
   - reject nested archives in v1.
4. Local file/directory source:
   - copy into staging rather than linking;
   - record a content digest as the installed revision;
   - never retain access to the original path as an executable dependency.
5. Inspect exactly three supported shapes: one plugin root, a collection of direct plugin child directories plus selected `_shared` dependencies, or one self-contained TypeScript file.
6. Return an inspection token bound to the staged digest so neither staging nor Apply can use a different payload than the one reviewed.

Behavioral tests:

- A local single plugin, collection, and direct file produce the expected selectable entries and source kinds.
- A local source cannot escape through symlinks.
- A fixture archive extracts safely and a traversal archive is rejected.
- A Git fixture resolves a commit without executing hooks or scripts.
- Changing staged content after inspection invalidates the confirmation token.
- A direct file with relative imports is rejected as unsupported.

```sh
node --import tsx --test tests/userPluginManager/sources.test.ts
```

### Task 4 — Recoverable batched filesystem transactions

Files:

- Create `core/src/main/userPluginManager/transaction.ts`.
- Create `tests/userPluginManager/transaction.test.ts`.

Work:

1. Define journal phases: `prepared`, `files-swapped`, `awaiting-build`, `rolling-back`, `awaiting-recovery-build`, and `committing`.
2. Revalidate every pending source digest/revision, ownership record, and destination precondition before the first installed-file mutation.
3. Write the journal before each irreversible boundary and fsync the journal file plus parent directory where supported.
4. Snapshot every affected destination once into the operation backup directory.
5. Apply the complete pending set with same-filesystem renames; record each completed entry so a crash between entries can be rolled back deterministically.
6. Do not delete backups, staged inputs, or the pending set until state commit succeeds.
7. On startup, inspect the journal and return the required rollback/rebuild action rather than automatically declaring success.
8. Reject any destination currently unmanaged or owned by another source. Adoption remains an explicit staged operation.

Behavioral tests:

- Several staged installs/updates/removals commit as one operation after one successful build acknowledgement.
- An injected failure between entry swaps restores the complete prior tree.
- A failed build restores all entries, retains the pending set, and requires one recovery build.
- Process restart at every journal phase returns one deterministic recovery action.
- A stale inspected digest/revision stops before destination mutation.
- Unmanaged destinations and cross-source ownership collisions remain untouched.

Gate:

```sh
node --import tsx --test tests/userPluginManager/transaction.test.ts
```

### Task 5 — Core native API and bootstrap patch

Files:

- Create `core/src/main/userPluginManager/index.ts`.
- Update `core/src/shared/userPluginManager.ts` with IPC result types.
- Create `patches/userplugin-manager.patch`.

Work:

1. Resolve persistent paths from Vencord's `DATA_DIR`; do not reimplement data-directory selection.
2. Register the complete IPC contract for inspection, staging, pending review/discard, batched Apply, commit, rollback, and interrupted-operation recovery.
3. Keep inspection/acquisition tokens server-side, expiring, and bound to revision/digest.
4. Serialize mutations with a native mutex and journal checks.
5. Return structured phase/source/destination errors without raw credentials.
6. Ensure core manager paths are outside `src/userplugins` and never enter source inventory/removal operations.
7. Seed PlatformSpoofer and QuestCompleter as bundled source records without changing their enabled settings.
8. Make `patches/userplugin-manager.patch` bootstrap the native module, preload/shared API, and core files only; source-management logic remains in reviewable `core/src/*`.

Verification:

- Run Tasks 1–4 tests together.
- Apply the patch and copy `core/src/*` into an isolated Vencord checkout.
- Run Vencord `pnpm testTsc` to verify imports, IPC bindings, and handler registration compile.

### Task 6 — Native Plugins-page integration, activation gate, and Apply bar

Files:

- Create `core/src/components/settings/tabs/plugins/UserPluginManager/index.tsx`.
- Create `ActivationGate.tsx`, `AddSourceModal.tsx`, `SourceManagerModal.tsx`, `PendingChangesBar.tsx`, `PendingChangesModal.tsx`, `UserPluginCardDetails.tsx`, and `styles.css` in that directory.
- Extend `patches/userplugin-manager.patch` at the existing Plugins search/filter controls, plugin-card metadata path, and plugin modal.

Work:

1. Add **Add UserPlugin** and **Manage sources** beside the existing search/filter controls; do not create a settings row or manager plugin card.
2. Preserve the existing **Show UserPlugins** filter and plugin grid as the entry inventory.
3. Decorate only userplugin cards with managed, bundled, unmanaged, conflict, update-available, pending-change, or reload-required state.
4. Extend the existing plugin modal only for userplugin entries with provenance, revision, and context-valid source-management actions.
5. Keep stock plugin cards and runtime enable/disable behavior unchanged.
6. Before management activation, show a safety gate explaining that userplugins execute unsandboxed code, unknown sources should not be installed, and the manager does not audit/certify code.
7. Add Git URL, HTTP URL, local file, and local directory inspection without installing.
8. Show normalized source, resolved revision/digest, selected subpath, entries, destinations, conflicts, and content changes before queueing a change.
9. Route Install/Update/Resync/Remove/Adopt to the pending set; modal closure never applies implicitly.
10. Show one persistent page-level bar with pending count, **Review changes**, primary **Apply changes**, and **Discard**.
11. Show the ordered aggregate plan and conflicts in `PendingChangesModal`; require Apply confirmation for the whole set.
12. Expose no destructive action for unmanaged entries before explicit adoption.
13. Block manager deactivation until pending changes are applied or discarded.
14. Show phase-specific Apply/recovery progress and errors without hiding the existing plugin grid.

Verification:

- Renderer component tests cover activation cancel/accept, queue without mutation, plan review, Discard, aggregate conflict, Apply progress, and deactivation with pending work.
- ESLint passes for only the new/changed manager UI paths.
- Plugin-modal checks confirm stock cards are unchanged.

### Task 7 — Single-build Apply, rollback, and reload orchestration

Files:

- Update the core renderer controller under `core/src/components/settings/tabs/plugins/UserPluginManager/`.
- Update shared IPC types only where the observable flow requires it.

Work:

1. Implement pending-set staging and refresh without calling the updater rebuild path.
2. Implement `prepareApply(pendingId) → one rebuild → commit` against `VencordNative.updater.rebuild()`.
3. Unwrap IPC results using Vencord's existing updater utility behavior rather than testing wrapped-value truthiness.
4. Lock manager actions while Apply, rollback, or recovery build is active.
5. If the Apply build fails, restore the complete source snapshot, run one recovery build, and preserve the journal if recovery also fails.
6. Keep the failed pending set available after a successful rollback for review/retry or Discard.
7. Recover safely when the renderer closes/reloads during an `awaiting-build` operation.
8. Prompt for Discord reload only once after a successful aggregate Apply.

Behavioral scenarios:

- Queue install + update + remove: installed tree remains unchanged before Apply.
- Discard: pending state/staging clears and installed tree/settings remain unchanged.
- Valid aggregate Apply: all files swap, one build succeeds, one state commit occurs, and one reload prompt appears.
- Invalid item in aggregate Apply: the full prior tree is restored, one recovery build succeeds, old install remains, and pending review remains.
- Recovery build failure: journal/backups remain and exact manual recovery information is shown.
- Renderer closes after prepare: reopening the core manager detects and offers deterministic recovery.

### Task 8 — Installer core overlay and provenance seed

Files:

- Update `install.sh`.

Work:

1. Resolve a remote custom-overlay commit and download that immutable revision rather than independently moving branch archives.
2. For a local overlay checkout, record its current commit if clean; otherwise record `local:<content-digest>` without claiming it matches HEAD.
3. Copy `core/src/*` into the Vencord checkout before applying required custom patches.
4. Copy `patches/userplugin-manager.patch` into `custom-patches` and apply it strictly; patch drift must stop installation.
5. After copying bundled userplugins, write a non-secret bootstrap manifest for PlatformSpoofer and QuestCompleter with normalized provenance and content digests.
6. Preserve the integrated install model and user settings. Cleanup may remove only exact, proven installer-owned targets.

Verification:

```sh
sh -n install.sh
```

Run installer logic against a temporary HOME/config fixture with external effects disabled. Assert immutable provenance, the core overlay, both bundled userplugins, all required patches, and absence of credential-bearing locators.
### Task 9 — Updater compatibility and old-contract checks

Files:

- Update `patches/update.patch` to preserve and verify `src/userplugins`, then reapply `userplugin-manager.patch` strictly.
- Update `patches/userplugin-manager.patch` only for verified upstream integration drift.

Work:

1. Before pull, record the managed/unmanaged inventory and content digests of `src/userplugins`.
2. Keep updater reset scoped to tracked upstream changes; never run `git clean` or delete/reset/replace `src/userplugins`.
3. Pull upstream, copy overlay-owned core files, and apply `translate.patch`, `update.patch`, and `userplugin-manager.patch` strictly.
4. Compare the post-pull userplugin inventory and digests with the pre-pull snapshot before allowing the build.
5. Abort visibly on missing/changed userplugins, patch drift, or a new upstream path colliding with an overlay-owned file.
6. Confirm manager state, pending changes, staging, and backups remain under `DATA_DIR`, outside the updated source tree.
7. Exercise rebuild after an upstream pull with no journal, committed managed content, a non-empty pending set, and interrupted recovery.
8. Treat old installations without bootstrap metadata as unmanaged; never adopt/delete automatically.
9. Confirm PlatformSpoofer, QuestCompleter, Translate, and existing runtime enabled settings remain unchanged.

Acceptance:

- Upstream update preserves manager state, pending changes, every managed/unmanaged source file, enabled settings, and the integrated Plugins controls.
- Missing bootstrap metadata degrades to explicit unmanaged state.
- Userplugin digest mismatch, patch drift, or core-path collision is a visible updater failure before build.

### Task 10 — Documentation and final cleanup

Files:

- Update `.github/README.md`.
- Update the design spec only if implementation forced an approved contract change.

Work:

1. Document activation, source types, staging/review/Apply/Discard lifecycle, the single build/reload boundary, state location, recovery behavior, and the unsandboxed-code warning.
2. State explicitly that arbitrary source support is not a trust endorsement.
3. Document unsupported repository mechanisms: install scripts, dependency installation, submodules, LFS, and external relative imports for direct files.
4. Document how to recover using retained journal/backups without telling users to delete broad directories.
5. Remove test fixtures/staging created by this work only after successful verification; do not clean unrelated user files.

## Final verification matrix

### Baseline before implementation

Record:

- branch and exact commit of `vencord-custom`;
- clean/dirty state of `vencord-custom` and installed Vencord separately;
- installed Vencord commit;
- current targeted ESLint result for existing custom plugins;
- current `pnpm testTsc` result;
- current `sh -n install.sh` result.

Do not claim no regressions without comparing to this baseline.

### Automated gates

Run:

```sh
node --import tsx --test tests/userPluginManager/*.test.ts
sh -n install.sh
pnpm testTsc
pnpm eslint src/components/settings/tabs/plugins/UserPluginManager src/main/userPluginManager src/shared/userPluginManager.ts src/shared/userPluginManagerSafety.ts src/userplugins/platformSpoofer src/userplugins/questCompleter
pnpm build --standalone --disable-updater
```

The Vencord commands run in the checkout containing the copied overlay. Inspect exit codes and report baseline → delta, including pre-existing failures by name.

### End-to-end scenarios

Exercise through the actual Discord/Vencord Plugins UI:

1. Open Plugins and choose **Add UserPlugin** before activation; verify warning and explicit acknowledgement.
2. Cancel activation; verify no state/source mutation.
3. Activate and inspect a local fixture; queue Install and verify only the pending bar/card badge changes.
4. Queue a Git fixture pinned to a ref and an HTTP archive fixture; verify resolved commits/digests, entries, and limits in **Review changes**.
5. Close/reopen Plugins; verify the pending set persists and no installed source/runtime behavior changed.
6. Discard the set; verify pending staging clears while installed plugins and enabled settings remain unchanged.
7. Queue local Install + Git Install and Apply; verify one transaction, one build, one reload prompt, and both cards appear only after reload.
8. Queue Update + Remove together; verify aggregate diff review, one Apply/build/reload, new revision, removed source, and unrelated/unmanaged entries preserved.
9. Attempt a destination collision and a traversal/symlink escape; verify Apply is blocked before destination mutation.
10. Queue a deliberately non-compiling fixture with another valid change; verify full rollback, one successful recovery build, old tree remains usable, and pending review remains.
11. Interrupt after the aggregate file swap in a controlled fixture; reopen Plugins and verify deterministic recovery.
12. Verify manager deactivation is blocked while pending changes exist and succeeds after Apply or Discard without deleting installed plugins.
13. Verify the manager is absent from source inventory/removal actions and remains available after removing every managed fixture.
14. Run the updater fixture with managed, unmanaged, and pending changes; verify identical contents, pending plan, and enabled settings after pull, strict patch reapplication, build, and reload.

### Completion criteria

The feature is complete only when:

- all source kinds and supported source shapes work through the real UI;
- activation is explicit and persisted;
- credentials are absent from persisted state/logs/errors;
- unmanaged paths are never overwritten or deleted;
- staging never mutates installed source and Discard preserves installed plugins/settings;
- batched add/update/remove/adopt uses one recoverable Apply/build/reload boundary;
- manager infrastructure cannot remove itself;
- upstream update/rebuild preserves manager state, pending changes, managed/unmanaged source content, and runtime enabled settings;
- baseline/delta is recorded;
- live behavior is verified, not inferred from typecheck/build alone.

## Rollback boundary

Until the live verification step, rollback is deleting only files created by this implementation and reverting minimal hunks in `install.sh`/`.github/README.md` while preserving unrelated work. Before touching the live Vencord installation, create timestamped backups of every destination and manager state file that the verification will replace. If verification fails, restore those exact files and rebuild the prior known-good bundle; never use a broad checkout/reset/clean operation.