# Comprehensive Extension Test Suite

## Context

Before the major CLI parity refactoring (PLAN-CLI-PARITY.md), we need a full test suite that validates every feature of the extension works correctly. This creates a safety net — after the refactoring we run the tests and instantly see what broke.

The tests go beyond standard unit tests: they test live functionality with real CLIs (claude, codex), real Chrome instances, real Docker containers, and real MCP servers. Each test may consume API tokens/resources — that's acceptable.

**Existing test infrastructure:** 12 test files in `tests/` using Node.js `node:test`, with fake backends in `tests/fakes/`. We build on this.

---

## Test Suite Structure

```
tests/
  fakes/                          # Existing fake backends
    fake-codex.js
    fake-claude.js
  integration.test.js             # Existing integration tests
  session-manager-config.test.js  # Existing
  ... (existing test files)

  # NEW TEST FILES:
  live/                           # Live integration tests (real CLIs, real resources)
    claude-worker.test.js         # Claude Code as worker (all configs)
    codex-worker.test.js          # Codex as worker
    codex-controller.test.js      # Codex as controller
    claude-controller.test.js     # Claude as controller
    interactive-mode.test.js      # Claude interactive PTY mode (claude-parser)
    remote-agent.test.js          # qa-remote-claude/codex in Docker containers
    browser-testing.test.js       # Chrome lifecycle + DevTools MCP
    desktop-testing.test.js       # Docker container lifecycle + qa-desktop MCP
    mcp-tasks.test.js             # Tasks MCP CRUD (stdio + HTTP)
    mcp-detached-command.test.js  # Detached command MCP job lifecycle
    mcp-qa-desktop.test.js        # QA Desktop MCP (snapshot, instances)
    mcp-injection.test.js         # MCP auto-injection and merging per role
    agent-delegation.test.js      # Controller delegates to agents
    direct-agent.test.js          # Direct agent mode (no controller)
    modes.test.js                 # Mode selection and configuration
    full-flows.test.js            # End-to-end complete user scenarios

  unit/                           # Pure logic unit tests (no real CLIs)
    escapeHtml.test.js            # escapeHtml handles objects, arrays, nulls
    config-merge.test.js          # Agent/mode/MCP config merging logic
    args-building.test.js         # buildClaudeArgs, buildCodexArgs, buildCodexWorkerArgs
    mcp-placeholder.test.js       # {CHROME_DEBUG_PORT}, {EXTENSION_DIR} replacement
    render-labels.test.js         # workerLabelFor, controllerLabelFor
    transcript-restore.test.js    # sendTranscript label + trim
    wizard-logic.test.js          # Mode resolution, env-aware field resolution
    process-utils.test.js         # winEscapeArg, spawnArgs

  crud/                           # CRUD operation tests (real filesystem)
    tasks-crud.test.js            # Create/read/update/delete tasks
    agents-crud.test.js           # Agent CRUD (system, global, project scopes)
    modes-crud.test.js            # Mode CRUD (system, global, project scopes)
    mcp-servers-crud.test.js      # MCP server config CRUD (global + project)

  helpers/
    test-utils.js                 # Shared test utilities
    live-test-utils.js            # Helpers for live tests (start/stop Chrome, containers, etc.)
```

---

## Part 1: Unit Tests (No External Dependencies)

### 1a. `tests/unit/escapeHtml.test.js`
Test the `escapeHtml` function handles all types:
- String input → HTML-escaped
- Object input → JSON stringified then escaped
- Array input → JSON stringified then escaped
- null/undefined → empty string
- Number → string conversion

### 1b. `tests/unit/config-merge.test.js`
Test agent/mode/MCP merging logic (extract from agents-store/modes-store):
- System agents merge with global overrides
- Project agents override global
- Disabled agents filtered out
- Removed system agents hidden
- System override restore works
- MCP global + project merge
- MCP target filtering (both/controller/worker/none)

### 1c. `tests/unit/args-building.test.js`
Test CLI argument construction:
- `buildClaudeArgs` with: default config, custom model, custom thinking, agent system prompt, agent MCPs, disallowed tools, interactive mode flag
- `buildCodexArgs` with: default config, custom model, MCP injection (TOML format), shell disabling
- `buildCodexWorkerArgs` with: system prompt prepended, MCP injection
- Placeholder replacement: `{CHROME_DEBUG_PORT}` → actual port, `{EXTENSION_DIR}` → path, `{REPO_ROOT}` → path

