/**
 * Feature flags — loaded from resources/feature-flags.json.
 * Shipped with the extension and CLI; not user-editable.
 */
const fs = require('node:fs');
const path = require('node:path');

const DEFAULTS = {
  enableRemoteDesktop: false,
  enableClaudeCli: false,
};

let _cached = null;

function loadFeatureFlags(extensionOrPackageRoot) {
  if (_cached) return _cached;
  const candidates = [
    extensionOrPackageRoot ? path.join(extensionOrPackageRoot, 'resources', 'feature-flags.json') : null,
    path.resolve(__dirname, '..', 'resources', 'feature-flags.json'),
    path.resolve(__dirname, '..', 'extension', 'resources', 'feature-flags.json'),
  ].filter(Boolean);
  for (const fp of candidates) {
    try {
      const data = JSON.parse(fs.readFileSync(fp, 'utf8'));
      _cached = { ...DEFAULTS, ...data };
      return _cached;
    } catch {}
  }
  _cached = { ...DEFAULTS };
  return _cached;
}

function getFlag(name, extensionRoot) {
  return loadFeatureFlags(extensionRoot)[name];
}

// Reset cache (for testing)
function _resetCache() { _cached = null; }
function _setForTest(overrides) { _cached = { ...DEFAULTS, ...overrides }; }

module.exports = { loadFeatureFlags, getFlag, DEFAULTS, _resetCache, _setForTest };
