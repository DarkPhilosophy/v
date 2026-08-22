# UserPlugin Manager — design specification

Status: approved direction, implementation not started

## Decision

Implement the manager as first-class Vencord core functionality exposed directly in the existing **Plugins** settings page.

Repository layout:

```text
core/src/
├── components/settings/tabs/plugins/UserPluginManager/
├── main/userPluginManager/
└── shared/userPluginManager*.ts

patches/userplugin-manager.patch
```

The core sources contain the manager UI, state model, source acquisition, filesystem transactions, and native handlers. `patches/userplugin-manager.patch` contains only the upstream integration points needed to compile and expose those sources: the Plugins-page control surface, shared IPC declarations, preload bindings, and main-process registration.

This bootstrap is intentionally not a userplugin. It never appears as a removable plugin card, cannot disable or delete itself, and remains available when every managed userplugin is removed. Existing plugin cards continue to own runtime enable/disable; the manager owns installation, provenance, update, and removal of userplugin source.

## Goals

- Inventory every installed userplugin and distinguish manager-owned, bundled, and unmanaged entries.
- Install userplugins from remote URLs or local filesystem sources without an allowlist or mandatory registry.
- Support manual check, update, removal, and source resynchronization.
- Preserve source provenance and the exact resolved revision or content identity.
- Make every source mutation transactional and recoverable.
- Reuse Vencord's existing build/updater path rather than implementing a second build system.
- Keep manager state across upstream Vencord updates.
- Warn clearly that userplugins execute unsandboxed code and must not be installed from unknown sources.

## Non-goals

- Sandboxing userplugins. Vencord userplugins run in Vencord/Discord processes by design.
- Rating, reviewing, or certifying third-party sources.
- Executing repository installer scripts, lifecycle hooks, or arbitrary shell commands.
- Replacing the existing Plugins screen's enable/disable controls.
- Hot-unloading webpack patches. Install, update, and removal complete after a successful build and Discord reload.
- Supporting binary package-manager formats unrelated to Vencord userplugin source trees.

## Safety activation

The manager is installed but its mutating capabilities are disabled initially.

Opening its settings for the first time displays a blocking activation panel with these facts:

- Userplugins execute unsandboxed code with the capabilities available to Vencord and Discord.
- A malicious plugin can access Discord-visible information and local/native capabilities exposed to the process.
- A trusted source can become unsafe after an update.
- The user should inspect the source and must not install plugins from unknown or untrusted sources.
- Installation, update, and removal require a rebuild and Discord reload.

The panel requires an unchecked acknowledgement and an explicit button labelled **I understand the risks — Activate UserPlugin Manager**. Cancel leaves management disabled.

Activation is persisted in manager state. Deactivation disables install, update, adoption, and removal operations; it does not silently remove already installed plugins or change their existing enabled state.

Every add operation still shows the normalized source, selected subpath, update policy, and resolved revision before confirmation. Enabling automatic source updates, if implemented later, requires a separate warning; manual updates are the initial default.

## Source model

A source record contains:

```ts
type SourceKind = "git" | "http-archive" | "http-file" | "local-file" | "local-directory";

interface ManagedSource {
    id: string;
    kind: SourceKind;
    locator: string;
    subpath?: string;
    requestedRef?: string;
    resolvedRevision: string;
    contentDigest: string;
    installEntries: string[];
    updatePolicy: UpdatePolicy;
    installedAt: string;
    updatedAt: string;
}
```
Supported inputs:

1. Git repositories, including a selected ref and optional repository subdirectory.
2. HTTP(S) archives containing a userplugin or userplugin collection.
3. A direct HTTP(S) or local TypeScript/TSX userplugin entry file.
4. A local directory, copied as a managed snapshot and resynchronized explicitly.

Git operations are invoked with argument arrays, never through a shell. Remote URLs are passed as data and cannot inject command-line options. The manager relies on the host's existing Git authentication without reading or managing credentials.
The manager does not initialize Git submodules or Git LFS, execute hooks from the fetched repository, install its dependencies, or run its scripts. A source that requires those mechanisms is rejected as unsupported rather than partially installed.

## Source shapes

After fetching into staging, the manager recognizes:

