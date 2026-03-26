# Continue / Loop UI + Agent-to-Agent Delegation

## Context

Replace the confusing Auto checkbox with explicit controls: Send, Continue, and Loop. Each button does exactly one thing. Also add `delegate_to_agent` MCP tool so any agent can call other agents.

## UI Design

```
[Text input                          ] [Send] [Continue ▶] [⟳]
TARGET: QA Engineer (Browser) ▼
```

When running, Send and Continue hide, Stop appears:
```
[Text input (disabled)               ] [Stop ■]            [⟳]
TARGET: QA Engineer (Browser) ▼
```

### Button Behavior

| Button | What it does |
|--------|-------------|
| **Send** | Sends text to whatever **Target** is selected (agent or controller) |
| **Continue ▶** | Sends text (optional guidance) to the **controller**, which then instructs the Target agent. If empty, controller decides on its own based on transcript. |
| **Loop ⟳** | Toggle. When on, auto-clicks Continue (empty) after each agent response. Click Stop to pause. |
| **Stop ■** | Stops whatever is running. Loop pauses but stays toggled — next Send or Continue resumes it. |

### User Flows

**Manual chat with agent:**
Target = Agent, type + Send. Normal direct mode.

**Give controller a task:**
Target = Controller, type + Send. Traditional controller mode.

**Have controller auto-continue after agent responds:**
Target = Agent, type + Send (first message to agent), toggle Loop on. Controller runs after each agent response.

**Give controller guidance then auto-continue:**
Type "Focus on error handling" + Continue. Controller uses guidance + transcript, instructs agent. Toggle Loop to keep going.

**Interrupt and redirect:**
Click Stop. Type feedback + Send (goes to agent). Or type new direction + Continue (goes to controller). Toggle Loop to resume auto.

**Multi-agent orchestration via controller:**
Type "Have QA test login, dev fix issues, QA re-test" + Continue. Controller orchestrates via `agent_id` in its decisions.

**Multi-agent via agent delegation:**
Target = QA, Send "Test login and delegate fixes to dev agent". QA calls `delegate_to_agent("dev", "fix the CSS")` MCP tool. Dev runs, returns result, QA continues.

## Part 1: UI Changes

### Remove Auto checkbox, add Continue and Loop buttons

**File: `extension/extension.js` HTML template**

Replace the auto toggle with Continue and Loop buttons:
```html
<button id="btn-send">Send</button>
<button id="btn-continue" title="Send to controller with optional guidance">Continue ▶</button>
<button id="btn-stop">Stop</button>
<label class="loop-toggle" title="Auto-continue: controller runs after each agent response">
  <input type="checkbox" id="loop-toggle" />
  <span>⟳</span>
</label>
```

**File: `extension/webview/main.js`**

Wire up buttons:
- `btn-continue` click → `vscode.postMessage({ type: 'continueInput', text: textarea.value })`
- `loop-toggle` change → `vscode.postMessage({ type: 'configChanged', config: { loopMode: checked } })`
- When `running=true`: hide Send + Continue, show Stop
- When `running=false`: show Send + Continue, hide Stop

**File: `extension/webview/style.css`**

Style Continue button (blue accent), Loop toggle (orange when active).

### Handle `continueInput` message

**File: `extension/session-manager.js`**

Add `continueInput` to `handleMessage()`:
```js
if (msg.type === 'continueInput') {
  // Run controller turn, then controller instructs the Target agent
  const guidance = msg.text || '';
  await this._runControllerContinue(guidance);
}
```

New method `_runControllerContinue(guidance)`:
1. Build user message for controller: guidance text (or empty = "continue based on transcript")
2. Run `runManagerLoop(manifest, renderer, { userMessage: guidance || '[AUTO-CONTINUE]', singlePass: true })`
3. Controller reads transcript + guidance, decides what to tell the agent
4. Agent runs one turn
5. If `_loopMode` is on → schedule next `_runControllerContinue('')` after agent responds

