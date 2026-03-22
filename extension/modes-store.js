const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

function globalModesPath() {
  return path.join(os.homedir(), '.cc-manager', 'modes.json');
}

function projectModesPath(repoRoot) {
  return path.join(repoRoot, '.cc-manager', 'modes.json');
}

function systemModesOverridePath() {
  return path.join(os.homedir(), '.cc-manager', 'system-modes.json');
}

function loadModesFile(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return {};
  }
}

function saveModesFile(filePath, data) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
}

/**
 * Load bundled system modes from the extension's resources directory,
 * merged with user overrides from ~/.cc-manager/system-modes.json.
 */
function loadSystemModes(extensionDir) {
  const bundledPath = path.join(extensionDir, 'resources', 'system-modes.json');
  const bundled = loadModesFile(bundledPath);
  const userOverrides = loadModesFile(systemModesOverridePath());

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

/** Load and merge system + global + project modes. */
function loadMergedModes(repoRoot, extensionDir) {
  const globalModes = loadModesFile(globalModesPath());
  const projectModes = loadModesFile(projectModesPath(repoRoot));

  let systemModes = {};
  let systemMeta = {};
  if (extensionDir) {
    const result = loadSystemModes(extensionDir);
    systemModes = result.modes;
    systemMeta = result.meta;
  }

  return { system: systemModes, systemMeta, global: globalModes, project: projectModes };
}

/** Return only enabled modes for runtime use. System < global < project. */
function enabledModes(modesData) {
  const result = {};
  const all = { ...(modesData.system || {}), ...(modesData.global || {}), ...(modesData.project || {}) };
  for (const [id, mode] of Object.entries(all)) {
    if (mode && mode.enabled !== false) {
      result[id] = mode;
    }
  }
  return result;
}

module.exports = {
  globalModesPath,
  projectModesPath,
  systemModesOverridePath,
  loadModesFile,
  saveModesFile,
  loadSystemModes,
  loadMergedModes,
  enabledModes,
};