- **Single plugin:** the selected root contains `index.ts` or `index.tsx`; it is installed under one destination directory.
- **Collection:** direct child directories contain `index.ts` or `index.tsx`; the confirmation screen allows selecting plugin directories. Private/shared direct children beginning with `_` may be included as dependencies of that source.
- **Single file:** a self-contained `.ts` or `.tsx` entry is wrapped in a destination directory as `index.ts` or `index.tsx`; relative imports outside that file are unsupported.

The initial implementation does not attempt to infer arbitrary transitive files outside the selected source root. Path traversal and symlink escapes outside staging are rejected. This is filesystem integrity validation, not a trust judgment about plugin code.

## Inventory and ownership

The manager lists:

- **Managed:** an installed entry owned by a source record.
- **Bundled:** entries shipped by `v` and seeded into manager state by installation.
- **Unmanaged:** pre-existing entries found under `src/userplugins` with no source record.

No source may overwrite a path owned by another source or an unmanaged directory. The UI reports the exact conflict and offers a different destination. Existing directories can be adopted only through an explicit flow that records their chosen provenance and first creates a recoverable snapshot.

The core manager is outside `src/userplugins`, so it is never part of this inventory and no source-management operation can target its files.

## Persistent state

State lives outside `src/userplugins`, under Vencord's persistent settings/data directory, and includes:

- schema version;
- activation acknowledgement;
- source records;
- ownership mapping;
- one pending change set with inspected revisions, digests, destinations, and ordering;
- last successful apply/build result;
- recovery metadata for an interrupted transaction.

Writes use a temporary file, flush/close, and atomic rename. Invalid or unsupported state is not overwritten automatically; the manager opens read-only with a recovery error.

Pending changes never alter `src/userplugins`. They survive closing/reopening the Plugins page so the user can review them, but a source is revalidated before Apply; if content or revision changed since inspection, Apply stops and requests a refreshed review.

## Operations

### Stage install

1. Normalize the supplied source without storing credentials.
2. Fetch or copy into a private staging directory.
3. Resolve the concrete revision and calculate a content digest.
4. Validate source shape, paths, size limits, and destination ownership.
5. Show the source, revision, entry selection, destinations, and content changes.
6. Add the inspected install to the pending change set; do not touch `src/userplugins` or build yet.

### Check and stage update

Checking is read-only: fetch metadata/content into staging, compare resolved revision and digest, and report whether content changed.

Choosing **Update** adds `old revision → new revision` and its content diff to the pending change set. It does not replace installed content until the global Apply.

### Stage remove

Show every owned destination and source record that will be removed, then add the removal to the pending change set. No installed path is deleted before Apply.

### Stage adopt

Adoption never guesses ownership. The user selects existing entries, supplies or confirms provenance, and queues new ownership records. Adoption does not change source contents unless a later explicit sync/update is staged.

### Review, Apply, and Discard

Any staged install, update, remove, resync, or adoption activates one page-level pending-changes bar with:

- the number and kinds of pending changes;
- **Review changes**;
- primary **Apply changes**;
- **Discard**.

The change set is validated as a whole. Conflicting operations are rejected; later edits to the same source replace the earlier draft rather than creating ambiguous ordering.

**Apply changes**:

1. Revalidate every inspected source, revision/digest, destination, and ownership precondition.
2. Snapshot every affected installed entry once.
3. Under one operation journal, swap all staged additions/updates/removals into `src/userplugins`; the journal makes the multi-entry transaction recoverable even though several directories cannot be renamed atomically as one unit.
4. Invoke Vencord's existing build path once for the complete change set.
5. On success, atomically commit manager state, clear the pending change set, and prompt once for Discord reload.
6. On failure, restore the complete pre-Apply snapshot and rebuild the previous known source state. Retain the pending change set for review/retry unless the user discards it.

**Discard** removes only pending metadata and private staging created for that change set. It never changes installed plugins, runtime enabled settings, or committed source records.

## Build and updater integration

The Plugins-page renderer calls a dedicated `VencordNative.userPluginManager` API. Main-process handlers own source, state, and filesystem operations; the renderer never receives arbitrary filesystem authority.

The manager reuses Vencord's existing updater/build API for compilation so Flatpak/host execution and build-error behavior remain centralized. A writable Vencord source checkout and build toolchain are required for mutations. Without them, the integrated controls remain inventory-only and explicitly report that this installation cannot rebuild userplugins.