### Loop Mode in Session Manager

**File: `extension/session-manager.js`**

Replace `_autoMode` with `_loopMode`:
```js
this._loopMode = false;

// In applyConfig:
if (config.loopMode !== undefined) this._loopMode = !!config.loopMode;

// After any agent response in _runControllerContinue or _runLoop:
if (this._loopMode && manifest.status === 'running') {
  // Auto-continue: run controller again
  setTimeout(() => this._runControllerContinue(''), 500);
}
```

### Remove Old Auto Mode Code

- Remove `_autoMode` from session-manager
- Remove `_runCopilotLoop()` from session-manager
- Remove the auto checkbox wiring from main.js
- Remove `runCopilotLoop()` from orchestrator.js (or keep and refactor)
- Remove `/auto` from shell.js, add `/continue` and `/loop`

## Part 2: Agent-to-Agent Delegation MCP

### `delegate_to_agent` MCP Tool

**File: `extension/agent-delegate-mcp-http.js`** (new)

HTTP MCP server with one tool:
```json
{
  "name": "delegate_to_agent",
  "description": "Delegate a task to another agent. The agent runs to completion and returns its response.",
  "inputSchema": {
    "properties": {
      "agent_id": { "type": "string", "description": "Agent ID (e.g., 'dev', 'QA-Browser', 'QA')" },
      "message": { "type": "string", "description": "Task instruction for the agent" }
    },
    "required": ["agent_id", "message"]
  }
}
```

The HTTP server needs access to the session manager to run agents. Pattern:
```js
async function startAgentDelegateMcpServer(delegateFn) {
  return createMcpHttpServer({
    tools: [DELEGATE_TOOL],
    handleToolCall: async (name, args) => {
      const result = await delegateFn(args.agent_id, args.message);
      return JSON.stringify(result);
    },
    serverName: 'cc-agent-delegate',
  });
}
```

The `delegateFn` is provided by session-manager:
```js
async delegateToAgent(agentId, message) {
  const { runDirectWorkerTurn } = require('./src/orchestrator');
  const manifest = await runDirectWorkerTurn(this._activeManifest, this._renderer, {
    userMessage: message, agentId
  });
  this._activeManifest = manifest;
  const lastReq = manifest.requests[manifest.requests.length - 1];
  return {
    agent_id: agentId,
    result: lastReq?.latestWorkerResult?.resultText || 'No response',
  };
}
```

### Depth Limiting

Track via env var `CC_DELEGATION_DEPTH`:
- Increment on each delegation
- Reject if > 3
- Reset when returning to parent

### Auto-inject MCP

**File: `extension/session-manager.js` `_mcpServersForRole()`**