### 1d. `tests/unit/mcp-placeholder.test.js`
- `{CHROME_DEBUG_PORT}` replaced in MCP args
- `{EXTENSION_DIR}` replaced in MCP args/command
- `{REPO_ROOT}` replaced
- Nested replacement in env vars
- Missing placeholder left as-is (no crash)

### 1e. `tests/unit/render-labels.test.js`
- `workerLabelFor('claude')` → "Worker (Claude)"
- `workerLabelFor('codex')` → "Worker (Codex)"
- `workerLabelFor('claude', 'Developer')` → "Developer"
- `workerLabelFor('qa-remote-claude')` → "Worker (qa-remote-claude)"
- `controllerLabelFor('codex')` → "Controller (Codex)"
- `controllerLabelFor('claude')` → "Controller (Claude)"

### 1f. `tests/unit/transcript-restore.test.js`
- Worker text trimmed (no leading/trailing newlines)
- Worker label from manifest agent sessions (not just CLI)
- Controller label from manifest controller CLI
- Empty transcript → no messages
- Malformed JSONL lines → skipped gracefully

### 1g. `tests/unit/wizard-logic.test.js`
- `resolveByEnv(string, env)` → returns string as-is
- `resolveByEnv({browser: "A", computer: "B"}, "browser")` → "A"
- `resolveByEnv({browser: "A", computer: "B"}, "computer")` → "B"
- `getAllEnabledModes()` filters disabled modes
- Mode with `requiresTestEnv` validates env is set

### 1h. `tests/unit/process-utils.test.js`
- `winEscapeArg` handles spaces, quotes, special chars
- `spawnArgs` adds `shell: true` on Windows

---

## Part 2: CRUD Tests (Real Filesystem, Temp Directories)

### 2a. `tests/crud/tasks-crud.test.js`
Using temp directory for `.cc-manager/tasks.json`:
- Create task → verify in file
- List tasks → returns all
- Update task status (backlog → in-progress → done)
- Add comment to task
- Update task fields (title, description)
- Delete task → removed from file
- Empty tasks file → empty list (no crash)
- Concurrent reads/writes don't corrupt

### 2b. `tests/crud/agents-crud.test.js`
Using temp directory structure:
- Load system agents from `resources/system-agents.json`
- Save global agent → appears in `~/.cc-manager/agents.json`
- Save project agent → appears in `.cc-manager/agents.json`
- Project overrides global (same ID)
- Disable system agent via override
- Remove system agent via override
- Restore system agent default
- Delete custom agent
- Verify merged result: system + global + project

### 2c. `tests/crud/modes-crud.test.js`
Same pattern as agents:
- Load system modes
- Save/edit/delete global and project modes
- System mode override and restore
- Merged result correct

### 2d. `tests/crud/mcp-servers-crud.test.js`
- Save global MCP server config
- Save project MCP server config
- Edit server (change command, args, env)
- Toggle target (both → controller → worker → none)
- Delete server
- Merge global + project (project wins on name collision)

---

## Part 3: MCP Server Tests (Real MCP Servers, Local)

### 3a. `tests/live/mcp-tasks.test.js`
Start tasks MCP server (stdio), send JSON-RPC messages:
- `tools/list` → returns all task tools
- `tools/call` → `create_task` with title/description → success
- `tools/call` → `list_tasks` → includes created task
- `tools/call` → `update_task_status` → status changes
- `tools/call` → `add_comment` → comment stored
- `tools/call` → `get_task` → returns full task with comments
- Also test HTTP variant (start tasks-mcp-http, POST to /mcp)

### 3b. `tests/live/mcp-detached-command.test.js`
Start detached-command MCP (stdio), send JSON-RPC:
- `start_command` → run `echo hello` → returns job_id
- `read_output` → returns "hello\n"
- `list_jobs` → shows the job
- `get_job` → shows status=exited, exit_code=0
- `start_command` → run long-running command → `stop_job` → verify stopped
- Multiple concurrent jobs
- Job output persistence (stdout/stderr files)

### 3c. `tests/live/mcp-qa-desktop.test.js`
**Requires:** `qa-desktop` CLI installed
- `list_instances` → returns instance list
- `get_instance_status` → returns status for known instance
- `snapshot_container` → creates snapshot (if container running)
- `snapshot_delete` → removes snapshot

