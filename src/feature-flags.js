/**
 * Feature flags loaded from bundled resources with optional local-only
 * overrides from ~/.qpanda/secret-features.json and
 * <repo>/.qpanda/secret-features.json.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const DEFAULTS = {
  enableRemoteDesktop: false,
  enableClaudeCli: false,
  enablePersonalWorkspaces: false,
};

let _cached = new Map();
let _testOverride = null;

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function normalizeArgs(extensionOrPackageRoot, repoRoot) {
  if (extensionOrPackageRoot && typeof extensionOrPackageRoot === 'object' && !Array.isArray(extensionOrPackageRoot)) {
    return {
      extensionRoot: extensionOrPackageRoot.extensionRoot || extensionOrPackageRoot.extensionOrPackageRoot || null,
      repoRoot: extensionOrPackageRoot.repoRoot || null,
    };
  }
  return {
    extensionRoot: extensionOrPackageRoot || null,
    repoRoot: repoRoot || null,
  };
}

function mergeKnownFlags(base, overrides) {
  if (!overrides || typeof overrides !== 'object' || Array.isArray(overrides)) return base;
  const next = { ...base };
  for (const [key, value] of Object.entries(overrides)) {
    if (!(key in DEFAULTS)) continue;
    if (typeof value !== 'boolean') continue;
    next[key] = value;
  }
  return next;
}

function loadFeatureFlags(extensionOrPackageRoot, repoRoot) {
  if (_testOverride) return _testOverride;

  const options = normalizeArgs(extensionOrPackageRoot, repoRoot);
  const cacheKey = JSON.stringify({
    extensionRoot: options.extensionRoot ? path.resolve(options.extensionRoot) : '',
    repoRoot: options.repoRoot ? path.resolve(options.repoRoot) : '',
  });
  if (_cached.has(cacheKey)) return _cached.get(cacheKey);

  let resolved = { ...DEFAULTS };
  const candidates = [
    options.extensionRoot ? path.join(options.extensionRoot, 'resources', 'feature-flags.json') : null,
    path.resolve(__dirname, '..', 'resources', 'feature-flags.json'),
    path.resolve(__dirname, '..', 'extension', 'resources', 'feature-flags.json'),
  ].filter(Boolean);

  for (const fp of candidates) {
    const data = readJson(fp);
    if (!data) continue;
    resolved = mergeKnownFlags(resolved, data);
    break;
  }

  resolved = mergeKnownFlags(resolved, readJson(path.join(os.homedir(), '.qpanda', 'secret-features.json')));
  if (options.repoRoot) {
    resolved = mergeKnownFlags(resolved, readJson(path.join(options.repoRoot, '.qpanda', 'secret-features.json')));
  }

  _cached.set(cacheKey, resolved);
  return resolved;
}

function getFlag(name, extensionRoot, repoRoot) {
  return loadFeatureFlags(extensionRoot, repoRoot)[name];
}

function _resetCache() {
  _cached = new Map();
  _testOverride = null;
}

function _setForTest(overrides) {
  _cached = new Map();
  _testOverride = { ...DEFAULTS, ...overrides };
}

module.exports = { loadFeatureFlags, getFlag, DEFAULTS, _resetCache, _setForTest };
