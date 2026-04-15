# External slskd Integration Spec

## Purpose

Define a safe, optional external `slskd` backend for Aurral flows and imported playlists.

This backend does not replace the built-in Soulseek client initially. Users can choose either:

- the existing built-in Soulseek client
- an external shared `slskd` instance

The primary user goals are:

- use an already-running external `slskd` container
- reduce CPU and protocol load inside Aurral
- preserve Aurral's current flow and playlist library model
- keep user-managed `slskd` activity and personal downloads untouched

## Summary

Aurral will:

- keep Lidarr as the library and request system of record
- optionally use `slskd` for track search, enqueueing, download monitoring, and cancellation
- continue owning flow and imported-playlist lifecycle logic
- continue owning the final `aurral-weekly-flow` library structure consumed by Navidrome
- use a persistent manifest to track only transfers created by Aurral
- hardlink or move completed files from the shared `slskd` complete directory into Aurral's managed flow library

`slskd` will:

- handle Soulseek connectivity
- handle network search requests
- handle transfer queueing and transfer execution
- expose state through its REST API

Navidrome will:

- read only from Aurral's managed flow library
- remain unaware of the built-in client vs external `slskd` choice

## Scope

### In Scope

- optional external `slskd` integration for flows
- optional external `slskd` integration for imported playlists
- shared external `slskd` instance support
- manifest-backed ownership and cleanup
- transfer polling, reconciliation, retries, and finalization
- path validation and shared-filesystem validation
- preserving the existing `aurral-weekly-flow` final library layout

### Out Of Scope

- replacing Lidarr download/import behavior
- changing the main library model
- requiring a dedicated `slskd` instance
- removing the built-in client in v1
- supporting per-download custom target paths inside `slskd`
- changing Navidrome playlist semantics

## Key Assumptions

- `slskd` writes to a configured complete directory and incomplete directory
- Aurral can access the `slskd` complete directory over a shared filesystem mount
- Aurral and the `aurral-weekly-flow` library root can live on the same filesystem as the `slskd` complete directory when hardlink mode is enabled
- users may also use the same `slskd` instance manually
- Aurral must never mutate or delete files it cannot prove it owns

## Non-Negotiable Safety Rules

1. Aurral only manages transfers that Aurral itself created through the `slskd` API.
2. Aurral only deletes files that are linked to a manifest row created by Aurral.
3. Aurral never scans the whole `slskd` complete tree looking for cleanup candidates.
4. Aurral never deletes a path unless it first validates containment inside the configured `slskd` complete root.
5. Aurral never deletes a transfer from `slskd` unless that transfer ID is stored on a manifest row created by Aurral.
6. Source-file deletion in the shared `slskd` complete directory is conservative and ownership-gated.
7. If ownership cannot be proven, Aurral removes only its own final library link and leaves the shared `slskd` source in place.

## Architectural Decision

### Backend Choice

Add a per-instance download backend setting:

- `builtin`
- `external_slskd`

The setting applies to:

- weekly flows
- imported playlists

The rest of the app continues to behave the same way. Lidarr artist and album operations are unchanged.

### Final Library Contract

Regardless of backend, completed flow and imported-playlist tracks must end up under the same final root:

- `aurral-weekly-flow/<playlist-type>/<artist>/<album>/<track>`

This preserves current Navidrome and smart-playlist behavior and avoids touching the rest of the flow library model.

### Shared Instance Model

This integration assumes a shared external `slskd` instance.

Because the instance is shared:

- Aurral tracks only Aurral-created transfers
- Aurral does not assume all files under the complete directory are safe to manage
- Aurral treats the `slskd` complete directory as a shared workspace, not an Aurral-owned library

## Filesystem Model

### Recommended Layout

All finalization targets should be on the same filesystem if hardlink mode is desired.

Example host layout:

```text
/data/music/
  slskd-complete/
  slskd-incomplete/
  aurral-weekly-flow/
```

Example mounts:

```yaml
services:
  slskd:
    volumes:
      - /data/music/slskd-complete:/downloads/complete
      - /data/music/slskd-incomplete:/downloads/incomplete

  aurral:
    volumes:
      - /data/music/slskd-complete:/slskd-complete
      - /data/music/aurral-weekly-flow:/app/downloads/aurral-weekly-flow

  navidrome:
    volumes:
      - /data/music/aurral-weekly-flow:/music/aurral-weekly-flow:ro
```

### Finalization Modes

Support two finalization modes:

- `hardlink`
- `copy`

Optional future mode:

- `move`

Rules:

- `hardlink` is preferred when the filesystem supports it
- `copy` is the fallback when hardlinking is unavailable
- `move` should not be used in shared-instance mode by default because it removes the shared `slskd` source path immediately

### Startup Validation

At startup, when `external_slskd` is enabled, Aurral validates:

