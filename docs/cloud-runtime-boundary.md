# QA Panda Cloud Runtime Boundary

`B-02` adds a dedicated `src/cloud/` layer so this CommonJS repo can consume the hosted platform packages through one boundary instead of scattered direct imports.

## Runtime layout

- `src/cloud/config.js`
  - parses `QAPANDA_CLOUD_API_BASE_URL`
  - parses `QAPANDA_CLOUD_APP_BASE_URL`
  - parses `QAPANDA_CLOUD_AUTH_MODE`
  - parses `QAPANDA_CLOUD_SYNC_INTERVAL_MS`
  - defaults to the local hosted stack at `https://api.qapanda.localhost` and `https://app.qapanda.localhost`
- `src/cloud/loader.js`
  - dynamically imports the client-safe `@qapanda/*` ESM packages from CommonJS code
- `src/cloud/index.js`
  - creates the runtime boundary used by the CLI, VS Code extension host, and standalone web server
- `src/cloud/cli-auth.js`
  - adds CLI-only cloud login, status, logout, whoami, and hosted deep-link helpers on top of the shared boundary
  - persists the CLI session to `~/.qpanda/cloud/session.json` by default
  - uses encrypted-file storage by default, with `QAPANDA_CLOUD_SESSION_FILE` and `QAPANDA_CLOUD_SESSION_KEY` available for local overrides
- `src/cloud/extension-auth.js`
  - adds VS Code extension login, logout, hosted-link, and live-account-state helpers on top of the shared boundary
  - persists the extension session through VS Code `SecretStorage`
  - refreshes stale sessions before falling back to a logged-out state
- `src/cloud/repository-sync.js`
  - computes repository identity through `@qapanda/sync-core`
  - persists repo-local context-mode settings in `.qpanda/config.json`
  - generates shared device metadata for CLI and extension auth
  - resolves the local sync SQLite path at `.qpanda/runtime/cloud-sync.sqlite`
- `src/cloud/sync-adapters.js`
  - maps local issues from `.qpanda/tasks.json`, local tests from `.qpanda/tests.json`, and repo-local recipes from `.qpanda/workflows/*/WORKFLOW.md` into the cloud sync object model
  - queues upsert/delete mutations through the shared SQLite sync store
  - hydrates pulled remote objects back into the local JSON/workflow stores
  - surfaces sync conflicts per object type instead of hiding them behind the raw store API
- `src/cloud/sync-runtime.js`
  - registers the current checkout once a stored cloud session exists
  - imports the local tests/issues/recipes snapshot, runs startup `syncOnce()`, and keeps the same SQLite-backed store hydrated
  - starts periodic sync ticks and separate checkout heartbeats
  - resolves cloud conflicts through the shared sync client instead of bypassing the repo store
  - refreshes unread cloud-notification summary during sync so CLI and extension surfaces can show hosted presence without a second state path

## Entry-point wiring

- `src/cli.js` creates a CLI cloud boundary during config loading and preloads the packages before `run`
- `src/cli.js` also exposes `qapanda cloud login`, `status`, `logout`, `whoami`, and `open ...` through the CLI auth layer
- `extension/extension.js` creates an extension cloud boundary during activation, resolves the current hosted session through VS Code `SecretStorage`, and passes both bootstrap + live account state into `initConfig`
- `extension/extension.js` also starts one activation-scoped persistent sync runtime for the workspace repo when a hosted session exists, restarts it after extension login, and stops it on logout/deactivation
- `extension/extension.js` surfaces sync state + unread notification presence in both the Settings tab and a VS Code status bar item by reading that same runtime state
- `web/server.js` mirrors the same boundary for the standalone web app
- `createCloudBoundary()` now also exposes repository identity, device metadata, repo-local sync config, a factory for the local SQLite sync store, `createRepositorySyncAdapters()` for tests/issues/recipes, and `createRepositorySyncRuntime()` for persistent sync orchestration

## Environment contract

- `QAPANDA_CLOUD_API_BASE_URL`
  - defaults to `https://api.qapanda.localhost`
- `QAPANDA_CLOUD_APP_BASE_URL`
  - defaults to `https://app.qapanda.localhost`
- `QAPANDA_CLOUD_AUTH_MODE`
  - valid values: `disabled`, `pkce`, `device_code`
  - default: `disabled`
- `QAPANDA_CLOUD_SYNC_INTERVAL_MS`
  - default: `15000`

## CLI auth storage

- default file: `~/.qpanda/cloud/session.json`
- default storage mode: encrypted file envelope via `@qapanda/client-cloud`
- optional local overrides:
  - `QAPANDA_CLOUD_SESSION_FILE`
  - `QAPANDA_CLOUD_SESSION_KEY`

## Extension auth storage

- default storage boundary: VS Code `SecretStorage`
- secret key: `qapanda.cloud.session`
- the Settings tab shows hosted auth state, workspace, sync state, unread notification presence, and login/logout/open actions

## Repository identity and local sync state

- repo-local sync settings live in `.qpanda/config.json`
  - `cloudContextMode`
  - `cloudContextKey`
  - `cloudContextLabel`
- supported context modes:
  - `shared`
  - `branch`
  - `worktree`
  - `custom`
- the local sync database path is `.qpanda/runtime/cloud-sync.sqlite`
- `.qpanda/` is already ignored by Git in both the extension activation flow and repo defaults, so the sync database stays local-only
- local CRUD queueing and the persistent sync loop share that same SQLite-backed store instead of creating a second persistence path

The runtime layer now covers the `B-03` CLI auth path, the `B-04` VS Code extension auth/session UX path, the `B-05` repository identity + local sync-store path, the `B-06` local tests/issues/recipes sync adapter path, the `B-07` persistent sync/registration/heartbeat path, and the `B-08` sync-status + notification surfacing path.
