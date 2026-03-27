# Onboarding Wizard + Self-Healing + Dependency Detection

## Context

The extension currently jumps straight into mode selection without checking if the required tools (Claude Code CLI, Codex CLI, Chrome, Docker) are available. If something is missing, the user hits a confusing error much later. We need a one-time onboarding wizard that:

1. Detects available CLIs and tools
2. Asks the user their preferences (Claude only, Codex only, or both)
3. Validates everything works
4. Only runs once per machine (persisted flag)
5. Available as a re-run button on the init screen

Plus self-healing: auto-start Chrome/Docker when needed, prompt user if that fails.

---

## Onboarding Flow (New Step 0, before mode selection)

```
Extension opens → Check ~/.qpanda/onboarding.json
  → If exists and complete: skip to mode selection (existing wizard)
  → If missing/incomplete: show onboarding wizard

Onboarding Wizard Steps:
  Step 0a: Welcome + CLI Detection
    - Auto-detect: claude --version, codex --version
    - Show status: ✅ Claude Code v4.x found / ❌ Not found
    - Show status: ✅ Codex CLI v1.x found / ❌ Not found
    - If neither found: show install instructions, block proceeding
    - If only one found: note it, continue

  Step 0b: CLI Preference
    - "Which CLI backends do you want to use?"
    - Options: "Both (recommended)", "Claude Code only", "Codex only"
    - Pre-select based on what's available
    - This sets default controller CLI (codex if available, else claude)
    - This sets default worker CLI (claude if available, else codex)

  Step 0c: Docker Desktop Detection (optional)
    - Auto-detect: docker --version, docker ps
    - Show status: ✅ Docker running / ⚠️ Installed but not running / ❌ Not found
    - If not found: "Desktop testing (Linux containers) won't be available. Skip or install Docker Desktop."
    - Also detect: qa-desktop CLI
    - This determines if "computer" test environment is available

  Step 0d: Chrome Detection
    - Auto-detect Chrome binary (reuse _findChromeBinary from chrome-manager.js)
    - Show status: ✅ Chrome found at path / ❌ Not found
    - If not found: "Browser testing won't be available. Install Chrome to enable it."
    - This determines if "browser" test environment is available

  Step 0e: Summary + Save
    - Show what's available:
      "✅ Claude Code — will be used as worker"
      "✅ Codex — will be used as controller"
      "✅ Chrome — browser testing available"
      "⚠️ Docker — not running, desktop testing unavailable"
    - "Complete Setup" button
    - Writes ~/.qpanda/onboarding.json
    - Proceeds to existing mode selection wizard (step 1)
```

---

## Persistence: `~/.qpanda/onboarding.json`

```json
{
  "version": 1,
  "completedAt": "2026-03-24T...",
  "cliPreference": "both",
  "detectedClis": {
    "claude": { "available": true, "version": "4.6.0", "path": "claude" },
    "codex": { "available": true, "version": "1.2.0", "path": "codex" }
  },
  "detectedTools": {
    "chrome": { "available": true, "path": "C:\\Program Files\\Google\\Chrome\\..." },
    "docker": { "available": true, "running": true },
    "qaDesktop": { "available": true }
  },
  "defaults": {
    "controllerCli": "codex",
    "workerCli": "claude"
  }
}
```

---

## Self-Healing Behavior

### Chrome Auto-Start
**Where:** `session-manager.js` `_ensureChromeIfNeeded(agentId)` (already exists)

Currently starts Chrome silently. Enhance:
- If Chrome binary not found → post message to webview: `{ type: 'dependencyMissing', tool: 'chrome', message: 'Chrome not found. Install it to use browser testing.' }`
- Webview shows a banner/toast with the message
- Agent falls back gracefully (runs without chrome-devtools MCP)

### Docker Auto-Start
**Where:** `session-manager.js` when running remote agents, and `src/remote-desktop.js` `ensureDesktop()`

Currently returns null on failure. Enhance:
- If `qa-desktop` not found → post `dependencyMissing` message
- If Docker not running → post `dependencyMissing` with "Docker Desktop is not running. Start it and try again."
- If container fails to start → post error with details
- Webview shows actionable banner: "Docker not running. [Start Docker] [Skip]"

### CLI Availability at Runtime
**Where:** `session-manager.js` before spawning controller/worker

Before each run:
- Quick check if the configured CLI is still available
- If not → post `dependencyMissing` with suggestion to switch
- Don't block — just warn. The spawn will fail with a clear error anyway.

---

## Agent Auto-Configuration Based on Available CLIs

### How the preference is applied (writes to real config files)

When onboarding completes, it **writes actual config changes** to the same files the Agents tab uses. No runtime remapping — what you see in the Agents tab is what you get.

**What gets written:**

1. **`~/.qpanda/system-agents.json`** — System agent CLI overrides (same file the "Edit" button on Agents tab writes to). For each system agent whose CLI doesn't match the preference:

   ```
   If "claude-only": write overrides for agents that use codex/qa-remote-codex
     { "QA-Browser": { "cli": "claude" },      // was codex
       "QA": { "cli": "qa-remote-claude" },     // already claude, no change needed
       "dev": { "cli": "claude" } }             // already claude, no change needed

   If "codex-only": write overrides for agents that use claude/qa-remote-claude
     { "dev": { "cli": "codex" },
       "QA": { "cli": "qa-remote-codex" },
       "setup-browser": { "cli": "codex" },
       "setup-computer": { "cli": "qa-remote-codex" } }

   If "both": no overrides needed (system-agents.json defaults are already optimal)
   ```

