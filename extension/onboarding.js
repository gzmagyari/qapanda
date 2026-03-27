const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { exec } = require('node:child_process');
const { findChromeBinary } = require('./chrome-manager');

const ONBOARDING_VERSION = 1;

function onboardingPath() {
  return path.join(os.homedir(), '.qpanda', 'onboarding.json');
}

function loadOnboarding() {
  try {
    return JSON.parse(fs.readFileSync(onboardingPath(), 'utf8'));
  } catch {
    return null;
  }
}

function saveOnboarding(data) {
  const filePath = onboardingPath();
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
}

function isOnboardingComplete() {
  const data = loadOnboarding();
  return data && data.version === ONBOARDING_VERSION && !!data.completedAt;
}

// ── CLI detection ─────────────────────────────────────────────────

function _execTimeout(cmd, timeoutMs = 10000) {
  return new Promise((resolve) => {
    exec(cmd, { timeout: timeoutMs }, (err, stdout, stderr) => {
      if (err) {
        resolve({ ok: false, stdout: '', stderr: '', code: err.code });
      } else {
        resolve({ ok: true, stdout: (stdout || '').trim(), stderr: (stderr || '').trim(), code: 0 });
      }
    });
  });
}

async function detectCli(name) {
  const result = await _execTimeout(`${name} --version`);
  if (!result.ok) {
    return { available: false, version: null, path: name };
  }
  const version = result.stdout || result.stderr || 'unknown';
  return { available: true, version, path: name };
}

async function detectChrome() {
  const chromePath = findChromeBinary();
  if (!chromePath) {
    return { available: false, path: null };
  }
  return { available: true, path: chromePath };
}

async function detectDocker() {
  // Check if docker binary exists
  const versionResult = await _execTimeout('docker --version');
  if (!versionResult.ok) {
    return { available: false, running: false, version: null };
  }
  const version = versionResult.stdout || 'unknown';

  // Check if Docker daemon is running
  const psResult = await _execTimeout('docker ps', 5000);
  const running = psResult.ok;

  return { available: true, running, version };
}

async function detectQaDesktop() {
  // qa-desktop doesn't support --version; just check if it's on PATH with --help or ls
  const result = await _execTimeout('qa-desktop ls --json 2>&1');
  if (result.ok) {
    return { available: true, version: 'installed' };
  }
  // Fallback: check if binary exists via where/which
  const which = process.platform === 'win32' ? 'where qa-desktop' : 'which qa-desktop';
  const whichResult = await _execTimeout(which);
  if (whichResult.ok && whichResult.stdout.trim()) {
    return { available: true, version: 'installed' };
  }
  return { available: false, version: null };
}

async function runFullDetection() {
  const [claude, codex, chrome, docker] = await Promise.all([
    detectCli('claude'),
    detectCli('codex'),
    detectChrome(),
    detectDocker(),
  ]);

  // qa-desktop is bundled in the extension — always available
  const qaDesktop = { available: true, version: 'bundled' };

  return {
    clis: { claude, codex },
    tools: { chrome, docker, qaDesktop },
  };
}

// ── Agent CLI overrides based on preference ───────────────────────

const { loadAgentsFile, saveAgentsFile, systemAgentsOverridePath } = require('./agents-store');

/**
 * Write system-agents.json overrides based on CLI preference.
 * This modifies ~/.qpanda/system-agents.json (same file the Agents tab uses).
 *
 * @param {'both'|'claude-only'|'codex-only'} preference
 * @param {Object} bundledAgents - The original bundled system agents
 */
function applyCliPreference(preference, bundledAgents) {
  if (preference === 'both') {
    // No overrides needed — bundled defaults use both CLIs optimally
    // But remove any previous onboarding overrides for CLI fields
    const existing = loadAgentsFile(systemAgentsOverridePath());
    let changed = false;
    for (const [id, override] of Object.entries(existing)) {
      if (override && override._onboardingCli) {
        delete existing[id];
        changed = true;
      }
    }
    if (changed) saveAgentsFile(systemAgentsOverridePath(), existing);
    return;
  }

  const existing = loadAgentsFile(systemAgentsOverridePath());

  for (const [id, agent] of Object.entries(bundledAgents)) {
    const currentCli = (existing[id] && existing[id].cli) || agent.cli;

    let targetCli = currentCli;
    if (preference === 'claude-only') {
      if (currentCli === 'codex') targetCli = 'claude';
      if (currentCli === 'qa-remote-codex') targetCli = 'qa-remote-claude';
    } else if (preference === 'codex-only') {
      if (currentCli === 'claude') targetCli = 'codex';
      if (currentCli === 'qa-remote-claude') targetCli = 'qa-remote-codex';
    }

    if (targetCli !== agent.cli) {
      // Need an override
      if (!existing[id]) existing[id] = {};
      existing[id].cli = targetCli;
      existing[id]._onboardingCli = true; // Mark as onboarding-generated
    } else if (existing[id] && existing[id]._onboardingCli) {
      // Remove previous onboarding override if no longer needed
      delete existing[id].cli;
      delete existing[id]._onboardingCli;
      if (Object.keys(existing[id]).length === 0) delete existing[id];
    }
  }

  saveAgentsFile(systemAgentsOverridePath(), existing);
}

/**
 * Get the recommended controller and worker CLI defaults based on preference.
 */
function getCliDefaults(preference) {
  switch (preference) {
    case 'claude-only':
      return { controllerCli: 'claude', workerCli: 'claude' };
    case 'codex-only':
      return { controllerCli: 'codex', workerCli: 'codex' };
    case 'both':
    default:
      return { controllerCli: 'codex', workerCli: 'claude' };
  }
}

/**
 * Complete the onboarding: save detection results, apply preference, write onboarding.json.
 */
function completeOnboarding({ preference, detected, bundledAgents }) {
  // Apply CLI overrides to system agents
  applyCliPreference(preference, bundledAgents);

  // Save onboarding state
  const defaults = getCliDefaults(preference);
  const data = {
    version: ONBOARDING_VERSION,
    completedAt: new Date().toISOString(),
    cliPreference: preference,
    detectedClis: detected.clis,
    detectedTools: detected.tools,
    defaults,
  };
  saveOnboarding(data);
  return data;
}

module.exports = {
  ONBOARDING_VERSION,
  onboardingPath,
  loadOnboarding,
  saveOnboarding,
  isOnboardingComplete,
  detectCli,
  detectChrome,
  detectDocker,
  detectQaDesktop,
  runFullDetection,
  applyCliPreference,
  getCliDefaults,
  completeOnboarding,
};
