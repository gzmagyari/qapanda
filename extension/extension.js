const vscode = require('vscode');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { WebviewRenderer } = require('./webview-renderer');
const { SessionManager } = require('./session-manager');
const { globalAgentsPath, projectAgentsPath, systemAgentsOverridePath, loadAgentsFile, saveAgentsFile, loadSystemAgents, loadMergedAgents } = require('./agents-store');
const { loadMergedModes, saveModesFile, globalModesPath, projectModesPath, systemModesOverridePath, loadModesFile } = require('./modes-store');
const { listInstances, stopInstance, restartInstance, ensureDesktop, findExistingDesktop, getLinkedInstance, getSnapshotExists, instanceName } = require('./src/remote-desktop');
const { startTasksMcpServer, stopTasksMcpServer } = require('./tasks-mcp-http');
const { startTestsMcpServer, stopTestsMcpServer } = require('./tests-mcp-http');
const { startQaDesktopMcpServer, stopQaDesktopMcpServer } = require('./qa-desktop-mcp-server');
const { loadOnboarding, isOnboardingComplete, runFullDetection, completeOnboarding } = require('./onboarding');

const activePanels = new Set();
let _tasksMcpPort = null;
let _testsMcpPort = null;
let _qaDesktopMcpPort = null;

// ── MCP config file helpers ─────────────────────────────────────────
function globalMcpPath() {
  return path.join(os.homedir(), '.cc-manager', 'mcp.json');
}

function projectMcpPath(repoRoot) {
  return path.join(repoRoot, '.cc-manager', 'mcp.json');
}

function loadMcpFile(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return {};
  }
}

function saveMcpFile(filePath, data) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
}

// ── Instance config helpers ──────────────────────────────────────────
function loadInstanceConfig(repoRoot) {
  try {
    return JSON.parse(fs.readFileSync(path.join(repoRoot, '.cc-manager', 'config.json'), 'utf8'));
  } catch {
    return {};
  }
}

function saveInstanceConfig(repoRoot, data) {
  const dir = path.join(repoRoot, '.cc-manager');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const existing = loadInstanceConfig(repoRoot);
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ ...existing, ...data }, null, 2), 'utf8');
}

/** Load and merge global + project MCP servers. Project overrides global by name. */
function loadMergedMcpServers(repoRoot) {
  const globalServers = loadMcpFile(globalMcpPath());
  const projectServers = loadMcpFile(projectMcpPath(repoRoot));
  return { global: globalServers, project: projectServers };
}

// ── Tasks file helpers ───────────────────────────────────────────────
function tasksFilePath(repoRoot) {
  return path.join(repoRoot, '.cc-manager', 'tasks.json');
}

function loadTasksFile(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return { nextId: 1, nextCommentId: 1, nextProgressId: 1, tasks: [] };
  }
}

function saveTasksFile(filePath, data) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
}

function nowIso() { return new Date().toISOString(); }

function handleTaskMessage(msg, repoRoot) {
  const fp = tasksFilePath(repoRoot);
  const data = loadTasksFile(fp);

  if (msg.type === 'tasksLoad') {
    return { type: 'tasksData', tasks: data.tasks };
  }

  if (msg.type === 'taskCreate') {
    const id = `task-${data.nextId++}`;
    const task = {
      id, title: msg.title || 'Untitled', description: msg.description || '',
      detail_text: msg.detail_text || '', status: msg.status || 'backlog',
      created_at: nowIso(), updated_at: nowIso(), comments: [], progress_updates: [],
    };
    data.tasks.push(task);
    saveTasksFile(fp, data);
    return { type: 'tasksData', tasks: data.tasks };
  }

  if (msg.type === 'taskUpdate') {
    const task = data.tasks.find(t => t.id === msg.task_id);
    if (task) {
      if (msg.title !== undefined) task.title = msg.title;
      if (msg.description !== undefined) task.description = msg.description;
      if (msg.detail_text !== undefined) task.detail_text = msg.detail_text;
      if (msg.status !== undefined) task.status = msg.status;
      task.updated_at = nowIso();
      saveTasksFile(fp, data);
    }
    return { type: 'tasksData', tasks: data.tasks };
  }

  if (msg.type === 'taskDelete') {
    data.tasks = data.tasks.filter(t => t.id !== msg.task_id);
    saveTasksFile(fp, data);
    return { type: 'tasksData', tasks: data.tasks };
  }

  if (msg.type === 'taskAddComment') {
    const task = data.tasks.find(t => t.id === msg.task_id);
    if (task) {
      if (!task.comments) task.comments = [];
      task.comments.push({ id: data.nextCommentId++, author: msg.author || 'user', text: msg.text, created_at: nowIso() });
      task.updated_at = nowIso();
      saveTasksFile(fp, data);
    }
    return { type: 'tasksData', tasks: data.tasks };
  }

  if (msg.type === 'taskDeleteComment') {
    const task = data.tasks.find(t => t.id === msg.task_id);
    if (task && task.comments) {
      task.comments = task.comments.filter(c => c.id !== msg.comment_id);
      task.updated_at = nowIso();
      saveTasksFile(fp, data);
    }
    return { type: 'tasksData', tasks: data.tasks };
  }

  if (msg.type === 'taskEditComment') {
    const task = data.tasks.find(t => t.id === msg.task_id);
    if (task && task.comments) {
      const comment = task.comments.find(c => c.id === msg.comment_id);
      if (comment) { comment.text = msg.text; task.updated_at = nowIso(); saveTasksFile(fp, data); }
    }
    return { type: 'tasksData', tasks: data.tasks };
  }

  if (msg.type === 'taskDeleteProgress') {
    const task = data.tasks.find(t => t.id === msg.task_id);
    if (task && task.progress_updates) {
      task.progress_updates = task.progress_updates.filter(p => p.id !== msg.progress_id);
      task.updated_at = nowIso();
      saveTasksFile(fp, data);
    }
    return { type: 'tasksData', tasks: data.tasks };
  }

  if (msg.type === 'taskEditProgress') {
    const task = data.tasks.find(t => t.id === msg.task_id);
    if (task && task.progress_updates) {
      const update = task.progress_updates.find(p => p.id === msg.progress_id);
      if (update) { update.text = msg.text; task.updated_at = nowIso(); saveTasksFile(fp, data); }
    }
    return { type: 'tasksData', tasks: data.tasks };
  }

  if (msg.type === 'taskAddProgress') {
    const task = data.tasks.find(t => t.id === msg.task_id);
    if (task) {
      if (!task.progress_updates) task.progress_updates = [];
      task.progress_updates.push({ id: data.nextProgressId++, author: msg.author || 'user', text: msg.text, created_at: nowIso() });
      task.updated_at = nowIso();
      saveTasksFile(fp, data);
    }
    return { type: 'tasksData', tasks: data.tasks };
  }

  return null;
}