Add `cc-agent-delegate` injection alongside cc-tasks and cc-tests:
```js
if (this._agentDelegateMcpPort) {
  result['cc-agent-delegate'] = { type: 'http', url: `http://${mcpHost}:${this._agentDelegateMcpPort}/mcp` };
}
```

**File: `src/mcp-injector.js`**

Add for CLI injection too.

### Agent Prompt Updates

Add to all agent system prompts in `resources/system-agents.json`:
```
## Agent Delegation
You can delegate tasks to other agents:
- delegate_to_agent("dev", "Fix the CSS bug") — dev agent fixes and returns result
- delegate_to_agent("QA-Browser", "Test the login page") — QA tests and returns result
- delegate_to_agent("QA", "Test the desktop app") — QA tests on remote desktop
The delegated agent runs independently and returns its response to you.
```

## How Modes Work With Continue/Loop

Modes are just **presets** that set two things: Target dropdown value and Loop toggle default.

| Mode | Target | Loop Default | Controller Prompt |
|------|--------|-------------|-------------------|
| **Test** | QA-Browser or QA | off | (none — manual testing) |
| **Dev** | dev | off | (none — manual dev) |
| **Dev & Test** | dev | **on** | "Copilot for dev+QA: after dev tasks suggest testing, after test results suggest fixes. Available agents: dev, QA-Browser/QA." |
| **Test & Fix** | QA-Browser or QA | **on** | "Copilot for QA+dev: after test failures suggest delegating fix to dev, after fixes suggest re-testing. Available agents: QA-Browser/QA, dev." |

### Flow Example: "Dev & Test" mode

1. Mode wizard sets Target=dev, Loop=on, `controllerPrompt` set on manifest
2. User types "Implement a login page" + **Send** → goes to dev agent
3. Dev responds with implementation
4. **Loop is on** → controller auto-fires with custom prompt → reads transcript → says "Now delegate testing to QA" (uses `agent_id: "QA-Browser"` in decision)
5. QA tests → controller fires again → "2 issues found, tell dev to fix" → delegates back to dev
6. Dev fixes → controller → "Re-test" → QA → "All passing" → controller says stop
7. Loop pauses, user sees results

### Flow Example: "Test" mode (manual, no loop)

1. Mode sets Target=QA-Browser, Loop=off
2. User chats directly with QA agent
3. User can click Continue anytime to have controller send a follow-up
4. User can toggle Loop on if they want auto-continue

### Mode applies `controllerPrompt`

The existing `mode.controllerPrompt` field (env-aware: `{ browser: "...", computer: "..." }`) is already stored on `manifest.controllerSystemPrompt` when a mode is selected. The controller uses this prompt when Continue/Loop fires. No new code needed for this — it's already wired.

### Mode applies `autoDefault` → Loop toggle

In `applyMode()` in webview main.js, when a mode has `autoDefault: true`:
```js
if (mode.autoDefault) {
  config.loopMode = true;
  loopToggle.checked = true;
} else {
  config.loopMode = false;
  loopToggle.checked = false;
}
```

## Part 3: Shell Commands

**File: `src/shell.js`**

Replace `/auto` with:
- `/continue [guidance]` — runs one controller→agent cycle with optional guidance
- `/loop` — toggles loop mode on/off

## Files to Create

1. `extension/agent-delegate-mcp-http.js` — Agent delegation MCP

## Files to Modify

1. `extension/extension.js` — HTML: replace auto checkbox with Continue + Loop buttons, start delegate MCP
2. `extension/webview/main.js` — Wire Continue/Loop buttons, remove auto checkbox, handle `continueInput`
3. `extension/webview/style.css` — Button styling
4. `extension/session-manager.js` — Replace `_autoMode` with `_loopMode`, add `_runControllerContinue()`, `delegateToAgent()`, inject delegate MCP
5. `src/orchestrator.js` — Remove `runCopilotLoop()` (replaced by existing `runManagerLoop` with `singlePass`)
6. `src/shell.js` — Replace `/auto` with `/continue` and `/loop`
7. `src/mcp-injector.js` — Add cc-agent-delegate injection
8. `resources/system-agents.json` — Add delegation instructions to all agent prompts

## Testing

### Unit Tests
- `tests/unit/continue-loop.test.js` — Continue sends to controller, Loop toggle state

### UI Tests
- `tests/ui/continue-loop.test.js` — Buttons exist, Continue fires continueInput, Loop fires configChanged

### Live Tests
- `tests/live/cli-continue.test.js` — `/continue` shell command works
- `tests/live/agent-delegate-mcp.test.js` — delegate_to_agent MCP tool callable by real agent

## Verification

```bash
# UI: Continue button
1. Target = QA-Browser, Send "Test the login page"
2. Agent responds with results
3. Type "Now test with invalid inputs" + Continue
4. Controller instructs agent to test invalid inputs

# UI: Loop
1. Target = dev, Send "Implement a login page"
2. Toggle Loop on
3. Controller auto-sends "now add tests" → "now add error handling" → ... → stops

# Agent delegation
1. Target = QA-Browser, Send "Test login and get dev to fix any issues"
2. QA calls delegate_to_agent("dev", "fix the button CSS")
3. Dev fixes, returns result
4. QA re-tests

npm run test:all
```
