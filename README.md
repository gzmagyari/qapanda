<p align="center">
  <img src="extension/resources/icon.png" width="80" height="80" alt="QA Panda">
</p>

<h1 align="center">QA Panda</h1>

<p align="center">
  <strong>AI-powered QA agents for your codebase — test, fix, and ship with confidence</strong>
</p>

<p align="center">
  <a href="https://marketplace.visualstudio.com/items?itemName=qapandaapp.qapanda-vscode">
    <img src="https://img.shields.io/visual-studio-marketplace/v/qapandaapp.qapanda-vscode?label=VS%20Code%20Marketplace&logo=visual-studio-code&logoColor=white&color=0078d7" alt="VS Code Marketplace">
  </a>
  <a href="https://github.com/gzmagyari/qapanda/actions">
    <img src="https://img.shields.io/github/actions/workflow/status/gzmagyari/qapanda/ci.yml?label=CI&logo=github" alt="CI">
  </a>
</p>

<p align="center">
  <a href="#installation">Installation</a> •
  <a href="#quick-start">Quick Start</a> •
  <a href="#features">Features</a> •
  <a href="#agents">Agents</a> •
  <a href="#cli">CLI</a> •
  <a href="#configuration">Configuration</a>
</p>

---

<p align="center">
  <a href="https://marketplace.visualstudio.com/items?itemName=qapandaapp.qapanda-vscode">
    <img src="https://img.shields.io/badge/Install_for_VSCode-0078d7?style=for-the-badge&logo=visual-studio-code&logoColor=white" alt="Install for VSCode">
  </a>
</p>

<p align="center">
  <video src="https://github.com/user-attachments/assets/1271d9c8-0b41-46d5-abdf-4a00475edfab" controls width="600"></video>
</p>

<h3 align="center">An open-source AI QA engineer that lives inside VSCode.<br>Works with your ChatGPT subscription — no API keys needed.</h3>

<p align="center">
Say <strong>"test the login page"</strong> and watch it work.<br>
It launches a <strong>real browser</strong>, navigates your app, clicks through flows,<br>
finds bugs, takes screenshots, and gives you a <strong>professional QA report</strong>.<br><br>
It can even delegate to a Developer agent to <strong>fix bugs and re-test automatically</strong>.<br>
Or just copy the report and hand it to <strong>Claude Code / Codex / Cursor</strong> to fix.
</p>

## Hot Updates

**2026-04-01**  
Latest updates. See the full history in [CHANGELOG.md](./CHANGELOG.md).

- 🔥 Added full **BYOK API mode** with curated provider/model support for OpenAI, Gemini, Anthropic, and OpenRouter.
- 🔐 Kept **Codex + your ChatGPT subscription** as the primary no-key-required path.
- 🧪 Added live QA progress cards plus cleaner final test summaries.
- 📋 Added a unified **QA Report** with `This Run` / `This Session`, clickable details, copy actions, and **Export PDF**.
- 🏷️ Renamed user-facing **Tasks** to **Issues** and improved test/issue ID visibility across the UI.
- 🧠 Added automatic context compaction plus manual `/compact` for long API sessions.
- 🐼 Added the animated panda beside the chat input.

### Why QA Panda?

