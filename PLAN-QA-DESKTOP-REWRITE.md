# Rewrite qa-desktop in Node.js + Bundle in Extension + Auto-Setup

## Context

`qa-desktop`, `qa-remote-claude`, and `qa-remote-codex` are Python CLIs that manage Docker containers for remote testing. They require Python installed on the user's machine and manual `pip install`. We rewrite them in Node.js so they can be bundled directly in the extension (zero extra dependencies — Node.js is built into VSCode). We also publish the Docker image publicly so the extension can auto-pull it on first use.

---

## What Needs to Be Rewritten

### Component 1: `qa-desktop` CLI (container lifecycle)

**Current:** `agent_api/cli/instances.py` (~400 lines Python)
**Rewrite to:** `qa-desktop/cli.js`

Commands to implement:
- `up [NAME] --workspace PATH [--no-snapshot] [--json]` — Start container with 3 auto-assigned ports (API, VNC, noVNC), Mutagen sync, health wait
- `down NAME` — Stop + remove container
- `ls [--json]` — List running instances (query Docker labels)
- `snapshot NAME` — `docker commit` with workspace-derived tag
- `snapshot-delete NAME` — `docker rmi` the snapshot
- `snapshot-exists [--workspace PATH] [--json]` — Check if snapshot image exists

Implementation (all via `child_process.execSync/exec` calling `docker` CLI):
- `docker run -d --name NAME --label qa-desktop-instance=true --label qa-desktop.api-port=PORT ...`
- `docker ps --filter label=qa-desktop-instance=true --format json`
- `docker stop NAME && docker rm NAME`
- `docker commit NAME TAG`
- `docker images --filter reference=TAG --format json`
- Port allocation: bind to port 0 via `net.createServer()` to find free ports
- Health polling: HTTP GET `http://127.0.0.1:${apiPort}/healthz`
- Mutagen sync: download binary, exec `mutagen sync create/pause/flush/terminate`

### Component 2: `qa-remote-claude` / `qa-remote-codex` proxy CLIs

**Current:** `agent_api/cli/main.py` (~500 lines Python)
**Rewrite to:** `qa-desktop/proxy.js`

What it does:
1. Parse CLI args, extract `--remote-host`, `--remote-port`, `--remote-cwd`, `--remote-timeout`
2. Connect WebSocket to `ws://{host}:{port}/ws/raw`
3. Build payload: `{ argv, cwd, timeout_seconds, stdin, files, session_id }`
4. Rewrite argv: strip `--output-last-message FILE` (capture result, write to host after), strip `--cd` (use container cwd), proxy local file paths in MCP configs
5. Stream events from server: `stream.text` → write to stdout/stderr, `agent.event` → write JSON line, `run.completed` → exit with code
6. Handle Ctrl+C: send `{ type: "cancel" }` via WebSocket

### Component 3: Agent API server (runs INSIDE container)

**NO CHANGES.** The Python FastAPI server inside the Docker image stays as-is. The QAAgentDesktop repository is not modified. We only rewrite the host-side CLIs that talk to the container's existing API.

The container exposes:
- `GET /healthz` → `{ ok: true }`
- `GET /status` → workspace, display, versions
- `POST /api/cancel` → kill running processes
- `WS /ws/raw` → raw argv passthrough with streaming events
- `WS /ws/logs` → log queries

Our Node.js proxy (`qa-desktop/proxy.js`) connects to these endpoints — same protocol the Python proxy used.

---

## Directory Structure

```
qa-desktop/
  package.json              # Node.js package (no native deps)
  cli.js                    # qa-desktop CLI (container lifecycle)
  proxy.js                  # qa-remote-claude / qa-remote-codex proxy
  lib/
    docker.js               # Docker command helpers (run, ps, stop, rm, commit, images)
    ports.js                # Free port finder
    health.js               # Health check polling
    mutagen.js              # Mutagen sync management
    snapshot.js             # Snapshot tag derivation + commands
    labels.js               # Docker label constants + parsing
    ws-stream.js            # WebSocket client for /ws/raw streaming
```

Note: No `server/` directory — the container-side server stays Python (in the QAAgentDesktop Docker image).

---

## How It Integrates With the Extension

### Bundling

`qa-desktop/` lives at the root of cc-manager (sibling to `src/` and `extension/`). During `ext:build`:
- Copy `qa-desktop/` into `extension/qa-desktop/`
- The CLIs are invoked via `node extension/qa-desktop/cli.js` and `node extension/qa-desktop/proxy.js`

### Current `src/remote-desktop.js` Changes

