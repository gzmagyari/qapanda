# CLI Parity: Complete Feature Parity with Extension (Updated)

## Context

The CLI (`cc-manager`) is severely behind the extension. This updated plan covers ALL gaps including onboarding, Docker auto-pull, system agents/modes, MCP auto-injection, task management, Chrome integration, and the new qa-desktop Node.js rewrite.

**Principle:** Everything the extension can do, the CLI can do (except visual Chrome/VNC output).

---

## Phase 1: Shared Config Infrastructure

### 1a. Move system resources to shared location

Move `extension/resources/system-agents.json` → `resources/system-agents.json`
Move `extension/resources/system-modes.json` → `resources/system-modes.json`
Update `extension/agents-store.js`, `extension/modes-store.js`, and `ext:build` script.

### 1b. Create `src/config-loader.js` — unified config loading

Extract merge logic from `extension/agents-store.js` and `extension/modes-store.js`:
- `loadMergedAgents(repoRoot, resourcesDir)` — system + global + project agents
- `loadMergedModes(repoRoot, resourcesDir)` — system + global + project modes
- `loadMergedMcpServers(repoRoot)` — global + project MCP servers
- `loadOnboarding()` — read `~/.cc-manager/onboarding.json`
- `enabledAgents(data)` / `enabledModes(data)` — filter disabled entries

Extension stores import from this shared module.

### 1c. Create `src/mcp-injector.js` — system MCP auto-injection

Port `_mcpServersForRole()` logic from session-manager:
- Auto-inject `detached-command` (local path for CLI, container path for remote)
- Auto-inject `cc-tasks` (start stdio server from `extension/tasks-mcp-server.js` or bundled copy)
- Filter MCPs by `target` field (both/controller/worker/none)
- Merge base + agent-specific MCPs
- Replace localhost with `host.docker.internal` for remote agents

### 1d. Bundle `detached-command-mcp/` and `tasks-mcp-server.js` for CLI access

Copy or symlink so CLI can find them at known relative paths.

---

## Phase 2: New CLI Flags & Arguments

### 2a. New flags in `src/cli.js` RUN_SPEC

```
--mode <id>                  Select mode (quick-test, auto-test, quick-dev, auto-dev, auto-dev-test)
--agent <id>                 Direct to specific agent (bypasses controller)
--test-env <browser|computer> Test environment for modes with requiresTestEnv
--print                      One-shot: run single turn, print result, exit
--controller-cli <codex|claude> Controller CLI (default from onboarding)
--worker-cli <claude|codex>  Worker CLI (default from onboarding)
--controller-thinking <level> Controller thinking tier (minimal/low/medium/high/xhigh)
--worker-thinking <level>    Worker thinking level (low/medium/high)
--wait <delay>               Auto-pass delay (1m, 5m, 1h, etc.)
--list-modes                 List available modes and exit
--list-agents                List available agents and exit
--no-mcp-inject              Disable auto-injection of system MCPs
```

### 2b. Mode application logic

When `--mode` specified:
1. Load modes from config
2. Resolve env-aware fields with `--test-env`
3. Set `controllerSystemPrompt` from mode
4. If `useController === false`: direct agent mode
5. If `requiresTestEnv`: validate `--test-env` is set
6. Apply onboarding CLI preference (remap agent CLIs if needed)

### 2c. Direct agent mode

When `--agent dev` or mode sets direct agent:
- Skip controller → `runDirectWorkerTurn()`
- Agent system prompt, CLI, MCPs applied
- If `--print`: run once, output to stdout, exit

### 2d. Config loading before run

In `cli.js` before `prepareNewRun()`:
1. Load onboarding preferences → set controller/worker CLI defaults
2. Load merged agents → apply CLI preference remapping
3. Load merged modes → apply if `--mode` set
4. Load merged MCP servers
5. Auto-inject system MCPs (detached-command, cc-tasks)
6. Pass everything to manifest

---

## Phase 3: Interactive Shell Enhancements

### 3a. New shell commands

```
/mode [id]              List modes or select one (reconfigures session)
/agent [id]             List agents or switch to direct agent
/agents                 List all agents with details
/modes                  List all modes with details
/tasks                  List tasks from .cc-manager/tasks.json
/task add <title>       Create task
/task done <id>         Mark task done
/task <id>              Show task details
/mcp                    List configured MCP servers
/config                 Show full config (mode, agent, models, thinking, CLIs)
/controller-model [m]   Show/set controller model
/worker-model [m]       Show/set worker model
/controller-thinking [l] Show/set controller thinking level
/worker-thinking [l]    Show/set worker thinking level
/controller-cli [name]  Show/switch controller CLI
/worker-cli [name]      Show/switch worker CLI
/instances              List Docker instances
/instance start         Start container for this session
/instance stop [name]   Stop container
/instance snapshot      Create snapshot
/clear                  Clear chat, start fresh
```

### 3b. Mid-session config switching

All `/controller-*` and `/worker-*` commands modify the active manifest and take effect on the next turn. CLI switching resets session IDs (same as extension).

---

## Phase 4: Onboarding & Doctor

### 4a. `cc-manager doctor` (enhanced)

