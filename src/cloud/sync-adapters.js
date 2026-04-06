const fs = require('node:fs');
const path = require('node:path');

const { projectModesPath, readJsonFile, writeJsonFile } = require('../config-loader');
const {
  compactWorkflowPresetValues,
  listWorkflowPresets,
  materializeWorkflowPreset,
  replaceWorkflowPresets,
} = require('../workflow-presets-store');
const { buildWorkflowDocument, loadWorkflows } = require('../workflow-store');
const {
  appInfoPath,
  loadProjectConfig,
  memoryPath,
  projectConfigPath,
  saveProjectConfig,
} = require('../project-context');
const {
  defaultStateRoot,
  manifestPath: stateManifestPath,
  runDirFromId,
} = require('../state');

function nowIso() {
  return new Date().toISOString();
}

function ensureArray(value) {
  return Array.isArray(value) ? value : [];
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function sanitizeForPersistence(value) {
  if (value === undefined) return null;
  if (Array.isArray(value)) return value.map((item) => sanitizeForPersistence(item));
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, sanitizeForPersistence(entry)])
    );
  }
  return value;
}

function normalizeConflictSummary(binding, conflict) {
  const safe = sanitizeForPersistence(conflict || {});
  const repositoryId = String(safe.repositoryId || binding.repositoryId || 'local');
  const repositoryContextId = String(safe.repositoryContextId || binding.repositoryContextId || 'local');
  return {
    conflictId: String(safe.conflictId || `${safe.objectType || 'object'}:${safe.objectId || 'unknown'}:${Date.now()}`),
    workspaceId: String(safe.workspaceId || repositoryId),
    repositoryId,
    repositoryContextId,
    objectType: String(safe.objectType || 'issue'),
    objectId: String(safe.objectId || 'unknown'),
    conflictCode: String(safe.conflictCode || 'client_remote_conflict'),
    status: String(safe.status || 'open'),
    clientMutationId: String(safe.clientMutationId || ''),
    checkoutId: safe.checkoutId == null ? null : String(safe.checkoutId),
    localPayload: safe.localPayload && typeof safe.localPayload === 'object' ? safe.localPayload : {},
    remotePayload: safe.remotePayload && typeof safe.remotePayload === 'object' ? safe.remotePayload : {},
    resolution: safe.resolution && typeof safe.resolution === 'object' ? safe.resolution : null,
    createdAt: String(safe.createdAt || safe.updatedAt || nowIso()),
    updatedAt: String(safe.updatedAt || safe.createdAt || nowIso()),
    resolvedAt: safe.resolvedAt == null ? null : String(safe.resolvedAt),
  };
}

function projectQpandaDir(repoRoot) {
  return path.join(repoRoot, '.qpanda');
}

function tasksFilePath(repoRoot) {
  return path.join(projectQpandaDir(repoRoot), 'tasks.json');
}

function testsFilePath(repoRoot) {
  return path.join(projectQpandaDir(repoRoot), 'tests.json');
}

function projectWorkflowsDir(repoRoot) {
  return path.join(projectQpandaDir(repoRoot), 'workflows');
}

function projectAgentsFilePath(repoRoot) {
  return path.join(projectQpandaDir(repoRoot), 'agents.json');
}

function projectMcpFilePath(repoRoot) {
  return path.join(projectQpandaDir(repoRoot), 'mcp.json');
}

function projectModesFilePath(repoRoot) {
  return projectModesPath(repoRoot);
}

function projectPromptsDir(repoRoot) {
  return path.join(projectQpandaDir(repoRoot), 'prompts');
}

function projectRunsDir(repoRoot) {
  return path.join(defaultStateRoot(repoRoot), 'runs');
}

function runTranscriptFilePath(repoRoot, runId) {
  return path.join(runDirFromId(defaultStateRoot(repoRoot), runId), 'transcript.jsonl');
}

function runChatLogFilePath(repoRoot, runId) {
  return path.join(runDirFromId(defaultStateRoot(repoRoot), runId), 'chat.jsonl');
}

function runEventsFilePath(repoRoot, runId) {
  return path.join(runDirFromId(defaultStateRoot(repoRoot), runId), 'events.jsonl');
}

function runProgressFilePath(repoRoot, runId) {
  return path.join(runDirFromId(defaultStateRoot(repoRoot), runId), 'progress.md');
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

function loadTestsFile(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return { nextId: 1, nextStepId: 1, nextRunId: 1, tests: [] };
  }
}

function saveTestsFile(filePath, data) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
}

function safeNumericId(value, prefix) {
  const normalized = String(value || '');
  if (!normalized.startsWith(prefix)) return 0;
  const parsed = Number.parseInt(normalized.slice(prefix.length), 10);
  return Number.isFinite(parsed) ? parsed : 0;
}

function normalizeIssue(local) {
  return {
    id: String(local.id),
    title: String(local.title || local.id || 'Untitled issue'),
    description: String(local.description || ''),
    detail_text: String(local.detail_text || ''),
    status: String(local.status || 'todo'),
    created_at: String(local.created_at || nowIso()),
    updated_at: String(local.updated_at || local.created_at || nowIso()),
    comments: ensureArray(local.comments).map((comment) => ({
      id: Number(comment.id),
      author: String(comment.author || 'user'),
      text: String(comment.text || ''),
      created_at: String(comment.created_at || nowIso()),
    })),
    progress_updates: ensureArray(local.progress_updates).map((update) => ({
      id: Number(update.id),
      author: String(update.author || 'user'),
      text: String(update.text || ''),
      created_at: String(update.created_at || nowIso()),
    })),
  };
}

function issuePayloadFromLocal(local) {
  const issue = normalizeIssue(local);
  return {
    schemaVersion: 1,
    objectType: 'issue',
    id: issue.id,
    title: issue.title,
    description: issue.description,
    detailText: issue.detail_text,
    status: issue.status,
    createdAt: issue.created_at,
    updatedAt: issue.updated_at,
    comments: cloneJson(issue.comments),
    progressUpdates: cloneJson(issue.progress_updates),
  };
}

function issueFromPayload(payload, fallbackId) {
  return normalizeIssue({
    id: payload.id || fallbackId,
    title: payload.title || fallbackId,
    description: payload.description || '',
    detail_text: payload.detailText || '',
    status: payload.status || 'todo',
    created_at: payload.createdAt || nowIso(),
    updated_at: payload.updatedAt || payload.createdAt || nowIso(),
    comments: ensureArray(payload.comments),
    progress_updates: ensureArray(payload.progressUpdates),
  });
}

function issueLegacyObject(local) {
  const payload = issuePayloadFromLocal(local);
  return {
    objectId: payload.id,
    title: payload.title,
    payload,
    updatedAt: payload.updatedAt,
  };
}

function normalizeTest(local) {
  return {
    id: String(local.id),
    title: String(local.title || local.id || 'Untitled test'),
    description: String(local.description || ''),
    environment: String(local.environment || 'browser'),
    status: String(local.status || 'untested'),
    steps: ensureArray(local.steps).map((step) => ({
      id: Number(step.id),
      description: String(step.description || ''),
      expectedResult: String(step.expectedResult || ''),
      status: String(step.status || 'untested'),
      actualResult: step.actualResult == null ? null : String(step.actualResult),
    })),
    linkedTaskIds: ensureArray(local.linkedTaskIds).map((id) => String(id)),
    tags: ensureArray(local.tags).map((tag) => String(tag)),
    lastTestedAt: local.lastTestedAt == null ? null : String(local.lastTestedAt),
    lastTestedBy: local.lastTestedBy == null ? null : String(local.lastTestedBy),
    created_at: String(local.created_at || nowIso()),
    updated_at: String(local.updated_at || local.created_at || nowIso()),
    runs: ensureArray(local.runs).map((run) => ({
      id: Number(run.id),
      status: String(run.status || 'untested'),
      actor: run.actor == null ? null : String(run.actor),
      startedAt: run.startedAt == null ? null : String(run.startedAt),
      completedAt: run.completedAt == null ? null : String(run.completedAt),
      notes: run.notes == null ? null : String(run.notes),
      stepResults: ensureArray(run.stepResults).map((result) => ({
        stepId: Number(result.stepId),
        status: String(result.status || 'untested'),
        actualResult: result.actualResult == null ? null : String(result.actualResult),
      })),
    })),
  };
}

function testPayloadFromLocal(local) {
  const test = normalizeTest(local);
  return {
    schemaVersion: 1,
    objectType: 'test',
    id: test.id,
    title: test.title,
    description: test.description,
    environment: test.environment,
    status: test.status,
    steps: cloneJson(test.steps),
    linkedTaskIds: cloneJson(test.linkedTaskIds),
    tags: cloneJson(test.tags),
    lastTestedAt: test.lastTestedAt,
    lastTestedBy: test.lastTestedBy,
    createdAt: test.created_at,
    updatedAt: test.updated_at,
    runs: cloneJson(test.runs),
  };
}

function testFromPayload(payload, fallbackId) {
  return normalizeTest({
    id: payload.id || fallbackId,
    title: payload.title || fallbackId,
    description: payload.description || '',
    environment: payload.environment || 'browser',
    status: payload.status || 'untested',
    steps: ensureArray(payload.steps),
    linkedTaskIds: ensureArray(payload.linkedTaskIds),
    tags: ensureArray(payload.tags),
    lastTestedAt: payload.lastTestedAt ?? null,
    lastTestedBy: payload.lastTestedBy ?? null,
    created_at: payload.createdAt || nowIso(),
    updated_at: payload.updatedAt || payload.createdAt || nowIso(),
    runs: ensureArray(payload.runs),
  });
}

function testLegacyObject(local) {
  const payload = testPayloadFromLocal(local);
  return {
    objectId: payload.id,
    title: payload.title,
    payload,
    updatedAt: payload.updatedAt,
  };
}

