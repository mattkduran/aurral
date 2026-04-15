# External slskd Task Breakdown By Repo Area

## Purpose

Break the external `slskd` integration spec into concrete work areas based on the current Aurral repository structure.

This plan assumes:

- the built-in Soulseek client remains supported
- external `slskd` is optional
- the target is flows and imported playlists, not Lidarr album downloads
- the external instance is shared, so cleanup rules must remain conservative

## Delivery Strategy

Recommended implementation order:

1. configuration and data model
2. backend transport abstraction
3. external `slskd` client wrapper
4. worker integration
5. cleanup and reconciliation
6. UI and observability
7. docs and rollout

## Repo Area: `backend/config`

### Files

- `backend/config/constants.js`
- `backend/config/db-helpers.js`
- `backend/config/encryption.js`
- `backend/config/db-sqlite.js`

### Tasks

- Extend default settings with external `slskd` configuration fields.
- Decide whether backend choice is global or scoped to flows/imported playlists.
- Add new encrypted fields for external `slskd` credentials if needed.
- Add persistence for:
  - backend selection
  - `slskd` URL
  - `slskd` API key
  - complete-dir path as seen by Aurral
  - finalization mode
  - cleanup mode
  - polling and timeout settings
- Add a new SQLite table for manifest-backed external `slskd` downloads.
- Add helper methods for CRUD operations on the manifest table.
- Add migrations or schema bootstrapping for the new table.

### Deliverables

- settings schema updated
- encryption coverage updated
- manifest table created
- DB helper methods available to services

## Repo Area: `backend/routes/settings.js`

### Tasks

- Accept and validate new external `slskd` settings.
- Add a test-connection endpoint for the external `slskd` API.
- Add a filesystem validation endpoint for:
  - complete-dir existence
  - final library root existence
  - hardlink support in hardlink mode
- Return structured validation errors suitable for the frontend settings page.
- Keep the current built-in client configuration path intact.

### Deliverables

- `slskd` connection test route
- filesystem validation route
- settings persistence for external backend configuration

## Repo Area: `backend/routes/weeklyFlow.js`

### Tasks

- Expose backend health and backend choice in weekly flow status responses.
- Add any control-plane endpoints needed for:
  - manual reconciliation
  - retrying failed external downloads
  - backend-specific diagnostics
- Ensure current flow actions continue to work with either backend.
- Add guardrails so backend-specific actions are only available when the external backend is enabled.

### Deliverables

- external-backend-aware status payloads
- optional operational routes for reconciliation and debugging

## Repo Area: `backend/services`

### Files

- `backend/services/simpleSoulseekClient.js`
- `backend/services/weeklyFlowWorker.js`
- `backend/services/weeklyFlowDownloadTracker.js`
- `backend/services/weeklyFlowStatusSnapshot.js`
- `backend/services/weeklyFlowScheduler.js`
- `backend/services/weeklyFlowPlaylistManager.js`
- `backend/services/logger.js`

### Tasks

#### 1. Introduce a backend abstraction

- Define a transport/backend interface that both built-in Soulseek and external `slskd` can implement.
- Keep search, enqueue, poll, cancel, finalize, and health methods behind that abstraction.
- Preserve most current worker logic by swapping the acquisition backend rather than rewriting the entire flow system.

#### 2. Refactor the built-in client into one backend implementation

- Wrap current `simpleSoulseekClient` behavior as the `builtin` backend implementation.
- Avoid changing user-visible behavior while the abstraction is introduced.

#### 3. Add a new `slskd` client service

- Create a new service such as `backend/services/slskdClient.js`.
- Implement:
  - connection test
  - search start
  - search polling
  - result normalization
  - download enqueue
  - transfer polling
  - transfer cancel/delete
  - API health check
- Normalize `slskd` responses into shapes that the worker can use consistently.

#### 4. Add an external backend orchestrator

- Create a service such as `backend/services/externalSlskdBackend.js`.
- Implement higher-level operations:
  - search and rank candidates
  - enqueue selected transfer
  - create manifest rows
  - poll active transfers
  - finalize completed files into `aurral-weekly-flow`
  - conservative cleanup
  - startup reconciliation

#### 5. Refactor `weeklyFlowWorker.js`

- Replace direct calls to `simpleSoulseekClient` with the new backend abstraction.
- Keep the existing worker responsibilities:
  - job scheduling
  - retry logic
  - flow completion checks
  - playlist completion checks
  - final file layout rules
- Split transport-specific logic from worker orchestration logic.
- Preserve current playlist target-count behavior and retry-cycle behavior.

#### 6. Update status snapshotting

- Extend `weeklyFlowStatusSnapshot.js` to include:
  - backend type in use
  - external backend health
  - transfer counts by backend state
  - last reconciliation status

