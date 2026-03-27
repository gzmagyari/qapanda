# Tests Tab: Full Test Management System

## Context

Add a repeatable test case management system with its own MCP, tab UI, and bi-directional linking to tasks. Tests are fundamentally different from tasks — they are repeatable verification scenarios with steps, acceptance criteria, pass/fail status per step, and run history. Agents can create, run, update, and re-test them. Failed tests can spawn bug tickets (tasks) that link back.

---

## Data Model

### `tests.json` (stored at `.qpanda/tests.json`)

```json
{
  "nextId": 1,
  "nextStepId": 1,
  "nextRunId": 1,
  "tests": [
    {
      "id": "test-1",
      "title": "Login page loads correctly",
      "description": "Verify the login page renders all required elements",
      "environment": "browser",
      "status": "passing",
      "steps": [
        {
          "id": 1,
          "description": "Navigate to /login",
          "expectedResult": "Login page loads with email and password fields",
          "status": "pass"
        },
        {
          "id": 2,
          "description": "Check for submit button",
          "expectedResult": "Submit button is visible and enabled",
          "status": "fail",
          "actualResult": "Button is disabled"
        }
      ],
      "linkedTaskIds": ["task-5"],
      "tags": ["auth", "ui"],
      "lastTestedAt": "2026-03-24T...",
      "lastTestedBy": "QA Engineer (Browser)",
      "created_at": "2026-03-24T...",
      "updated_at": "2026-03-24T...",
      "runs": [
        {
          "id": 1,
          "date": "2026-03-24T...",
          "agent": "QA Engineer (Browser)",
          "status": "failing",
          "stepResults": [
            { "stepId": 1, "status": "pass" },
            { "stepId": 2, "status": "fail", "actualResult": "Button disabled" }
          ],
          "notes": "Button CSS class changed after last deploy"
        }
      ]
    }
  ]
}
```

### Task extension (in existing `tasks.json`)

Add optional `linkedTestIds: []` field to tasks. The `update_task_fields` tool already supports arbitrary field updates, so no MCP change needed — agents just write the field.

---

## MCP Server: `cc-tests`

### Tools (17 tools)

**CRUD:**
| Tool | Required Params | Description |
|------|----------------|-------------|
| `list_tests` | `status?`, `environment?`, `tag?` | List tests with filtering |
| `get_test` | `test_id` | Full test with steps, runs, linked tasks |
| `create_test` | `title`, `environment` | Create test (status: untested) |
| `update_test` | `test_id`, `title?`, `description?`, `environment?`, `tags?` | Update test fields |
| `delete_test` | `test_id` | Delete test |

**Steps:**
| Tool | Required Params | Description |
|------|----------------|-------------|
| `add_test_step` | `test_id`, `description`, `expectedResult` | Add step (status: untested) |
| `update_test_step` | `test_id`, `step_id`, `description?`, `expectedResult?` | Edit step definition |
| `delete_test_step` | `test_id`, `step_id` | Remove step |

**Test Execution:**
| Tool | Required Params | Description |
|------|----------------|-------------|
| `run_test` | `test_id`, `agent?` | Start a test run, returns run_id |
| `update_step_result` | `test_id`, `run_id`, `step_id`, `status`, `actualResult?` | Record pass/fail for a step |
| `complete_test_run` | `test_id`, `run_id`, `notes?` | Finalize run, compute overall status |

**Linking:**
| Tool | Required Params | Description |
|------|----------------|-------------|
| `link_test_to_task` | `test_id`, `task_id` | Link a bug ticket to this test |
| `unlink_test_from_task` | `test_id`, `task_id` | Remove link |
| `create_bug_from_test` | `test_id`, `title`, `description?` | Create a task and auto-link it |

**Queries:**
| Tool | Required Params | Description |
|------|----------------|-------------|
| `get_test_history` | `test_id` | Get all runs for a test |
| `get_test_summary` | | Overall stats: total, passing, failing, untested |