### 3d. `tests/live/mcp-injection.test.js`
Test the MCP auto-injection and merging logic:
- Session manager `_mcpServersForRole('worker', false)` → includes cc-tasks, detached-command
- Session manager `_mcpServersForRole('controller', false)` → includes cc-tasks, detached-command
- Session manager `_mcpServersForRole('worker', true)` → remote paths for detached-command
- Agent-specific MCPs merged with base (e.g., QA-Browser gets chrome-devtools + base)
- Target filtering: MCP with `target: "controller"` only appears in controller MCPs
- User-defined MCPs from global + project scopes included

---

## Part 4: Live CLI Backend Tests (Real CLIs, Costs Tokens)

### 4a. `tests/live/claude-worker.test.js`
**Requires:** `claude` CLI on PATH
- Spawn Claude worker with simple prompt "Say hello" → get response text
- Verify stream-json output format (content_block_delta events)
- Verify session ID returned
- Resume session (second turn) → verify session continuity
- Custom model flag → verify model override
- Custom thinking level → verify env var set
- Agent system prompt → verify appended
- Agent MCPs → verify --mcp-config includes them
- disallowedTools → verify Bash disabled when detached-command present

### 4b. `tests/live/codex-worker.test.js`
**Requires:** `codex` CLI on PATH
- Spawn Codex as worker with simple prompt → get response
- Verify output format (line-by-line JSON)
- System prompt prepended to stdin
- MCP injection via `-c` flags
- Shell disabling when detached-command present

### 4c. `tests/live/codex-controller.test.js`
**Requires:** `codex` CLI on PATH
- Spawn Codex as controller with transcript → get JSON decision
- Verify decision format: `{ action, controller_messages, claude_message }`
- Decision `action: "stop"` → loop ends
- Decision `action: "delegate"` → has `claude_message`
- Session resume (exec → resume → exec)
- Custom model flag
- MCP injection works

### 4d. `tests/live/claude-controller.test.js`
**Requires:** `claude` CLI on PATH
- Spawn Claude as controller (alternative to Codex)
- Verify it produces valid JSON decisions
- Output schema enforced

### 4e. `tests/live/interactive-mode.test.js`
**Requires:** `claude` CLI on PATH, `node-pty` installed
- Create `ClaudeSession` → verify starts and reaches idle
- `session.send("Say hello")` → get response with events
- Verify event types: text-delta, final-text
- Tool call events: tool-start, tool-output
- Multiple turns on same session → session persists
- `session.abort()` → process killed cleanly
- `session.close()` → cleanup

---

## Part 5: Browser Testing (Real Chrome)

### 5a. `tests/live/browser-testing.test.js`
**Requires:** Chrome/Chromium installed
- Start Chrome via chrome-manager → get debug port
- Verify Chrome process is running
- Verify `/json/version` endpoint responds
- Start screencast → receive frame data
- Navigate to a URL via CDP → verify chromeUrl event
- Send click input via CDP → no crash
- Kill Chrome → process stopped, temp dir cleaned
- Multiple instances (different panelIds) → different ports
- Chrome DevTools MCP connects and works:
  - `navigate_page` to a test URL
  - `take_screenshot` → returns image data
  - `list_pages` → returns page list
- QA-Browser agent with Chrome:
  - Start Chrome, inject chrome-devtools MCP
  - Run agent with "navigate to example.com and tell me the title"
  - Verify agent uses CDP tools and returns result

---

## Part 6: Desktop/Container Testing (Real Docker)

### 6a. `tests/live/desktop-testing.test.js`
**Requires:** Docker, `qa-desktop` CLI
- `ensureDesktop(repoRoot, panelId)` → container starts, returns ports
- Verify health endpoint responds: `http://localhost:${apiPort}/healthz`
- Verify noVNC port accessible
- `listInstances()` → shows the container
- Snapshot: `getSnapshotExists()` → check state
- `stopInstance(name)` → container stops
- `restartInstance()` → container back up
- Remote agent run:
  - Start container
  - Run qa-remote-claude with simple prompt inside container
  - Verify response comes back
  - Verify workspace mounted at /workspace