#### 7. Logging

- Add structured logging for the external backend in `logger.js`.
- Include categories for:
  - `slskd`
  - transfer lifecycle
  - reconciliation
  - cleanup decisions

### Deliverables

- backend abstraction in place
- built-in backend preserved
- external `slskd` backend service implemented
- worker transport decoupled from current embedded client

## Repo Area: New Backend Services

### Suggested New Files

- `backend/services/slskdClient.js`
- `backend/services/slskdTransferStore.js`
- `backend/services/slskdPathResolver.js`
- `backend/services/slskdReconciler.js`
- `backend/services/slskdFinalizer.js`
- `backend/services/slskdCleanupService.js`

### Task Breakdown

#### `slskdClient.js`

- Thin API wrapper over `slskd` REST endpoints.
- Handle auth headers, timeouts, error normalization, and connectivity failures.

#### `slskdTransferStore.js`

- DB access layer for the external manifest table.
- Encapsulate row creation, state updates, cleanup marking, and query helpers.

#### `slskdPathResolver.js`

- Validate and normalize source and final paths.
- Resolve safe final Aurral library paths.
- Implement path-containment checks.

#### `slskdReconciler.js`

- On-demand and startup reconciliation of manifest state against:
  - `slskd` API
  - filesystem
- Re-finalize or requeue where safe.

#### `slskdFinalizer.js`

- Hardlink or copy completed source files into final library locations.
- Verify finalization success before marking rows finalized.

#### `slskdCleanupService.js`

- Remove Aurral final files for rotating/deleted playlists.
- Perform conservative source cleanup only when ownership checks pass.
- Leave shared-source files alone when ownership is unclear.

### Deliverables

- external backend logic split into testable modules

## Repo Area: `backend/routes`

### Additional Route Review

- `backend/routes/weeklyFlow.js`
- `backend/routes/settings.js`
- possibly `backend/routes/health.js`

### Tasks

- Surface external backend health in health routes if appropriate.
- Add explicit diagnostics for:
  - backend selected
  - last API error
  - mount/path validation result
  - hardlink support status
- Keep route payloads backward compatible where possible.

### Deliverables

- operable backend diagnostics from the UI and health endpoints

## Repo Area: `frontend/src/pages/Settings`

### Files

- `frontend/src/pages/Settings/components/SettingsIntegrationsTab.jsx`
- `frontend/src/pages/Settings/hooks/useSettingsData.js`
- `frontend/src/pages/Settings/utils.js`

### Tasks

- Add backend-selection UI for flow/import download backend choice.
- Add fields for:
  - `slskd` URL
  - API key
  - complete-dir path
  - finalization mode
  - cleanup mode
  - timeout/poll settings if exposed
- Add a `Test Connection` action for the external backend.
- Add a filesystem validation action and status message.
- Show warnings for:
  - hardlink mode requiring same filesystem
  - shared-instance cleanup being conservative by default
- Keep existing built-in Soulseek settings intact.

### Deliverables

- settings UI for external backend
- connection and filesystem validation UX

## Repo Area: `frontend/src/pages/FlowPage*`

### Files

- `frontend/src/pages/FlowPage.jsx`
- `frontend/src/pages/FlowPageComponents.jsx`

### Tasks

- Display which backend is active for flow/import downloads.
- Surface external-backend transfer errors in the existing flow/import status views.
- Show clear messaging when:
  - `slskd` is unavailable
  - filesystem validation fails
  - finalization mode falls back or fails
- Keep status vocabulary understandable:
  - queued
  - downloading
  - completed
  - finalized
  - failed

### Deliverables

- user-facing backend awareness for flows and imported playlists

## Repo Area: `frontend/src/utils/api.js`

### Tasks

- Add client helpers for:
  - testing external `slskd` connection
  - validating external backend filesystem paths
  - requesting reconciliation if exposed
- Extend settings save/load helpers for the new config shape.

### Deliverables

- frontend API support for settings and diagnostics

## Repo Area: Flow/Playlist Data And Worker Internals

### Relevant Files

- `backend/services/weeklyFlowWorker.js`
- `backend/services/weeklyFlowDownloadTracker.js`
- `backend/services/weeklyFlowPlaylistManager.js`
- `backend/services/weeklyFlowPlaylistSource.js`

### Tasks

- Decide how much of the existing download tracker can be reused versus extended.
- Keep playlist completion based on finalized files, not merely completed source downloads.
- Ensure retries and incomplete-playlist cycles work for external backend failures.
- Preserve flow refill behavior for shortfalls.
- Ensure imported playlists continue retrying original tracks rather than generating replacements.

### Deliverables

- backend-neutral worker behavior
- consistent flow/import semantics across both backends