### Status values
- **Test overall:** `untested`, `passing`, `failing`, `partial` (some steps pass, some fail)
- **Step:** `untested`, `pass`, `fail`, `skip`

### Files to create
1. `extension/tests-mcp-server.js` — stdio MCP server (same pattern as tasks-mcp-server.js)
2. `extension/tests-mcp-http.js` — HTTP wrapper (same pattern as tasks-mcp-http.js)

---

## Tab UI: Tests

### HTML (in `extension/extension.js` `getWebviewHtml()`)

Add tab button:
```html
<button class="tab-btn" data-tab="tests">Tests</button>
```

Add tab panel:
```html
<div id="tab-tests" class="tab-hidden">
  <div id="test-board" class="test-board"></div>
  <div id="test-detail" class="test-detail"></div>
</div>
```

### Webview JS (in `extension/webview/main.js`)

**Test columns:**
```js
const TEST_COLUMNS = [
  { key: 'untested', label: 'Untested' },
  { key: 'passing', label: 'Passing' },
  { key: 'failing', label: 'Failing' },
  { key: 'partial', label: 'Partial' },
];
```

**Board rendering (`renderTestBoard()`):**
- Toolbar: "+ New Test" button, filter dropdowns (environment, tag)
- Columns: untested / passing / failing / partial
- Each test card shows:
  - Title
  - Environment badge (🌐 Browser / 🖥️ Desktop)
  - Step count: "3/5 passing"
  - Last tested: relative time
  - Tags
  - "Re-test" button (inline)

**Test detail view (`showTestDetail(test)`):**
- Title, description, environment, tags (editable)
- Steps list:
  - Each step: description, expected result, status indicator (✅/❌/⬜)
  - Actual result (if failed)
  - Add step button
  - Edit/delete per step
- Run history:
  - Collapsible list of past runs
  - Each shows: date, agent, overall status, step-by-step results
- Linked tasks:
  - List of linked task IDs (clickable → switch to Tasks tab)
  - "Create Bug Ticket" button → creates task via `taskCreate` + links
- Action buttons:
  - "Re-test" → sends message to appropriate agent
  - "Delete Test"
  - "Edit"

**Re-test button flow:**
1. Get test's `environment` field
2. Determine agent: `browser` → QA-Browser, `computer` → QA
3. Build prompt: "Re-test the following test case: [test title]. Steps: [list steps]. Report results using the cc-tests MCP tools."
4. Set chat target to the appropriate agent
5. Send as user message
6. Agent runs the test, calls `run_test` → `update_step_result` for each step → `complete_test_run`
7. UI refreshes with updated results

### Message types (webview ↔ extension host)

| Type | Direction | Purpose |
|------|-----------|---------|
| `testsLoad` | webview → ext | Request test data |
| `testsData` | ext → webview | Send full test list |
| `testCreate` | webview → ext | Create new test |
| `testUpdate` | webview → ext | Update test fields |
| `testDelete` | webview → ext | Delete test |
| `testAddStep` | webview → ext | Add step to test |
| `testUpdateStep` | webview → ext | Edit step |
| `testDeleteStep` | webview → ext | Remove step |
| `testRetest` | webview → ext | Trigger re-test (routes to session-manager) |

---

## Extension Host Integration

### `extension/extension.js`

Add `handleTestMessage()` function (same pattern as `handleTaskMessage()`):
- `testsLoad` → load and return
- `testCreate` → create test with auto-ID
- `testUpdate` → update fields
- `testDelete` → remove from array
- `testAddStep` → add step with auto-ID
- `testUpdateStep` → edit step
- `testDeleteStep` → remove step
- All return `{ type: 'testsData', tests: data.tests }`

Start tests MCP HTTP server alongside tasks:
```js
const { startTestsMcpServer, stopTestsMcpServer } = require('./tests-mcp-http');
let _testsMcpPort = null;
// In panel creation: start server, pass port to session
```

### `extension/session-manager.js`

