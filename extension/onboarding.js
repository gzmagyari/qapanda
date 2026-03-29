const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { exec } = require('node:child_process');
const { findChromeBinary } = require('./chrome-manager');

const ONBOARDING_VERSION = 1;

// Minimum supported versions
const MIN_CODEX_VERSION = '0.100.0';
const MIN_CHROME_VERSION = 120;
const MIN_NODE_VERSION = 18;

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

// ── Helpers ──────────────────────────────────────────────────────────

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

/** Parse major.minor.patch from a version string like "codex-cli 0.111.0" or "v22.0.0" */
function _parseVersion(versionStr) {
  if (!versionStr) return null;
  const m = versionStr.match(/(\d+)\.(\d+)\.(\d+)/);
  if (!m) return null;
  return { major: parseInt(m[1], 10), minor: parseInt(m[2], 10), patch: parseInt(m[3], 10), raw: m[0] };
}

/** Compare version against minimum (major.minor.patch string) */
function _versionAtLeast(parsed, minStr) {
  if (!parsed) return false;
  const min = _parseVersion(minStr);
  if (!min) return true;
  if (parsed.major !== min.major) return parsed.major > min.major;
  if (parsed.minor !== min.minor) return parsed.minor > min.minor;
  return parsed.patch >= min.patch;
}

// ── Detection functions ──────────────────────────────────────────────

/** On Windows, npm installs .ps1 wrappers that fail if execution policy is restricted.
 *  Use the .cmd wrapper instead. */
function _cmdName(name) {
  return process.platform === 'win32' ? name + '.cmd' : name;
}

async function detectCli(name) {
  const result = await _execTimeout(`${_cmdName(name)} --version`);
  if (!result.ok) {
    return { available: false, version: null, path: name };
  }
  const version = result.stdout || result.stderr || 'unknown';
  return { available: true, version, path: name };
}

async function detectCodexDetailed() {
  const cli = await detectCli('codex');
  if (!cli.available) {
    return {
      available: false, version: null, parsed: null,
      versionOk: false, loggedIn: false, loginMethod: null,
    };
  }

  // Parse version
  const parsed = _parseVersion(cli.version);
  const versionOk = _versionAtLeast(parsed, MIN_CODEX_VERSION);

  // Check login status
  let loggedIn = false;
  let loginMethod = null;
  try {
    // Check codex login status first, fall back to API key env var
    const authResult = await _execTimeout(_cmdName('codex') + ' login status', 5000);
    const authOutput = authResult.stdout || authResult.stderr || '';
    if (authOutput) {
      const text = authOutput.toLowerCase();
      if (text.includes('logged in')) {
        loggedIn = true;
        const methodMatch = authOutput.match(/using\s+(.+)/i);
        loginMethod = methodMatch ? methodMatch[1].trim() : 'authenticated';
      }
    }
    // If not logged in via CLI, check for API key as fallback
    if (!loggedIn && process.env.OPENAI_API_KEY) {
      loggedIn = true;
      loginMethod = 'API key';
    }
  } catch {}

  return {
    available: true,
    version: cli.version,
    parsed,
    versionOk,
    loggedIn,
    loginMethod,
  };
}