- `slskd` API connectivity
- complete directory exists and is writable as needed
- final library root exists and is writable
- hardlink capability, if `hardlink` mode is selected

Hardlink validation must use a real temporary source file and `link()` call. Path assumptions alone are insufficient.

## Configuration

### User-Facing Settings

Add an optional external `slskd` section:

- backend: `builtin` or `external_slskd`
- `slskd` base URL
- `slskd` API key
- `slskd` complete directory as seen by Aurral
- finalization mode: `hardlink` or `copy`
- poll interval
- stalled transfer timeout
- max retries per track
- alternate query retry enabled
- source cleanup mode

### Source Cleanup Modes

Use explicit cleanup modes:

- `none`
- `aurral_owned_safe_only`

Definitions:

- `none`: remove only Aurral's final library links and manifest state; never delete source files from `slskd` complete
- `aurral_owned_safe_only`: delete source files only when all ownership and reference checks pass

Default:

- `none`

Reason:

Shared `slskd` instances must default to the safest behavior.

## Data Model

## Manifest Table

The manifest is the source of truth for Aurral-created external `slskd` transfers.

SQLite-oriented schema:

```sql
CREATE TABLE external_slskd_downloads (
    id TEXT PRIMARY KEY,
    playlist_type TEXT NOT NULL,
    playlist_id TEXT,
    job_id TEXT NOT NULL,
    artist_name TEXT NOT NULL,
    track_name TEXT NOT NULL,
    album_name TEXT,
    slskd_username TEXT NOT NULL,
    remote_path TEXT NOT NULL,
    remote_size INTEGER,
    slskd_transfer_id TEXT,
    slskd_state TEXT,
    local_relative_path TEXT,
    slskd_local_path TEXT,
    final_path TEXT,
    finalize_mode TEXT NOT NULL DEFAULT 'hardlink',
    backend_state TEXT NOT NULL DEFAULT 'queued',
    retry_count INTEGER NOT NULL DEFAULT 0,
    last_error TEXT,
    enqueued_at TEXT NOT NULL,
    completed_at TEXT,
    finalized_at TEXT,
    cleaned_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE INDEX idx_external_slskd_downloads_backend_state
    ON external_slskd_downloads(backend_state);

CREATE INDEX idx_external_slskd_downloads_playlist_type
    ON external_slskd_downloads(playlist_type);

CREATE INDEX idx_external_slskd_downloads_job_id
    ON external_slskd_downloads(job_id);

CREATE INDEX idx_external_slskd_downloads_transfer_id
    ON external_slskd_downloads(slskd_transfer_id);
```

### Notes

- `job_id` links back to Aurral's existing flow/import job tracking
- `playlist_type` remains important because current smart playlist behavior is path-based by playlist type
- `playlist_id` is optional for flows but useful for imported playlists and future unification
- `local_relative_path` is stored separately so path recomputation can be deterministic
- `slskd_transfer_id` becomes authoritative once available

## State Machine

Use backend states that are independent from raw `slskd` transfer states.

### Backend States

- `queued`
- `searching`
- `matched`
- `enqueued`
- `downloading`
- `completed`
- `finalized`
- `failed`
- `cancelled`
- `cleaned`

### State Mapping

- search request created -> `searching`
- search result selected -> `matched`
- transfer submitted to `slskd` -> `enqueued`
- `slskd` reports progress -> `downloading`
- `slskd` reports completed and file exists -> `completed`
- file linked or copied to final library -> `finalized`
- retry budget exhausted or unrecoverable error -> `failed`
- rotation or user action stops pending work -> `cancelled`
- final library cleanup completed and optional source cleanup processed -> `cleaned`

### Important Rule

Final playlist visibility should key off `finalized`, not `completed`.

`completed` means the source exists in the shared `slskd` tree.

`finalized` means the file has reached Aurral's managed flow library and is now part of playback.

## Search And Match Flow

### Phase 1: Generate Track Jobs

Aurral's existing recommendation/import logic produces the desired track list.

Each desired track becomes a normal Aurral worker job with metadata such as:

- artist name
- track name
- album name when known
- playlist type
- preferred format

### Phase 2: Search Via slskd

Aurral uses `slskd` search endpoints to:

- submit a network search
- poll until results are complete or timed out
- collect results

Aurral remains responsible for:

- building search queries
- query fallback strategy
- preferred format handling
- ranking candidates
- user blacklist or penalty logic, if retained

The result-ranking behavior should stay conceptually aligned with the current built-in client implementation so the backend swap does not change user expectations more than necessary.

### Phase 3: Candidate Selection

Aurral picks a single best candidate using heuristics such as:

- exact or near-exact title match
- preferred extension
- acceptable file size
- upload slot availability
- uploader reliability
- queue penalty

This logic stays in Aurral, not in `slskd`.

