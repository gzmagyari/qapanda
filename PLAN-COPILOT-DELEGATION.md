# Copilot Auto Mode + Agent-to-Agent Delegation

## Context

Two connected features that transform how agents work:

1. **Copilot Auto Mode** — A toggle that lets the controller watch the user-agent conversation and automatically send follow-up instructions. The user talks directly to the agent; the controller steps in as a "copilot" to feed tasks when auto is on.

2. **Agent-to-Agent Delegation** — Any agent can call other agents via an MCP tool. The dev agent can ask QA to test, QA can ask dev to fix, etc.

These together eliminate the need for separate "quick" and "auto" modes. Any mode can become auto by toggling the switch. Any agent can orchestrate other agents.

## Part 1: Copilot Auto Mode

### How It Works

```
Auto OFF:  User -> Agent (direct, existing behavior)
Auto ON:   User -> Agent -> Controller reads transcript -> Controller sends next message -> Agent -> repeat
           User can interrupt at any time -> message goes directly to Agent
           Controller sees the interruption and adjusts
```

### New Orchestration Flow: `runCopilotLoop()`

**In `src/orchestrator.js`**, add a new function:

```js
async function runCopilotLoop(manifest, renderer, options = {}) {
  // 1. Run the user's message as a direct worker turn (user -> agent)
  // 2. After agent responds, check if auto mode is on
  // 3. If on: run controller turn - controller sees full transcript
  // 4. Controller decides: send another message to agent (action: delegate) or stop
  // 5. If delegate: run agent with controller's message (prefixed "Controller: ...")
  // 6. Loop back to step 3
  // 7. If stop or user interrupts: exit loop, wait for next user message
}
```

**Key difference from `runManagerLoop()`:**
- The FIRST message always goes directly from user to the active agent (not through controller)
- The controller only enters AFTER the first agent response
- The controller's message to the agent is prefixed with "Controller:" so the agent knows who's talking
- User interruptions bypass the controller and go directly to the agent, prefixed with "User:"

### Controller Prompt for Copilot Mode

New prompt variant in `src/prompts.js`:

```
You are a copilot overseeing a conversation between a user and an AI agent.

You can see the full conversation history. Your job is to:
1. After the agent completes a task, decide what should happen next
2. If more work is needed, send a focused instruction to the agent
3. If the user has interrupted with new directions, adjust your plan accordingly
4. If everything is done, stop

The agent sees messages from both you and the user. Your messages are prefixed
with "Controller:" and user messages with "User:".

Output JSON: { action: "delegate"|"stop", claude_message: "...", controller_messages: [...] }
```

### Message Prefixing

When the agent receives messages in copilot mode:
- User messages: `"User: <message>"`
- Controller messages: `"Controller: <message>"`
- Agent system prompt updated: "You may receive messages from multiple participants. Messages are prefixed with the sender name."

### Session Manager Changes

**In `extension/session-manager.js` `_handleInput()`:**

```js
if (this._chatTarget.startsWith('agent-') && this._autoMode) {
  // Copilot mode: send user message to agent, then run copilot loop
  const agentId = this._chatTarget.slice('agent-'.length);
  await this._runCopilotLoop('User: ' + text, agentId);
} else if (this._chatTarget.startsWith('agent-')) {
  // Direct mode: user -> agent only
  await this._runDirectAgent(text, agentId);
} else if (this._chatTarget === 'controller') {
  // Traditional controller mode
  await this._runLoop({ userMessage: text });
}
```

**New `_runCopilotLoop()` method:**
1. Run direct agent turn with user message
2. After agent responds, check `_autoMode`
3. If on: run controller turn (reads transcript, decides next action)
4. If controller says `delegate`: run another agent turn with controller's message
5. Loop until controller says `stop` or user interrupts (abort signal)
6. Schedule next pass if wait delay set

### UI Changes

**Auto toggle in webview (`extension/webview/main.js`):**

Add a toggle switch next to or below the input box:

```html
<label class="auto-toggle">
  <input type="checkbox" id="auto-mode-toggle" />
  <span>Auto</span>
</label>
```

When toggled:
- Posts `{ type: 'configChanged', config: { autoMode: true/false } }`
- Session manager sets `this._autoMode = config.autoMode`
- Visual indicator when auto is active (e.g., pulsing icon, colored border)

