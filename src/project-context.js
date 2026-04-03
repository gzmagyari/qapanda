const fs = require('node:fs');
const path = require('node:path');

function projectStateDir(repoRoot) {
  return path.join(repoRoot, '.qpanda');
}

function projectConfigPath(repoRoot) {
  return path.join(projectStateDir(repoRoot), 'config.json');
}

function appInfoPath(repoRoot) {
  return path.join(projectStateDir(repoRoot), 'APPINFO.md');
}

function memoryPath(repoRoot) {
  return path.join(projectStateDir(repoRoot), 'MEMORY.md');
}

function ensureProjectStateDir(repoRoot) {
  fs.mkdirSync(projectStateDir(repoRoot), { recursive: true });
}

function loadProjectConfig(repoRoot) {
  try {
    return JSON.parse(fs.readFileSync(projectConfigPath(repoRoot), 'utf8'));
  } catch {
    return {};
  }
}

function saveProjectConfig(repoRoot, updates) {
  ensureProjectStateDir(repoRoot);
  const next = { ...loadProjectConfig(repoRoot), ...(updates || {}) };
  fs.writeFileSync(projectConfigPath(repoRoot), JSON.stringify(next, null, 2), 'utf8');
  return next;
}

function readProjectTextFile(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return '';
  }
}

function writeProjectTextFile(repoRoot, filePath, content) {
  ensureProjectStateDir(repoRoot);
  fs.writeFileSync(filePath, String(content || ''), 'utf8');
}

function loadAppInfo(repoRoot) {
  return readProjectTextFile(appInfoPath(repoRoot));
}

function saveAppInfo(repoRoot, content) {
  writeProjectTextFile(repoRoot, appInfoPath(repoRoot), content);
  return loadAppInfo(repoRoot);
}

function loadMemory(repoRoot) {
  return readProjectTextFile(memoryPath(repoRoot));
}

function saveMemory(repoRoot, content) {
  writeProjectTextFile(repoRoot, memoryPath(repoRoot), content);
  return loadMemory(repoRoot);
}

function isAppInfoEnabled(repoRoot) {
  return loadProjectConfig(repoRoot).appInfoEnabled !== false;
}

function isMemoryEnabled(repoRoot) {
  return loadProjectConfig(repoRoot).memoryEnabled !== false;
}

module.exports = {
  appInfoPath,
  ensureProjectStateDir,
  isAppInfoEnabled,
  isMemoryEnabled,
  loadAppInfo,
  loadMemory,
  loadProjectConfig,
  memoryPath,
  projectConfigPath,
  projectStateDir,
  saveAppInfo,
  saveMemory,
  saveProjectConfig,
};