// ── Test CRUD ────────────────────────────────────────────────────

function testsFilePath(repoRoot) { return path.join(repoRoot, '.cc-manager', 'tests.json'); }
function loadTestsFile(fp) { try { return JSON.parse(fs.readFileSync(fp, 'utf8')); } catch { return { nextId: 1, nextStepId: 1, nextRunId: 1, tests: [] }; } }
function saveTestsFile(fp, data) { const dir = path.dirname(fp); if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(fp, JSON.stringify(data, null, 2), 'utf8'); }

function handleTestMessage(msg, repoRoot) {
  const fp = testsFilePath(repoRoot);
  if (msg.type === 'testsLoad') {
    const data = loadTestsFile(fp);
    return { type: 'testsData', tests: data.tests };
  }
  if (msg.type === 'testCreate') {
    const data = loadTestsFile(fp);
    const id = 'test-' + data.nextId++;
    const test = {
      id, title: msg.title || 'New Test', description: msg.description || '',
      environment: msg.environment || 'browser', status: 'untested',
      steps: [], linkedTaskIds: [], tags: msg.tags || [],
      lastTestedAt: null, lastTestedBy: null,
      created_at: nowIso(), updated_at: nowIso(), runs: [],
    };
    data.tests.push(test);
    saveTestsFile(fp, data);
    return { type: 'testsData', tests: data.tests };
  }
  if (msg.type === 'testUpdate') {
    const data = loadTestsFile(fp);
    const test = data.tests.find(t => t.id === msg.test_id);
    if (test) {
      if (msg.title !== undefined) test.title = msg.title;
      if (msg.description !== undefined) test.description = msg.description;
      if (msg.environment !== undefined) test.environment = msg.environment;
      if (msg.tags !== undefined) test.tags = msg.tags;
      test.updated_at = nowIso();
      saveTestsFile(fp, data);
    }
    return { type: 'testsData', tests: data.tests };
  }
  if (msg.type === 'testDelete') {
    const data = loadTestsFile(fp);
    data.tests = data.tests.filter(t => t.id !== msg.test_id);
    saveTestsFile(fp, data);
    return { type: 'testsData', tests: data.tests };
  }
  if (msg.type === 'testAddStep') {
    const data = loadTestsFile(fp);
    const test = data.tests.find(t => t.id === msg.test_id);
    if (test) {
      test.steps.push({ id: data.nextStepId++, description: msg.description || '', expectedResult: msg.expectedResult || '', status: 'untested', actualResult: null });
      test.updated_at = nowIso();
      saveTestsFile(fp, data);
    }
    return { type: 'testsData', tests: data.tests };
  }
  if (msg.type === 'testUpdateStep') {
    const data = loadTestsFile(fp);
    const test = data.tests.find(t => t.id === msg.test_id);
    if (test) {
      const step = test.steps.find(s => s.id === msg.step_id);
      if (step) {
        if (msg.description !== undefined) step.description = msg.description;
        if (msg.expectedResult !== undefined) step.expectedResult = msg.expectedResult;
        test.updated_at = nowIso();
        saveTestsFile(fp, data);
      }
    }
    return { type: 'testsData', tests: data.tests };
  }
  if (msg.type === 'testDeleteStep') {
    const data = loadTestsFile(fp);
    const test = data.tests.find(t => t.id === msg.test_id);
    if (test) {
      test.steps = test.steps.filter(s => s.id !== msg.step_id);
      test.updated_at = nowIso();
      saveTestsFile(fp, data);
    }
    return { type: 'testsData', tests: data.tests };
  }
  return null;
}

function handleAgentMessage(msg, repoRoot, extensionPath) {
  if (msg.type === 'agentsLoad') {
    return { type: 'agentsData', agents: loadMergedAgents(repoRoot, extensionPath) };
  }
  if (msg.type === 'agentSave') {
    const scope = msg.scope; // 'global' or 'project'
    const filePath = scope === 'global' ? globalAgentsPath() : projectAgentsPath(repoRoot);
    saveAgentsFile(filePath, msg.agents);
    return { type: 'agentsData', agents: loadMergedAgents(repoRoot, extensionPath) };
  }
  if (msg.type === 'agentSaveSystem') {
    // Save user override for a system agent
    const overridePath = systemAgentsOverridePath();
    const existing = loadAgentsFile(overridePath);
    existing[msg.id] = msg.agent;
    saveAgentsFile(overridePath, existing);
    return { type: 'agentsData', agents: loadMergedAgents(repoRoot, extensionPath) };
  }
  if (msg.type === 'agentRestoreSystem') {
    // Remove user override to restore bundled default
    const overridePath = systemAgentsOverridePath();
    const existing = loadAgentsFile(overridePath);
    delete existing[msg.id];
    saveAgentsFile(overridePath, existing);
    return { type: 'agentsData', agents: loadMergedAgents(repoRoot, extensionPath) };
  }
  return null;
}