**Chat display:**
- User messages: cyan (existing)
- Agent messages: green (existing)
- Controller messages in copilot mode: yellow (same as existing controller color)
- Clear label showing "Controller" when controller sends a message in copilot mode

### Mode Simplification

Reduce system modes from 5 to 4 presets (each just sets Target + Auto default):

| Old Mode(s) | New Mode | Target | Auto | Description |
|-------------|----------|--------|------|-------------|
| quick-test | **Test** | QA agent | off | Manual testing — user drives QA |
| quick-dev | **Dev** | dev | off | Manual dev — user drives developer |
| auto-dev-test | **Dev & Test** | dev | on | Dev implements + delegates to QA for testing |
| *(new)* | **Test & Fix** | QA agent | on | QA tests + delegates to dev for bug fixes |

All four are just presets. The user can toggle auto on/off and change target anytime. The auto toggle is independent of the mode — any mode supports it.

---

## Part 2: Agent-to-Agent Delegation MCP

### MCP Tool: `delegate_to_agent`

New HTTP MCP server (`extension/agent-delegate-mcp-http.js`) with one tool:

```json
{
  "name": "delegate_to_agent",
  "description": "Delegate a task to another agent and get the result.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "agent_id": { "type": "string", "description": "Agent to delegate to" },
      "message": { "type": "string", "description": "Task instruction" },
      "max_turns": { "type": "number", "description": "Max turns (default: 10)" }
    },
    "required": ["agent_id", "message"]
  }
}
```

### How It Works

1. Agent A calls `delegate_to_agent` tool
2. HTTP MCP server receives request
3. Server calls `sessionManager.delegateToAgent(agentId, message, maxTurns)`
4. This runs `runDirectWorkerTurn()` with Agent B
5. Agent B completes, result text returned
6. Agent A receives result as tool response and continues

### Depth Limiting

Prevent infinite chains (A -> B -> A -> B...):
- Track delegation depth via env var `CC_DELEGATION_DEPTH`
- Each delegation increments depth
- MCP tool rejects if depth > 3

### Agent Prompt Updates

Add to ALL agent system prompts:

```
## Agent Delegation

You can delegate tasks to other agents using the delegate_to_agent tool:
- delegate_to_agent("QA-Browser", "Test the login page")
- delegate_to_agent("dev", "Fix the CSS bug")
- delegate_to_agent("QA", "Test the desktop app")

The delegated agent runs independently and returns its result to you.
```

---

## Files to Create

1. `extension/agent-delegate-mcp-http.js` — Agent delegation MCP HTTP server

## Files to Modify

1. `src/orchestrator.js` — Add `runCopilotLoop()`
2. `src/prompts.js` — Add copilot controller prompt variant
3. `extension/session-manager.js` — Add `_autoMode`, `_runCopilotLoop()`, `delegateToAgent()`
4. `extension/webview/main.js` — Auto toggle UI, copilot chat display
5. `extension/webview/style.css` — Auto toggle styling
6. `extension/extension.js` — Start agent-delegate MCP server
7. `resources/system-agents.json` — Update all agent prompts with delegation + copilot instructions
8. `resources/system-modes.json` — Simplify to 3 modes
9. `src/mcp-injector.js` — Auto-inject cc-agent-delegate
10. `src/shell.js` — Add `/auto` toggle command

## Testing

### Unit Tests
- `tests/unit/copilot-mode.test.js` — copilot loop logic, message prefixing
- `tests/unit/agent-delegate.test.js` — delegation depth limits, agent resolution

### Live Tests
- `tests/live/copilot-mode.test.js` — toggle auto, controller sends follow-up, user interrupt
- `tests/live/agent-delegate.test.js` — dev delegates to QA, QA delegates to dev
- `tests/live/agent-delegate-mcp.test.js` — MCP tool callable by real Claude

### UI Tests
- `tests/ui/auto-toggle.test.js` — toggle state, config message posted

## Verification

```bash
# Copilot mode
1. Select Dev agent, send "implement a login page"
2. Toggle Auto ON
3. Controller sends "now add tests" -> dev agent responds
4. User sends "use different CSS framework" -> goes directly to dev
5. Controller adjusts and continues

# Agent delegation
1. Select Dev agent, send "implement login and get it tested"
2. Dev calls delegate_to_agent("QA-Browser", "test the login page")
3. QA-Browser runs, returns results to dev
4. Dev sees results and continues

npm run test:all
```