Expand current doctor to check everything:
```
cc-manager doctor

Claude Code CLI:    ✓ v4.6.0
Codex CLI:          ✓ v1.0.0
Google Chrome:      ✓ /Program Files/Google/Chrome/...
Docker Desktop:     ✓ Running
Docker Image:       ✓ gzmagyari/qa-agent-desktop:latest (local)
detached-command:   ✓ bundled
tasks-mcp:          ✓ bundled
Onboarding:         ✓ Complete (preference: both)
```

Uses same detection functions from `extension/onboarding.js` (shared via config-loader).

### 4b. `cc-manager setup` (CLI onboarding)

Interactive onboarding equivalent:
```
cc-manager setup

Detecting environment...
  ✓ Claude Code CLI v4.6.0
  ✓ Codex CLI v1.0.0
  ✓ Google Chrome found
  ✓ Docker Desktop running
  ✗ Docker image not found

CLI preference? [both/claude-only/codex-only] (both): both

Pulling Docker image gzmagyari/qa-agent-desktop:latest...
  Downloading... 45% [===========         ]

Setup complete! Saved to ~/.cc-manager/onboarding.json
```

Writes same `onboarding.json` and `system-agents.json` overrides as extension.

### 4c. `--setup` flag

`cc-manager run --setup "test the app"` — runs setup if not done, then executes.
Or: auto-detect on first run if `onboarding.json` missing, prompt user.

---

## Phase 5: Browser Testing (Chrome)

### 5a. Chrome management for CLI

