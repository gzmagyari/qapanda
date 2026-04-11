const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function stripElectronRunAsNode(env = process.env) {
  const { ELECTRON_RUN_AS_NODE: _ignored, ...cleanEnv } = env;
  return cleanEnv;
}

function realCodexHome() {
  return path.join(os.homedir(), '.codex');
}

function ensureDirSync(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function removePathSync(targetPath) {
  try {
    fs.rmSync(targetPath, { recursive: true, force: true });
  } catch {}
}

function copyFileIfExistsSync(sourcePath, targetPath) {
  if (!sourcePath || !targetPath) return false;
  if (!fs.existsSync(sourcePath)) return false;
  ensureDirSync(path.dirname(targetPath));
  fs.copyFileSync(sourcePath, targetPath);
  return true;
}

function copyDirIfExistsSync(sourcePath, targetPath) {
  if (!sourcePath || !targetPath) return false;
  if (!fs.existsSync(sourcePath)) return false;
  removePathSync(targetPath);
  ensureDirSync(path.dirname(targetPath));
  fs.cpSync(sourcePath, targetPath, { recursive: true, force: true });
  return true;
}

function listMatchingCodexStateFilesSync(codexHomePath) {
  if (!codexHomePath || !fs.existsSync(codexHomePath)) return [];
  return fs.readdirSync(codexHomePath)
    .filter((name) => /^state_.*\.sqlite(?:-wal)?$/i.test(name))
    .map((name) => path.join(codexHomePath, name));
}

function relativeCodexImportPath(filePath, codexHomePath = realCodexHome()) {
  if (!filePath) return null;
  const resolvedHome = path.resolve(codexHomePath);
  const resolvedFile = path.resolve(filePath);
  const relative = path.relative(resolvedHome, resolvedFile);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    return null;
  }
  return relative;
}

function syncImportedCodexStateSync(targetHomePath, importSource, codexHomePath = realCodexHome()) {
  if (!importSource || importSource.provider !== 'codex') return;

  copyFileIfExistsSync(
    path.join(codexHomePath, 'session_index.jsonl'),
    path.join(targetHomePath, 'session_index.jsonl'),
  );
  copyFileIfExistsSync(
    path.join(codexHomePath, 'version.json'),
    path.join(targetHomePath, 'version.json'),
  );

  for (const sourcePath of listMatchingCodexStateFilesSync(codexHomePath)) {
    copyFileIfExistsSync(sourcePath, path.join(targetHomePath, path.basename(sourcePath)));
  }

  const relativeImportPath = relativeCodexImportPath(importSource.filePath, codexHomePath);
  if (relativeImportPath) {
    copyFileIfExistsSync(
      path.join(codexHomePath, relativeImportPath),
      path.join(targetHomePath, relativeImportPath),
    );
  }
}

function buildIsolatedCodexEnv(manifest, tempHomeName, env = process.env) {
  const cleanEnv = stripElectronRunAsNode(env);
  const tempHomePath = path.join(os.tmpdir(), tempHomeName);
  const codexHomePath = realCodexHome();

  ensureDirSync(tempHomePath);
  copyFileIfExistsSync(path.join(codexHomePath, 'auth.json'), path.join(tempHomePath, 'auth.json'));
  copyFileIfExistsSync(path.join(codexHomePath, 'cap_sid'), path.join(tempHomePath, 'cap_sid'));
  syncImportedCodexStateSync(tempHomePath, manifest && manifest.importSource, codexHomePath);

  cleanEnv.CODEX_HOME = tempHomePath;
  return cleanEnv;
}

module.exports = {
  buildIsolatedCodexEnv,
  listMatchingCodexStateFilesSync,
  relativeCodexImportPath,
  stripElectronRunAsNode,
  syncImportedCodexStateSync,
};
