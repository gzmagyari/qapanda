const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

function globalAgentsPath() {
  return path.join(os.homedir(), '.cc-manager', 'agents.json');
}

function projectAgentsPath(repoRoot) {
  return path.join(repoRoot, '.cc-manager', 'agents.json');
}

function systemAgentsOverridePath() {
  return path.join(os.homedir(), '.cc-manager', 'system-agents.json');
}

function loadAgentsFile(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return {};
  }
}

function saveAgentsFile(filePath, data) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
}

/**
 * Load bundled system agents from the extension's resources directory,
 * merged with user overrides from ~/.cc-manager/system-agents.json.
 *
 * Returns:
 *   agents: { [id]: agentObj }  — removed agents excluded
 *   meta:   { [id]: { hasUserOverride: bool } }
 */
function loadSystemAgents(extensionDir) {
  const bundledPath = path.join(extensionDir, 'resources', 'system-agents.json');
  const bundled = loadAgentsFile(bundledPath);
  const userOverrides = loadAgentsFile(systemAgentsOverridePath());

  const agents = {};
  const meta = {};

  for (const [id, base] of Object.entries(bundled)) {
    const override = userOverrides[id];
    if (override && override.removed) {
      // User deleted this agent — track as removable/restorable but exclude from agents
      meta[id] = { hasUserOverride: true, removed: true, bundled: base };
      continue;
    }
    agents[id] = override ? { ...base, ...override } : { ...base };
    meta[id] = { hasUserOverride: Boolean(override), removed: false, bundled: base };
  }

  return { agents, meta };
}

/** Load and merge system + global + project agents. */
function loadMergedAgents(repoRoot, extensionDir) {
  const globalAgents = loadAgentsFile(globalAgentsPath());
  const projectAgents = loadAgentsFile(projectAgentsPath(repoRoot));

  let systemAgents = {};
  let systemMeta = {};
  if (extensionDir) {
    const result = loadSystemAgents(extensionDir);
    systemAgents = result.agents;
    systemMeta = result.meta;
  }

  return { system: systemAgents, systemMeta, global: globalAgents, project: projectAgents };
}

/** Return only enabled agents for runtime use. System < global < project. */
function enabledAgents(agentsData) {
  const result = {};
  const all = { ...(agentsData.system || {}), ...(agentsData.global || {}), ...(agentsData.project || {}) };
  for (const [id, agent] of Object.entries(all)) {
    if (agent && agent.enabled !== false) {
      result[id] = agent;
    }
  }
  return result;
}

module.exports = {
  globalAgentsPath,
  projectAgentsPath,
  systemAgentsOverridePath,
  loadAgentsFile,
  saveAgentsFile,
  loadSystemAgents,
  loadMergedAgents,
  enabledAgents,
};