## Repo Area: Filesystem And Cleanup Safety

### Tasks

- Add safe path-containment utilities.
- Add source-path normalization utilities.
- Add shared-source reference checks before any source deletion.
- Default cleanup mode to removing only Aurral-managed final files.
- Add optional safe source cleanup mode for manifest-proven files.
- Add empty-directory cleanup in:
  - final Aurral library tree
  - optionally under the shared `slskd` source tree for Aurral-owned empty branches only

### Deliverables

- reusable safety utilities
- conservative shared-instance cleanup behavior

## Repo Area: Testing

### Suggested Test Areas

- `.tests/weekly-flow/`
- new backend-service unit tests
- new path-safety tests

### Tasks

#### Unit Tests

- path containment and normalization
- manifest row creation and state transitions
- finalization mode behavior
- cleanup safety decisions
- reconciliation decision logic

#### Integration Tests

- settings persistence for external backend
- worker behavior with a mocked `slskd` API
- playlist finalization into `aurral-weekly-flow`
- flow rotation cleanup with shared-source safeguards

#### Regression Tests

- built-in backend still works unchanged
- imported playlists retain current retry semantics
- Navidrome smart-playlist path assumptions remain intact

### Deliverables

- coverage around the risky shared-instance behaviors
- regression protection for the existing built-in path

## Repo Area: Documentation

### Files

- `README.md`
- `flows-and-playlists.md`
- `external-slskd-integration-spec.md`

### Tasks

- Add user-facing setup docs for external `slskd`.
- Document shared-filesystem requirements for hardlink mode.
- Document copy-mode fallback.
- Document cleanup behavior clearly:
  - Aurral only manages Aurral-created transfers
  - source cleanup is conservative by default
- Add example Docker Compose snippets for shared-instance use.
- Add troubleshooting for:
  - API connection failures
  - complete dir not mounted
  - cross-device hardlink failures
  - permission issues

### Deliverables

- operator-ready documentation

## Repo Area: Observability And Support

### Tasks

- Add log categories and health payloads for external backend debugging.
- Add admin-facing UI or API surfaces for inspecting:
  - manifest rows
  - stuck transfers
  - last reconciliation run
  - failed finalizations
- Provide enough detail to support shared-instance troubleshooting without exposing unsafe cleanup operations.

### Deliverables

- debuggable production behavior

## Milestone Breakdown

## Milestone 1: Settings And Manifest

### Includes

- config constants
- DB schema
- encryption updates
- settings persistence
- settings UI shell
- connection test route

### Exit Criteria

- users can save external backend settings
- Aurral can validate API connectivity
- manifest table exists

## Milestone 2: External slskd Search And Enqueue

### Includes

- `slskd` API wrapper
- search normalization
- enqueue flow
- manifest row creation

### Exit Criteria

- Aurral can search and enqueue through `slskd`
- results are persisted into manifest rows

## Milestone 3: Worker Integration

### Includes

- backend abstraction
- built-in backend wrapped
- external backend integrated into worker

### Exit Criteria

- worker can run with either backend
- built-in behavior remains intact

## Milestone 4: Finalization And Playback

### Includes

- hardlink/copy finalization
- final path generation
- flow/import completion based on finalized files
- Navidrome compatibility validation

### Exit Criteria

- finalized files appear correctly under `aurral-weekly-flow`

## Milestone 5: Cleanup And Reconciliation

### Includes

- conservative cleanup service
- startup reconciliation
- retry and stuck-transfer handling

### Exit Criteria

- flow rotation works safely
- Aurral survives restarts without orphaning its own state

## Milestone 6: Docs, Diagnostics, And Polish

### Includes

- README updates
- admin diagnostics
- additional tests
- rollout notes

### Exit Criteria

- feature is supportable by users and maintainers

## Suggested Ownership By Area

### Backend Core

- transport abstraction
- worker refactor
- manifest and reconciliation

### Backend API

- settings routes
- diagnostics routes
- health surfaces

### Frontend

- settings UX
- status messaging
- diagnostics display

### Docs And Release

- setup docs
- migration notes
- feature flag and rollout guidance

## Recommended First Coding Slice

The smallest meaningful first implementation slice is:

1. add settings fields and persistence
2. add external `slskd` connection test route
3. add manifest table
4. add `slskdClient.js`
5. add a backend abstraction without changing behavior
6. wrap the built-in client in that abstraction

That creates the scaffolding needed to add the external backend safely without destabilizing the current worker.

## Final Note

The most important architectural principle is to treat external `slskd` as a transport and transfer-state provider, not as the owner of Aurral's playlist library.

If the code stays organized around that rule, the optional external backend can be added without rewriting the surrounding flow, imported-playlist, Navidrome, and Lidarr behavior.
