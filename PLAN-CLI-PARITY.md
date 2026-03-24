# CLI Parity: Bring All Extension Features to the Terminal App

## Context

The CLI terminal app (`cc-manager`) is severely behind the VSCode extension. The extension has modes, system agents, MCP auto-injection, tasks, browser/desktop testing, and agent management — none of which work from the CLI. This plan brings full parity so the CLI can be used for automation pipelines, CI/CD, and headless testing.

---

## Phase 1: Shared Config Loading Infrastructure

**Goal:** CLI reads the same config files as the extension.

### 1a. Move system resources to a shared location

Currently `system-agents.json` and `system-modes.json` live in `extension/resources/`. Move them to `resources/` at project root so both CLI and extension can access them.

**Files:**
- Move `extension/resources/system-agents.json` → `resources/system-agents.json`
- Move `extension/resources/system-modes.json` → `resources/system-modes.json`
- Update `extension/agents-store.js` and `extension/modes-store.js` to read from new path
- Update `npm run ext:build` to copy `resources/` into extension package

### 1b. Create `src/config-loader.js` — unified config loading

New module that loads and merges all config from JSON files (same logic as extension stores):

```
loadMergedMcpServers(repoRoot)
  → reads ~/.cc-manager/mcp.json + .cc-manager/mcp.json
  → returns { global: {...}, project: {...} }

loadMergedAgents(repoRoot)
  → reads resources/system-agents.json + ~/.cc-manager/agents.json + .cc-manager/agents.json
  → merges system → global → project (project overrides global overrides system)
  → applies system overrides (enabled/disabled/removed)
  → returns { system: {...}, global: {...}, project: {...} }

loadMergedModes(repoRoot)
  → reads resources/system-modes.json + ~/.cc-manager/modes.json + .cc-manager/modes.json
  → same merge logic
  → returns { system: {...}, global: {...}, project: {...} }
```

Extract the merge logic from `extension/agents-store.js` and `extension/modes-store.js` into this shared module. The extension stores would then import from this shared module.

### 1c. Create `src/mcp-injector.js` — system MCP auto-injection

Shared function to auto-inject system MCPs into a manifest:

```
injectSystemMcps(manifest, options)
  options: { repoRoot, tasksMcpPort?, qaDesktopMcpPort?, extensionPath? }

  Injects:
  - detached-command (always, using local path to detached-command-mcp/)
  - cc-tasks (if port available, or start stdio server)
  - qa-desktop (if port available)

  Also:
  - Filters MCPs by target (both/controller/worker/none)
  - Merges base + agent MCPs per role
```