function handleModeMessage(msg, repoRoot, extensionPath) {
  if (msg.type === 'modesLoad') {
    return { type: 'modesData', modes: loadMergedModes(repoRoot, extensionPath) };
  }
  if (msg.type === 'modeSave') {
    const scope = msg.scope; // 'global' or 'project'
    const filePath = scope === 'global' ? globalModesPath() : projectModesPath(repoRoot);
    saveModesFile(filePath, msg.modes);
    return { type: 'modesData', modes: loadMergedModes(repoRoot, extensionPath) };
  }
  if (msg.type === 'modeSaveSystem') {
    const overridePath = systemModesOverridePath();
    const existing = loadModesFile(overridePath);
    existing[msg.id] = msg.mode;
    saveModesFile(overridePath, existing);
    return { type: 'modesData', modes: loadMergedModes(repoRoot, extensionPath) };
  }
  if (msg.type === 'modeRestoreSystem') {
    const overridePath = systemModesOverridePath();
    const existing = loadModesFile(overridePath);
    delete existing[msg.id];
    saveModesFile(overridePath, existing);
    return { type: 'modesData', modes: loadMergedModes(repoRoot, extensionPath) };
  }
  return null;
}

async function _instancesData(repoRoot, panelId, extra = {}, actionId = undefined) {
  const cfg = loadInstanceConfig(repoRoot);
  const [instances, snap] = await Promise.all([
    listInstances(panelId, repoRoot),
    getSnapshotExists(repoRoot),
  ]);
  return { type: 'instancesData', instances, panelId, useSnapshot: cfg.useSnapshot !== false, snapshotExists: snap.exists, snapshotTag: snap.tag, _actionId: actionId, ...extra };
}

async function handleInstanceMessage(msg, repoRoot, panelId, postFn, extensionPath) {
  const aid = msg._actionId;
  if (msg.type === 'instancesLoad') {
    return _instancesData(repoRoot, panelId, {}, aid);
  }
  if (msg.type === 'instanceStart') {
    const cfg = loadInstanceConfig(repoRoot);
    const useSnapshot = cfg.useSnapshot !== false;
    const desktop = await ensureDesktop(repoRoot, panelId, useSnapshot);
    return _instancesData(repoRoot, panelId, { novncPort: desktop ? desktop.novncPort : null }, aid);
  }
  if (msg.type === 'instanceSettingsSave') {
    saveInstanceConfig(repoRoot, { useSnapshot: msg.useSnapshot });
    return { type: 'instanceSettings', useSnapshot: msg.useSnapshot, _actionId: aid };
  }
  if (msg.type === 'instanceSnapshot') {
    const safePath = repoRoot.replace(/\\/g, '/');
    const { execFile } = require('node:child_process');
    const qaCliPath = path.join(extensionPath, 'qa-desktop', 'cli.js');
    await new Promise((resolve) => {
      execFile('node', [qaCliPath, 'snapshot', msg.name, '--workspace', safePath, '--json'], { timeout: 600000 }, (err, stdout, stderr) => {
        if (err) console.error('[instance] snapshot failed:', stderr);
        resolve();
      });
    });
    return _instancesData(repoRoot, panelId, {}, aid);
  }
  if (msg.type === 'instanceSnapshotDelete') {
    const safePath = repoRoot.replace(/\\/g, '/');
    const { execFile } = require('node:child_process');
    const qaCliPath = path.join(extensionPath, 'qa-desktop', 'cli.js');
    await new Promise((resolve) => {
      const instName = msg.name === '_workspace_' ? 'workspace' : msg.name;
      execFile('node', [qaCliPath, 'snapshot-delete', instName, '--workspace', safePath, '--json'], { timeout: 30000 }, (err, stdout, stderr) => {
        if (err) console.error('[instance] snapshot-delete failed:', stderr);
        resolve();
      });
    });
    return _instancesData(repoRoot, panelId, {}, aid);
  }
  if (msg.type === 'instanceStop') {
    await stopInstance(msg.name);
    // Notify webview to clear VNC if this was the linked instance
    try { postFn({ type: 'desktopGone' }); } catch {}
    return _instancesData(repoRoot, panelId, {}, aid);
  }
  if (msg.type === 'instanceRestart') {
    await restartInstance(msg.name, repoRoot, panelId);
    return _instancesData(repoRoot, panelId, {}, aid);
  }
  if (msg.type === 'instanceStopAll') {
    const current = await listInstances(panelId);
    for (const inst of current) {
      await stopInstance(inst.name);
    }
    // Notify webview to clear VNC
    try { postFn({ type: 'desktopGone' }); } catch {}
    return _instancesData(repoRoot, panelId, {}, aid);
  }
  if (msg.type === 'instanceRestartAll') {
    const current = await listInstances(panelId);
    for (const inst of current) {
      await restartInstance(inst.name, repoRoot, panelId);
    }
    return _instancesData(repoRoot, panelId, {}, aid);
  }
  if (msg.type === 'instanceOpenVnc') {
    const port = msg.novncPort;
    if (port) {
      vscode.env.openExternal(vscode.Uri.parse(`http://localhost:${port}/vnc.html?autoconnect=true&resize=scale`));
    }
    return null;
  }
  return null;
}