`patches/userplugin-manager.patch` is a required overlay patch. `i` copies the core source overlay before applying patches. The patch changes only tracked Vencord integration points; manager implementation files remain overlay-owned.

`patches/update.patch` must preserve these invariants:

1. Never run `git clean` and never delete, reset, or replace `src/userplugins`.
2. Record the managed/unmanaged inventory and content digests before the upstream pull.
3. Reset only tracked upstream changes, pull upstream, and reapply `translate.patch`, `update.patch`, and `userplugin-manager.patch` strictly.
4. Verify the pre-update `src/userplugins` inventory and digests before building.
5. Abort visibly on patch drift, missing userplugins, digest changes, or a new upstream path colliding with an overlay-owned core file.
6. Build only after those checks pass; never hide a preservation or patch error in an empty `catch`.

Manager state lives under Vencord's persistent data directory, outside the source checkout. Upstream update may refresh tracked integration points but must preserve state, installed userplugin sources, and runtime enable/disable settings.

## Error and recovery behavior

- Network, authentication, validation, conflict, and build failures are distinct user-visible states.
- Error messages redact credentials and avoid dumping environment variables or full remote responses.
- A failed fetch leaves installed files untouched.
- A failed build triggers rollback and a rebuild of the last known source state.
- If rollback or the recovery build also fails, the manager preserves snapshots, marks recovery required, disables further mutations, and gives exact recovery paths without deleting evidence.
- Startup checks for an interrupted transaction before allowing another mutation.
- Only one mutation may run at a time.

## UI

Management is integrated directly into the existing **Plugins** page rather than placed in a separate settings row:

1. Add **Add UserPlugin** and **Manage sources** controls beside the existing search/filter controls.
2. Keep Vencord's existing **Show UserPlugins** filter and plugin grid as the canonical inventory view.
3. Decorate userplugin cards with managed, bundled, unmanaged, conflict, update-available, pending-change, or reload-required state.
4. Extend the existing plugin modal for userplugins with provenance, resolved revision, and context-valid **Check**, **Update**, **Resync**, **Remove**, **Adopt**, and **View source** actions.
5. Keep stock plugin cards and runtime enable/disable behavior unchanged.
6. Show the activation warning before management is enabled; unknown sources must be discouraged explicitly because userplugins execute unsandboxed code.
7. After the first staged change, show one persistent page-level bar with **Review changes**, **Apply changes**, and **Discard**. Closing a modal never applies implicitly.
8. Show Apply progress and persistent results/errors, then offer Discord reload only after the single build and state commit succeed.
9. Provide **Deactivate manager** without deleting/disabling installed plugins or silently discarding pending changes; deactivation requires the user to Apply or Discard first.

One source may contain multiple plugin entries, so **Manage sources** remains a source-oriented modal while the plugin grid remains entry-oriented. This avoids duplicating Vencord's filter and card implementation.

## Verification contract

Implementation is complete only when the following observable scenarios pass through the real installed Vencord checkout:

- First opening shows the warning and mutations remain unavailable before acknowledgement.
- Activation persists across reload; deactivation preserves installed plugins.
- Staging an install/update/remove changes only the pending bar and leaves installed source/runtime behavior untouched.
- Discard clears pending changes without changing installed plugins or enabled settings.
- Applying several staged changes performs one recoverable transaction, one build, and one reload prompt.
- Install from a local fixture appears as a userplugin only after Apply, successful build, and reload.
- Install from a temporary Git fixture records the exact commit after Apply.
- Update changes the recorded revision and installed behavior only after a successful Apply/build.
- A deliberately broken batched Apply restores every prior source and leaves the previous build usable.
- Removing a managed plugin takes effect after Apply/build/reload while unrelated entries remain.
- An unmanaged folder is listed but cannot be overwritten or removed before adoption.
- A path traversal/symlink escape fixture is rejected without touching installed files.
- A source locator containing credentials is redacted and never persisted verbatim.
- Upstream update/rebuild preserves manager state, pending changes, managed/unmanaged sources, and enabled settings.

Static typecheck/lint are supplementary; they do not replace exercising the installed Discord/Vencord path.