async function detectChromeDetailed() {
  const chromePath = findChromeBinary();
  if (!chromePath) {
    return { available: false, path: null, version: null, major: null, versionOk: false };
  }

  // Get Chrome version
  let version = null;
  let major = null;

  if (process.platform === 'win32') {
    // Windows: use PowerShell to get file version
    const escaped = chromePath.replace(/'/g, "''");
    const result = await _execTimeout(
      `powershell -command "(Get-Item '${escaped}').VersionInfo.FileVersion"`, 5000
    );
    if (result.ok && result.stdout) {
      version = result.stdout.trim();
      const m = version.match(/^(\d+)\./);
      if (m) major = parseInt(m[1], 10);
    }
  } else {
    // macOS/Linux: chrome --version
    const result = await _execTimeout(`"${chromePath}" --version`, 5000);
    const output = result.ok ? result.stdout : '';
    const m = output.match(/(\d+)\.\d+\.\d+/);
    if (m) {
      version = m[0];
      major = parseInt(m[1], 10);
    }
  }

  const versionOk = major !== null && major >= MIN_CHROME_VERSION;

  return { available: true, path: chromePath, version, major, versionOk };
}

async function detectNode() {
  const result = await _execTimeout('node --version', 5000);
  if (!result.ok) {
    return { available: false, version: null, major: null, versionOk: false };
  }
  const version = result.stdout || '';
  const parsed = _parseVersion(version);
  const major = parsed ? parsed.major : null;
  const versionOk = major !== null && major >= MIN_NODE_VERSION;
  return { available: true, version, major, versionOk };
}

async function detectDocker() {
  const versionResult = await _execTimeout('docker --version');
  if (!versionResult.ok) {
    return { available: false, running: false, version: null };
  }
  const version = versionResult.stdout || 'unknown';
  const psResult = await _execTimeout('docker ps', 5000);
  const running = psResult.ok;
  return { available: true, running, version };
}

async function detectQaDesktop() {
  const result = await _execTimeout('qa-desktop ls --json 2>&1');
  if (result.ok) {
    return { available: true, version: 'installed' };
  }
  const which = process.platform === 'win32' ? 'where qa-desktop' : 'which qa-desktop';
  const whichResult = await _execTimeout(which);
  if (whichResult.ok && whichResult.stdout.trim()) {
    return { available: true, version: 'installed' };
  }
  return { available: false, version: null };
}

async function detectChrome() {
  const chromePath = findChromeBinary();
  if (!chromePath) {
    return { available: false, path: null };
  }
  return { available: true, path: chromePath };
}

async function runFullDetection() {
  const { loadFeatureFlags } = require('./src/feature-flags');
  const flags = loadFeatureFlags();

  const checks = [
    detectCli('claude'),
    detectCodexDetailed(),
    detectChromeDetailed(),
    detectNode(),
  ];

  // Only check docker/qa-desktop if remote desktop feature is enabled
  if (flags.enableRemoteDesktop) {
    checks.push(detectDocker());
    checks.push(detectQaDesktop());
  }

  const results = await Promise.all(checks);

  const [claude, codex, chrome, node] = results;
  const docker = flags.enableRemoteDesktop ? results[4] : { available: false, running: false, version: null };
  const qaDesktop = flags.enableRemoteDesktop ? results[5] : { available: false, version: null };

  return {
    platform: process.platform,
    clis: { claude, codex },
    tools: { chrome, node, docker, qaDesktop },
  };
}

// ── Auto-fix ─────────────────────────────────────────────────────

const { spawn } = require('node:child_process');

const AUTO_FIX_COMMANDS = {
  'codex-install': { cmd: 'npm', args: ['install', '-g', '@openai/codex'] },
  'codex-login': { cmd: 'codex', args: ['login'] },
};

/**
 * Run an auto-fix step. Streams output via onProgress, calls onDone when finished.
 * @param {string} step - 'codex-install' | 'codex-login'
 * @param {(text: string) => void} onProgress
 * @param {(success: boolean, error?: string) => void} onDone
 */
function runAutoFix(step, onProgress, onDone) {
  const spec = AUTO_FIX_COMMANDS[step];
  if (!spec) { onDone(false, 'Unknown step: ' + step); return; }

  const cmd = _cmdName(spec.cmd);
  const useShell = process.platform === 'win32';
  const child = spawn(cmd, spec.args, { stdio: ['ignore', 'pipe', 'pipe'], shell: useShell });

  child.stdout.on('data', (data) => onProgress(data.toString()));
  child.stderr.on('data', (data) => onProgress(data.toString()));
  child.on('error', (err) => onDone(false, err.message));
  child.on('close', (code) => {
    if (code === 0) onDone(true);
    else onDone(false, 'Process exited with code ' + code);
  });
}

// ── Agent CLI overrides based on preference ───────────────────────

const { loadAgentsFile, saveAgentsFile, systemAgentsOverridePath } = require('./agents-store');

function applyCliPreference(preference, bundledAgents) {
  if (preference === 'both') {
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
      if (!existing[id]) existing[id] = {};
      existing[id].cli = targetCli;
      existing[id]._onboardingCli = true;
    } else if (existing[id] && existing[id]._onboardingCli) {
      delete existing[id].cli;
      delete existing[id]._onboardingCli;
      if (Object.keys(existing[id]).length === 0) delete existing[id];
    }
  }

  saveAgentsFile(systemAgentsOverridePath(), existing);
}

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

function completeOnboarding({ preference, detected, bundledAgents }) {
  applyCliPreference(preference, bundledAgents);

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
  detectCodexDetailed,
  detectChromeDetailed,
  detectNode,
  runFullDetection,
  applyCliPreference,
  getCliDefaults,
  completeOnboarding,
  runAutoFix,
};
