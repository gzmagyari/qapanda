const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function candidateLogPaths(options = {}) {
  const paths = new Set();
  const repoRoot = options.repoRoot ? path.resolve(options.repoRoot) : null;
  const stateRoot = options.stateRoot ? path.resolve(options.stateRoot) : null;
  if (repoRoot) {
    paths.add(path.join(repoRoot, '.qpanda', 'wizard-debug.log'));
  }
  if (stateRoot) {
    paths.add(path.join(stateRoot, 'wizard-debug.log'));
  }
  paths.add(path.join(os.homedir(), '.qpanda', 'wizard-debug.log'));
  return Array.from(paths);
}

function summarizeForDebug(value, maxLength = 1200) {
  if (value == null) return '';
  let text;
  if (typeof value === 'string') {
    text = value;
  } else {
    try {
      text = JSON.stringify(value);
    } catch {
      text = String(value);
    }
  }
  const normalized = String(text).replace(/\s+/g, ' ').trim();
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, maxLength - 3)}...`;
}

function appendWizardDebug(tag, message, options = {}) {
  const line = `[${new Date().toISOString()}] [${tag}] ${message}\n`;
  for (const logPath of candidateLogPaths(options)) {
    try {
      fs.mkdirSync(path.dirname(logPath), { recursive: true });
      fs.appendFileSync(logPath, line);
    } catch {}
  }
}

function appendManifestDebug(tag, manifest, message, extra = null) {
  appendWizardDebug(tag, extra == null
    ? message
    : `${message} ${summarizeForDebug(extra)}`, {
    repoRoot: manifest && manifest.repoRoot ? manifest.repoRoot : null,
  });
}

module.exports = {
  appendManifestDebug,
  appendWizardDebug,
  summarizeForDebug,
};