For CLI, `detached-command-mcp/` needs to be accessible. Options:
- Bundle it in the npm package (it's already in the repo)
- Reference it via `__dirname` relative path

### 1d. Move `detached-command-mcp/` to shared location

Currently only in `extension/detached-command-mcp/`. Either:
- Keep it there and reference via path resolution, OR
- Copy to `lib/detached-command-mcp/` at project root

---

## Phase 2: New CLI Flags & Arguments

**Goal:** CLI can select modes, agents, test environments, and more.

### 2a. New flags in `src/cli.js`

Add to `RUN_SPEC` (applies to `run`, `resume`, `shell`):

```
--mode <id>              Select a mode (quick-test, auto-test, quick-dev, auto-dev, auto-dev-test)
--agent <id>             Talk directly to a specific agent (bypasses controller)
--test-env <env>         Test environment: browser or computer (for modes that need it)
--print                  One-shot: run single message, no controller loop, exit immediately
--list-modes             List available modes and exit
--list-agents            List available agents and exit
--controller-cli <cli>   Already exists (codex/claude)
--worker-cli <cli>       Already exists (claude/codex)
```

### 2b. Mode application logic

When `--mode` is specified:
1. Load modes from config
2. Look up the mode by ID
3. Resolve env-aware fields using `--test-env` (or default to 'browser')
4. Set:
   - `controllerSystemPrompt` from `mode.controllerPrompt`
   - If `mode.useController === false`, set chat target to direct agent (using `mode.defaultAgent`)
   - If `mode.useController === true`, configure available agents
   - If `mode.requiresTestEnv`, validate test-env is set

### 2c. Direct agent mode (`--agent` or `--print`)

When `--agent dev` is specified (or mode sets direct agent):
- Skip controller entirely
- Run `runDirectWorkerTurn()` with the agent's config
- Agent's system prompt, CLI, and MCPs are applied
- If `--print` is also set: run once and exit (like `claude --print`)

### 2d. Config loading integration

In `src/cli.js`, before calling `prepareNewRun()`:
1. Call `loadMergedAgents(repoRoot)` → flatten into agents object
2. Call `loadMergedMcpServers(repoRoot)` → build MCP config
3. Call `loadMergedModes(repoRoot)` → if `--mode` set, apply mode config
4. Call `injectSystemMcps()` → add cc-tasks, detached-command, etc.
5. Pass all of this to `prepareNewRun()`

---

## Phase 3: Interactive Shell Enhancements

**Goal:** Shell commands for managing agents, modes, tasks, MCPs.

### 3a. New shell commands in `src/shell.js`

```
/mode [id]          List modes or select a mode (reconfigures the session)
/agent [id]         List agents or switch to direct agent mode
/agents             List all available agents with details
/modes              List all available modes with details
/tasks              List tasks from .cc-manager/tasks.json
/task <action>      Create/update tasks (add, done, etc.)
/mcp                List configured MCP servers
/config             Show current configuration (mode, agent, MCPs, etc.)
/instances          List Docker desktop instances
/clear              Clear conversation and start fresh
```

### 3b. Mid-session mode/agent switching

When `/mode quick-dev` is run mid-session:
1. Clear current run (like /new)
2. Apply mode config (controller prompt, default agent, etc.)
3. Start fresh with new configuration
4. Display confirmation

---

## Phase 4: Browser Testing Support

**Goal:** CLI can launch headless Chrome and use Chrome DevTools MCP.

### 4a. Chrome management for CLI

Extract Chrome launch logic from `extension/chrome-manager.js` into a shared `src/chrome-manager.js` (or reuse directly):
- `launchChrome()` → starts headless Chrome with `--remote-debugging-port`
- Returns the debug port
- Manages Chrome process lifecycle

### 4b. Auto-configure Chrome DevTools MCP

When an agent has `chrome-devtools` in its MCPs (like QA-Browser):
1. Launch headless Chrome (if not already running)
2. Replace `{CHROME_DEBUG_PORT}` placeholder in MCP args with actual port
3. Add the Chrome DevTools MCP to the worker's MCP config

### 4c. CLI flags for browser

```
--chrome-port <port>     Use existing Chrome instance at this debug port
--no-chrome              Don't auto-launch Chrome (use existing)
```

---

## Phase 5: Desktop Testing Support (Docker Containers)

**Goal:** CLI can manage Docker containers for remote agent testing.

### 5a. Container lifecycle from CLI

`src/remote-desktop.js` already has the functions (`ensureDesktop`, `listInstances`, `stopInstance`, etc.). The CLI just needs to use them.

When a mode/agent requires `qa-remote-*` CLI:
1. `ensureDesktop(repoRoot, panelId)` → starts container, returns ports
2. Container gets workspace mounted at `/workspace`
3. qa-desktop MCP is injected with the container's API port
4. Agent runs inside container via the proxy CLI

### 5b. New shell commands for instances

```
/instances              List running containers
/instance start         Start a desktop container
/instance stop [name]   Stop a container
/instance snapshot      Snapshot current container state
```

### 5c. CLI flags for desktop

```
--desktop               Force start a desktop container (for remote agents)
--desktop-snapshot      Use snapshot for faster startup
--instance-name <name>  Use specific container name
```

---

## Phase 6: Tasks Support

**Goal:** CLI agents can read/write tasks, shell can manage tasks.

### 6a. Tasks MCP for CLI

The extension runs `tasks-mcp-http.js` as an HTTP server. For CLI, we can either:
- Start the same HTTP server in the CLI process
- OR use a stdio-based tasks MCP (the extension already has `tasks-mcp-server.js` for stdio)

Simplest: use stdio tasks MCP server. Auto-inject `cc-tasks` as a stdio MCP:
```json
{
  "command": "node",
  "args": ["<path>/tasks-mcp-server.js"],
  "env": { "TASKS_FILE": "<repoRoot>/.cc-manager/tasks.json" }
}
```

### 6b. Shell task commands

```
/tasks              List all tasks (grouped by status)
/task add <title>   Create a new task
/task done <id>     Mark task as done
/task <id>          Show task details
```

---

## Phase 7: Bash Disabling

**Goal:** CLI disables Bash tool when detached-command is available (matching extension behavior).

### 7a. In `src/claude.js` — `buildClaudeArgs()`

Already has Bash disabling logic (lines 123-132) that checks for `detached-command` in merged MCPs. Currently works if the MCP is manually configured. With auto-injection from Phase 1c, this will automatically fire.

### 7b. In `src/codex.js` — `buildCodexArgs()`

Check for `detached-command` in controller MCPs and add `-c features.shell_tool=false` if present.

---

## Phase 8: Print Mode (One-Shot Direct Agent)

**Goal:** `cc-manager run --print --agent dev "fix this bug"` runs a single agent turn and exits.

### 8a. Implementation in `src/cli.js`

When `--print` flag is set with `run` subcommand:
1. Load config (agents, MCPs, modes)
2. If `--agent` specified: run direct worker turn with that agent
3. If `--mode` specified: apply mode, then run accordingly
4. Print result to stdout
5. Exit with code 0 (success) or 1 (error)

No controller loop, no interactive shell. Just: spawn agent → get result → print → exit.

### 8b. Stream output

In print mode, stream the worker's output directly to stdout (like `claude --print`):
- Text deltas → stdout
- Tool calls → stderr or suppressed
- Final result → stdout

---

## Implementation Order

### Milestone 1: Foundation (Phases 1 + 2a + 7)
- Shared config loader
- Move system resources
- MCP auto-injection
- New CLI flags (--mode, --agent, --test-env, --print)
- Bash disabling
- **Result:** `cc-manager run --mode quick-dev "fix the bug"` works

### Milestone 2: Direct Agent & Print Mode (Phases 2b-2d + 8)
- Mode application logic
- Direct agent mode (--agent flag)
- Print mode (--print flag)
- **Result:** `cc-manager run --print --agent dev "fix this"` works

### Milestone 3: Interactive Shell (Phase 3)
- New shell commands (/mode, /agent, /tasks, /config, etc.)
- Mid-session switching
- **Result:** Interactive shell has feature parity with extension

### Milestone 4: Browser Testing (Phase 4)
- Chrome management for CLI
- Chrome DevTools MCP auto-config
- **Result:** `cc-manager run --mode quick-test --test-env browser "test login"` works

### Milestone 5: Desktop Testing (Phase 5)
- Container lifecycle from CLI
- Instance management shell commands
- **Result:** `cc-manager run --mode quick-test --test-env computer "test desktop app"` works

### Milestone 6: Tasks (Phase 6)
- Tasks MCP for CLI (stdio)
- Shell task commands
- **Result:** Agents can read/write tasks, shell can manage tasks

---

## Files to Create

1. `src/config-loader.js` — unified config file loading
2. `src/mcp-injector.js` — system MCP auto-injection
3. `src/chrome-manager.js` — Chrome lifecycle for CLI (extracted from extension)

## Files to Modify

1. `src/cli.js` — new flags, config loading, mode/agent application
2. `src/shell.js` — new commands, mid-session switching
3. `src/state.js` — accept loaded agents/MCPs/modes in normalizeRunOptions
4. `src/orchestrator.js` — support direct agent turns from CLI
5. `src/codex.js` — Bash disabling when detached-command present
6. `src/claude.js` — minor: ensure agent MCP merge works with auto-injected MCPs
7. `extension/agents-store.js` — import from shared config-loader
8. `extension/modes-store.js` — import from shared config-loader

## Files to Move

1. `extension/resources/system-agents.json` → `resources/system-agents.json`
2. `extension/resources/system-modes.json` → `resources/system-modes.json`

## Verification

### Milestone 1 Test
```bash
cc-manager run --mode quick-dev "say hello"
# Should: load dev agent, skip controller, use claude CLI, auto-inject detached-command
```

### Milestone 2 Test
```bash
cc-manager run --print --agent dev "what files are in this directory"
# Should: run dev agent once, print output, exit
```

### Milestone 3 Test
```bash
cc-manager shell
> /modes
# Should list: quick-test, auto-test, quick-dev, auto-dev, auto-dev-test
> /mode quick-dev
# Should switch to dev agent direct mode
> fix the login bug
# Should delegate directly to dev agent
```

### Milestone 4 Test
```bash
cc-manager run --mode quick-test --test-env browser "test the homepage loads"
# Should: launch Chrome, inject Chrome DevTools MCP, run QA-Browser agent
```

### Milestone 5 Test
```bash
cc-manager run --mode quick-test --test-env computer "test the desktop app"
# Should: start Docker container, inject qa-desktop MCP, run QA agent via qa-remote-claude
```

### Milestone 6 Test
```bash
cc-manager shell
> /tasks
# Should list tasks from .cc-manager/tasks.json
> /task add "Fix the login bug"
# Should create task
```
