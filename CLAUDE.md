# CC Manager

Interactive manager CLI (and VSCode extension) that uses **Codex CLI** as a controller and **Claude Code CLI** as a worker in a supervised agentic loop.

## Architecture

```
User input
  -> Codex CLI (controller) decides what to do
    -> Claude Code CLI (worker) executes the task
      -> Controller reviews result, loops or stops
```

The controller (Codex) receives user messages and outputs structured JSON decisions with `action: "delegate"` or `action: "stop"`, along with `claude_message` (prompt for the worker) and `controller_messages` (messages shown to the user). The worker (Claude Code) executes the prompt using `--output-format stream-json` and streams results back.

### Core loop (`src/orchestrator.js`)

1. User sends a message
2. Controller turn: Codex CLI runs, reads transcript, outputs a JSON decision
3. If decision is `stop`, the loop ends
4. If decision is `delegate`, the worker turn starts: Claude Code runs with the `claude_message`
5. Worker result is appended to transcript, loop returns to step 2

## Project Structure

```
bin/cc-manager.js          Entry point (CLI)
src/
  cli.js                   CLI argument parsing, subcommands (shell, run, resume, status, logs, list, doctor)
  shell.js                 Interactive readline shell (terminal UI)
  orchestrator.js          Core manager loop (controller turn -> worker turn -> repeat)
  codex.js                 Spawns Codex CLI, parses structured JSON output
  claude.js                Spawns Claude Code CLI, handles streaming events
  events.js                Parses raw streaming events into normalized summaries
  render.js                Terminal renderer (ANSI colors, timeline UI with circles/pipes)
  state.js                 Run state management (manifests, run dirs, requests, loops)
  schema.js                JSON schema for controller output format
  prompts.js               System prompt for the controller
  process-utils.js         Process spawning helpers (Windows .cmd shim handling)
  utils.js                 General utilities (JSON I/O, truncate, slugify, etc.)
extension/
  package.json             VSCode extension manifest
  extension.js             Extension activate/deactivate, WebviewPanel creation
  webview-renderer.js      WebviewRenderer (same API as terminal Renderer, sends postMessage)
  session-manager.js       Bridges webview input to orchestrator (replaces shell.js)
  webview/
    main.js                Frontend: renders messages, markdown, thinking animation
    style.css              Timeline UI styles, role colors, input area
  resources/
    icon.svg               Orange "CC" icon for editor title bar
  .vscodeignore            Excludes dev files from vsix package
  .gitignore               Ignores copied src/, .vsix, node_modules
```

## Key Concepts

### Renderer interface

Both `src/render.js` (terminal) and `extension/webview-renderer.js` (VSCode) implement the same public API:

- `user(text)`, `controller(text)`, `claude(text)`, `shell(text)` - Role-labeled messages
- `claudeEvent(raw)`, `controllerEvent(raw)` - Process raw streaming events
- `streamMarkdown(label, text)`, `flushStream()` - Streaming text output
- `launchClaude(prompt, sameSession)` - Show worker launch info
- `stop()`, `close()` - Lifecycle
- `banner(text)`, `line(label, text)`, `mdLine(label, text)` - Misc output
- `requestStarted(runId)`, `requestFinished(message)` - Request lifecycle
- `userPrompt()` - Returns prompt string (terminal) or no-op (webview)
- `write(text)` - Raw output (terminal only)

### Claude Code streaming events

Claude Code outputs `stream-json` with these event types we care about:
- `content_block_delta` with `text_delta` -> text streaming
- `content_block_delta` with `input_json_delta` -> tool input accumulation
- `content_block_start` with `tool_use` -> tool call start (name, index)
- `content_block_stop` -> block finished (triggers tool call formatting)

### Tool call formatting

Tool calls are accumulated (start -> input deltas -> stop) then formatted with human-readable descriptions:
- `Bash` -> "Running command: ..."
- `Read` -> "Reading path"
- `Write/Edit` -> "Writing/Editing path"
- `Glob` -> "Glob: pattern"
- `Grep` -> "Grep: pattern in path"

### Terminal timeline UI (`src/render.js`)

- Unicode circles (U+25CF) on content lines, pipes (U+2502) between them
- Role headers: User (cyan), Controller (yellow), Claude code (green), Shell (magenta)
- User messages have gray background, controller messages have dark yellow background
- Inline markdown to ANSI conversion (bold, italic, code, headings, bullets)

### Windows process spawning (`src/process-utils.js`)

- `winEscapeArg()` handles proper quoting for Windows .cmd shims
- `spawnArgs()` wraps args with `shell: true` on Windows
- Both `codex` and `claude` are spawned as child processes with streaming stdout

### State management (`src/state.js`)

Runs are stored in `.cc-manager/runs/<run-id>/`:
- `manifest.json` - Run metadata, config, counters, request history
- `events.jsonl` - All events (user messages, controller decisions, worker results)
- `transcript.jsonl` - Conversation transcript
- `requests/<req-id>/loop-<n>/` - Per-loop controller/worker stdout/stderr logs

## npm Scripts

### Core
- `npm test` - Run tests

### VSCode Extension
- `npm run ext:build` - Copy `src/` into `extension/src/` and package as `extension/cc-manager.vsix`
- `npm run ext:install` - Build + install the vsix into VSCode (requires `code` CLI)
- `npm run ext:clean` - Remove copied `extension/src/` and `extension/cc-manager.vsix`
- `npm run ext:copy-src` - Just copy `src/` into `extension/src/` (used by ext:build)

After running `ext:install`, reload VSCode (Ctrl+Shift+P -> "Reload Window"). The extension adds:
- Command palette: "CC Manager: Open"
- Orange CC icon in the editor title bar
- Opens as a full-width editor tab with input box at bottom
- Multiple tabs supported simultaneously
- Repo root = currently open workspace folder

When you modify files in `src/`, run `npm run ext:install` again to update the extension.

## CLI Usage

```
cc-manager                         Start interactive shell
cc-manager run <message>           One-shot run
cc-manager resume <run-id>         Resume existing run
cc-manager status <run-id>         Show run status
cc-manager logs <run-id>           Show recent events
cc-manager list                    List saved runs
cc-manager doctor                  Verify codex and claude binaries
```

### Interactive shell commands
- `/help` - Show help
- `/new <message>` - Start a new run
- `/resume <run-id>` - Attach to existing run
- `/use <run-id>` - Alias for /resume
- `/run` - Continue interrupted request
- `/status` - Show attached run status
- `/list` - List runs
- `/logs [n]` - Show last n events
- `/workflow [name]` - List or run a workflow
- `/detach` - Detach from current run
- `/quit` - Exit

Plain text starts a new run (if none attached) or sends a message to the current run.

## Workflows

Place workflow directories in `.cc-manager/workflows/` (project-level) or `~/.cc-manager/workflows/` (global). Each directory must contain a `WORKFLOW.md` with YAML frontmatter (`name`, `description`). Use `/workflow` to list available workflows or `/workflow <name>` to run one.

## Project-level customization (CCMANAGER.md)

Place a `CCMANAGER.md` file in your project root to customize the controller's behavior — similar to how `CLAUDE.md` customizes Claude Code. Its contents are automatically appended to the controller's system prompt as "Project instructions from CCMANAGER.md". This works in both the CLI and the VSCode extension. If the file doesn't exist, nothing is appended.

## Prerequisites

- Node.js >= 18.17
- [Codex CLI](https://github.com/openai/codex) installed and on PATH (`codex`)
- [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) installed and on PATH (`claude`)
- For the VSCode extension: VSCode >= 1.85.0
