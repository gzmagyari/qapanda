# Workflow Studio

## What It Is

A tabbed view in the VS Code extension where the first tab is "Agent" (the existing chat interface) and the second tab is "Workflows" — a full workflow management environment. The Workflows tab shows a list of all workflows, a built-in text editor for each one, and its own chat interface with a workflow-specialized agent that can create, edit, delete, validate, and dry-run workflows through natural language. Instead of hand-writing `WORKFLOW.md` files, the user just tells the workflow agent what they want. This feature is VS Code only — the CLI keeps basic workflow commands but does not get the tabbed UI.

## Why Users Would Want It

Workflows are powerful but friction-heavy today. Users have to remember the frontmatter format, get the YAML right, and manually test by running full sessions. A dedicated tab with an agent that understands the workflow format means users can say "create a workflow that runs all tests and fixes failures" and get a valid, ready-to-use workflow. The built-in editor lets them fine-tune it, and the agent handles the tedious parts.

## MVP Shape

- **Tabbed webview**: The VS Code extension gains a tab bar at the top of the panel. "Agent" is the existing chat experience. "Workflows" is the new tab.
- **Workflow list**: The left side of the Workflows tab shows all workflows from `.cc-manager/workflows/` (project) and `~/.cc-manager/workflows/` (global), with create and delete buttons.
- **Editor pane**: Selecting a workflow opens its `WORKFLOW.md` in a full text editor on the right side — syntax-highlighted markdown with live frontmatter validation.
- **Workflow agent chat**: Below the editor (or as a split), a chat interface connected to a workflow-specialized agent with tools for all CRUD operations: create workflow from instructions, modify an existing workflow's steps or parameters, validate frontmatter and placeholders, dry-run to preview the first controller decision, and delete workflows. The user just describes what they want in plain language.
- **Parameters**: Workflows declare `params:` in YAML frontmatter. Placeholders like `{{branch}}` are substituted at run time. The workflow agent understands this format and uses it when generating workflows.

## Why It Fits cc-manager

Workflows already live in `.cc-manager/workflows/` and are loaded by `src/state.js`. The studio adds a management UI and an agent layer on top of existing infrastructure. The workflow agent is a scoped instance of the same agent pattern cc-manager already uses — a chat interface with specialized tools — applied to workflow files instead of repo code.

## Implementation Notes

- `extension/webview/main.js` gains a tab system: `renderAgentTab()` (existing chat) and `renderWorkflowsTab()` (new). Tab state is managed in the webview, switching between two content areas.
- The workflow list reads from `src/state.js` workflow loading. The editor is a `<textarea>` or a Monaco editor instance embedded in the webview, saving back to the `WORKFLOW.md` file on change.
- The workflow agent is a separate Claude Code session spawned by `extension/session-manager.js` with a workflow-specific system prompt and tools: `create_workflow`, `edit_workflow`, `delete_workflow`, `validate_workflow`, `dry_run_workflow`. Each tool calls into `src/workflow-studio.js`.
- Add `src/workflow-studio.js` with `scaffold(name, content)`, `update(name, content)`, `remove(name)`, `validate(workflowDir)`, and `dryRun(workflowDir, params)`.
- Extend workflow loading in `src/state.js` to parse `params` from frontmatter and substitute `{{placeholder}}` tokens.
- CLI keeps `cc-manager workflow list`, `workflow validate`, and `workflow dry-run` as lightweight subcommands — no tabbed UI, but the core operations remain accessible.
