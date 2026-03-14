const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

function globalAgentsPath() {
  return path.join(os.homedir(), '.cc-manager', 'agents.json');
}

function projectAgentsPath(repoRoot) {
  return path.join(repoRoot, '.cc-manager', 'agents.json');
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

/** Load and merge global + project agents. Project overrides global by id. */
function loadMergedAgents(repoRoot) {
  const globalAgents = loadAgentsFile(globalAgentsPath());
  const projectAgents = loadAgentsFile(projectAgentsPath(repoRoot));
  return { global: globalAgents, project: projectAgents };
}

/** Return only enabled agents for runtime use. */
function enabledAgents(agentsData) {
  const result = {};
  const all = { ...agentsData.global, ...agentsData.project };
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
  loadAgentsFile,
  saveAgentsFile,
  loadMergedAgents,
  enabledAgents,
};