Replace all `qa-desktop` CLI calls with direct function calls:
```javascript
// Before: execSync('qa-desktop up "name" --workspace "/path" --json')
// After:  const { up } = require('./qa-desktop/cli'); await up(name, { workspace, json: true });
```

Or keep the exec approach but point to the bundled Node.js script:
```javascript
const qaDesktopBin = `node "${path.join(extensionPath, 'qa-desktop', 'cli.js')}"`;
```

The second approach is simpler and requires fewer changes to `remote-desktop.js`.

### Proxy CLI Resolution

Instead of expecting `qa-remote-claude` / `qa-remote-codex` on PATH:
```javascript
// In claude.js / codex-worker.js:
const proxyBin = path.join(extensionPath, 'qa-desktop', 'proxy.js');
// Spawn: node proxyBin --agent claude --remote-port PORT ...
// Or:    node proxyBin --agent codex --remote-port PORT ...
```

The proxy script takes `--agent claude|codex` to determine which CLI to invoke inside the container.

---

## Docker Image

### Publishing

The Docker image (`Dockerfile` in QAAgentDesktop) needs to be published to a public registry:
- **Docker Hub:** `docker pull ccmanager/qa-agent-desktop:latest`
- **GitHub Container Registry:** `docker pull ghcr.io/yourorg/qa-agent-desktop:latest`

The image stays Python-based internally (it has the full Ubuntu desktop, Chrome, Claude, Codex, etc.) but the **agent API server inside the image** gets replaced with the Node.js version from `qa-desktop/server/`.

### Auto-Pull on First Use

When the extension needs a container (user selects desktop testing mode):
1. Check if image exists locally: `docker images ccmanager/qa-agent-desktop --format json`
2. If not found: show progress banner "Downloading QA Agent Desktop image (~2GB)..."
3. Run `docker pull ccmanager/qa-agent-desktop:latest`
4. Then proceed with `docker run`

### Dockerfile

**No changes to the Docker image.** The existing QAAgentDesktop image with its Python FastAPI server is published to Docker Hub as-is. Our Node.js proxy on the host talks to the container's existing API.

---

## Onboarding Auto-Setup Flow

```
Onboarding Step: Docker Detection
  1. Check `docker --version` → Docker installed?
     No  → "Install Docker Desktop to enable desktop testing" [link]
     Yes → Continue

  2. Check `docker ps` → Docker daemon running?
     No  → "Start Docker Desktop to enable desktop testing" [Start Docker]
     Yes → Continue

  3. Check `docker images ccmanager/qa-agent-desktop` → Image exists?
     No  → "Download QA Agent Desktop image? (~2GB)" [Download] [Skip]
           → Run `docker pull ccmanager/qa-agent-desktop:latest`
           → Show progress
     Yes → Continue

  4. Desktop testing ready ✅
```

No `qa-desktop` CLI detection needed anymore — it's bundled in the extension.
No `qa-remote-claude`/`qa-remote-codex` detection needed — they're bundled too.
Only Docker itself needs to be installed by the user.

---

## Implementation Order

### Phase 1: Node.js qa-desktop CLI (`qa-desktop/cli.js`)
- Port the `up`, `down`, `ls`, `snapshot`, `snapshot-delete`, `snapshot-exists` commands
- Use `child_process.exec` to call Docker CLI
- Free port finder, health polling, label management
- **Test:** Run existing desktop tests with the new CLI

### Phase 2: Node.js proxy (`qa-desktop/proxy.js`)
- WebSocket client connecting to container's `/ws/raw`
- Argv rewriting (strip `--output-last-message`, `--cd`, proxy file paths)
- Stdin/stdout streaming
- Signal handling (Ctrl+C → cancel)
- **Test:** Run existing remote-agent tests with the new proxy

### Phase 3: Docker image publishing
- Publish the existing QAAgentDesktop Docker image to Docker Hub (no changes to image)
- Image name: e.g., `ccmanager/qa-agent-desktop:latest`
- Done from the QAAgentDesktop repo, not from cc-manager

### Phase 4: Extension integration
- Bundle `qa-desktop/` in extension
- Update `remote-desktop.js` to use bundled CLI
- Update `claude.js` / `codex-worker.js` to use bundled proxy
- Remove `qa-desktop`, `qa-remote-claude`, `qa-remote-codex` from PATH detection
- Add Docker image auto-pull to onboarding

### Phase 5: Mutagen sync
- Port Mutagen binary download + sync management
- Or evaluate simpler alternatives (Docker volumes with watch mode)

---

## Files to Create

