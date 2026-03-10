# Workflow Studio

## What It Is

A tabbed view in the VS Code extension where the first tab is "Agent" (the existing chat interface) and the second tab is "Workflows" — a full workflow management environment. The Workflows tab shows a list of all workflows, a built-in text editor for each one, and tools for validation and dry-run testing. This is a VS Code-only feature — the CLI keeps basic workflow commands but does not get the tabbed UI.

## Why Users Would Want It

Workflows are powerful but friction-heavy today. Users have to remember the frontmatter format, get the YAML right, and manually test by running full sessions. A dedicated tab with an editor, validation, and dry-run means users can build and iterate on workflows without leaving the extension. The built-in editor catches mistakes early, and dry-run previews the controller's first decision without burning real tokens.

## MVP Shape

- **Tabbed webview**: The VS Code extension gains a tab bar at the top of the panel. "Agent" is the existing chat experience. "Workflows" is the new tab.
- **Workflow list**: The left side of the Workflows tab shows all workflows from `.cc-manager/workflows/` (project) and `~/.cc-manager/workflows/` (global), with create and delete buttons.
- **Editor pane**: Selecting a workflow opens its `WORKFLOW.md` in a full text editor on the right side — syntax-highlighted markdown with live frontmatter validation. Errors (missing name, bad params syntax) are shown inline.
- **Validation and dry-run**: A "Validate" button checks frontmatter fields, parameter declarations, and placeholder syntax. A "Dry Run" button simulates the first controller turn and shows the decision in a preview pane — fast iteration without spawning a real worker.
- **Parameters**: Workflows declare `params:` in YAML frontmatter. Placeholders like `{{branch}}` are substituted at run time. The editor highlights placeholders and lists declared parameters in a sidebar.
- **Phase 2 — Workflow agent**: A future addition would add a chat interface within the Workflows tab connected to a workflow-specialized agent that can create, edit, and manage workflows through natural language conversation. This is not part of the initial MVP.

## Why It Fits cc-manager

Workflows already live in `.cc-manager/workflows/` and are loaded by `src/prompts.js`. The studio adds a management UI on top of existing infrastructure. Dry-run mode plugs into `src/orchestrator.js` by running a single controller turn with a flag that skips the worker spawn.

## Implementation Notes

- `extension/webview/main.js` gains a tab system: `renderAgentTab()` (existing chat) and `renderWorkflowsTab()` (new). Tab state is managed in the webview, switching between two content areas.
- The workflow list reads from `src/prompts.js` workflow loading. The editor is a `<textarea>` or a Monaco editor instance embedded in the webview, saving back to the `WORKFLOW.md` file on change.
- Add `src/workflow-studio.js` with `scaffold(name)`, `validate(workflowDir)`, and `dryRun(workflowDir, params)`.
- Extend workflow loading in `src/prompts.js` to parse `params` from frontmatter and substitute `{{placeholder}}` tokens.
- Dry-run reuses the controller turn logic in `src/orchestrator.js` with a `dryRun: true` option that returns the decision without proceeding to the worker.
- CLI keeps `cc-manager workflow list`, `workflow validate`, and `workflow dry-run` as lightweight subcommands.