- **No test scripts to write.** Describe what to test in plain English. The AI agent figures out the rest.
- **Real browser, real bugs.** Not mocking or simulating — it controls headless Chrome and interacts with your actual app.
- **Find, fix, and verify in one loop.** QA agent finds bugs, Developer agent fixes them, QA re-tests. Fully automated.
- **Built-in test & bug tracking.** Test cases, run history, kanban board, screenshots — no external tools needed.
- **Works with your stack.** Extend with any MCP server. Add your own agents. Customize everything.
- **Copy the report, paste to Claude Code / Codex / Cursor.** Use QA Panda for testing, then hand the bug report to your favorite coding tool to fix.
- **Works with your ChatGPT subscription.** Powered by [Codex CLI](https://github.com/openai/codex) — no expensive API tokens needed. Just use your existing ChatGPT Plus/Pro subscription.
- **Free and open source.** MIT licensed.

---

## What Can It Do?

- **AI QA Engineer** — Creates test plans, executes them step by step, logs bugs with screenshot evidence, and tracks pass/fail results
- **Browser Testing** — Headless Chrome with screenshots, DOM inspection, network monitoring, and full page interaction
- **Test Case Management** — Create, run, and track repeatable test cases with pass/fail/skip status and full history
- **Bug Tracking** — Built-in kanban board with task tracking, comments, and progress updates
- **Agent Orchestration** — Chain agents together: QA finds bugs -> Developer fixes them -> QA re-tests -> repeat until done
- **MCP Ecosystem** — Extensible with any MCP server (file system, databases, APIs, custom tools)
- **Developer Agent** — A coding agent that can read your codebase, write fixes, and run tests

## Installation

### VSCode Extension

Install from the [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=qapandaapp.qapanda-vscode):

1. Open VSCode
2. Go to Extensions (`Ctrl+Shift+X`)
3. Search for **"QA Panda"**
4. Click Install

Or install from the command line:
```bash
code --install-extension qapandaapp.qapanda-vscode
```

### Terminal CLI

```bash
npm install -g qapanda
```

### Prerequisites

- **Node.js** >= 18
- **[Codex CLI](https://github.com/openai/codex)** — `npm install -g @openai/codex` then `codex login`
- **Google Chrome** (optional) — for browser-based testing

The setup wizard checks all dependencies and helps you install anything missing.

## Quick Start

### VSCode Extension

1. Open a project in VSCode
2. Click the **QA Panda** icon in the editor title bar (or `Ctrl+Shift+P` → "QA Panda: Open")
3. The setup wizard runs on first launch — it checks your environment and gets you ready
4. Start chatting: **"test my app"**, **"test the login page for bugs"**, or **"run a full QA pass on the signup flow"**

### Terminal CLI

```bash
# Interactive shell
qapanda

# One-shot: test something and exit
qapanda run "test the signup form for validation bugs"

# Take a screenshot and report
qapanda run --print --agent QA-Browser "take a screenshot of the homepage"

# Run a full QA pass
qapanda run "do a full QA pass on this app"

# Check your setup
qapanda doctor
```

## Features

### Browser Testing with Headless Chrome

QA Panda launches a headless Chrome browser and gives your AI agents full control. They can navigate pages, fill forms, click buttons, take screenshots, inspect the DOM, monitor network requests, and read console output.

```
You: test the login page

🔍 QA Engineer (Browser)
  ● Navigating to http://localhost:3000/login
  ● Screenshot captured: login-page-initial.png
  ● Testing valid credentials...
  ● Screenshot captured: login-success-redirect.png
  ● Testing empty password field...
  ● Screenshot captured: validation-error.png
  ● ✅ 4 passed  ❌ 1 failed  ⏭️ 0 skipped

🐛 Bug: Password field accepts spaces-only input
   Severity: medium
   Steps: Enter "   " in password → form submits instead of showing validation
```

The Browser tab shows a live screencast of what the agent sees, with navigation controls.

### Test Case Management

Agents automatically create structured, repeatable test cases:

- **Create tests** with descriptions, tags, and steps
- **Run tests** with pass/fail/skip results per step
- **Track history** — every run is recorded with timestamps and evidence
- **Link bugs** — failing tests automatically create bug tickets
- **Re-test** — run the same test again after fixes to verify

View all tests in the **Tests tab** — a board view organized by status (untested, passing, failing, partial).

### Bug & Task Tracking

Built-in kanban board for managing bugs and tasks:

- **6 columns**: Backlog → Todo → In Progress → Review → Testing → Done
- **Bug reports** with severity levels (critical, high, medium, low)
- **Comments and progress updates** on each task
- **Linked to tests** — bugs reference the failing test step and screenshot evidence
- **Drag and drop** to move tasks between columns

### Agent Orchestration

Three modes for working with agents:

| Mode | How it works | Best for |
|------|-------------|----------|
| **Send** | Direct message to the selected agent | Quick tasks, specific questions |
| **Continue** | Controller picks the next step, delegates to an agent, and reports back | Single-pass tasks, iterating on feedback |
| **Orchestrate** | Controller runs agents autonomously until done | End-to-end testing, complex tasks |

The **Loop toggle** works with Continue mode — after each Continue pass completes, it automatically sends another one, so the controller keeps driving work forward without you pressing Continue each time. Orchestrate mode already loops automatically until it decides to stop.

### Agent Delegation

In Orchestrate mode, the controller can chain agents together. For example, QA finds bugs, then the controller delegates to Developer to fix them, then back to QA to verify:

```
🎯 Orchestrator
  "QA found 2 bugs. Delegating to Developer to fix them."

💻 Developer
  "Fixed the validation bug in signup.js and the CSS overflow in navbar.css."

🎯 Orchestrator
  "Fixes applied. Delegating back to QA to re-test."

🔍 QA Engineer
  ● Re-testing signup validation... ✅ PASS
  ● Re-testing navbar overflow... ✅ PASS
  "All bugs verified fixed."
```

### MCP Server Ecosystem

QA Panda comes with built-in MCP servers and supports adding your own:

**Built-in:**

| Server | Purpose |
|--------|---------|
| **detached-command** | Run shell commands safely from agents |
| **cc-tests** | Test case CRUD, execution, and reporting |
| **cc-tasks** | Task/bug tracking with kanban workflow |
| **chrome-devtools** | Browser automation via Chrome DevTools Protocol |
| **cc-agent-delegate** | Agent-to-agent delegation |

**Add your own** on the MCP Servers tab — project-level (`.qpanda/mcp.json`) or global (`~/.qpanda/mcp.json`). Any MCP server that follows the protocol works (stdio or HTTP).

Example — add a filesystem MCP:
```json
{
  "filesystem": {
    "command": "npx",
    "args": ["-y", "@modelcontextprotocol/server-filesystem", "/path/to/dir"]
  }
}
```

### Multi-Tab Interface

| Tab | What it does |
|-----|-------------|
| **Agent** | Chat interface with Send / Continue / Orchestrate controls |
| **Tasks** | Kanban board for bugs and tasks |
| **Tests** | Test case board with run history |
| **Agents** | View and configure AI agents |
| **MCP Servers** | Add and manage MCP tool servers |
| **Browser** | Live Chrome screencast with navigation controls |
| **Settings** | Developer settings and prompt customization |

### Smart Setup Wizard

First-time setup detects your environment and helps you get started:

- **Codex CLI** — checks installation, version, and login status
- **Google Chrome** — checks installation and version (v120+ for headless debugging)
- **Node.js** — checks version (v18+ required)
- **Auto-fix** — click "Fix automatically" to install Codex or log in without leaving the editor
- **Manual steps** — OS-specific instructions (Windows, macOS, Linux) for manual setup
- **Re-check** — verify your fixes worked with one click

### Standalone Web App

Run the same UI outside VSCode:

```bash
npm run web
# Opens at http://localhost:3000
```

Same features, same agents, same MCP servers — just in a browser tab. Hot-reloads when you change the source code.

## Agents

### QA Engineer (Browser)

A professional QA engineer that tests web applications using headless Chrome:

- Creates structured test plans before testing
- Takes screenshots before and after every action
- Verifies results visually and via DOM/console/network inspection
- Logs bugs immediately when found — with screenshot evidence
- Covers happy path, edge cases, error states, validation, accessibility, and security basics
- Reports findings with a professional summary

### Developer (Secondary)

A software developer agent available for bug fixing and code changes. Works best when paired with QA — the orchestrator can delegate bugs found by QA to the Developer for fixes, then send them back to QA for re-testing.

- Reads and understands your codebase before making changes
- Follows existing patterns, naming conventions, and code style
- Makes focused, minimal changes

### Custom Agents

Create your own agents on the **Agents tab** or in config files:

```json
{
  "my-agent": {
    "name": "My Custom Agent",
    "description": "Does something specific",
    "system_prompt": "You are a specialist in...",
    "cli": "codex",
    "enabled": true,
    "mcps": {}
  }
}
```

Save in `.qpanda/agents.json` (project) or `~/.qpanda/agents.json` (global).

### Prompt Tags

Use `@@filename` in any agent's `system_prompt` to include the contents of a markdown file:

```json
{
  "system_prompt": "@@my_custom_prompt"
}
```

This loads `my_custom_prompt.md` from `.qpanda/prompts/` (project), `~/.qpanda/prompts/` (global), or the built-in `prompts/` directory.

## CLI

### Commands

```bash
qapanda                          # Start interactive shell
qapanda run <message>            # One-shot run
qapanda run --print --agent QA-Browser <msg>  # Single turn, print result, exit
qapanda resume <run-id>          # Resume existing run
qapanda status <run-id>          # Show run status
qapanda logs <run-id>            # Show recent events
qapanda list                     # List saved runs
qapanda doctor                   # Check dependencies
qapanda setup                    # Run setup wizard
qapanda agents                   # List available agents
qapanda modes                    # List available modes
```

### Interactive Shell

```
/help                    Show help
/new <message>           Start a new run
/resume <run-id>         Attach to existing run
/run                     Continue interrupted request
/status                  Show run status
/list                    List saved runs
/agents                  List available agents
/agent <id>              Switch to direct agent mode
/controller-cli [cli]    Show or set controller CLI
/worker-cli [cli]        Show or set worker CLI
/tasks                   List tasks
/task add <title>        Create a task
/task done <id>          Mark task done
/mcp                     List MCP servers
/config                  Show current config
/clear                   Clear and reset
/quit                    Exit
```

### CLI Options

```bash
--agent <id>              Direct to specific agent
--mode <id>               Select mode (test, dev, dev-test, test-fix)
--controller-model <name> Controller model
--worker-model <name>     Worker model
--wait <delay>            Auto-continue delay (1m, 5m, 1h, etc.)
--print                   One-shot mode
--quiet                   Minimal output
--raw-events              Show raw streaming events
```

## Configuration

### Project-Level

Place files in `.qpanda/` at your project root:

| File | Purpose |
|------|---------|
| `.qpanda/agents.json` | Project-specific agents |
| `.qpanda/mcp.json` | Project MCP server configs |
| `.qpanda/prompts/*.md` | Prompt templates for `@@tag` syntax |
| `QAPANDA.md` | Project instructions appended to controller prompt |

### Global

Place files in `~/.qpanda/`:

| File | Purpose |
|------|---------|
| `~/.qpanda/agents.json` | Global agents (available in all projects) |
| `~/.qpanda/mcp.json` | Global MCP server configs |
| `~/.qpanda/prompts/*.md` | Global prompt templates |
| `~/.qpanda/settings.json` | Global settings |

### Workflows

Create reusable workflows in `.qpanda/workflows/` or `~/.qpanda/workflows/`:

```
.qpanda/workflows/
  my-workflow/
    WORKFLOW.md      # YAML frontmatter with name + description
```

Run with `/workflow my-workflow` in the interactive shell.

## Architecture

```
User Input
  → Codex CLI (controller) decides what to do
    → Codex CLI (worker/agent) executes the task
      → Controller reviews result, loops or stops
```

**State** is stored in `.qpanda/runs/<run-id>/` with manifests, events, transcripts, and per-request logs.

**MCP servers** (tasks, tests, detached-command) run as HTTP servers on localhost, auto-injected into every agent session.

**Chrome** is managed by the extension — launched headless on demand with a debug port for DevTools Protocol access.

## Development

```bash
# Install dependencies
npm install

# Run tests
npm run test:unit      # Unit tests
npm run test:ui        # UI tests (JSDOM-based)
npm test               # All tests

# VSCode extension
npm run ext:build      # Build .vsix package
npm run ext:install    # Build + install to VSCode

# Standalone web app (same UI as extension)
npm run web            # Start at http://localhost:3000
```

## Cross-Platform Support

QA Panda works on **Windows**, **macOS**, and **Linux**. CI runs on all three platforms with every push.

| Feature | Windows | macOS | Linux |
|---------|---------|-------|-------|
| VSCode Extension | ✅ | ✅ | ✅ |
| Terminal CLI | ✅ | ✅ | ✅ |
| Browser Testing | ✅ | ✅ | ✅ |
| Setup Wizard | ✅ | ✅ | ✅ |
| Auto-fix Install | ✅ | ✅ | ✅ |

## Requirements

| Dependency | Required | Purpose |
|-----------|----------|---------|
| Node.js >= 18 | Yes | Runtime |
| [Codex CLI](https://github.com/openai/codex) | Yes | AI agent backend |
| Google Chrome | No | Browser testing (recommended) |
| VSCode >= 1.85 | No | Extension UI (CLI works standalone) |

## License

MIT