## Enqueue And Transfer Tracking

### Enqueue

For the selected result, Aurral calls the appropriate `slskd` transfer enqueue endpoint and stores:

- remote username
- remote file path
- remote size
- `slskd_transfer_id`, if returned immediately
- predicted local path information

### Local Path Prediction

Aurral may compute an initial expected local path using the known `slskd` complete-root mapping rules, but this path is provisional.

After enqueue and during polling, Aurral should reconcile actual transfer metadata and normalize the authoritative local path if `slskd` exposes it.

### Transfer Polling

Aurral polls `slskd` on a configurable interval and matches transfers:

- first by `slskd_transfer_id` when available
- otherwise by `(slskd_username, remote_path, remote_size)`

Polling updates:

- progress
- transfer state
- last error
- completion timestamp

### Transfer Timeouts

Support:

- search timeout
- queued timeout
- stalled progress timeout
- total transfer timeout

When a timeout occurs, Aurral may:

- cancel the transfer if supported by the API
- mark the attempt failed
- choose another candidate
- requeue based on retry policy

## Finalization

### Finalization Trigger

When a manifest row reaches `completed`, Aurral:

1. verifies the source file exists
2. validates source containment within the configured `slskd` complete root
3. builds the final target path inside `aurral-weekly-flow`
4. finalizes via hardlink or copy
5. marks the row `finalized`

### Final Path

Final paths must preserve the current flow library conventions:

```text
/app/downloads/aurral-weekly-flow/<playlist-type>/<artist>/<album>/<track>
```

Album may be:

- the provided album name
- an inferred album name
- a safe fallback such as `Unknown Album`

### Finalization Semantics

In `hardlink` mode:

- `link(source, final)` is attempted
- source and final path refer to the same inode

In `copy` mode:

- source is copied to final
- checksum or size verification is recommended

## Playback And Navidrome

Nothing about Navidrome should depend on the backend choice.

Navidrome continues to:

- read the `aurral-weekly-flow` root
- consume `.nsp` smart playlists
- discover tracks by final file path

Aurral should continue generating smart playlists only after enough tracks are finalized for the playlist state to be coherent.

## Cleanup

## Cleanup Goals

When a flow rotates or an imported playlist is deleted:

- remove Aurral's final library files
- remove Aurral's playlist metadata sidecars as needed
- cancel or delete Aurral-owned pending transfers
- optionally clean Aurral-owned shared-source files if safe

### Cleanup Order

For each Aurral manifest row in the target playlist:

1. cancel active transfer if still queued or downloading
2. remove final file from Aurral's managed library
3. determine whether source cleanup is allowed
4. if allowed, remove the shared `slskd` source file
5. if supported and appropriate, remove the transfer record from `slskd`
6. update manifest to `cleaned`

### Source Cleanup Policy

Because `slskd` is shared, source cleanup is conservative.

A source file may be deleted only when all of the following are true:

1. cleanup mode is `aurral_owned_safe_only`
2. the manifest row was created by Aurral
3. the source path matches the manifest row exactly after normalization
4. the source path is within the configured `slskd` complete root
5. no other non-cleaned Aurral manifest rows reference the same source path
6. the transfer ID belongs to Aurral's manifest row
7. the file still exists

Optional additional check:

- `nlink <= expected_aurral_reference_count`

`nlink` must not be the primary ownership decision.

### Shared Instance Rule

If ownership is unclear, Aurral must leave the source file in the shared `slskd` complete directory.

That is acceptable. The primary cleanup obligation is Aurral's own final library.

## Startup Reconciliation

On startup, Aurral reconciles manifest state against both:

- the `slskd` API
- the filesystem

### Reconciliation Rules

For rows in `queued`, `enqueued`, or `downloading`:

- query `slskd`
- if transfer is active, update state
- if transfer completed, verify source path and mark `completed`
- if transfer disappeared unexpectedly, mark failed or retry based on policy

For rows in `completed`:

- if source exists, attempt finalization
- if source is missing, re-enqueue or fail based on retry policy

For rows in `finalized`:

- if final file exists, row is healthy
- if final file is missing and source still exists, re-finalize
- if both are missing, mark failed and surface the problem

For rows in `failed`:

- leave as-is unless the worker explicitly requeues retryable failures

## Concurrency And Deduplication

### Concurrency

Keep the existing Aurral worker concurrency limits for flows/imports.

The external backend changes the transport, not the high-level scheduling model.

### Deduplication

Deduplicate in two places:

- before search, by normalized `(playlist_type, artist, track)`
- before enqueue, by checking whether an identical Aurral-managed source or finalized file already exists

If two playlists intentionally reference the same underlying source:

- reuse the existing Aurral-managed source record when safe
- create an additional hardlink or copy into the second playlist location
- do not enqueue a duplicate transfer unnecessarily

## Error Handling