1. `qa-desktop/package.json`
2. `qa-desktop/cli.js` — Container lifecycle CLI (replaces Python qa-desktop)
3. `qa-desktop/proxy.js` — WebSocket proxy CLI (replaces Python qa-remote-claude/codex)
4. `qa-desktop/lib/docker.js` — Docker command helpers
5. `qa-desktop/lib/ports.js` — Free port allocation
6. `qa-desktop/lib/health.js` — Health check polling
7. `qa-desktop/lib/mutagen.js` — Mutagen sync
8. `qa-desktop/lib/snapshot.js` — Snapshot management
9. `qa-desktop/lib/labels.js` — Docker label constants
10. `qa-desktop/lib/ws-stream.js` — WebSocket client for container's /ws/raw

## Files to Modify

1. `src/remote-desktop.js` — Use bundled CLI instead of PATH lookup
2. `src/claude.js` — Use bundled proxy instead of `qa-remote-claude`
3. `src/codex-worker.js` — Use bundled proxy instead of `qa-remote-codex`
4. `extension/onboarding.js` — Remove qa-desktop PATH detection, add Docker image check
5. `extension/extension.js` — Update ext:build to copy qa-desktop/
6. `package.json` — Update ext:copy-src script

## Testing

### Unit Tests (`tests/unit/qa-desktop-*.test.js`)

**qa-desktop CLI logic:**
- `lib/ports.js`: findFreePort returns valid port numbers
- `lib/labels.js`: label constants correct, label parsing from Docker JSON
- `lib/snapshot.js`: snapshot tag derivation from workspace path (hash matches Python implementation)
- `lib/docker.js`: Docker command string building (run, ps, stop, rm, commit, images)
- `lib/health.js`: health poll logic (retry, timeout)
- `cli.js` arg parsing: all subcommands parse correctly (up, down, ls, snapshot, etc.)

**Proxy logic:**
- `proxy.js` arg parsing: extracts --remote-host, --remote-port, --remote-cwd, --remote-timeout, --agent
- Argv rewriting: --output-last-message stripped + captured, --cd stripped, local file paths proxied
- WebSocket message construction: correct payload format for /ws/raw
- Event handling: stream.text → stdout, agent.event → JSON line, run.completed → exit code
- Signal handling: cancel message sent on first Ctrl+C

### Live Tests (`tests/live/qa-desktop-*.test.js`)

**qa-desktop CLI live (requires Docker):**
- `up` starts a container with correct labels + ports → verify `docker ps` shows it
- `ls` lists the running container with correct metadata
- Health endpoint responds after `up`
- noVNC port accessible after `up`
- `snapshot` creates a Docker image with correct tag
- `snapshot-exists` returns true after snapshot
- `snapshot-delete` removes the image
- `down` stops + removes the container
- Multiple containers don't collide (different names/ports)

**Proxy CLI live (requires Docker + container running):**
- `proxy.js --agent claude`: connects WebSocket, sends prompt, gets streaming response
- `proxy.js --agent codex`: same with codex
- `--output-last-message`: result written to host file after run
- Ctrl+C sends cancel → process terminates
- Timeout handling: long prompt → times out correctly
- MCP config proxying: local paths rewritten to container paths

**Full integration (replaces existing remote-agent tests):**
- Start container via Node.js `qa-desktop/cli.js`
- Run prompt via Node.js `qa-desktop/proxy.js --agent claude`
- Verify response
- Run prompt via Node.js `qa-desktop/proxy.js --agent codex`
- Verify response
- Inject detached-command MCP, verify agent can call it inside container
- Inject cc-tasks MCP (HTTP via host.docker.internal), verify callable
- Stop container via Node.js `qa-desktop/cli.js`

**Parity tests (Node.js vs Python):**
- Run same prompt through Python `qa-remote-claude` and Node.js `proxy.js --agent claude`
- Verify both produce equivalent output format (same JSON event types, same exit codes)
- Verify snapshot tags match between Python and Node.js implementations

### Docker image auto-pull test
- Remove image locally (`docker rmi`)
- Extension detects image missing
- Auto-pull triggered → image downloaded
- Container starts normally after pull

## Verification

```bash
# Unit tests
npm run test:unit           # Includes new qa-desktop unit tests

# Live CLI tests
node qa-desktop/cli.js up test-instance --workspace /tmp/test --json
node qa-desktop/cli.js ls --json
node qa-desktop/cli.js down test-instance

# Live proxy tests
node qa-desktop/proxy.js --agent claude --remote-port 8765 -p "Say hello"

# Full test suite
npm run test:live:desktop   # Uses bundled Node.js CLI instead of Python
npm run test:live:mcp       # Remote MCP tests through new proxy
npm run test:all            # Everything including existing 328+ tests

# Extension build
npm run ext:install
# Open CC Manager → onboarding → desktop testing works without Python qa-desktop on PATH
```