function getWebviewHtml(panel, extensionUri) {
  const webviewDir = vscode.Uri.joinPath(extensionUri, 'webview');
  const styleUri = panel.webview.asWebviewUri(vscode.Uri.joinPath(webviewDir, 'style.css'));
  const scriptUri = panel.webview.asWebviewUri(vscode.Uri.joinPath(webviewDir, 'main.js'));

  const nonce = getNonce();

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${panel.webview.cspSource}; script-src 'nonce-${nonce}'; frame-src http://localhost:*; img-src data:;">
  <link rel="stylesheet" href="${styleUri}">
  <title>CC Manager</title>
</head>
<body>
  <div id="app">
    <div id="tab-bar">
      <button class="tab-btn active" data-tab="agent">Agent</button>
      <button class="tab-btn" data-tab="tasks">Tasks</button>
      <button class="tab-btn" data-tab="tests">Tests</button>
      <button class="tab-btn" data-tab="agents">Agents</button>
      <button class="tab-btn" data-tab="mcp">MCP Servers</button>
      <button class="tab-btn" data-tab="instances">Instances</button>
      <button class="tab-btn" data-tab="computer">Computer</button>
      <button class="tab-btn" data-tab="browser">Browser</button>
      <button class="tab-btn" data-tab="modes">Modes</button>
    </div>

    <div id="confirm-modal" style="display:none;">
      <div class="confirm-modal-backdrop"></div>
      <div class="confirm-modal-box">
        <p id="confirm-modal-text"></p>
        <div class="confirm-modal-buttons">
          <button id="confirm-modal-yes">Yes, continue</button>
          <button id="confirm-modal-no">Cancel</button>
        </div>
      </div>
    </div>

    <div id="init-wizard" class="wizard-hidden">
      <!-- Onboarding steps (shown on first run only) -->
      <div id="wizard-step-onboard" class="wizard-step wizard-hidden">
        <h2>Welcome to CC Manager</h2>
        <p class="wizard-subtitle">Let's check your environment and preferences.</p>
        <div id="onboard-status" class="onboard-status"></div>
        <div id="onboard-cli-preference" class="wizard-cards wizard-hidden"></div>
        <div class="wizard-nav">
          <button class="wizard-skip" id="onboard-skip">Skip Setup</button>
          <button class="wizard-next" id="onboard-next" disabled>Continue</button>
        </div>
      </div>

      <div id="wizard-step-onboard-summary" class="wizard-step wizard-hidden">
        <h2>Setup Complete</h2>
        <div id="onboard-summary" class="onboard-status"></div>
        <div class="wizard-nav">
          <button class="wizard-back" id="onboard-summary-back">Back</button>
          <button class="wizard-next" id="onboard-complete">Get Started</button>
        </div>
      </div>

      <!-- Existing mode selection steps -->
      <div id="wizard-step-1" class="wizard-step">
        <h2>What would you like to do?</h2>
        <div id="wizard-rerun-setup" class="wizard-rerun-setup"></div>
        <div class="wizard-cards" id="wizard-mode-cards"></div>
      </div>
      <div id="wizard-step-2" class="wizard-step wizard-hidden">
        <h2>Where should testing happen?</h2>
        <div class="wizard-cards">
          <div class="wizard-card" data-env="browser">
            <div class="wizard-card-icon">&#127760;</div>
            <div class="wizard-card-title">Browser</div>
            <div class="wizard-card-desc">Test web apps in a headless Chrome browser</div>
          </div>
          <div class="wizard-card" data-env="computer">
            <div class="wizard-card-icon">&#128421;</div>
            <div class="wizard-card-title">Desktop</div>
            <div class="wizard-card-desc">Test desktop apps in a Linux container</div>
          </div>
        </div>
        <div class="wizard-nav">
          <button class="wizard-back" id="wizard-back-2">Back</button>
          <button class="wizard-skip" id="wizard-skip-2">Skip</button>
        </div>
      </div>
      <div id="wizard-step-3" class="wizard-step wizard-hidden">
        <h2>Setup</h2>
        <div id="wizard-setup-options" class="wizard-cards"></div>
        <div class="wizard-nav">
          <button class="wizard-back" id="wizard-back-3">Back</button>
          <button class="wizard-skip" id="wizard-skip-3">Skip</button>
        </div>
      </div>
    </div>

    <div id="tab-agent">
      <div id="progress-bubble" class="progress-bubble hidden">
        <div class="progress-header">Progress</div>
        <div class="progress-body"></div>
      </div>
      <div id="messages"></div>
      <div id="suggestions"></div>
      <div id="input-area">
        <textarea id="user-input" rows="1" placeholder="Type a message or /help for commands..."></textarea>
        <button id="btn-send">Send</button>
        <button id="btn-continue" title="Send to controller with optional guidance">Continue ▶</button>
        <button id="btn-orchestrate" title="Full controller orchestration — controller investigates and delegates to agents">Orchestrate ⚡</button>
        <button id="btn-stop">Stop</button>
        <label class="loop-toggle" title="Auto-continue: controller runs after each agent response"><input type="checkbox" id="loop-toggle" /><span>⟳</span></label>
      </div>
      <div id="config-bar">
      <div class="config-group">
        <label>Target</label>
        <select id="cfg-chat-target">
          <option value="controller">Controller</option>
          <option value="claude">Worker (Default)</option>
        </select>
      </div>
      <div class="config-group cfg-controller-only">
        <label>Controller CLI</label>
        <select id="cfg-controller-cli">
          <option value="codex">Codex</option>
          <option value="claude">Claude</option>
        </select>
      </div>
      <div class="config-group cfg-controller-only">
        <label>Controller</label>
        <select id="cfg-controller-model">
          <option value="">Model: default</option>
        </select>
        <select id="cfg-controller-thinking">
          <option value="">Thinking: default</option>
        </select>
      </div>
      <div class="config-group cfg-worker-only">
        <label>Default Worker CLI</label>
        <select id="cfg-worker-cli">
          <option value="claude">Claude</option>
          <option value="codex">Codex</option>
        </select>
      </div>
      <div class="config-group cfg-worker-only">
        <label>Default Worker</label>
        <select id="cfg-worker-model">
          <option value="">Model: default</option>
        </select>
        <select id="cfg-worker-thinking">
          <option value="">Thinking: default</option>
        </select>
      </div>
      <div class="config-group cfg-controller-only">
        <label>Wait</label>
        <select id="cfg-wait-delay">
          <option value="">None</option>
          <option value="1m">1 min</option>
          <option value="2m">2 min</option>
          <option value="3m">3 min</option>
          <option value="5m">5 min</option>
          <option value="10m">10 min</option>
          <option value="15m">15 min</option>
          <option value="30m">30 min</option>
          <option value="1h">1 hour</option>
          <option value="2h">2 hours</option>
          <option value="3h">3 hours</option>
          <option value="5h">5 hours</option>
          <option value="6h">6 hours</option>
          <option value="12h">12 hours</option>
          <option value="1d">1 day</option>
          <option value="2d">2 days</option>
          <option value="3d">3 days</option>
          <option value="4d">4 days</option>
          <option value="5d">5 days</option>
          <option value="6d">6 days</option>
          <option value="7d">7 days</option>
        </select>
      </div>
    </div>
    </div><!-- /tab-agent -->

    <div id="tab-tasks" class="tab-hidden">
      <div id="kanban-board" class="kanban-board"></div>
      <div id="task-detail" class="task-detail" style="display:none"></div>
    </div><!-- /tab-tasks -->

    <div id="tab-tests" class="tab-hidden">
      <div id="test-board" class="test-board"></div>
      <div id="test-detail" class="test-detail"></div>
    </div><!-- /tab-tests -->

    <div id="tab-agents" class="tab-hidden">
      <div class="mcp-container">
        <div class="mcp-section">
          <div class="mcp-section-header">
            <h3>System Agents</h3>
            <span class="mcp-section-path">Built-in agents shipped with the extension</span>
          </div>
          <div id="agent-list-system" class="mcp-list"></div>
        </div>
        <div class="mcp-section">
          <div class="mcp-section-header">
            <h3>Global Agents</h3>
            <span class="mcp-section-path">~/.cc-manager/agents.json</span>
            <button class="agent-add-btn" data-scope="global">+ Add</button>
          </div>
          <div id="agent-list-global" class="mcp-list"></div>
        </div>
        <div class="mcp-section">
          <div class="mcp-section-header">
            <h3>Project Agents</h3>
            <span class="mcp-section-path">.cc-manager/agents.json</span>
            <button class="agent-add-btn" data-scope="project">+ Add</button>
          </div>
          <div id="agent-list-project" class="mcp-list"></div>
        </div>
      </div>
    </div><!-- /tab-agents -->

    <div id="tab-mcp" class="tab-hidden">
      <div class="mcp-container">
        <div class="mcp-section">
          <div class="mcp-section-header">
            <h3>Global Servers</h3>
            <span class="mcp-section-path">~/.cc-manager/mcp.json</span>
            <button class="mcp-add-btn" data-scope="global">+ Add</button>
          </div>
          <div id="mcp-list-global" class="mcp-list"></div>
        </div>
        <div class="mcp-section">
          <div class="mcp-section-header">
            <h3>Project Servers</h3>
            <span class="mcp-section-path">.cc-manager/mcp.json</span>
            <button class="mcp-add-btn" data-scope="project">+ Add</button>
          </div>
          <div id="mcp-list-project" class="mcp-list"></div>
        </div>
      </div>
    </div><!-- /tab-mcp -->

    <div id="tab-instances" class="tab-hidden">
      <div class="mcp-container">
        <div class="mcp-section">
          <div class="mcp-section-header">
            <h3>Docker Instances</h3>
            <span class="mcp-section-path">qa-desktop containers</span>
            <div style="flex:1"></div>
            <label class="instance-snapshot-toggle"><input type="checkbox" id="use-snapshot-checkbox" checked> Use snapshot</label>
            <button class="instance-action-btn" data-action="start">Start for this session</button>
            <button class="instance-action-btn instance-btn-secondary" data-action="restartAll">Restart All</button>
            <button class="instance-action-btn instance-btn-secondary" data-action="stopAll">Stop All</button>
          </div>
          <div id="snapshot-info" style="display:flex;align-items:center;gap:8px;padding:4px 8px;min-height:24px;"></div>
          <div id="instance-list" class="mcp-list"></div>
        </div>
      </div>
    </div><!-- /tab-instances -->

    <div id="tab-computer" class="tab-hidden">
      <div id="computer-placeholder" class="computer-placeholder">
        <p>No desktop instance linked to this session.</p>
        <p><small>Start a remote agent or launch an instance from the Instances tab.</small></p>
      </div>
      <iframe id="computer-vnc-frame" class="computer-vnc-frame" style="display:none;" sandbox="allow-scripts allow-same-origin allow-forms allow-popups"></iframe>
    </div><!-- /tab-computer -->
    <div id="tab-browser" class="tab-hidden">
      <div id="browser-nav" class="browser-nav" style="display:none;">
        <button id="browser-back" class="browser-nav-btn" title="Back">\u2190</button>
        <button id="browser-forward" class="browser-nav-btn" title="Forward">\u2192</button>
        <button id="browser-reload" class="browser-nav-btn" title="Reload">\u21BB</button>
        <input id="browser-url" class="browser-url-input" type="text" placeholder="Enter URL..." spellcheck="false" />
        <button id="browser-go" class="browser-nav-btn" title="Go">Go</button>
      </div>
      <div id="browser-placeholder" class="computer-placeholder">
        <p>No Chrome instance linked to this session.</p>
        <p><small>Click this tab to start a headless Chrome instance.</small></p>
      </div>
      <img id="browser-chrome-frame" class="browser-chrome-frame" tabindex="0" style="display:none;" alt="Chrome Screencast" />
    </div><!-- /tab-browser -->

    <div id="tab-modes" class="tab-hidden">
      <div class="mcp-container">
        <div class="mcp-section">
          <div class="mcp-section-header">
            <h3>System Modes</h3>
            <span class="mcp-section-path">Built-in modes shipped with the extension</span>
          </div>
          <div id="mode-list-system" class="mcp-list"></div>
        </div>
        <div class="mcp-section">
          <div class="mcp-section-header">
            <h3>Global Modes</h3>
            <span class="mcp-section-path">~/.cc-manager/modes.json</span>
            <button class="mode-add-btn" data-scope="global">+ Add</button>
          </div>
          <div id="mode-list-global" class="mcp-list"></div>
        </div>
        <div class="mcp-section">
          <div class="mcp-section-header">
            <h3>Project Modes</h3>
            <span class="mcp-section-path">.cc-manager/modes.json</span>
            <button class="mode-add-btn" data-scope="project">+ Add</button>
          </div>
          <div id="mode-list-project" class="mcp-list"></div>
        </div>
      </div>
    </div><!-- /tab-modes -->
  </div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
}