### Search Errors

- no results -> retry with alternate query, then fail gracefully
- `slskd` unavailable -> backoff and surface degraded status

### Transfer Errors

- queued too long -> cancel and retry next candidate
- stalled -> cancel and retry next candidate
- remote user offline -> retry different candidate
- duplicate transfer -> attach to existing Aurral-owned transfer if safe, otherwise pick another candidate

### Finalization Errors

- source missing -> retry reconciliation or re-enqueue
- cross-device link failure in hardlink mode -> fail loudly and instruct user to reconfigure or switch to copy mode
- permission denied -> fail loudly with actionable message

### Cleanup Errors

- source removal denied or unsafe -> leave source, still clean Aurral final file and manifest appropriately
- transfer delete API fails -> log warning, do not block playlist cleanup completion

## UI And UX

### Settings

Add a backend selector under flow/playlist download settings:

- built-in Soulseek
- external `slskd`

If `external_slskd` is selected, show:

- URL
- API key
- complete dir path as seen by Aurral
- finalization mode
- cleanup mode
- connection test button
- filesystem validation status

### Status Surfaces

Flow and imported-playlist status should show:

- backend type in use
- external `slskd` connectivity problems
- queued/downloading/completed/finalized counts
- retryable vs terminal failures

### Clear User Messaging

Users should understand:

- Aurral only manages tracks it created through the external backend
- Aurral final files live in `aurral-weekly-flow`
- source cleanup from shared `slskd` is conservative by default

## Backend Interface

To keep both backends side by side, introduce an internal transport abstraction.

Example responsibilities:

- `search(artistName, trackName, options)`
- `pickBestMatches(results, trackName, options)`
- `enqueueDownload(match, job, options)`
- `getTransferStatus(handle)`
- `cancelTransfer(handle)`
- `finalizeDownload(handle, finalPath, options)`
- `reconcilePending()`
- `getHealth()`

The built-in client becomes one implementation.

The external `slskd` integration becomes another implementation.

This keeps the worker orchestration stable and avoids duplicating all flow/import business logic.

## Implementation Plan

### Phase 1: Foundations

- add settings and secret storage for external `slskd`
- add connection test endpoint
- add filesystem validation endpoint
- add manifest table and data access layer
- add backend abstraction

### Phase 2: Search And Enqueue

- implement `slskd` search wrapper
- implement result normalization
- implement candidate ranking reuse from current logic
- implement enqueue and transfer-handle storage

### Phase 3: Polling And Finalization

- implement transfer polling
- implement reconciliation loop
- implement hardlink and copy finalization
- finalize into existing `aurral-weekly-flow` paths

### Phase 4: Cleanup And Safety

- implement manifest-gated cleanup
- implement conservative shared-source deletion
- implement restart reconciliation
- implement explicit error surfaces in UI

### Phase 5: Rollout

- ship as opt-in
- keep built-in client as default
- gather feedback from shared-`slskd` users
- tune retry and cleanup behavior before broadening scope

## Acceptance Criteria

The feature is acceptable when all of the following are true:

1. A user can configure an external `slskd` instance and pass a connection test.
2. A flow can search, download, and finalize tracks into `aurral-weekly-flow` without using the built-in client.
3. Imported playlists can use the same backend.
4. Navidrome playback works with no changes to existing smart-playlist behavior.
5. Aurral can restart and reconcile in-flight external transfers without losing state.
6. Aurral can rotate a playlist and clean its final library reliably.
7. In default cleanup mode, Aurral never deletes an untracked file from the shared `slskd` complete directory.
8. In hardlink mode, misconfigured cross-device setups fail with a clear error.
9. Built-in and external backends can coexist and be selected by users.

## Open Questions

- which exact `slskd` endpoints and response shapes should be normalized for the wrapper
- whether `slskd` exposes authoritative local completed-file paths for all completed transfers
- whether duplicate-transfer semantics need attach-or-skip handling in addition to retry handling
- whether cleanup mode should later allow pruning Aurral-owned sources more aggressively
- whether backend selection should be global or separately configurable for flows vs imported playlists

## Recommended Defaults

- backend: `builtin`
- external backend availability: opt-in
- finalization mode: `hardlink`
- fallback finalization mode on explicit user choice: `copy`
- source cleanup mode: `none`
- restart reconciliation: enabled
- built-in client remains supported

## Final Recommendation

This architecture is plausible and worth pursuing.

The safest version is not "Aurral fully manages a shared `slskd` downloads tree".

The safest version is:

- Aurral manages only Aurral-created external transfers
- Aurral owns only the final `aurral-weekly-flow` library
- source cleanup in the shared `slskd` complete directory is conservative and optional
- the built-in client remains available as an alternate backend

That gives users the external `slskd` option they want while preserving the current flow library model and keeping shared-instance risk under control.
