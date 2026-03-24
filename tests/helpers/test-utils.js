const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');

/**
 * Create a temporary directory with a .cc-manager structure for testing.
 * @returns {{ root: string, ccDir: string, cleanup: () => void }}
 */
function createTempDir() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-test-'));
  const ccDir = path.join(root, '.cc-manager');
  fs.mkdirSync(ccDir, { recursive: true });
  return {
    root,
    ccDir,
    cleanup() {
      try { fs.rmSync(root, { recursive: true, force: true }); } catch {}
    },
  };
}

/**
 * Create a mock renderer that captures method calls.
 */
function mockRenderer() {
  const calls = [];
  const handler = {
    get(target, prop) {
      if (prop === '_calls') return calls;
      if (prop === '_callsFor') return (name) => calls.filter(c => c.method === name);
      return (...args) => { calls.push({ method: prop, args }); };
    },
  };
  return new Proxy({}, handler);
}

/**
 * Create a mock postMessage function that captures messages.
 */
function mockPostMessage() {
  const messages = [];
  const fn = (msg) => { messages.push(msg); };
  fn.messages = messages;
  fn.messagesOfType = (type) => messages.filter(m => m.type === type);
  return fn;
}

/**
 * Poll a condition function until it returns true or timeout.
 * @param {() => boolean} conditionFn
 * @param {number} timeoutMs
 * @param {number} intervalMs
 * @returns {Promise<void>}
 */
async function waitFor(conditionFn, timeoutMs = 5000, intervalMs = 100) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (conditionFn()) return;
    await new Promise(r => setTimeout(r, intervalMs));
  }
  throw new Error(`waitFor timed out after ${timeoutMs}ms`);
}

/**
 * Write a JSON file to a path, creating parent dirs.
 */
function writeJson(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
}

/**
 * Read a JSON file, returning null if not found.
 */
function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch {
    return null;
  }
}

/**
 * Generate a random ID for test isolation.
 */
function randomId() {
  return crypto.randomBytes(4).toString('hex');
}

module.exports = {
  createTempDir,
  mockRenderer,
  mockPostMessage,
  waitFor,
  writeJson,
  readJson,
  randomId,
};
