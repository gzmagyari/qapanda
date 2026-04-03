/**
 * Message handlers extracted from extension.js for reuse by both
 * the VSCode extension and the standalone web server.
 * All functions are pure Node.js — no VSCode dependency.
 */
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { globalAgentsPath, projectAgentsPath, systemAgentsOverridePath, loadAgentsFile, saveAgentsFile, loadMergedAgents } = require('./agents-store');
const { loadMergedModes, saveModesFile, globalModesPath, projectModesPath, systemModesOverridePath, loadModesFile } = require('./modes-store');
const { listInstances, stopInstance, restartInstance, ensureDesktop, getSnapshotExists } = require('./src/remote-desktop');
const {
  loadProjectConfig,
  saveProjectConfig,
  loadAppInfo,
  saveAppInfo,
  loadMemory,
  saveMemory,
} = require('./src/project-context');

// ── MCP config file helpers ─────────────────────────────────────────
function globalMcpPath() {
  return path.join(os.homedir(), '.qpanda', 'mcp.json');
}

function projectMcpPath(repoRoot) {
  return path.join(repoRoot, '.qpanda', 'mcp.json');
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

function loadMergedMcpServers(repoRoot) {
  const globalServers = loadMcpFile(globalMcpPath());
  const projectServers = loadMcpFile(projectMcpPath(repoRoot));
  return { global: globalServers, project: projectServers };
}

// ── Instance config helpers ──────────────────────────────────────────
function loadInstanceConfig(repoRoot) {
  return loadProjectConfig(repoRoot);
}

function saveInstanceConfig(repoRoot, data) {
  saveProjectConfig(repoRoot, data);
}

function handleProjectContextMessage(msg, repoRoot) {
  if (msg.type === 'appInfoLoad') {
    return {
      type: 'appInfoData',
      content: loadAppInfo(repoRoot),
      enabled: loadProjectConfig(repoRoot).appInfoEnabled !== false,
    };
  }
  if (msg.type === 'appInfoSave') {
    const content = saveAppInfo(repoRoot, msg.content || '');
    const config = saveProjectConfig(repoRoot, { appInfoEnabled: msg.enabled !== false });
    return {
      type: 'appInfoData',
      content,
      enabled: config.appInfoEnabled !== false,
      saved: true,
    };
  }
  if (msg.type === 'memoryLoad') {
    return {
      type: 'memoryData',
      content: loadMemory(repoRoot),
      enabled: loadProjectConfig(repoRoot).memoryEnabled !== false,
    };
  }
  if (msg.type === 'memorySave') {
    const content = saveMemory(repoRoot, msg.content || '');
    const config = saveProjectConfig(repoRoot, { memoryEnabled: msg.enabled !== false });
    return {
      type: 'memoryData',
      content,
      enabled: config.memoryEnabled !== false,
      saved: true,
    };
  }
  return null;
}

// ── Tasks file helpers ───────────────────────────────────────────────
function tasksFilePath(repoRoot) {
  return path.join(repoRoot, '.qpanda', 'tasks.json');
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

// ── Tests file helpers ───────────────────────────────────────────────
function testsFilePath(repoRoot) { return path.join(repoRoot, '.qpanda', 'tests.json'); }
function loadTestsFile(fp) { try { return JSON.parse(fs.readFileSync(fp, 'utf8')); } catch { return { nextId: 1, nextStepId: 1, nextRunId: 1, tests: [] }; } }
function saveTestsFile(fp, data) { const dir = path.dirname(fp); if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(fp, JSON.stringify(data, null, 2), 'utf8'); }

// ── Task CRUD ────────────────────────────────────────────────────────
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

// ── Test CRUD ────────────────────────────────────────────────────────
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

// ── Agent CRUD ───────────────────────────────────────────────────────
function handleAgentMessage(msg, repoRoot, extensionPath) {
  if (msg.type === 'agentsLoad') {
    return { type: 'agentsData', agents: loadMergedAgents(repoRoot, extensionPath) };
  }
  if (msg.type === 'agentSave') {
    const scope = msg.scope;
    const filePath = scope === 'global' ? globalAgentsPath() : projectAgentsPath(repoRoot);
    saveAgentsFile(filePath, msg.agents);
    return { type: 'agentsData', agents: loadMergedAgents(repoRoot, extensionPath) };
  }
  if (msg.type === 'agentSaveSystem') {
    const overridePath = systemAgentsOverridePath();
    const existing = loadAgentsFile(overridePath);
    existing[msg.id] = msg.agent;
    saveAgentsFile(overridePath, existing);
    return { type: 'agentsData', agents: loadMergedAgents(repoRoot, extensionPath) };
  }
  if (msg.type === 'agentRestoreSystem') {
    const overridePath = systemAgentsOverridePath();
    const existing = loadAgentsFile(overridePath);
    delete existing[msg.id];
    saveAgentsFile(overridePath, existing);
    return { type: 'agentsData', agents: loadMergedAgents(repoRoot, extensionPath) };
  }
  return null;
}

// ── Mode CRUD ────────────────────────────────────────────────────────
function handleModeMessage(msg, repoRoot, extensionPath) {
  if (msg.type === 'modesLoad') {
    return { type: 'modesData', modes: loadMergedModes(repoRoot, extensionPath) };
  }
  if (msg.type === 'modeSave') {
    const scope = msg.scope;
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

// ── Instance management ──────────────────────────────────────────────
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
    // In web mode this is a no-op; VSCode extension handles it with vscode.env.openExternal
    return null;
  }
  return null;
}

module.exports = {
  globalMcpPath,
  projectMcpPath,
  loadMcpFile,
  saveMcpFile,
  loadMergedMcpServers,
  loadInstanceConfig,
  saveInstanceConfig,
  handleProjectContextMessage,
  handleTaskMessage,
  handleTestMessage,
  handleAgentMessage,
  handleModeMessage,
  handleInstanceMessage,
};