2. **`~/.qpanda/onboarding.json`** — Stores preference + detected tools + controller/worker defaults:
   ```json
   {
     "version": 1,
     "completedAt": "2026-03-24T...",
     "cliPreference": "both",
     "defaults": {
       "controllerCli": "codex",
       "workerCli": "claude"
     },
     "detected": { ... }
   }
   ```

3. **Controller/Worker CLI defaults** — The `onboarding.json` `defaults` are read by `extension.js` and used as `initialConfig` for new panels (only if the panel has no saved config yet). Per-panel config bar overrides still take precedence.

**Why this works without conflicts:**
- Onboarding writes to `~/.qpanda/system-agents.json` — the same file the Agents tab "Edit" button writes to
- If the user later edits an agent in the Agents tab and picks a different CLI, it overwrites what onboarding set — no conflict
- Re-running onboarding rewrites the overrides again (user is explicitly choosing)
- `system-agents.json` bundled in `extension/resources/` is never modified — it stays as the "ideal both-CLIs" reference

### When environment tools are missing

- **No Chrome:** Disable modes that need browser testing (`requiresTestEnv` + browser env) — show them grayed out with "Chrome required"
- **No Docker:** Disable modes that need desktop testing — show grayed out with "Docker required"
- **No qa-desktop:** Same as no Docker for remote agents

---

## Implementation

### Files to Create

1. **`extension/onboarding.js`** — Onboarding logic module
   - `loadOnboarding()` — read `~/.qpanda/onboarding.json`
   - `saveOnboarding(data)` — write onboarding file
   - `isOnboardingComplete()` — check if wizard was completed
   - `detectCli(name)` — run `<name> --version`, return `{ available, version, path }`
   - `detectChrome()` — reuse `_findChromeBinary()` from chrome-manager
   - `detectDocker()` — run `docker --version` + `docker ps`
   - `detectQaDesktop()` — run `qa-desktop --version`
   - `runFullDetection()` — detect everything, return summary

### Files to Modify

2. **`extension/extension.js`**
   - On panel creation: load onboarding state
   - Include onboarding data in `initConfig` message: `onboarding: { complete, detected, defaults }`
   - Handle `onboardingSave` message from webview
   - Handle `onboardingDetect` message (re-run detection)

3. **`extension/webview/main.js`**
   - New onboarding wizard steps (step 0a-0e) before existing mode selection
   - `initConfig` handler: if `!msg.onboarding.complete` → show onboarding wizard instead of mode wizard
   - "Re-run Setup" button on the mode selection screen (existing step 1)
   - `dependencyMissing` message handler → show warning banner
   - Disable unavailable modes based on detected tools

4. **`extension/webview/style.css`**
   - Onboarding step styles (reuse existing `.wizard-step` / `.wizard-card` patterns)
   - Dependency status badges (✅ green, ⚠️ yellow, ❌ red)
   - Disabled mode card style (grayed out with overlay text)

5. **`extension/session-manager.js`**
   - `_ensureChromeIfNeeded()`: add `dependencyMissing` message on failure
   - Remote agent runs: add `dependencyMissing` message when Docker/qa-desktop missing
   - Apply onboarding defaults to `initialConfig` for new panels

6. **`extension/chrome-manager.js`**
   - Export `_findChromeBinary()` so onboarding.js can reuse it

### HTML Changes in `extension/extension.js` `getWebviewHtml()`

Add onboarding wizard steps inside `#init-wizard`, before existing step 1:

```html
<div id="wizard-step-onboard-welcome" class="wizard-step wizard-hidden">
  <h2>Welcome to QA Panda</h2>
  <p>Let's check your setup...</p>
  <div id="onboard-detection-status">Detecting...</div>
  <button id="onboard-next">Continue</button>
</div>

<div id="wizard-step-onboard-cli" class="wizard-step wizard-hidden">
  <h2>CLI Preference</h2>
  <div class="wizard-cards" id="onboard-cli-cards">
    <!-- Both / Claude only / Codex only -->
  </div>
</div>

<div id="wizard-step-onboard-tools" class="wizard-step wizard-hidden">
  <h2>Environment Tools</h2>
  <div id="onboard-tools-status">
    <!-- Chrome, Docker, qa-desktop status -->
  </div>
  <button id="onboard-complete">Complete Setup</button>
</div>
```

---

## Verification

### Unit Tests
- `tests/unit/onboarding.test.js`: loadOnboarding, saveOnboarding, isOnboardingComplete with temp files
- `tests/unit/detection.test.js`: detectCli, detectChrome, detectDocker return correct formats

### Live Tests
- `tests/live/onboarding.test.js`:
  - Detect real claude CLI → available=true with version
  - Detect real codex CLI → available=true with version
  - Detect real Chrome → available=true with path
  - Detect real Docker → available=true/false based on running state
  - Save + load onboarding.json roundtrip
  - isOnboardingComplete returns true after save

### Extension Tests (future @vscode/test-electron)
- Extension opens → onboarding wizard shows on first run
- Complete onboarding → mode wizard shows
- Reload → onboarding skipped, mode wizard or chat shown
- "Re-run Setup" button → onboarding wizard reopens