Add `_testsMcpPort` variable. In `_mcpServersForRole()`, inject `cc-tests` the same way as `cc-tasks`:
```js
if (this._testsMcpPort) {
  result['cc-tests'] = { type: 'http', url: `http://${mcpHost}:${this._testsMcpPort}/mcp` };
}
```

### `src/mcp-injector.js`

Add `cc-tests` auto-injection for CLI:
```js
// Auto-inject cc-tests (same pattern as cc-tasks)
const testsMcpPath = findTestsMcpPath(hints);
if (testsMcpPath) {
  result['cc-tests'] = {
    command: 'node', args: [testsMcpPath],
    env: { TESTS_FILE: path.join(repoRoot, '.qpanda', 'tests.json') },
  };
}
```

---

## Agent Prompt Updates

### QA Engineer (Browser) — add to system_prompt:

```
## Test Management

You have access to the cc-tests MCP for managing test cases:
- Use `create_test` to create new test cases (set environment to "browser")
- Use `add_test_step` to add steps with descriptions and expected results
- Use `run_test` to start a test run, then `update_step_result` for each step
- Use `complete_test_run` when done testing
- Use `create_bug_from_test` to create bug tickets for failing tests

When asked to generate tests, create comprehensive test cases covering:
- Happy path scenarios
- Error cases and edge cases
- Boundary conditions
- Security considerations

When asked to re-test, retrieve the test with `get_test`, run each step, and update results.
```

### QA Engineer (Computer) — same but with `environment: "computer"`

### Developer agent — add awareness:

```
## Test Awareness

You have access to the cc-tests MCP. When fixing bugs:
- Check if the bug has a linked test using `get_test`
- After fixing, note which test should be re-tested
- Use `link_test_to_task` to link your fix task to the relevant test
```

---

## CSS Styling

### Test board (reuse kanban patterns)
- Same column layout as tasks kanban
- Test cards slightly different: show step progress bar, environment badge
- Color coding: green (passing), red (failing), gray (untested), orange (partial)

### Test detail
- Step list with status indicators
- Collapsible run history
- Linked tasks as clickable badges

---

## CLI Integration

### Shell commands
```
/tests                    List all tests
/test <id>                Show test detail
/test create <title>      Create new test
/test retest <id>         Re-test via appropriate agent
```

### CLI flags
Already supported via MCP injection — agents running from CLI can call cc-tests MCP tools.

---

## Files to Create

1. `extension/tests-mcp-server.js` — stdio MCP server (~350 lines)
2. `extension/tests-mcp-http.js` — HTTP wrapper (~30 lines)

## Files to Modify

1. `extension/extension.js` — add handleTestMessage, start tests MCP server, wire message routing
2. `extension/session-manager.js` — add _testsMcpPort, inject cc-tests MCP
3. `extension/webview/main.js` — Tests tab, test board, test detail, re-test flow
4. `extension/webview/style.css` — Test board styling
5. `extension/resources/system-agents.json` — update QA agent prompts
6. `src/mcp-injector.js` — add cc-tests auto-injection for CLI
7. `src/shell.js` — add /tests, /test commands
8. `package.json` — no changes needed (no new deps)

## Testing

### Unit tests
- `tests/unit/tests-data.test.js` — test data model, status computation
- `tests/crud/tests-crud.test.js` — file CRUD operations

### Live tests
- `tests/live/mcp-tests.test.js` — stdio MCP: create, add steps, run, update results, complete
- `tests/live/mcp-tests-http.test.js` — HTTP variant
- `tests/live/mcp-tests-linking.test.js` — create_bug_from_test, link/unlink
- `tests/live/mcp-tests-via-claude.test.js` — real Claude can call cc-tests tools

### UI tests
- `tests/ui/tests-tab.test.js` — board renders, cards show, detail view works

## Verification

```bash
# MCP works
npm run test:live:mcp

# UI renders
npm run test:ui

# Agent can use it
qapanda run --agent QA-Browser --mode quick-test --test-env browser \
  "Generate 3 test cases for a login page. Use the cc-tests MCP to create them with steps."

# Full suite
npm run test:all
```