### 6b. `tests/live/remote-agent.test.js`
**Requires:** Docker, `qa-desktop` CLI, `qa-remote-claude`/`qa-remote-codex`
- qa-remote-claude worker: spawn with --remote-port → response
- qa-remote-codex worker: spawn with --remote-port → response
- Verify remote port injection in args
- Verify MCP merging for remote (host.docker.internal substitution)
- Container session persistence across turns
- Container health check recovery

---

## Part 7: Agent Delegation & Modes (Real or Fake CLIs)

### 7a. `tests/live/agent-delegation.test.js`
Using fake backends for fast iteration, real CLIs for validation:
- Controller delegates to "dev" agent → worker runs with dev's system prompt
- Controller delegates to "QA-Browser" → worker runs with QA-Browser config + chrome-devtools MCP
- Controller delegates to "QA" → remote worker runs in container
- Per-agent session tracking (each agent gets unique sessionId)
- Agent not found → fallback to default worker
- Agent-specific thinking level applied

### 7b. `tests/live/direct-agent.test.js`
- Direct to "dev" agent → no controller, worker runs directly
- Direct to "QA-Browser" → Chrome auto-started, agent uses CDP
- Direct to "QA" → container auto-started, agent runs remotely
- Chat target switching mid-session (controller → direct agent → controller)
- Direct worker (no agent) → default Claude worker

### 7c. `tests/live/modes.test.js`
- Apply "quick-test" mode + browser env → QA-Browser agent, no controller, chrome-devtools MCP
- Apply "quick-test" mode + computer env → QA agent, no controller, container started
- Apply "auto-test" mode → controller with test coordinator prompt, QA agent available
- Apply "quick-dev" mode → dev agent, no controller
- Apply "auto-dev" mode → controller with dev coordinator prompt
- Apply "auto-dev-test" mode → controller with dev+QA agents available
- Mode env-aware field resolution (controllerPrompt, defaultAgent, availableAgents, setupAgent)
- Setup agent runs before main agent (when requiresTestEnv + setupAgent configured)

---

## Part 8: End-to-End Complete Flow Tests

### 8a. `tests/live/full-flows.test.js`

**Flow 1: Quick Dev (simple code question)**
1. Select quick-dev mode
2. Send "What is 2+2?"
3. Dev agent responds directly (no controller)
4. Verify: correct agent label, response text, no controller turn

**Flow 2: Quick Test Browser**
1. Select quick-test mode, browser env
2. Chrome auto-starts
3. Send "Navigate to example.com and verify the title"
4. QA-Browser agent uses Chrome DevTools
5. Verify: Chrome started, CDP commands sent, response includes page info

**Flow 3: Quick Test Desktop**
1. Select quick-test mode, computer env
2. Docker container auto-starts
3. Send "Run 'ls /workspace' and tell me what files are there"
4. QA agent runs in container
5. Verify: container started, response includes file listing

**Flow 4: Auto Dev (controller loop)**
1. Select auto-dev mode
2. Send "Create a file called test.txt with hello inside"
3. Controller plans → delegates to dev agent → dev creates file → controller reviews → stops
4. Verify: transcript has controller + worker turns, file created

**Flow 5: Session restore**
1. Run a quick-dev task
2. Save run ID
3. "Reload" (create new session manager)
4. Reattach to run
5. Send transcript to new webview
6. Verify: correct labels, trimmed text, mode indicator restored

---

## Helpers

### `tests/helpers/test-utils.js`
- `createTempDir()` → tmp directory with .cc-manager structure
- `cleanupTempDir(dir)` → remove
- `waitFor(conditionFn, timeoutMs)` → poll until condition true
- `mockRenderer()` → stub renderer with captured calls
- `mockPostMessage()` → capture postMessage calls

### `tests/helpers/live-test-utils.js`
- `startTasksMcp(tasksFile)` → start stdio tasks MCP, return { send, receive, close }
- `startDetachedCommandMcp(dataDir)` → start detached-command MCP
- `startChrome()` → launch Chrome, return { port, kill }
- `startDesktop(repoRoot)` → ensure Docker container, return { apiPort, vncPort, name, stop }
- `isCliAvailable(name)` → check if CLI is on PATH
- `skipIfMissing(name)` → skip test if CLI not available

---

## npm Scripts

