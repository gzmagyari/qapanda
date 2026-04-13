/**
 * Unified config loading — shared by CLI and extension.
 *
 * Loads and merges agents, modes, MCP servers from:
 *   - Bundled system resources (resources/system-agents.json, system-modes.json)
 *   - Global user config (~/.qpanda/)
 *   - Project config (.qpanda/)
 *   - Onboarding preferences (~/.qpanda/onboarding.json)
 */
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

// ── File I/O ─────────────────────────────────────────────────────

function readJsonFile(filePath) {
  try { return JSON.parse(fs.readFileSync(filePath, 'utf8')); }
  catch { return {}; }
}

function writeJsonFile(filePath, data) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
}

// ── Path helpers ─────────────────────────────────────────────────

function globalDir() { return path.join(os.homedir(), '.qpanda'); }
function globalAgentsPath() { return path.join(globalDir(), 'agents.json'); }
function globalModesPath() { return path.join(globalDir(), 'modes.json'); }
function globalMcpPath() { return path.join(globalDir(), 'mcp.json'); }
function systemAgentsOverridePath() { return path.join(globalDir(), 'system-agents.json'); }
function systemModesOverridePath() { return path.join(globalDir(), 'system-modes.json'); }
function onboardingPath() { return path.join(globalDir(), 'onboarding.json'); }

function projectAgentsPath(repoRoot) { return path.join(repoRoot, '.qpanda', 'agents.json'); }
function projectModesPath(repoRoot) { return path.join(repoRoot, '.qpanda', 'modes.json'); }
function projectMcpPath(repoRoot) { return path.join(repoRoot, '.qpanda', 'mcp.json'); }

function attachMcpConfigMetadata(configMap, configDir, scope) {
  const result = {};
  for (const [name, value] of Object.entries(configMap || {})) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      result[name] = value;
      continue;
    }
    result[name] = {
      ...value,
      __configDir: configDir,
      __configScope: scope,
    };
  }
  return result;
}

/**
 * Find the resources directory containing system-agents.json and system-modes.json.
 * Checks: provided path, project root/resources/, __dirname/../resources/
 */
function findResourcesDir(hint) {
  const candidates = [
    hint,
    path.resolve(__dirname, '..', 'resources'),
    path.resolve(__dirname, '..', 'extension', 'resources'),
  ].filter(Boolean);
  for (const dir of candidates) {
    if (fs.existsSync(path.join(dir, 'system-agents.json'))) return dir;
  }
  return null;
}

// ── System agents ────────────────────────────────────────────────

function loadSystemAgents(resourcesDir, repoRoot) {
  if (!resourcesDir) return { agents: {}, meta: {} };
  const bundledPath = path.join(resourcesDir, 'system-agents.json');
  const bundled = readJsonFile(bundledPath);
  const userOverrides = readJsonFile(systemAgentsOverridePath());
  const { loadFeatureFlags } = require('./feature-flags');
  const flags = loadFeatureFlags(null, repoRoot);

  const agents = {};
  const meta = {};
  for (const [id, base] of Object.entries(bundled)) {
    // Skip agents gated by a disabled feature flag
    if (base.featureFlag && !flags[base.featureFlag]) continue;
    const override = userOverrides[id];
    if (override && override.removed) {
      meta[id] = { hasUserOverride: true, removed: true, bundled: base };
      continue;
    }
    agents[id] = override ? { ...base, ...override } : { ...base };
    meta[id] = { hasUserOverride: Boolean(override), removed: false, bundled: base };
  }
  return { agents, meta };
}

function loadMergedAgents(repoRoot, resourcesDir) {
  const globalAgents = readJsonFile(globalAgentsPath());
  const projectAgents = readJsonFile(projectAgentsPath(repoRoot));
  const { agents: systemAgents, meta: systemMeta } = loadSystemAgents(resourcesDir, repoRoot);
  return { system: systemAgents, systemMeta, global: globalAgents, project: projectAgents };
}

// ── System modes ─────────────────────────────────────────────────

function loadSystemModes(resourcesDir) {
  if (!resourcesDir) return { modes: {}, meta: {} };
  const bundledPath = path.join(resourcesDir, 'system-modes.json');
  const bundled = readJsonFile(bundledPath);
  const userOverrides = readJsonFile(systemModesOverridePath());

  const modes = {};
  const meta = {};
  for (const [id, base] of Object.entries(bundled)) {
    const override = userOverrides[id];
    if (override && override.removed) {
      meta[id] = { hasUserOverride: true, removed: true, bundled: base };
      continue;
    }
    modes[id] = override ? { ...base, ...override } : { ...base };
    meta[id] = { hasUserOverride: Boolean(override), removed: false, bundled: base };
  }
  return { modes, meta };
}

function loadMergedModes(repoRoot, resourcesDir) {
  const globalModes = readJsonFile(globalModesPath());
  const projectModes = readJsonFile(projectModesPath(repoRoot));
  const { modes: systemModes, meta: systemMeta } = loadSystemModes(resourcesDir);
  return { system: systemModes, systemMeta, global: globalModes, project: projectModes };
}

// ── MCP servers ──────────────────────────────────────────────────

function loadMergedMcpServers(repoRoot) {
  const globalPath = globalMcpPath();
  const projectPath = projectMcpPath(repoRoot);
  const globalMcp = attachMcpConfigMetadata(readJsonFile(globalPath), path.dirname(globalPath), 'global');
  const projectMcp = attachMcpConfigMetadata(readJsonFile(projectPath), path.dirname(projectPath), 'project');
  return { global: globalMcp, project: projectMcp };
}

// ── Enabled filtering ────────────────────────────────────────────

function enabledAgents(agentsData) {
  const all = { ...(agentsData.system || {}), ...(agentsData.global || {}), ...(agentsData.project || {}) };
  const result = {};
  for (const [id, agent] of Object.entries(all)) {
    if (agent && agent.enabled !== false) result[id] = agent;
  }
  return result;
}

function enabledModes(modesData) {
  const all = { ...(modesData.system || {}), ...(modesData.global || {}), ...(modesData.project || {}) };
  const result = {};
  for (const [id, mode] of Object.entries(all)) {
    if (mode && mode.enabled !== false) result[id] = mode;
  }
  return result;
}

// ── Onboarding ───────────────────────────────────────────────────

function loadOnboarding() {
  return readJsonFile(onboardingPath()) || null;
}

function isOnboardingComplete() {
  const data = loadOnboarding();
  return data && data.version === 1 && !!data.completedAt;
}

function getCliDefaults() {
  const data = loadOnboarding();
  if (data && data.defaults) return data.defaults;
  return { controllerCli: 'codex', workerCli: 'codex' };
}

// ── Env-aware field resolution ───────────────────────────────────

function resolveByEnv(val, env) {
  if (val && typeof val === 'object' && !Array.isArray(val)) {
    return val[env] || val['browser'] || Object.values(val)[0];
  }
  return val;
}

module.exports = {
  readJsonFile,
  writeJsonFile,
  findResourcesDir,
  // Paths
  globalDir,
  globalAgentsPath,
  globalModesPath,
  globalMcpPath,
  systemAgentsOverridePath,
  systemModesOverridePath,
  onboardingPath,
  projectAgentsPath,
  projectModesPath,
  projectMcpPath,
  // Loaders
  loadSystemAgents,
  loadMergedAgents,
  loadSystemModes,
  loadMergedModes,
  loadMergedMcpServers,
  loadOnboarding,
  isOnboardingComplete,
  getCliDefaults,
  // Filters
  enabledAgents,
  enabledModes,
  resolveByEnv,
};