function normalizeRecipeDirectoryName(value, fallback) {
  const normalized = String(value || fallback || 'workflow').trim().replace(/[<>:"/\\|?*\u0000-\u001f]/g, '-');
  return normalized || String(fallback || 'workflow');
}

function recipePayloadFromWorkflow(workflow) {
  const filePath = path.resolve(workflow.path);
  const content = fs.readFileSync(filePath, 'utf8');
  const stat = fs.statSync(filePath);
  const relativePath = path.relative(workflow.repoRoot, filePath).split(path.sep).join('/');
  const directoryName = normalizeRecipeDirectoryName(path.basename(workflow.dir), workflow.id || workflow.name);
  return {
    schemaVersion: 2,
    objectType: 'recipe',
    id: workflow.id || directoryName,
    title: workflow.name,
    name: workflow.name,
    description: workflow.description || '',
    preferredMode: workflow.preferredMode || 'continue',
    suggestedAgent: workflow.suggestedAgent || null,
    inputs: cloneJson(workflow.inputs || []),
    directoryName,
    relativePath,
    body: workflow.body || '',
    content,
    updatedAt: stat.mtime.toISOString(),
  };
}

function recipeLegacyObject(workflow) {
  const payload = recipePayloadFromWorkflow(workflow);
  return {
    objectId: payload.id,
    title: payload.title,
    payload,
    updatedAt: payload.updatedAt,
  };
}

function listProjectWorkflows(repoRoot) {
  return loadWorkflows(repoRoot)
    .filter((workflow) => workflow.scope === 'project')
    .map((workflow) => ({ ...workflow, repoRoot }));
}

function workflowProfileObjectId(workflowId, profileId) {
  return `${String(workflowId || '').trim()}:${String(profileId || '').trim()}`;
}

function workflowProfilePayloadFromLocal(local) {
  const workflow = local && local.workflow;
  if (!workflow || !workflow.id) {
    throw new Error('Workflow profile payloads require a project workflow.');
  }
  const profileId = String(local.id || '').trim();
  if (!profileId) {
    throw new Error('Workflow profile id is required.');
  }
  const values = compactWorkflowPresetValues(workflow, local.values || {}, local.secretRefs || {});
  return {
    schemaVersion: 1,
    objectType: 'workflow_profile',
    id: workflowProfileObjectId(workflow.id, profileId),
    title: `${workflow.name} / ${local.name}`,
    workflowId: workflow.id,
    profileId,
    name: String(local.name || ''),
    values: cloneJson(values),
    updatedAt: String(local.updatedAt || nowIso()),
  };
}

function workflowProfileLegacyObject(local) {
  const payload = workflowProfilePayloadFromLocal(local);
  return {
    objectId: payload.id,
    title: payload.title,
    payload,
    updatedAt: payload.updatedAt,
  };
}

function listProjectWorkflowProfiles(repoRoot) {
  const profiles = [];
  for (const workflow of listProjectWorkflows(repoRoot)) {
    for (const preset of listWorkflowPresets(repoRoot, workflow)) {
      profiles.push({
        ...preset,
        workflowId: workflow.id,
        workflowName: workflow.name,
        workflow,
      });
    }
  }
  return profiles.sort((left, right) => {
    const a = `${left.workflowName || ''}\u0000${left.name || ''}\u0000${left.id || ''}`.toLowerCase();
    const b = `${right.workflowName || ''}\u0000${right.name || ''}\u0000${right.id || ''}`.toLowerCase();
    return a.localeCompare(b);
  });
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function buildIssueCounters(issues) {
  return {
    nextId: Math.max(0, ...issues.map((issue) => safeNumericId(issue.id, 'task-'))) + 1,
    nextCommentId: Math.max(0, ...issues.flatMap((issue) => ensureArray(issue.comments).map((comment) => Number(comment.id) || 0))) + 1,
    nextProgressId: Math.max(0, ...issues.flatMap((issue) => ensureArray(issue.progress_updates).map((update) => Number(update.id) || 0))) + 1,
  };
}

function buildTestCounters(tests) {
  return {
    nextId: Math.max(0, ...tests.map((test) => safeNumericId(test.id, 'test-'))) + 1,
    nextStepId: Math.max(0, ...tests.flatMap((test) => ensureArray(test.steps).map((step) => Number(step.id) || 0))) + 1,
    nextRunId: Math.max(0, ...tests.flatMap((test) => ensureArray(test.runs).map((run) => Number(run.id) || 0))) + 1,
  };
}

function writeIssueObjects(repoRoot, objects) {
  const issues = objects
    .filter((object) => object.deletedAt === null)
    .map((object) => issueFromPayload(object.payload || {}, object.objectId));
  const counters = buildIssueCounters(issues);
  saveTasksFile(tasksFilePath(repoRoot), { ...counters, tasks: issues });
  return issues;
}

function writeTestObjects(repoRoot, objects) {
  const tests = objects
    .filter((object) => object.deletedAt === null)
    .map((object) => testFromPayload(object.payload || {}, object.objectId));
  const counters = buildTestCounters(tests);
  saveTestsFile(testsFilePath(repoRoot), { ...counters, tests });
  return tests;
}

function writeRecipeObjects(repoRoot, objects, options = {}) {
  const baseDir = projectWorkflowsDir(repoRoot);
  ensureDir(baseDir);
  const keep = new Set();
  for (const object of objects) {
    if (object.deletedAt !== null) continue;
    const payload = object.payload || {};
    const directoryName = normalizeRecipeDirectoryName(payload.directoryName || object.objectId, object.objectId);
    const workflowDir = path.join(baseDir, directoryName);
    ensureDir(workflowDir);
    const content = typeof payload.content === 'string' && payload.content.trim()
      ? payload.content
      : buildWorkflowDocument({
          name: payload.name || payload.title || object.objectId,
          description: payload.description || '',
          preferredMode: payload.preferredMode || 'continue',
          suggestedAgent: payload.suggestedAgent || null,
          inputs: ensureArray(payload.inputs),
          body: typeof payload.body === 'string' ? payload.body : '',
        });
    fs.writeFileSync(path.join(workflowDir, 'WORKFLOW.md'), String(content), 'utf8');
    keep.add(directoryName);
  }
  if (options.pruneRemoved) {
    for (const entry of fs.readdirSync(baseDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      if (keep.has(entry.name)) continue;
      fs.rmSync(path.join(baseDir, entry.name), { recursive: true, force: true });
    }
  }
  return Array.from(keep.values());
}

function writeWorkflowProfileObjects(repoRoot, objects, options = {}) {
  const workflows = listProjectWorkflows(repoRoot);
  const workflowsById = new Map(workflows.map((workflow) => [workflow.id, workflow]));
  const touchedWorkflowIds = new Set();
  const nextByWorkflowId = new Map();

  for (const object of objects) {
    const payload = object.payload || {};
    const workflowId = String(payload.workflowId || String(object.objectId || '').split(':')[0] || '').trim();
    if (!workflowId) continue;
    touchedWorkflowIds.add(workflowId);
    if (object.deletedAt !== null) continue;
    const workflow = workflowsById.get(workflowId);
    if (!workflow) continue;
    const profileId = String(payload.profileId || String(object.objectId || '').split(':').slice(1).join(':') || '').trim();
    if (!profileId) continue;
    const profile = materializeWorkflowPreset(workflow, {
      id: profileId,
      name: String(payload.name || profileId),
      updatedAt: payload.updatedAt ? String(payload.updatedAt) : null,
      values: payload.values && typeof payload.values === 'object' ? payload.values : {},
    });
    if (!nextByWorkflowId.has(workflowId)) {
      nextByWorkflowId.set(workflowId, []);
    }
    nextByWorkflowId.get(workflowId).push(profile);
  }

  for (const workflowId of touchedWorkflowIds) {
    const workflow = workflowsById.get(workflowId);
    if (!workflow) continue;
    replaceWorkflowPresets(repoRoot, workflow, nextByWorkflowId.get(workflowId) || []);
  }

  if (options.pruneRemoved) {
    for (const workflow of workflows) {
      if (touchedWorkflowIds.has(workflow.id)) continue;
      replaceWorkflowPresets(repoRoot, workflow, nextByWorkflowId.get(workflow.id) || []);
    }
  }

  return workflows.map((workflow) => ({
    workflowId: workflow.id,
    profiles: listWorkflowPresets(repoRoot, workflow),
  }));
}

function listLocalIssues(repoRoot) {
  return ensureArray(loadTasksFile(tasksFilePath(repoRoot)).tasks).map((issue) => normalizeIssue(issue));
}

function listLocalTests(repoRoot) {
  return ensureArray(loadTestsFile(testsFilePath(repoRoot)).tests).map((test) => normalizeTest(test));
}

function normalizeAgent(local) {
  const agent = {
    id: String(local.id),
    name: String(local.name || local.id || 'Unnamed agent'),
    description: String(local.description || ''),
    system_prompt: String(local.system_prompt || ''),
    mcps: local.mcps && typeof local.mcps === 'object' ? cloneJson(local.mcps) : {},
    enabled: local.enabled !== false,
    updatedAt: String(local.updatedAt || nowIso()),
  };
  for (const key of ['cli', 'provider', 'model', 'thinking', 'runMode', 'codexMode']) {
    if (local[key] != null && local[key] !== '') {
      agent[key] = String(local[key]);
    }
  }
  return agent;
}

function agentPayloadFromLocal(local) {
  const agent = normalizeAgent(local);
  return {
    schemaVersion: 1,
    objectType: 'agent',
    id: agent.id,
    title: agent.name,
    name: agent.name,
    description: agent.description,
    systemPrompt: agent.system_prompt,
    mcps: cloneJson(agent.mcps),
    enabled: agent.enabled,
    ...(agent.cli ? { cli: agent.cli } : {}),
    ...(agent.provider ? { provider: agent.provider } : {}),
    ...(agent.model ? { model: agent.model } : {}),
    ...(agent.thinking ? { thinking: agent.thinking } : {}),
    ...(agent.runMode ? { runMode: agent.runMode } : {}),
    ...(agent.codexMode ? { codexMode: agent.codexMode } : {}),
    updatedAt: agent.updatedAt,
  };
}

function normalizeMode(local) {
  return {
    id: String(local.id || ''),
    name: String(local.name || local.id || 'Untitled mode'),
    description: String(local.description || ''),
    icon: String(local.icon || ''),
    category: String(local.category || 'develop'),
    useController: Boolean(local.useController),
    defaultAgent: local.defaultAgent == null ? null : String(local.defaultAgent),
    availableAgents: ensureArray(local.availableAgents).map((agentId) => String(agentId)),
    requiresTestEnv: Boolean(local.requiresTestEnv),
    controllerPrompt: String(local.controllerPrompt || ''),
    enabled: local.enabled !== false,
    updatedAt: String(local.updatedAt || nowIso()),
  };
}

function modePayloadFromLocal(local) {
  const mode = normalizeMode(local);
  return {
    schemaVersion: 1,
    objectType: 'mode',
    id: mode.id,
    title: mode.name,
    name: mode.name,
    description: mode.description,
    icon: mode.icon,
    category: mode.category,
    useController: mode.useController,
    defaultAgent: mode.defaultAgent,
    availableAgents: cloneJson(mode.availableAgents),
    requiresTestEnv: mode.requiresTestEnv,
    controllerPrompt: mode.controllerPrompt,
    enabled: mode.enabled,
    updatedAt: String(local.updatedAt || nowIso()),
  };
}

function modeLegacyObject(local) {
  const payload = modePayloadFromLocal(local);
  return {
    objectId: payload.id,
    title: payload.title,
    payload,
    updatedAt: payload.updatedAt,
  };
}

function listLocalProjectModes(repoRoot) {
  const data = readJsonFile(projectModesFilePath(repoRoot));
  return Object.entries(data).map(([id, mode]) => ({
    id,
    ...cloneJson(mode || {}),
    updatedAt: mode && mode.updatedAt
      ? String(mode.updatedAt)
      : (fs.existsSync(projectModesFilePath(repoRoot))
        ? fs.statSync(projectModesFilePath(repoRoot)).mtime.toISOString()
        : nowIso()),
  }));
}

function writeModeObjects(repoRoot, objects) {
  const filePath = projectModesFilePath(repoRoot);
  const next = {};
  for (const object of objects) {
    if (object.deletedAt !== null) continue;
    const payload = normalizeMode({
      id: object.objectId,
      ...(object.payload || {}),
    });
    if (!payload.id) continue;
    next[payload.id] = {
      name: payload.name,
      description: payload.description,
      icon: payload.icon,
      category: payload.category,
      useController: payload.useController,
      defaultAgent: payload.defaultAgent,
      availableAgents: payload.availableAgents,
      requiresTestEnv: payload.requiresTestEnv,
      controllerPrompt: payload.controllerPrompt,
      enabled: payload.enabled,
      updatedAt: payload.updatedAt,
    };
  }
  if (!fs.existsSync(filePath) && Object.keys(next).length === 0) {
    return next;
  }
  writeJsonFile(filePath, next);
  return next;
}

function agentFromPayload(payload, fallbackId) {
  return normalizeAgent({
    id: payload.id || fallbackId,
    name: payload.name || payload.title || fallbackId,
    description: payload.description || '',
    system_prompt: payload.systemPrompt || '',
    mcps: payload.mcps || {},
    enabled: payload.enabled !== false,
    cli: payload.cli || null,
    provider: payload.provider || null,
    model: payload.model || null,
    thinking: payload.thinking || null,
    runMode: payload.runMode || null,
    codexMode: payload.codexMode || null,
    updatedAt: payload.updatedAt || null,
  });
}

function agentLegacyObject(local) {
  const payload = agentPayloadFromLocal(local);
  return {
    objectId: payload.id,
    title: payload.title,
    payload,
    updatedAt: payload.updatedAt,
  };
}

function listLocalProjectAgents(repoRoot) {
  const agents = readJsonFile(projectAgentsFilePath(repoRoot));
  return Object.entries(agents).map(([id, agent]) => normalizeAgent({ id, ...(agent || {}) }));
}

function writeAgentObjects(repoRoot, objects) {
  const filePath = projectAgentsFilePath(repoRoot);
  const agents = {};
  for (const object of objects) {
    if (object.deletedAt !== null) continue;
    const agent = agentFromPayload(object.payload || {}, object.objectId);
    const { id, ...config } = agent;
    agents[id] = config;
  }
  if (Object.keys(agents).length === 0 && !fs.existsSync(filePath)) {
    return agents;
  }
  writeJsonFile(filePath, agents);
  return agents;
}

function normalizeMcpServer(local) {
  const server = {
    id: String(local.id),
    target: String(local.target || 'both'),
    updatedAt: String(local.updatedAt || nowIso()),
  };
  if (String(local.type || '').toLowerCase() === 'http' || local.url) {
    server.type = 'http';
    server.url = String(local.url || '');
  } else {
    server.command = String(local.command || '');
    server.args = ensureArray(local.args).map((arg) => String(arg));
  }
  if (local.env && typeof local.env === 'object') {
    server.env = cloneJson(local.env);
  }
  return server;
}

function mcpServerPayloadFromLocal(local) {
  const server = normalizeMcpServer(local);
  return {
    schemaVersion: 1,
    objectType: 'mcp_server',
    id: server.id,
    title: server.id,
    target: server.target,
    ...(server.type ? { type: server.type } : {}),
    ...(server.url ? { url: server.url } : {}),
    ...(server.command ? { command: server.command } : {}),
    ...(server.args ? { args: cloneJson(server.args) } : {}),
    ...(server.env ? { env: cloneJson(server.env) } : {}),
    updatedAt: server.updatedAt,
  };
}

function mcpServerFromPayload(payload, fallbackId) {
  return normalizeMcpServer({
    id: payload.id || fallbackId,
    type: payload.type || null,
    url: payload.url || null,
    command: payload.command || null,
    args: ensureArray(payload.args),
    env: payload.env || null,
    target: payload.target || 'both',
    updatedAt: payload.updatedAt || null,
  });
}

function mcpServerLegacyObject(local) {
  const payload = mcpServerPayloadFromLocal(local);
  return {
    objectId: payload.id,
    title: payload.title,
    payload,
    updatedAt: payload.updatedAt,
  };
}

function listLocalProjectMcpServers(repoRoot) {
  const servers = readJsonFile(projectMcpFilePath(repoRoot));
  return Object.entries(servers).map(([id, server]) => normalizeMcpServer({ id, ...(server || {}) }));
}

function writeMcpServerObjects(repoRoot, objects) {
  const filePath = projectMcpFilePath(repoRoot);
  const servers = {};
  for (const object of objects) {
    if (object.deletedAt !== null) continue;
    const server = mcpServerFromPayload(object.payload || {}, object.objectId);
    const { id, ...config } = server;
    servers[id] = config;
  }
  if (Object.keys(servers).length === 0 && !fs.existsSync(filePath)) {
    return servers;
  }
  writeJsonFile(filePath, servers);
  return servers;
}

function normalizePromptTemplate(local) {
  const fileName = String(local.fileName || local.id || '').replace(/\\/g, '/').split('/').pop() || '';
  const normalizedFileName = fileName.endsWith('.md') ? fileName : `${fileName}.md`;
  const id = normalizedFileName.replace(/\.md$/i, '');
  return {
    id,
    fileName: normalizedFileName,
    title: String(local.title || id || 'Prompt Template'),
    content: String(local.content || ''),
    updatedAt: String(local.updatedAt || nowIso()),
  };
}

function buildRunFiles(runDir) {
  return {
    manifest: stateManifestPath(runDir),
    events: path.join(runDir, 'events.jsonl'),
    transcript: path.join(runDir, 'transcript.jsonl'),
    chatLog: path.join(runDir, 'chat.jsonl'),
    progress: path.join(runDir, 'progress.md'),
    schema: path.join(runDir, 'controller.schema.json'),
    requestsDir: path.join(runDir, 'requests'),
  };
}

function normalizeRunManifest(local) {
  const runId = String(local.runId || local.id || '');
  const updatedAt = String(local.updatedAt || local.createdAt || nowIso());
  const createdAt = String(local.createdAt || updatedAt);
  return {
    version: Number(local.version || 1),
    runId,
    createdAt,
    updatedAt,
    status: String(local.status || 'idle'),
    phase: String(local.phase || 'idle'),
    error: local.error == null ? null : String(local.error),
    stopReason: local.stopReason == null ? null : String(local.stopReason),
    chatTarget: local.chatTarget == null ? null : String(local.chatTarget),
    transcriptSummary: String(local.transcriptSummary || runId || 'Run'),
    waitDelay: local.waitDelay == null ? null : String(local.waitDelay),
    nextWakeAt: local.nextWakeAt == null ? null : String(local.nextWakeAt),
    errorRetry: Boolean(local.errorRetry),
    loopMode: Boolean(local.loopMode),
    loopObjective: local.loopObjective == null ? null : String(local.loopObjective),
    activeRequestId: local.activeRequestId == null ? null : String(local.activeRequestId),
    counters: local.counters && typeof local.counters === 'object'
      ? {
          request: Number(local.counters.request || 0),
          loop: Number(local.counters.loop || 0),
          controllerTurn: Number(local.counters.controllerTurn || 0),
          workerTurn: Number(local.counters.workerTurn || 0),
        }
      : {
          request: 0,
          loop: 0,
          controllerTurn: 0,
          workerTurn: 0,
        },
    controller: {
      cli: local.controller && local.controller.cli ? String(local.controller.cli) : 'codex',
      bin: local.controller && local.controller.bin ? String(local.controller.bin) : 'codex',
      model: local.controller && local.controller.model != null ? String(local.controller.model) : null,
      profile: local.controller && local.controller.profile != null ? String(local.controller.profile) : null,
      sandbox: local.controller && local.controller.sandbox ? String(local.controller.sandbox) : 'workspace-write',
      config: ensureArray(local.controller && local.controller.config).map((entry) => String(entry)),
      skipGitRepoCheck: Boolean(local.controller && local.controller.skipGitRepoCheck),
      extraInstructions: local.controller && local.controller.extraInstructions != null
        ? String(local.controller.extraInstructions)
        : null,
      codexMode: local.controller && local.controller.codexMode ? String(local.controller.codexMode) : 'app-server',
      apiConfig: local.controller && local.controller.apiConfig && typeof local.controller.apiConfig === 'object'
        ? cloneJson(local.controller.apiConfig)
        : null,
    },
    worker: {
      cli: local.worker && local.worker.cli ? String(local.worker.cli) : 'codex',
      bin: local.worker && local.worker.bin ? String(local.worker.bin) : 'codex',
      apiConfig: local.worker && local.worker.apiConfig && typeof local.worker.apiConfig === 'object'
        ? cloneJson(local.worker.apiConfig)
        : null,
      model: local.worker && local.worker.model != null ? String(local.worker.model) : null,
      allowedTools: local.worker && local.worker.allowedTools != null ? String(local.worker.allowedTools) : 'Bash,Read,Edit',
      tools: local.worker && local.worker.tools != null ? sanitizeForPersistence(local.worker.tools) : null,
      disallowedTools: local.worker && local.worker.disallowedTools != null ? sanitizeForPersistence(local.worker.disallowedTools) : null,
      permissionPromptTool: local.worker && local.worker.permissionPromptTool != null ? String(local.worker.permissionPromptTool) : null,
      maxTurns: local.worker && local.worker.maxTurns != null ? Number(local.worker.maxTurns) : null,
      maxBudgetUsd: local.worker && local.worker.maxBudgetUsd != null ? Number(local.worker.maxBudgetUsd) : null,
      addDirs: ensureArray(local.worker && local.worker.addDirs).map((entry) => String(entry)),
      appendSystemPrompt: local.worker && local.worker.appendSystemPrompt != null ? String(local.worker.appendSystemPrompt) : null,
      runMode: local.worker && local.worker.runMode ? String(local.worker.runMode) : 'print',
      hasStarted: Boolean(local.worker && local.worker.hasStarted),
      boundBrowserPort: local.worker && local.worker.boundBrowserPort != null
        ? Number(local.worker.boundBrowserPort) || 0
        : null,
      lastSeenChatLine: local.worker && local.worker.lastSeenChatLine != null
        ? Number(local.worker.lastSeenChatLine) || 0
        : 0,
      lastSeenTranscriptLine: local.worker && local.worker.lastSeenTranscriptLine != null
        ? Number(local.worker.lastSeenTranscriptLine) || 0
        : 0,
      agentSessions: local.worker && local.worker.agentSessions && typeof local.worker.agentSessions === 'object'
        ? Object.fromEntries(
            Object.entries(local.worker.agentSessions).map(([agentId, session]) => [
              String(agentId),
              {
                ...(session && typeof session === 'object' ? sanitizeForPersistence(session) : {}),
                boundBrowserPort: session && session.boundBrowserPort != null
                  ? Number(session.boundBrowserPort) || 0
                  : null,
                lastSeenChatLine: session && session.lastSeenChatLine != null
                  ? Number(session.lastSeenChatLine) || 0
                  : 0,
                lastSeenTranscriptLine: session && session.lastSeenTranscriptLine != null
                  ? Number(session.lastSeenTranscriptLine) || 0
                  : 0,
              },
            ])
          )
        : {},
    },
    settings: local.settings && typeof local.settings === 'object'
      ? {
          rawEvents: Boolean(local.settings.rawEvents),
          quiet: Boolean(local.settings.quiet),
          color: local.settings.color !== false,
        }
      : {
          rawEvents: false,
          quiet: false,
          color: true,
        },
    mcpServers: local.mcpServers && typeof local.mcpServers === 'object' ? cloneJson(local.mcpServers) : {},
    controllerMcpServers: local.controllerMcpServers && typeof local.controllerMcpServers === 'object'
      ? cloneJson(local.controllerMcpServers)
      : null,
    workerMcpServers: local.workerMcpServers && typeof local.workerMcpServers === 'object'
      ? cloneJson(local.workerMcpServers)
      : null,
    agents: local.agents && typeof local.agents === 'object' ? cloneJson(local.agents) : {},
    selfTesting: Boolean(local.selfTesting),
    selfTestPrompts: local.selfTestPrompts && typeof local.selfTestPrompts === 'object'
      ? cloneJson(local.selfTestPrompts)
      : null,
    apiConfig: local.apiConfig && typeof local.apiConfig === 'object' ? cloneJson(local.apiConfig) : null,
    requests: ensureArray(local.requests).map((request) => ({
      id: String(request.id || ''),
      userMessage: String(request.userMessage || ''),
      startedAt: String(request.startedAt || createdAt),
      finishedAt: request.finishedAt == null ? null : String(request.finishedAt),
      status: String(request.status || 'idle'),
      stopReason: request.stopReason == null ? null : String(request.stopReason),
      latestControllerDecision: request.latestControllerDecision && typeof request.latestControllerDecision === 'object'
        ? sanitizeForPersistence(request.latestControllerDecision)
        : null,
      latestWorkerResult: request.latestWorkerResult && typeof request.latestWorkerResult === 'object'
        ? sanitizeForPersistence(request.latestWorkerResult)
        : null,
      loops: ensureArray(request.loops).map((loop, index) => ({
        id: String(loop.id || `loop-${String(index + 1).padStart(4, '0')}`),
        index: Number(loop.index || index + 1),
        startedAt: String(loop.startedAt || createdAt),
        finishedAt: loop.finishedAt == null ? null : String(loop.finishedAt),
        controller: loop.controller && typeof loop.controller === 'object'
          ? {
              exitCode: loop.controller.exitCode == null ? null : Number(loop.controller.exitCode),
              decision: loop.controller.decision && typeof loop.controller.decision === 'object'
                ? sanitizeForPersistence(loop.controller.decision)
                : null,
            }
          : { exitCode: null, decision: null },
        worker: loop.worker && typeof loop.worker === 'object'
          ? {
              exitCode: loop.worker.exitCode == null ? null : Number(loop.worker.exitCode),
              resultText: loop.worker.resultText == null ? null : String(loop.worker.resultText),
            }
          : null,
      })),
    })),
  };
}

function buildLocalManifestFromPayload(repoRoot, payload, fallbackId) {
  const normalized = normalizeRunManifest({
    runId: payload.runId || payload.id || fallbackId,
    ...(payload.manifest && typeof payload.manifest === 'object' ? payload.manifest : payload),
  });
  const stateRoot = defaultStateRoot(repoRoot);
  const runDir = runDirFromId(stateRoot, normalized.runId);
  const files = buildRunFiles(runDir);
  const manifest = {
    version: normalized.version,
    runId: normalized.runId,
    repoRoot,
    stateRoot,
    runDir,
    files,
    createdAt: normalized.createdAt,
    updatedAt: normalized.updatedAt,
    status: normalized.status,
    phase: normalized.phase,
    error: normalized.error,
    stopReason: normalized.stopReason,
    controller: {
      ...normalized.controller,
      sessionId: null,
      lastSeenChatLine: 0,
      lastSeenTranscriptLine: 0,
      schemaFile: files.schema,
      apiConfig: normalized.controller.apiConfig,
    },
    worker: {
      ...normalized.worker,
      sessionId: null,
      boundBrowserPort: Number.isFinite(normalized.worker.boundBrowserPort)
        ? normalized.worker.boundBrowserPort
        : null,
      lastSeenChatLine: Number.isFinite(normalized.worker.lastSeenChatLine)
        ? normalized.worker.lastSeenChatLine
        : 0,
      lastSeenTranscriptLine: Number.isFinite(normalized.worker.lastSeenTranscriptLine)
        ? normalized.worker.lastSeenTranscriptLine
        : 0,
      agentSessions: normalized.worker.agentSessions || {},
      apiConfig: normalized.worker.apiConfig,
    },
    settings: normalized.settings,
    mcpServers: normalized.mcpServers,
    controllerMcpServers: normalized.controllerMcpServers,
    workerMcpServers: normalized.workerMcpServers,
    agents: normalized.agents,
    panelId: null,
    chatTarget: normalized.chatTarget,
    controllerSystemPrompt: null,
    selfTesting: normalized.selfTesting,
    selfTestPrompts: normalized.selfTestPrompts,
    apiConfig: normalized.apiConfig,
    counters: normalized.counters,
    activeRequestId: normalized.activeRequestId,
    requests: ensureArray(normalized.requests).map((request) => {
      const requestDir = path.join(files.requestsDir, request.id);
      return {
        ...request,
        requestsDir: requestDir,
        loops: ensureArray(request.loops).map((loop) => {
          const loopDir = path.join(requestDir, loop.id || `loop-${String(loop.index || 1).padStart(4, '0')}`);
          return {
            id: loop.id,
            index: loop.index,
            startedAt: loop.startedAt,
            finishedAt: loop.finishedAt,
            controller: {
              promptFile: path.join(loopDir, 'controller.prompt.txt'),
              stdoutFile: path.join(loopDir, 'controller.stdout.log'),
              stderrFile: path.join(loopDir, 'controller.stderr.log'),
              finalFile: path.join(loopDir, 'controller.final.json'),
              exitCode: loop.controller && loop.controller.exitCode != null ? Number(loop.controller.exitCode) : null,
              decision: loop.controller && loop.controller.decision != null ? sanitizeForPersistence(loop.controller.decision) : null,
              sessionId: null,
            },
            worker: loop.worker
              ? {
                  promptFile: path.join(loopDir, 'worker.prompt.txt'),
                  stdoutFile: path.join(loopDir, 'worker.stdout.log'),
                  stderrFile: path.join(loopDir, 'worker.stderr.log'),
                  finalFile: path.join(loopDir, 'worker.final.json'),
                  exitCode: loop.worker.exitCode != null ? Number(loop.worker.exitCode) : null,
                  resultText: loop.worker.resultText == null ? null : String(loop.worker.resultText),
                  sessionId: null,
                }
              : null,
          };
        }),
      };
    }),
    transcriptSummary: normalized.transcriptSummary,
    waitDelay: normalized.waitDelay,
    nextWakeAt: normalized.nextWakeAt,
    errorRetry: normalized.errorRetry,
    loopMode: normalized.loopMode,
    loopObjective: normalized.loopObjective,
  };
  return manifest;
}

function runManifestPayloadFromLocal(local) {
  const manifest = normalizeRunManifest(local);
  return {
    schemaVersion: 1,
    objectType: 'run_manifest',
    id: manifest.runId,
    title: manifest.transcriptSummary || manifest.runId,
    manifest,
    updatedAt: manifest.updatedAt,
  };
}

function runManifestLegacyObject(local) {
  const payload = runManifestPayloadFromLocal(local);
  return {
    objectId: payload.id,
    title: payload.title,
    payload,
    updatedAt: payload.updatedAt,
  };
}

function listLocalRunManifestEntries(repoRoot) {
  const runsRoot = projectRunsDir(repoRoot);
  if (!fs.existsSync(runsRoot)) return [];
  return fs.readdirSync(runsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const runDir = path.join(runsRoot, entry.name);
      const filePath = stateManifestPath(runDir);
      if (!fs.existsSync(filePath)) return null;
      try {
        const manifest = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        return normalizeRunManifest(manifest);
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .sort((left, right) => String(right.updatedAt || '').localeCompare(String(left.updatedAt || '')));
}

function writeRunManifestObjects(repoRoot, objects, options = {}) {
  const liveObjects = objects.filter((object) => object.deletedAt === null);
  const keep = new Set();
  for (const object of liveObjects) {
    const manifest = buildLocalManifestFromPayload(repoRoot, object.payload || {}, object.objectId);
    const runDir = runDirFromId(defaultStateRoot(repoRoot), manifest.runId);
    ensureDir(runDir);
    fs.writeFileSync(stateManifestPath(runDir), JSON.stringify(manifest, null, 2), 'utf8');
    keep.add(manifest.runId);
  }
  if (options.pruneRemoved) {
    const runsRoot = projectRunsDir(repoRoot);
    if (fs.existsSync(runsRoot)) {
      for (const entry of fs.readdirSync(runsRoot, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        if (keep.has(entry.name)) continue;
        fs.rmSync(stateManifestPath(path.join(runsRoot, entry.name)), { force: true });
      }
    }
  }
  return liveObjects.map((object) => buildLocalManifestFromPayload(repoRoot, object.payload || {}, object.objectId));
}

function listLocalRunTranscripts(repoRoot) {
  return listLocalRunManifestEntries(repoRoot)
    .map((manifest) => {
      const filePath = runTranscriptFilePath(repoRoot, manifest.runId);
      return {
        id: manifest.runId,
        runId: manifest.runId,
        title: manifest.transcriptSummary || manifest.runId,
        content: fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : '',
        updatedAt: fs.existsSync(filePath)
          ? fs.statSync(filePath).mtime.toISOString()
          : String(manifest.updatedAt || nowIso()),
      };
    })
    .filter((entry) => entry.content || entry.updatedAt);
}

function listLocalRunChatLogs(repoRoot) {
  return listLocalRunManifestEntries(repoRoot)
    .map((manifest) => {
      const filePath = runChatLogFilePath(repoRoot, manifest.runId);
      return {
        id: manifest.runId,
        runId: manifest.runId,
        title: manifest.transcriptSummary || manifest.runId,
        content: fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : '',
        updatedAt: fs.existsSync(filePath)
          ? fs.statSync(filePath).mtime.toISOString()
          : String(manifest.updatedAt || nowIso()),
      };
    })
    .filter((entry) => entry.content || entry.updatedAt);
}

function listLocalRunEvents(repoRoot) {
  return listLocalRunManifestEntries(repoRoot)
    .map((manifest) => {
      const filePath = runEventsFilePath(repoRoot, manifest.runId);
      return {
        id: manifest.runId,
        runId: manifest.runId,
        title: manifest.transcriptSummary || manifest.runId,
        content: fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : '',
        updatedAt: fs.existsSync(filePath)
          ? fs.statSync(filePath).mtime.toISOString()
          : String(manifest.updatedAt || nowIso()),
      };
    })
    .filter((entry) => entry.content || entry.updatedAt);
}

function listLocalRunProgressFiles(repoRoot) {
  return listLocalRunManifestEntries(repoRoot)
    .map((manifest) => {
      const filePath = runProgressFilePath(repoRoot, manifest.runId);
      return {
        id: manifest.runId,
        runId: manifest.runId,
        title: manifest.transcriptSummary || manifest.runId,
        content: fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : '',
        updatedAt: fs.existsSync(filePath)
          ? fs.statSync(filePath).mtime.toISOString()
          : String(manifest.updatedAt || nowIso()),
      };
    })
    .filter((entry) => entry.content || entry.updatedAt);
}

function writeRunTranscriptObjects(repoRoot, objects, options = {}) {
  const keep = new Set();
  for (const object of objects) {
    const runId = String((object.payload && object.payload.id) || object.objectId || '');
    if (!runId) continue;
    const filePath = runTranscriptFilePath(repoRoot, runId);
    if (object.deletedAt !== null) {
      if (options.pruneRemoved) fs.rmSync(filePath, { force: true });
      continue;
    }
    ensureDir(path.dirname(filePath));
    fs.writeFileSync(filePath, String((object.payload && object.payload.content) || ''), 'utf8');
    keep.add(runId);
  }
  if (options.pruneRemoved) {
    const runsRoot = projectRunsDir(repoRoot);
    if (fs.existsSync(runsRoot)) {
      for (const entry of fs.readdirSync(runsRoot, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        if (keep.has(entry.name)) continue;
        fs.rmSync(runTranscriptFilePath(repoRoot, entry.name), { force: true });
      }
    }
  }
  return listLocalRunTranscripts(repoRoot);
}

function writeRunChatLogObjects(repoRoot, objects, options = {}) {
  const keep = new Set();
  for (const object of objects) {
    const runId = String((object.payload && object.payload.id) || object.objectId || '');
    if (!runId) continue;
    const filePath = runChatLogFilePath(repoRoot, runId);
    if (object.deletedAt !== null) {
      if (options.pruneRemoved) fs.rmSync(filePath, { force: true });
      continue;
    }
    ensureDir(path.dirname(filePath));
    fs.writeFileSync(filePath, String((object.payload && object.payload.content) || ''), 'utf8');
    keep.add(runId);
  }
  if (options.pruneRemoved) {
    const runsRoot = projectRunsDir(repoRoot);
    if (fs.existsSync(runsRoot)) {
      for (const entry of fs.readdirSync(runsRoot, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        if (keep.has(entry.name)) continue;
        fs.rmSync(runChatLogFilePath(repoRoot, entry.name), { force: true });
      }
    }
  }
  return listLocalRunChatLogs(repoRoot);
}

function writeRunEventObjects(repoRoot, objects, options = {}) {
  const keep = new Set();
  for (const object of objects) {
    const runId = String((object.payload && object.payload.id) || object.objectId || '');
    if (!runId) continue;
    const filePath = runEventsFilePath(repoRoot, runId);
    if (object.deletedAt !== null) {
      if (options.pruneRemoved) fs.rmSync(filePath, { force: true });
      continue;
    }
    ensureDir(path.dirname(filePath));
    fs.writeFileSync(filePath, String((object.payload && object.payload.content) || ''), 'utf8');
    keep.add(runId);
  }
  if (options.pruneRemoved) {
    const runsRoot = projectRunsDir(repoRoot);
    if (fs.existsSync(runsRoot)) {
      for (const entry of fs.readdirSync(runsRoot, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        if (keep.has(entry.name)) continue;
        fs.rmSync(runEventsFilePath(repoRoot, entry.name), { force: true });
      }
    }
  }
  return listLocalRunEvents(repoRoot);
}

function writeRunProgressObjects(repoRoot, objects, options = {}) {
  const keep = new Set();
  for (const object of objects) {
    const runId = String((object.payload && object.payload.id) || object.objectId || '');
    if (!runId) continue;
    const filePath = runProgressFilePath(repoRoot, runId);
    if (object.deletedAt !== null) {
      if (options.pruneRemoved) fs.rmSync(filePath, { force: true });
      continue;
    }
    ensureDir(path.dirname(filePath));
    fs.writeFileSync(filePath, String((object.payload && object.payload.content) || ''), 'utf8');
    keep.add(runId);
  }
  if (options.pruneRemoved) {
    const runsRoot = projectRunsDir(repoRoot);
    if (fs.existsSync(runsRoot)) {
      for (const entry of fs.readdirSync(runsRoot, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        if (keep.has(entry.name)) continue;
        fs.rmSync(runProgressFilePath(repoRoot, entry.name), { force: true });
      }
    }
  }
  return listLocalRunProgressFiles(repoRoot);
}

function runTranscriptPayloadFromLocal(local) {
  return {
    schemaVersion: 1,
    objectType: 'run_transcript',
    id: String(local.id || local.runId),
    title: String(local.title || local.id || local.runId || 'Run Transcript'),
    content: String(local.content || ''),
    updatedAt: String(local.updatedAt || nowIso()),
  };
}

function runTranscriptLegacyObject(local) {
  const payload = runTranscriptPayloadFromLocal(local);
  return {
    objectId: payload.id,
    title: payload.title,
    payload,
    updatedAt: payload.updatedAt,
  };
}

function runChatLogPayloadFromLocal(local) {
  return {
    schemaVersion: 1,
    objectType: 'run_chat_log',
    id: String(local.id || local.runId),
    title: String(local.title || local.id || local.runId || 'Run Chat Log'),
    content: String(local.content || ''),
    updatedAt: String(local.updatedAt || nowIso()),
  };
}

function runChatLogLegacyObject(local) {
  const payload = runChatLogPayloadFromLocal(local);
  return {
    objectId: payload.id,
    title: payload.title,
    payload,
    updatedAt: payload.updatedAt,
  };
}

function runEventPayloadFromLocal(local) {
  return {
    schemaVersion: 1,
    objectType: 'run_event_log',
    id: String(local.id || local.runId),
    title: String(local.title || local.id || local.runId || 'Run Event Log'),
    content: String(local.content || ''),
    updatedAt: String(local.updatedAt || nowIso()),
  };
}

function runEventLegacyObject(local) {
  const payload = runEventPayloadFromLocal(local);
  return {
    objectId: payload.id,
    title: payload.title,
    payload,
    updatedAt: payload.updatedAt,
  };
}

function runProgressPayloadFromLocal(local) {
  return {
    schemaVersion: 1,
    objectType: 'run_progress',
    id: String(local.id || local.runId),
    title: String(local.title || local.id || local.runId || 'Run Progress'),
    content: String(local.content || ''),
    updatedAt: String(local.updatedAt || nowIso()),
  };
}

function runProgressLegacyObject(local) {
  const payload = runProgressPayloadFromLocal(local);
  return {
    objectId: payload.id,
    title: payload.title,
    payload,
    updatedAt: payload.updatedAt,
  };
}

function promptTemplatePayloadFromLocal(local) {
  const prompt = normalizePromptTemplate(local);
  return {
    schemaVersion: 1,
    objectType: 'prompt_template',
    id: prompt.id,
    title: prompt.title,
    fileName: prompt.fileName,
    content: prompt.content,
    updatedAt: prompt.updatedAt,
  };
}

function promptTemplateLegacyObject(local) {
  const payload = promptTemplatePayloadFromLocal(local);
  return {
    objectId: payload.id,
    title: payload.title,
    payload,
    updatedAt: payload.updatedAt,
  };
}

function listLocalPromptTemplates(repoRoot) {
  const dir = projectPromptsDir(repoRoot);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.md'))
    .map((entry) => {
      const filePath = path.join(dir, entry.name);
      return {
        id: entry.name.replace(/\.md$/i, ''),
        fileName: entry.name,
        title: entry.name.replace(/\.md$/i, ''),
        content: fs.readFileSync(filePath, 'utf8'),
        updatedAt: fs.statSync(filePath).mtime.toISOString(),
      };
    });
}

function writePromptTemplateObjects(repoRoot, objects, options = {}) {
  const dir = projectPromptsDir(repoRoot);
  const liveObjects = objects.filter((object) => object.deletedAt === null);
  const nextByFileName = new Map();
  for (const object of liveObjects) {
    const payload = normalizePromptTemplate({
      id: object.objectId,
      ...(object.payload || {}),
    });
    if (!payload.fileName) continue;
    nextByFileName.set(payload.fileName, payload);
  }
  const hadExistingDir = fs.existsSync(dir);
  if (!hadExistingDir && nextByFileName.size === 0) {
    return [];
  }
  ensureDir(dir);
  if (options.pruneRemoved !== false) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
      if (!nextByFileName.has(entry.name)) {
        fs.rmSync(path.join(dir, entry.name), { force: true });
      }
    }
  }
  for (const payload of nextByFileName.values()) {
    fs.writeFileSync(path.join(dir, payload.fileName), payload.content, 'utf8');
  }
  return Array.from(nextByFileName.values());
}

function normalizeAppInfo(payload) {
  return {
    id: 'project-app-info',
    title: 'Project App Info',
    content: String(payload.content || ''),
    enabled: payload.enabled !== false,
    updatedAt: String(payload.updatedAt || nowIso()),
  };
}

function appInfoPayloadFromLocal(repoRoot) {
  return normalizeAppInfo({
    content: fs.existsSync(appInfoPath(repoRoot)) ? fs.readFileSync(appInfoPath(repoRoot), 'utf8') : '',
    enabled: loadProjectConfig(repoRoot).appInfoEnabled !== false,
    updatedAt: fs.existsSync(appInfoPath(repoRoot))
      ? fs.statSync(appInfoPath(repoRoot)).mtime.toISOString()
      : nowIso(),
  });
}

function appInfoLegacyObject(repoRoot) {
  const payload = appInfoPayloadFromLocal(repoRoot);
  return {
    objectId: payload.id,
    title: payload.title,
    payload,
    updatedAt: payload.updatedAt,
  };
}

function listLocalAppInfoEntries(repoRoot) {
  const config = loadProjectConfig(repoRoot);
  if (!fs.existsSync(appInfoPath(repoRoot)) && !Object.prototype.hasOwnProperty.call(config, 'appInfoEnabled')) {
    return [];
  }
  return [appInfoPayloadFromLocal(repoRoot)];
}

function writeAppInfoObjects(repoRoot, objects) {
  const filePath = appInfoPath(repoRoot);
  const existingConfig = loadProjectConfig(repoRoot);
  const latest = objects
    .filter((object) => object.deletedAt === null)
    .sort((left, right) => String(right.updatedAt || '').localeCompare(String(left.updatedAt || '')))[0];
  if (!latest && !fs.existsSync(filePath) && !Object.prototype.hasOwnProperty.call(existingConfig, 'appInfoEnabled')) {
    return null;
  }
  const payload = normalizeAppInfo(latest ? latest.payload || {} : {});
  ensureDir(projectQpandaDir(repoRoot));
  fs.writeFileSync(filePath, payload.content, 'utf8');
  saveProjectConfig(repoRoot, { appInfoEnabled: payload.enabled });
  return payload;
}

function normalizeMemory(payload) {
  return {
    id: 'project-memory',
    title: 'Project Memory',
    content: String(payload.content || ''),
    enabled: payload.enabled !== false,
    updatedAt: String(payload.updatedAt || nowIso()),
  };
}

function memoryPayloadFromLocal(repoRoot) {
  return normalizeMemory({
    content: fs.existsSync(memoryPath(repoRoot)) ? fs.readFileSync(memoryPath(repoRoot), 'utf8') : '',
    enabled: loadProjectConfig(repoRoot).memoryEnabled !== false,
    updatedAt: fs.existsSync(memoryPath(repoRoot))
      ? fs.statSync(memoryPath(repoRoot)).mtime.toISOString()
      : nowIso(),
  });
}

function memoryLegacyObject(repoRoot) {
  const payload = memoryPayloadFromLocal(repoRoot);
  return {
    objectId: payload.id,
    title: payload.title,
    payload,
    updatedAt: payload.updatedAt,
  };
}

function listLocalMemoryEntries(repoRoot) {
  const config = loadProjectConfig(repoRoot);
  if (!fs.existsSync(memoryPath(repoRoot)) && !Object.prototype.hasOwnProperty.call(config, 'memoryEnabled')) {
    return [];
  }
  return [memoryPayloadFromLocal(repoRoot)];
}

function writeMemoryObjects(repoRoot, objects) {
  const filePath = memoryPath(repoRoot);
  const existingConfig = loadProjectConfig(repoRoot);
  const latest = objects
    .filter((object) => object.deletedAt === null)
    .sort((left, right) => String(right.updatedAt || '').localeCompare(String(left.updatedAt || '')))[0];
  if (!latest && !fs.existsSync(filePath) && !Object.prototype.hasOwnProperty.call(existingConfig, 'memoryEnabled')) {
    return null;
  }
  const payload = normalizeMemory(latest ? latest.payload || {} : {});
  ensureDir(projectQpandaDir(repoRoot));
  fs.writeFileSync(filePath, payload.content, 'utf8');
  saveProjectConfig(repoRoot, { memoryEnabled: payload.enabled });
  return payload;
}

const PROJECT_SYNC_SETTING_KEYS = ['cloudContextMode', 'cloudContextKey', 'cloudContextLabel'];

function listLocalProjectSettings(repoRoot) {
  const config = loadProjectConfig(repoRoot);
  return PROJECT_SYNC_SETTING_KEYS
    .filter((key) => config[key] !== undefined)
    .map((key) => ({
      id: key,
      key,
      value: config[key],
      updatedAt: fs.existsSync(projectConfigPath(repoRoot))
        ? fs.statSync(projectConfigPath(repoRoot)).mtime.toISOString()
        : nowIso(),
    }));
}

function projectSettingPayloadFromLocal(local) {
  return {
    schemaVersion: 1,
    objectType: 'project_setting',
    id: String(local.id || local.key),
    title: String(local.key || local.id),
    key: String(local.key || local.id),
    value: sanitizeForPersistence(local.value),
    updatedAt: String(local.updatedAt || nowIso()),
  };
}

function projectSettingLegacyObject(local) {
  const payload = projectSettingPayloadFromLocal(local);
  return {
    objectId: payload.id,
    title: payload.title,
    payload,
    updatedAt: payload.updatedAt,
  };
}

function writeProjectSettingObjects(repoRoot, objects) {
  const existing = loadProjectConfig(repoRoot);
  const filePath = projectConfigPath(repoRoot);
  const next = { ...existing };
  for (const key of PROJECT_SYNC_SETTING_KEYS) {
    delete next[key];
  }
  for (const object of objects) {
    if (object.deletedAt !== null) continue;
    const payload = object.payload || {};
    const key = String(payload.key || object.objectId);
    if (!PROJECT_SYNC_SETTING_KEYS.includes(key)) continue;
    next[key] = sanitizeForPersistence(payload.value);
  }
  const hadExistingSyncState = PROJECT_SYNC_SETTING_KEYS.some((key) => Object.prototype.hasOwnProperty.call(existing, key));
  const hasNextSyncState = PROJECT_SYNC_SETTING_KEYS.some((key) => Object.prototype.hasOwnProperty.call(next, key));
  if (!fs.existsSync(filePath) && !hadExistingSyncState && !hasNextSyncState) {
    return next;
  }
  writeJsonFile(filePath, next);
  return next;
}

function createStoreBackedDomain(store, objectType) {
  return {
    importLegacy(objects) {
      store.importLegacyObjects(objectType, objects);
    },
    upsert(objectId, payload, title) {
      return store.queueMutation(objectType, objectId, 'upsert', payload, { title });
    },
    remove(objectId, payload = { title: objectId }) {
      return store.deleteObject(objectType, objectId, payload);
    },
  };
}

function normalizePayloadForDiff(payload) {
  const safe = sanitizeForPersistence(payload);
  if (!safe || typeof safe !== 'object' || Array.isArray(safe)) {
    return safe;
  }
  const clone = { ...safe };
  delete clone.updatedAt;
  return clone;
}

function createDomainAdapter(options) {
  const {
    domain,
    store,
    objectType,
    repoRoot,
    listLocal,
    toLegacy,
    toPayload,
    writeFromStore,
  } = options;

  function listStoreObjects() {
    return store.listObjects(objectType);
  }

  return {
    listLocal,
    listStoreObjects,
    importLocalSnapshot() {
      const objects = listLocal().map((item) => toLegacy(item));
      domain.importLegacy(objects);
      return objects;
    },
    captureLocalState() {
      return Object.fromEntries(
        listLocal().map((item) => {
          const payload = toPayload(item);
          return [String(payload.id), sanitizeForPersistence(payload)];
        })
      );
    },
    queueLocalChanges(previousState = {}) {
      const nextState = this.captureLocalState();
      const changes = { upserts: [], deletes: [] };
      for (const [id, payload] of Object.entries(nextState)) {
        if (JSON.stringify(normalizePayloadForDiff(previousState[id] || null)) === JSON.stringify(normalizePayloadForDiff(payload))) continue;
        domain.upsert(id, payload, payload.title);
        changes.upserts.push(id);
      }
      for (const [id, payload] of Object.entries(previousState || {})) {
        if (Object.prototype.hasOwnProperty.call(nextState, id)) continue;
        domain.remove(id, payload || { title: id });
        changes.deletes.push(id);
      }
      return { changes, state: nextState };
    },
    syncLocalToStore() {
      const localItems = listLocal();
      const localPayloads = localItems.map((item) => toPayload(item));
      const localById = new Map(localPayloads.map((payload) => [String(payload.id), payload]));
      const storeObjects = listStoreObjects().filter((object) => object.deletedAt === null);
      const storeById = new Map(storeObjects.map((object) => [String(object.objectId), object]));
      const changes = { upserts: [], deletes: [] };

      for (const payload of localPayloads) {
        const existing = storeById.get(String(payload.id));
        const normalizedPayload = normalizePayloadForDiff(payload);
        const normalizedExisting = normalizePayloadForDiff(existing ? (existing.payload || {}) : null);
        if (!existing || JSON.stringify(normalizedExisting) !== JSON.stringify(normalizedPayload)) {
          domain.upsert(payload.id, payload, payload.title);
          changes.upserts.push(payload.id);
        }
      }

      for (const object of storeObjects) {
        if (localById.has(String(object.objectId))) continue;
        domain.remove(object.objectId, object.payload || { title: object.title || object.objectId });
        changes.deletes.push(String(object.objectId));
      }

      return changes;
    },
    queueUpsert(localObject) {
      const payload = toPayload(localObject);
      return domain.upsert(payload.id, payload, payload.title);
    },
    queueDelete(objectId, localObject = null) {
      let payload = null;
      if (localObject) {
        try {
          payload = toPayload(localObject);
        } catch {
          payload = null;
        }
      }
      if (!payload) {
        payload = {
        schemaVersion: 1,
        objectType,
        id: String(objectId),
        title: String((localObject && localObject.title) || objectId),
        deletedAt: nowIso(),
        };
      }
      return store.deleteObject(objectType, String(objectId), payload);
    },
    hydrateFromStore(options = {}) {
      return writeFromStore(repoRoot, listStoreObjects(), options);
    },
    listConflicts() {
      return store.listConflicts().filter((conflict) => conflict.objectType === objectType);
    },
    resolveConflict(conflictId) {
      store.resolveConflict(conflictId);
    },
  };
}

async function createRepositorySyncAdapters(boundary, options = {}) {
  const packages = options.packages || await boundary.loadPackages();
  const repoRoot = path.resolve(options.repoRoot || boundary.repoRoot || process.cwd());
  const storeResult = options.store
    ? { store: options.store, dbPath: options.dbPath || boundary.getCloudSyncDbPath() }
    : await boundary.createLocalSyncStore(options.storeOptions || {});
  const repository = await boundary.getRepositoryIdentity(options.identityOptions || {});
  storeResult.store.bindCloudContext({
    repository: repository.identity,
  });

  const syncClient = packages.clientCloud.createRepositorySyncClient({
    store: storeResult.store,
    env: boundary.env,
    ...(options.api ? { api: options.api } : {}),
  });

  const issues = createDomainAdapter({
    domain: syncClient.issues,
    store: storeResult.store,
    objectType: 'issue',
    repoRoot,
    listLocal: () => listLocalIssues(repoRoot),
    toLegacy: issueLegacyObject,
    toPayload: issuePayloadFromLocal,
    writeFromStore: writeIssueObjects,
  });
  const tests = createDomainAdapter({
    domain: syncClient.tests,
    store: storeResult.store,
    objectType: 'test',
    repoRoot,
    listLocal: () => listLocalTests(repoRoot),
    toLegacy: testLegacyObject,
    toPayload: testPayloadFromLocal,
    writeFromStore: writeTestObjects,
  });
  const recipes = createDomainAdapter({
    domain: syncClient.recipes,
    store: storeResult.store,
    objectType: 'recipe',
    repoRoot,
    listLocal: () => listProjectWorkflows(repoRoot),
    toLegacy: recipeLegacyObject,
    toPayload: (workflow) => recipePayloadFromWorkflow(workflow),
    writeFromStore: writeRecipeObjects,
  });
  const workflowProfiles = createDomainAdapter({
    domain: createStoreBackedDomain(storeResult.store, 'workflow_profile'),
    store: storeResult.store,
    objectType: 'workflow_profile',
    repoRoot,
    listLocal: () => listProjectWorkflowProfiles(repoRoot),
    toLegacy: workflowProfileLegacyObject,
    toPayload: workflowProfilePayloadFromLocal,
    writeFromStore: writeWorkflowProfileObjects,
  });
  const agentConfigs = createDomainAdapter({
    domain: createStoreBackedDomain(storeResult.store, 'agent'),
    store: storeResult.store,
    objectType: 'agent',
    repoRoot,
    listLocal: () => listLocalProjectAgents(repoRoot),
    toLegacy: agentLegacyObject,
    toPayload: agentPayloadFromLocal,
    writeFromStore: writeAgentObjects,
  });
  const mcpServers = createDomainAdapter({
    domain: createStoreBackedDomain(storeResult.store, 'mcp_server'),
    store: storeResult.store,
    objectType: 'mcp_server',
    repoRoot,
    listLocal: () => listLocalProjectMcpServers(repoRoot),
    toLegacy: mcpServerLegacyObject,
    toPayload: mcpServerPayloadFromLocal,
    writeFromStore: writeMcpServerObjects,
  });
  const modes = createDomainAdapter({
    domain: createStoreBackedDomain(storeResult.store, 'mode'),
    store: storeResult.store,
    objectType: 'mode',
    repoRoot,
    listLocal: () => listLocalProjectModes(repoRoot),
    toLegacy: modeLegacyObject,
    toPayload: modePayloadFromLocal,
    writeFromStore: writeModeObjects,
  });
  const promptTemplates = createDomainAdapter({
    domain: createStoreBackedDomain(storeResult.store, 'prompt_template'),
    store: storeResult.store,
    objectType: 'prompt_template',
    repoRoot,
    listLocal: () => listLocalPromptTemplates(repoRoot),
    toLegacy: promptTemplateLegacyObject,
    toPayload: promptTemplatePayloadFromLocal,
    writeFromStore: writePromptTemplateObjects,
  });
  const appInfo = createDomainAdapter({
    domain: createStoreBackedDomain(storeResult.store, 'app_info'),
    store: storeResult.store,
    objectType: 'app_info',
    repoRoot,
    listLocal: () => listLocalAppInfoEntries(repoRoot),
    toLegacy: () => appInfoLegacyObject(repoRoot),
    toPayload: () => appInfoPayloadFromLocal(repoRoot),
    writeFromStore: writeAppInfoObjects,
  });
  const memory = createDomainAdapter({
    domain: createStoreBackedDomain(storeResult.store, 'project_memory'),
    store: storeResult.store,
    objectType: 'project_memory',
    repoRoot,
    listLocal: () => listLocalMemoryEntries(repoRoot),
    toLegacy: () => memoryLegacyObject(repoRoot),
    toPayload: () => memoryPayloadFromLocal(repoRoot),
    writeFromStore: writeMemoryObjects,
  });
  const projectSettings = createDomainAdapter({
    domain: createStoreBackedDomain(storeResult.store, 'project_setting'),
    store: storeResult.store,
    objectType: 'project_setting',
    repoRoot,
    listLocal: () => listLocalProjectSettings(repoRoot),
    toLegacy: projectSettingLegacyObject,
    toPayload: projectSettingPayloadFromLocal,
    writeFromStore: writeProjectSettingObjects,
  });
  const runManifests = createDomainAdapter({
    domain: createStoreBackedDomain(storeResult.store, 'run_manifest'),
    store: storeResult.store,
    objectType: 'run_manifest',
    repoRoot,
    listLocal: () => listLocalRunManifestEntries(repoRoot),
    toLegacy: runManifestLegacyObject,
    toPayload: runManifestPayloadFromLocal,
    writeFromStore: writeRunManifestObjects,
  });
  const runTranscripts = createDomainAdapter({
    domain: createStoreBackedDomain(storeResult.store, 'run_transcript'),
    store: storeResult.store,
    objectType: 'run_transcript',
    repoRoot,
    listLocal: () => listLocalRunTranscripts(repoRoot),
    toLegacy: runTranscriptLegacyObject,
    toPayload: runTranscriptPayloadFromLocal,
    writeFromStore: writeRunTranscriptObjects,
  });
  const runChatLogs = createDomainAdapter({
    domain: createStoreBackedDomain(storeResult.store, 'run_chat_log'),
    store: storeResult.store,
    objectType: 'run_chat_log',
    repoRoot,
    listLocal: () => listLocalRunChatLogs(repoRoot),
    toLegacy: runChatLogLegacyObject,
    toPayload: runChatLogPayloadFromLocal,
    writeFromStore: writeRunChatLogObjects,
  });
  const runEvents = createDomainAdapter({
    domain: createStoreBackedDomain(storeResult.store, 'run_event_log'),
    store: storeResult.store,
    objectType: 'run_event_log',
    repoRoot,
    listLocal: () => listLocalRunEvents(repoRoot),
    toLegacy: runEventLegacyObject,
    toPayload: runEventPayloadFromLocal,
    writeFromStore: writeRunEventObjects,
  });
  const runProgress = createDomainAdapter({
    domain: createStoreBackedDomain(storeResult.store, 'run_progress'),
    store: storeResult.store,
    objectType: 'run_progress',
    repoRoot,
    listLocal: () => listLocalRunProgressFiles(repoRoot),
    toLegacy: runProgressLegacyObject,
    toPayload: runProgressPayloadFromLocal,
    writeFromStore: writeRunProgressObjects,
  });

  function importAllLocal() {
    return {
      issues: issues.importLocalSnapshot(),
      tests: tests.importLocalSnapshot(),
      recipes: recipes.importLocalSnapshot(),
      workflowProfiles: workflowProfiles.importLocalSnapshot(),
      agentConfigs: agentConfigs.importLocalSnapshot(),
      mcpServers: mcpServers.importLocalSnapshot(),
      modes: modes.importLocalSnapshot(),
      promptTemplates: promptTemplates.importLocalSnapshot(),
      appInfo: appInfo.importLocalSnapshot(),
      memory: memory.importLocalSnapshot(),
      projectSettings: projectSettings.importLocalSnapshot(),
      runManifests: runManifests.importLocalSnapshot(),
      runTranscripts: runTranscripts.importLocalSnapshot(),
      runChatLogs: runChatLogs.importLocalSnapshot(),
      runEvents: runEvents.importLocalSnapshot(),
      runProgress: runProgress.importLocalSnapshot(),
    };
  }

  function hydrateAllFromStore(options = {}) {
    return {
      issues: issues.hydrateFromStore(options),
      tests: tests.hydrateFromStore(options),
      recipes: recipes.hydrateFromStore(options),
      workflowProfiles: workflowProfiles.hydrateFromStore(options),
      agentConfigs: agentConfigs.hydrateFromStore(options),
      mcpServers: mcpServers.hydrateFromStore(options),
      modes: modes.hydrateFromStore(options),
      promptTemplates: promptTemplates.hydrateFromStore(options),
      appInfo: appInfo.hydrateFromStore(options),
      memory: memory.hydrateFromStore(options),
      projectSettings: projectSettings.hydrateFromStore(options),
      runManifests: runManifests.hydrateFromStore(options),
      runTranscripts: runTranscripts.hydrateFromStore(options),
      runChatLogs: runChatLogs.hydrateFromStore(options),
      runEvents: runEvents.hydrateFromStore(options),
      runProgress: runProgress.hydrateFromStore(options),
    };
  }

  function syncLocalToStore() {
    return {
      issues: issues.syncLocalToStore(),
      tests: tests.syncLocalToStore(),
      recipes: recipes.syncLocalToStore(),
      workflowProfiles: workflowProfiles.syncLocalToStore(),
      agentConfigs: agentConfigs.syncLocalToStore(),
      mcpServers: mcpServers.syncLocalToStore(),
      modes: modes.syncLocalToStore(),
      promptTemplates: promptTemplates.syncLocalToStore(),
      appInfo: appInfo.syncLocalToStore(),
      memory: memory.syncLocalToStore(),
      projectSettings: projectSettings.syncLocalToStore(),
      runManifests: runManifests.syncLocalToStore(),
      runTranscripts: runTranscripts.syncLocalToStore(),
      runChatLogs: runChatLogs.syncLocalToStore(),
      runEvents: runEvents.syncLocalToStore(),
      runProgress: runProgress.syncLocalToStore(),
    };
  }

  function captureLocalState() {
    return {
      issues: issues.captureLocalState(),
      tests: tests.captureLocalState(),
      recipes: recipes.captureLocalState(),
      workflowProfiles: workflowProfiles.captureLocalState(),
      agentConfigs: agentConfigs.captureLocalState(),
      mcpServers: mcpServers.captureLocalState(),
      modes: modes.captureLocalState(),
      promptTemplates: promptTemplates.captureLocalState(),
      appInfo: appInfo.captureLocalState(),
      memory: memory.captureLocalState(),
      projectSettings: projectSettings.captureLocalState(),
      runManifests: runManifests.captureLocalState(),
      runTranscripts: runTranscripts.captureLocalState(),
      runChatLogs: runChatLogs.captureLocalState(),
      runEvents: runEvents.captureLocalState(),
      runProgress: runProgress.captureLocalState(),
    };
  }

  function queueLocalChanges(previousState = {}) {
    const issueResult = issues.queueLocalChanges(previousState.issues || {});
    const testResult = tests.queueLocalChanges(previousState.tests || {});
    const recipeResult = recipes.queueLocalChanges(previousState.recipes || {});
    const workflowProfileResult = workflowProfiles.queueLocalChanges(previousState.workflowProfiles || {});
    const agentResult = agentConfigs.queueLocalChanges(previousState.agentConfigs || {});
    const mcpResult = mcpServers.queueLocalChanges(previousState.mcpServers || {});
    const modeResult = modes.queueLocalChanges(previousState.modes || {});
    const promptResult = promptTemplates.queueLocalChanges(previousState.promptTemplates || {});
    const appInfoResult = appInfo.queueLocalChanges(previousState.appInfo || {});
    const memoryResult = memory.queueLocalChanges(previousState.memory || {});
    const settingsResult = projectSettings.queueLocalChanges(previousState.projectSettings || {});
    const runManifestResult = runManifests.queueLocalChanges(previousState.runManifests || {});
    const runTranscriptResult = runTranscripts.queueLocalChanges(previousState.runTranscripts || {});
    const runChatLogResult = runChatLogs.queueLocalChanges(previousState.runChatLogs || {});
    const runEventResult = runEvents.queueLocalChanges(previousState.runEvents || {});
    const runProgressResult = runProgress.queueLocalChanges(previousState.runProgress || {});
    return {
      changes: {
        issues: issueResult.changes,
        tests: testResult.changes,
        recipes: recipeResult.changes,
        workflowProfiles: workflowProfileResult.changes,
        agentConfigs: agentResult.changes,
        mcpServers: mcpResult.changes,
        modes: modeResult.changes,
        promptTemplates: promptResult.changes,
        appInfo: appInfoResult.changes,
        memory: memoryResult.changes,
        projectSettings: settingsResult.changes,
        runManifests: runManifestResult.changes,
        runTranscripts: runTranscriptResult.changes,
        runChatLogs: runChatLogResult.changes,
        runEvents: runEventResult.changes,
        runProgress: runProgressResult.changes,
      },
      state: {
        issues: issueResult.state,
        tests: testResult.state,
        recipes: recipeResult.state,
        workflowProfiles: workflowProfileResult.state,
        agentConfigs: agentResult.state,
        mcpServers: mcpResult.state,
        modes: modeResult.state,
        promptTemplates: promptResult.state,
        appInfo: appInfoResult.state,
        memory: memoryResult.state,
        projectSettings: settingsResult.state,
        runManifests: runManifestResult.state,
        runTranscripts: runTranscriptResult.state,
        runChatLogs: runChatLogResult.state,
        runEvents: runEventResult.state,
        runProgress: runProgressResult.state,
      },
    };
  }

  function applyRemoteEntries(entries, options = {}) {
    storeResult.store.applyRemoteEntries(entries);
    return hydrateAllFromStore({ pruneRemoved: true, ...options });
  }

  function listConflicts(objectType = null) {
    return storeResult.store.listConflicts().filter((conflict) => !objectType || conflict.objectType === objectType);
  }

  function close() {
    if (typeof storeResult.store.close === 'function') {
      storeResult.store.close();
    }
  }

  return {
    repoRoot,
    dbPath: storeResult.dbPath,
    repository,
    store: storeResult.store,
    syncClient,
    issues,
    tests,
    recipes,
    workflowProfiles,
    agentConfigs,
    mcpServers,
    modes,
    promptTemplates,
    appInfo,
    memory,
    projectSettings,
    runManifests,
    runTranscripts,
    runChatLogs,
    runEvents,
    runProgress,
    importAllLocal,
    captureLocalState,
    queueLocalChanges,
    syncLocalToStore,
    hydrateAllFromStore,
    applyRemoteEntries,
    listConflicts,
    setConflicts(conflicts) {
      const binding = storeResult.store.getBinding();
      storeResult.store.setConflicts(
        ensureArray(conflicts).map((conflict) => normalizeConflictSummary(binding, conflict))
      );
      return listConflicts();
    },
    resolveConflict(conflictId) {
      storeResult.store.resolveConflict(conflictId);
      return listConflicts();
    },
    close,
  };
}

module.exports = {
  createRepositorySyncAdapters,
  listLocalIssues,
  listLocalTests,
  listProjectWorkflows,
  listProjectWorkflowProfiles,
  listLocalRunManifestEntries,
  listLocalRunChatLogs,
  listLocalRunEvents,
  listLocalRunProgressFiles,
  listLocalRunTranscripts,
  issuePayloadFromLocal,
  testPayloadFromLocal,
  recipePayloadFromWorkflow,
  workflowProfilePayloadFromLocal,
  agentPayloadFromLocal,
  mcpServerPayloadFromLocal,
  modePayloadFromLocal,
  promptTemplatePayloadFromLocal,
  runManifestPayloadFromLocal,
  runChatLogPayloadFromLocal,
  runEventPayloadFromLocal,
  runProgressPayloadFromLocal,
  runTranscriptPayloadFromLocal,
  issueFromPayload,
  testFromPayload,
  tasksFilePath,
  testsFilePath,
  projectWorkflowsDir,
  projectAgentsFilePath,
  projectMcpFilePath,
  projectModesFilePath,
  projectPromptsDir,
  projectRunsDir,
  runChatLogFilePath,
  runEventsFilePath,
  runProgressFilePath,
  runTranscriptFilePath,
  PROJECT_SYNC_SETTING_KEYS,
};