Reuse `extension/chrome-manager.js` directly (it's pure Node.js, no VSCode deps except the `_dbg` logger):
- `ensureChrome(panelId)` → spawn headless Chrome, return port
- `killChrome(panelId)` → stop Chrome
- `getChromePort(panelId)` → check if running

### 5b. Auto-configure Chrome DevTools MCP

When agent uses `chrome-devtools` MCP:
1. Start Chrome via chrome-manager
2. Replace `{CHROME_DEBUG_PORT}` in MCP args
3. Inject into manifest

### 5c. CLI flags

```
--chrome-port <port>    Use existing Chrome at this debug port
--no-chrome             Skip Chrome auto-start
```

---

## Phase 6: Desktop Testing (Docker)

### 6a. Container lifecycle from CLI

`qa-desktop/` is already bundled Node.js. CLI just needs to call it:
- Before remote agent run: `ensureDesktop()` via `src/remote-desktop.js`
- `remote-desktop.js` already uses bundled `qa-desktop/cli.js`
- Auto-pull Docker image via `getImageName()` if missing

### 6b. Shell commands

```
/instances              List containers (calls qa-desktop ls)
/instance start         Start container (calls qa-desktop up)
/instance stop [name]   Stop container (calls qa-desktop down)
/instance snapshot      Create snapshot (calls qa-desktop snapshot)
```

### 6c. CLI flags

```
--no-desktop            Skip container auto-start for remote agents
--no-snapshot           Don't use snapshot image
```

---

## Phase 7: Tasks Support

### 7a. Tasks MCP for CLI

Start `tasks-mcp-server.js` as stdio MCP (injected into manifest):
```json
{
  "command": "node",
  "args": ["<path>/tasks-mcp-server.js"],
  "env": { "TASKS_FILE": "<repoRoot>/.cc-manager/tasks.json" }
}
```

Auto-injected by `mcp-injector.js` for all runs.

### 7b. Shell task commands

```
/tasks                  List all tasks grouped by status
/task add <title>       Create new task (status: todo)
/task <id>              Show task detail
/task done <id>         Move task to done
/task status <id> <s>   Change task status
```

Read/write directly to `.cc-manager/tasks.json` (same format as extension).

---

## Phase 8: Agent & Mode Management (CLI CRUD)

### 8a. Agent management commands

```
cc-manager agents                          List all agents
cc-manager agents add <id> --name "..." --cli claude --system-prompt "..."
cc-manager agents edit <id> --cli codex
cc-manager agents delete <id>
cc-manager agents restore <id>             Restore system agent to default
```

Or shell equivalents:
```
/agents
/agent add <id> ...
/agent edit <id> ...
/agent delete <id>
```

### 8b. Mode management commands

Same pattern for modes.

---

## Phase 9: MCP Server Management (CLI CRUD)

```
cc-manager mcp list                        List all MCP servers
cc-manager mcp add <name> --command node --args server.js --scope global
cc-manager mcp edit <name> --target worker
cc-manager mcp delete <name> --scope project
```

Or shell: `/mcp add ...`, `/mcp edit ...`, `/mcp delete ...`

---

## Phase 10: Print Mode

### 10a. `cc-manager run --print --agent dev "fix the bug"`

One-shot execution:
1. Load config, apply mode/agent
2. Run single direct worker turn
3. Stream text deltas to stdout, tool calls to stderr
4. Print final result to stdout
5. Exit with code 0/1

### 10b. `cc-manager run --print --mode quick-test --test-env browser "test login"`

Same but with mode:
1. Apply mode config
2. Start Chrome if needed (browser env)
3. Start container if needed (computer env)
4. Run agent turn
5. Exit

---

## Implementation Order

### Milestone 1: Foundation
- Phase 1 (shared config loader, MCP injector, move resources)
- Phase 2a (new CLI flags)
- Phase 7a (tasks MCP injection)
- **Result:** `cc-manager run --mode quick-dev "say hello"` works with system agents + MCPs

### Milestone 2: Direct Agent & Print Mode
- Phase 2b-2d (mode application, direct agent, config loading)
- Phase 10 (print mode)
- **Result:** `cc-manager run --print --agent dev "fix this"` works

### Milestone 3: Interactive Shell
- Phase 3 (all new shell commands)
- **Result:** Full interactive parity

### Milestone 4: Onboarding & Doctor
- Phase 4 (enhanced doctor, CLI setup wizard)
- **Result:** `cc-manager doctor` and `cc-manager setup` work

### Milestone 5: Browser Testing
- Phase 5 (Chrome management from CLI)
- **Result:** `cc-manager run --mode quick-test --test-env browser "test login"` works

### Milestone 6: Desktop Testing
- Phase 6 (container lifecycle from CLI)
- **Result:** `cc-manager run --mode quick-test --test-env computer "test app"` works

### Milestone 7: CRUD Commands
- Phase 8 (agent/mode management)
- Phase 9 (MCP server management)
- **Result:** Full management parity

---

## Files to Create

1. `src/config-loader.js` — unified config loading (shared by CLI + extension)
2. `src/mcp-injector.js` — system MCP auto-injection
3. `resources/system-agents.json` — moved from extension/resources/
4. `resources/system-modes.json` — moved from extension/resources/

## Files to Modify

1. `src/cli.js` — new flags, config loading, mode/agent/print support, setup/doctor commands
2. `src/shell.js` — all new interactive commands
3. `src/state.js` — accept loaded agents/MCPs/modes in normalizeRunOptions
4. `src/orchestrator.js` — support direct agent turns from CLI
5. `src/codex.js` — controller thinking level support
6. `src/claude.js` — ensure agent MCP merge works with auto-injected MCPs
7. `extension/agents-store.js` — import from shared config-loader
8. `extension/modes-store.js` — import from shared config-loader
9. `extension/onboarding.js` — share detection functions with CLI
10. `package.json` — ext:build copies resources/

## Testing

Every phase gets full test coverage before moving to the next milestone.

### Unit Tests (per phase)
- `tests/unit/config-loader.test.js` — merge logic, preference remapping, file loading
- `tests/unit/mcp-injector.test.js` — auto-injection, target filtering, host rewriting
- `tests/unit/cli-flags.test.js` — new flag parsing (mode, agent, test-env, print, thinking, etc.)
- `tests/unit/mode-application.test.js` — mode resolution, env-aware fields, chat target selection
- `tests/unit/doctor.test.js` — detection functions, output formatting

### CRUD Tests
- `tests/crud/cli-agents-crud.test.js` — agent add/edit/delete via CLI commands
- `tests/crud/cli-modes-crud.test.js` — mode add/edit/delete
- `tests/crud/cli-mcp-crud.test.js` — MCP server add/edit/delete
- `tests/crud/cli-tasks-crud.test.js` — task CRUD via shell commands

### Live Tests
- `tests/live/cli-mode-run.test.js` — `cc-manager run --mode quick-dev "hello"` with real claude
- `tests/live/cli-print-mode.test.js` — `--print --agent dev` one-shot execution
- `tests/live/cli-direct-agent.test.js` — agent delegation without controller
- `tests/live/cli-browser-test.test.js` — `--mode quick-test --test-env browser` with real Chrome
- `tests/live/cli-desktop-test.test.js` — `--mode quick-test --test-env computer` with real Docker
- `tests/live/cli-mcp-inject.test.js` — verify detached-command + cc-tasks auto-injected and callable
- `tests/live/cli-setup.test.js` — `cc-manager setup` interactive onboarding
- `tests/live/cli-doctor.test.js` — `cc-manager doctor` full health check
- `tests/live/cli-shell-commands.test.js` — all new shell commands (/mode, /agent, /config, /tasks, etc.)
- `tests/live/cli-config-switching.test.js` — mid-session model/thinking/CLI changes in shell

### Integration Tests
- `tests/live/cli-parity.test.js` — run the same prompt through extension (SessionManager) and CLI, verify equivalent output
- `tests/live/cli-onboarding-preference.test.js` — set "claude-only" preference, verify all agents use claude CLI

## Verification

```bash
# Milestone 1
cc-manager run --mode quick-dev "say hello"

# Milestone 2
cc-manager run --print --agent dev "what files are here"

# Milestone 3
cc-manager shell
> /modes
> /mode quick-dev
> /config
> /controller-model gpt-5.4
> /worker-thinking high

# Milestone 4
cc-manager doctor
cc-manager setup

# Milestone 5
cc-manager run --mode quick-test --test-env browser "test homepage"

# Milestone 6
cc-manager run --mode quick-test --test-env computer "test desktop app"

# Milestone 7
cc-manager agents
cc-manager mcp list

# Full test suite
npm run test:all
```