```json
{
  "test": "node --test tests/*.test.js",
  "test:unit": "node --test tests/unit/*.test.js",
  "test:crud": "node --test tests/crud/*.test.js",
  "test:live": "node --test tests/live/*.test.js",
  "test:live:mcp": "node --test tests/live/mcp-*.test.js",
  "test:live:cli": "node --test tests/live/claude-*.test.js tests/live/codex-*.test.js tests/live/interactive-*.test.js",
  "test:live:browser": "node --test tests/live/browser-*.test.js",
  "test:live:desktop": "node --test tests/live/desktop-*.test.js tests/live/remote-*.test.js",
  "test:live:flows": "node --test tests/live/full-flows.test.js",
  "test:all": "node --test tests/**/*.test.js"
}
```

---

## Implementation Order

### Step 1: Helpers + Unit Tests
- Create `tests/helpers/test-utils.js` and `tests/helpers/live-test-utils.js`
- Write all `tests/unit/*.test.js` files
- **Fast, no external deps, catches logic bugs like escapeHtml crash**

### Step 2: CRUD Tests
- Write all `tests/crud/*.test.js` files
- Uses temp filesystem, no real CLIs needed
- **Validates config file read/write/merge**

### Step 3: MCP Server Tests
- Write `tests/live/mcp-tasks.test.js` and `tests/live/mcp-detached-command.test.js`
- Start real MCP processes, send JSON-RPC
- Write `tests/live/mcp-injection.test.js`
- **Validates MCP servers actually work**

### Step 4: CLI Backend Tests
- Write `tests/live/claude-worker.test.js`, `codex-worker.test.js`, etc.
- Requires real CLIs, costs tokens
- **Validates all CLI integrations**

### Step 5: Browser + Desktop Tests
- Write `tests/live/browser-testing.test.js` and `tests/live/desktop-testing.test.js`
- Requires Chrome + Docker
- **Validates Chrome and container lifecycle**

### Step 6: Agent + Mode + Full Flow Tests
- Write delegation, direct agent, modes, and full flow tests
- Combines everything
- **End-to-end validation of complete user scenarios**

---

## Files to Create

1. `tests/helpers/test-utils.js`
2. `tests/helpers/live-test-utils.js`
3. `tests/unit/escapeHtml.test.js`
4. `tests/unit/config-merge.test.js`
5. `tests/unit/args-building.test.js`
6. `tests/unit/mcp-placeholder.test.js`
7. `tests/unit/render-labels.test.js`
8. `tests/unit/transcript-restore.test.js`
9. `tests/unit/wizard-logic.test.js`
10. `tests/unit/process-utils.test.js`
11. `tests/crud/tasks-crud.test.js`
12. `tests/crud/agents-crud.test.js`
13. `tests/crud/modes-crud.test.js`
14. `tests/crud/mcp-servers-crud.test.js`
15. `tests/live/claude-worker.test.js`
16. `tests/live/codex-worker.test.js`
17. `tests/live/codex-controller.test.js`
18. `tests/live/claude-controller.test.js`
19. `tests/live/interactive-mode.test.js`
20. `tests/live/remote-agent.test.js`
21. `tests/live/browser-testing.test.js`
22. `tests/live/desktop-testing.test.js`
23. `tests/live/mcp-tasks.test.js`
24. `tests/live/mcp-detached-command.test.js`
25. `tests/live/mcp-qa-desktop.test.js`
26. `tests/live/mcp-injection.test.js`
27. `tests/live/agent-delegation.test.js`
28. `tests/live/direct-agent.test.js`
29. `tests/live/modes.test.js`
30. `tests/live/full-flows.test.js`

## Files to Modify

1. `package.json` — add new test scripts
2. Possibly extract some functions from `extension/webview/main.js` into testable modules (e.g., `escapeHtml`, `resolveByEnv`, `getAllEnabledModes`)

## Verification

```bash
# Run just unit tests (fast, no deps)
npm run test:unit

# Run CRUD tests (needs filesystem)
npm run test:crud

# Run MCP tests (starts real MCP servers)
npm run test:live:mcp

# Run CLI tests (needs claude/codex, costs tokens)
npm run test:live:cli

# Run browser tests (needs Chrome)
npm run test:live:browser

# Run desktop tests (needs Docker + qa-desktop)
npm run test:live:desktop

# Run full flow tests (needs everything)
npm run test:live:flows

# Run everything
npm run test:all
```