function getNonce() {
  let text = '';
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 32; i++) {
    text += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return text;
}

function getRepoRoot(extensionUri) {
  const folders = vscode.workspace.workspaceFolders;
  if (folders && folders.length > 0) {
    return folders[0].uri.fsPath;
  }
  // Fallback: extension lives in <project>/extension, so go up one level
  return path.dirname(extensionUri.fsPath);
}

function activate(context) {
  // Start HTTP MCP servers (singletons shared across all panels)
  const defaultTasksFile = path.join(getRepoRoot(context.extensionUri), '.cc-manager', 'tasks.json');
  startTasksMcpServer(defaultTasksFile).then(r => { _tasksMcpPort = r.port; }).catch(e => console.error('[ext] Failed to start tasks MCP:', e));
  const defaultTestsFile = path.join(getRepoRoot(context.extensionUri), '.cc-manager', 'tests.json');
  startTestsMcpServer(defaultTestsFile, defaultTasksFile).then(r => { _testsMcpPort = r.port; }).catch(e => console.error('[ext] Failed to start tests MCP:', e));
  const defaultRepoRoot = getRepoRoot(context.extensionUri);
  startQaDesktopMcpServer(defaultRepoRoot).then(r => { _qaDesktopMcpPort = r.port; }).catch(e => console.error('[ext] Failed to start qa-desktop MCP:', e));

  const openCommand = vscode.commands.registerCommand('ccManager.open', () => {
    const title = activePanels.size === 0 ? 'CC Manager' : `CC Manager (${activePanels.size + 1})`;
    const panel = vscode.window.createWebviewPanel(
      'ccManagerPanel',
      title,
      vscode.ViewColumn.One,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [
          vscode.Uri.joinPath(context.extensionUri, 'webview'),
        ],
      }
    );

    panel.iconPath = vscode.Uri.joinPath(context.extensionUri, 'resources', 'icon.svg');
    panel.webview.html = getWebviewHtml(panel, context.extensionUri);

    const renderer = new WebviewRenderer(panel);
    const repoRoot = getRepoRoot(context.extensionUri);

    // Per-panel mutable config (new panels start with defaults)
    const panelConfig = {};

    function postMessage(msg) {
      // Keep panelConfig in sync when SessionManager pushes config changes
      if (msg && msg.type === 'syncConfig' && msg.config) {
        Object.assign(panelConfig, msg.config);
      }
      try {
        panel.webview.postMessage(msg);
      } catch {
        // Panel disposed
      }
    }

    const session = new SessionManager(renderer, {
      repoRoot,
      postMessage,
      initialConfig: panelConfig,
      extensionPath: context.extensionUri.fsPath,
    });
    // Pass HTTP MCP server ports so agents can reach them
    session._tasksMcpPort = _tasksMcpPort;
    session._testsMcpPort = _testsMcpPort;
    session._qaDesktopMcpPort = _qaDesktopMcpPort;
    // Initialize MCP servers and agents from disk
    const extensionPath1 = context.extensionUri.fsPath;
    session.setMcpServers(loadMergedMcpServers(repoRoot));
    session.setAgents(loadMergedAgents(repoRoot, extensionPath1));

    panel.webview.onDidReceiveMessage(
      async (msg) => {
        if (msg.type === 'configChanged') {
          session.applyConfig(msg.config);
          Object.assign(panelConfig, msg.config);
          return;
        }
        if (msg.type === '_debugLog') {
          const logPath = path.join(os.homedir(), '.cc-manager', 'wizard-debug.log');
          try { fs.mkdirSync(path.dirname(logPath), { recursive: true }); } catch {}
          try { fs.appendFileSync(logPath, `[${new Date().toISOString()}] ${msg.text}\n`); } catch {}
          return;
        }
        if (msg.type === 'onboardingDetect') {
          runFullDetection().then(detected => {
            try { panel.webview.postMessage({ type: 'onboardingDetected', detected }); } catch {}
          }).catch(() => {
            try { panel.webview.postMessage({ type: 'onboardingDetected', detected: null, error: 'Detection failed' }); } catch {}
          });
          return;
        }
        if (msg.type === 'onboardingSave') {
          const bundledPath = path.join(extensionPath1, 'resources', 'system-agents.json');
          const bundledAgents = loadAgentsFile(bundledPath);
          const result = completeOnboarding({ preference: msg.preference, detected: msg.detected, bundledAgents });
          // Reload agents after onboarding modified system-agents overrides
          const agentsData = loadMergedAgents(repoRoot, extensionPath1);
          session.setAgents(agentsData);
          try {
            panel.webview.postMessage({ type: 'onboardingComplete', onboarding: { complete: true, data: result } });
            // Send updated agents to webview so Agents tab reflects the changes immediately
            panel.webview.postMessage({ type: 'agentsData', agents: agentsData });
          } catch {}
          return;
        }
        if (msg.type === 'setPanelTitle') {
          panel.title = msg.title;
          return;
        }
        if (msg.type === 'ready') {
          // Debug: log that we got ready message
          const _dlog = path.join(os.homedir(), '.cc-manager', 'wizard-debug.log');
          try { fs.mkdirSync(path.dirname(_dlog), { recursive: true }); } catch {}
          try { fs.appendFileSync(_dlog, `[${new Date().toISOString()}] EXT-HOST: ready received, repoRoot=${repoRoot}, msg.runId=${msg.runId}, msg.panelId=${msg.panelId}\n`); } catch {}
          // Restore panelId from webview persisted state if available
          if (msg.panelId) session._panelId = msg.panelId;
          const mcpData = loadMergedMcpServers(repoRoot);
          const agentsData = loadMergedAgents(repoRoot, extensionPath1);
          const modesData = loadMergedModes(repoRoot, extensionPath1);
          const onboardingData = loadOnboarding();
          panel.webview.postMessage({ type: 'initConfig', config: panelConfig, mcpServers: mcpData, agents: agentsData, modes: modesData, panelId: session.panelId, runId: msg.runId || null, onboarding: { complete: isOnboardingComplete(), data: onboardingData } });
          // Re-link to existing container if still running (don't create a new one)
          if (msg.panelId) {
            findExistingDesktop(repoRoot, session.panelId).then(desktop => {
              if (desktop) {
                try { panel.webview.postMessage({ type: 'desktopReady', novncPort: desktop.novncPort }); } catch {}
              }
            }).catch(() => {});
          }
          return;
        }
        if (msg.type === 'mcpServersChanged') {
          const scope = msg.scope;
          const servers = msg.servers;
          const filePath = scope === 'global' ? globalMcpPath() : projectMcpPath(repoRoot);
          saveMcpFile(filePath, servers);
          const mcpData = loadMergedMcpServers(repoRoot);
          session.setMcpServers(mcpData);
          return;
        }
        // Task CRUD messages
        const taskReply = handleTaskMessage(msg, repoRoot);
        if (taskReply) { try { panel.webview.postMessage(taskReply); } catch {} return; }
        // Test CRUD messages
        const testReply = handleTestMessage(msg, repoRoot);
        if (testReply) { try { panel.webview.postMessage(testReply); } catch {} return; }
        // Agent CRUD messages
        const agentReply = handleAgentMessage(msg, repoRoot, extensionPath1);
        if (agentReply) {
          try { panel.webview.postMessage(agentReply); } catch {}
          session.setAgents(loadMergedAgents(repoRoot, extensionPath1));
          return;
        }
        // Mode CRUD messages
        const modeReply = handleModeMessage(msg, repoRoot, extensionPath1);
        if (modeReply) {
          try { panel.webview.postMessage(modeReply); } catch {}
          session.setModes(loadMergedModes(repoRoot, extensionPath1));
          return;
        }
        // Instance management messages (async)
        let instanceReply;
        try {
          instanceReply = await handleInstanceMessage(msg, repoRoot, session.panelId, (m) => { try { panel.webview.postMessage(m); } catch {} }, extensionPath1);
        } catch (err) {
          console.error('[instance] handler error:', err);
          instanceReply = await _instancesData(repoRoot, session.panelId, {}, msg._actionId).catch(() => ({ type: 'instancesData', instances: [], panelId: session.panelId, _actionId: msg._actionId }));
        }
        if (instanceReply) {
          try { panel.webview.postMessage(instanceReply); } catch {}
          if (instanceReply.novncPort) {
            try { panel.webview.postMessage({ type: 'desktopReady', novncPort: instanceReply.novncPort }); } catch {}
          }
          return;
        }
        session.handleMessage(msg);
      },
      undefined,
      context.subscriptions
    );

    activePanels.add(panel);

    panel.onDidDispose(
      () => {
        activePanels.delete(panel);
        // Stop the Docker container linked to this panel
        const name = instanceName(repoRoot, session.panelId);
        stopInstance(name).catch(() => {});
        // Kill headless Chrome for this panel
        try { require('./chrome-manager').killChrome(session.panelId); } catch {}
        session.dispose();
      },
      null,
      context.subscriptions
    );

    renderer.banner('cc-manager interactive session');
    renderer.banner(`Repo root: ${repoRoot}`);
    renderer.banner('Type /help for commands, or type a message to start.');
  });

  context.subscriptions.push(openCommand);

  // Register serializer for panel restoration
  vscode.window.registerWebviewPanelSerializer('ccManagerPanel', {
    async deserializeWebviewPanel(panel, state) {
      panel.webview.html = getWebviewHtml(panel, context.extensionUri);

      const renderer = new WebviewRenderer(panel);
      const repoRoot = getRepoRoot(context.extensionUri);
      // Per-panel config restored from webview state (per-panel, not shared)
      const panelConfig = (state && state.config) || {};
      const savedRunId = (state && state.runId) || null;

      function postMessage(msg) {
        if (msg && msg.type === 'syncConfig' && msg.config) {
          Object.assign(panelConfig, msg.config);
        }
        try {
          panel.webview.postMessage(msg);
        } catch {}
      }

      const session = new SessionManager(renderer, {
        repoRoot,
        postMessage,
        initialConfig: panelConfig,
        extensionPath: context.extensionUri.fsPath,
      });
      session._tasksMcpPort = _tasksMcpPort;
      session._qaDesktopMcpPort = _qaDesktopMcpPort;
      const extensionPath2 = context.extensionUri.fsPath;
      session.setMcpServers(loadMergedMcpServers(repoRoot));
      session.setAgents(loadMergedAgents(repoRoot, extensionPath2));

      panel.webview.onDidReceiveMessage(
        async (msg) => {
          if (msg.type === '_debugLog') {
            const logPath = path.join(repoRoot, '.cc-manager', 'wizard-debug.log');
            try { fs.mkdirSync(path.dirname(logPath), { recursive: true }); } catch {}
            try { fs.appendFileSync(logPath, `[${new Date().toISOString()}] ${msg.text}\n`); } catch {}
            return;
          }
          if (msg.type === 'onboardingDetect') {
            runFullDetection().then(detected => {
              try { panel.webview.postMessage({ type: 'onboardingDetected', detected }); } catch {}
            }).catch(() => {
              try { panel.webview.postMessage({ type: 'onboardingDetected', detected: null, error: 'Detection failed' }); } catch {}
            });
            return;
          }
          if (msg.type === 'onboardingSave') {
            const bundledPath = path.join(extensionPath2, 'resources', 'system-agents.json');
            const bundledAgents = loadAgentsFile(bundledPath);
            const result = completeOnboarding({ preference: msg.preference, detected: msg.detected, bundledAgents });
            const agentsData = loadMergedAgents(repoRoot, extensionPath2);
            session.setAgents(agentsData);
            try {
              panel.webview.postMessage({ type: 'onboardingComplete', onboarding: { complete: true, data: result } });
              panel.webview.postMessage({ type: 'agentsData', agents: agentsData });
            } catch {}
            return;
          }
          if (msg.type === 'configChanged') {
            session.applyConfig(msg.config);
            Object.assign(panelConfig, msg.config);
            return;
          }
          if (msg.type === 'setPanelTitle') {
            panel.title = msg.title;
            return;
          }
          if (msg.type === 'mcpServersChanged') {
            const scope = msg.scope;
            const servers = msg.servers;
            const filePath = scope === 'global' ? globalMcpPath() : projectMcpPath(repoRoot);
            saveMcpFile(filePath, servers);
            const mcpData = loadMergedMcpServers(repoRoot);
            session.setMcpServers(mcpData);
            return;
          }
          // Task CRUD messages
          const taskReply = handleTaskMessage(msg, repoRoot);
          if (taskReply) { try { panel.webview.postMessage(taskReply); } catch {} return; }
          // Test CRUD messages
          const testReply = handleTestMessage(msg, repoRoot);
          if (testReply) { try { panel.webview.postMessage(testReply); } catch {} return; }
          // Agent CRUD messages
          const agentReply = handleAgentMessage(msg, repoRoot, extensionPath2);
          if (agentReply) {
            try { panel.webview.postMessage(agentReply); } catch {}
            session.setAgents(loadMergedAgents(repoRoot, extensionPath2));
            return;
          }
          // Mode CRUD messages
          const modeReply = handleModeMessage(msg, repoRoot, extensionPath2);
          if (modeReply) {
            try { panel.webview.postMessage(modeReply); } catch {}
            session.setModes(loadMergedModes(repoRoot, extensionPath2));
            return;
          }
          // Instance management messages (async)
          let instanceReply;
          try {
            instanceReply = await handleInstanceMessage(msg, repoRoot, session.panelId, (m) => { try { panel.webview.postMessage(m); } catch {} }, extensionPath2);
          } catch (err) {
            console.error('[instance] handler error:', err);
            instanceReply = await _instancesData(repoRoot, session.panelId, {}, msg._actionId).catch(() => ({ type: 'instancesData', instances: [], panelId: session.panelId, _actionId: msg._actionId }));
          }
          if (instanceReply) {
            try { panel.webview.postMessage(instanceReply); } catch {}
            if (instanceReply.novncPort) {
              try { panel.webview.postMessage({ type: 'desktopReady', novncPort: instanceReply.novncPort }); } catch {}
            }
            return;
          }
          if (msg.type === 'ready') {
            // Debug: log that we got ready message (deserialized)
            const _dlog2 = path.join(os.homedir(), '.cc-manager', 'wizard-debug.log');
            try { fs.mkdirSync(path.dirname(_dlog2), { recursive: true }); } catch {}
            try { fs.appendFileSync(_dlog2, `[${new Date().toISOString()}] EXT-HOST(deserialized): ready received, repoRoot=${repoRoot}, msg.runId=${msg.runId}, savedRunId=${savedRunId}, msg.panelId=${msg.panelId}\n`); } catch {}
            // Restore panelId from webview persisted state if available
            if (msg.panelId) session._panelId = msg.panelId;
            const mcpData = loadMergedMcpServers(repoRoot);
            const agentsData = loadMergedAgents(repoRoot, extensionPath2);
            const modesData = loadMergedModes(repoRoot, extensionPath2);
            const onboardingData2 = loadOnboarding();
            panel.webview.postMessage({ type: 'initConfig', config: panelConfig, mcpServers: mcpData, agents: agentsData, modes: modesData, panelId: session.panelId, runId: msg.runId || savedRunId || null, onboarding: { complete: isOnboardingComplete(), data: onboardingData2 } });
            // Re-link to existing container if still running (don't create a new one)
            if (msg.panelId) {
              findExistingDesktop(repoRoot, session.panelId).then(desktop => {
                if (desktop) {
                  try { panel.webview.postMessage({ type: 'desktopReady', novncPort: desktop.novncPort }); } catch {}
                }
              }).catch(() => {});
            }
            // Reattach to saved run if the webview had one before reload
            const runId = msg.runId || savedRunId;
            if (runId) {
              const ok = await session.reattachRun(runId);
              if (ok) {
                await session.sendTranscript();
                renderer.banner(`Reattached to run ${session.getRunId()}`);
                await session.sendProgress();
                session._restoreWaitTimer();
              } else {
                renderer.banner(`Previous run ${runId} no longer exists. Starting fresh.`);
              }
            }
            return;
          }
          session.handleMessage(msg);
        },
        undefined,
        context.subscriptions
      );

      activePanels.add(panel);

      panel.onDidDispose(
        () => {
          activePanels.delete(panel);
          const name = instanceName(repoRoot, session.panelId);
          stopInstance(name).catch(() => {});
          try { require('./chrome-manager').killChrome(session.panelId); } catch {}
          session.dispose();
        },
        null,
        context.subscriptions
      );
    },
  });
}

function deactivate() {
  stopTasksMcpServer().catch(() => {});
  stopQaDesktopMcpServer().catch(() => {});
  try { require('./chrome-manager').killAll(); } catch {}
}

module.exports = { activate, deactivate };
