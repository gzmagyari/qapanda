const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const manifest = require(path.resolve(__dirname, '..', 'extension', 'package.json'));

test('extension manifest includes onWebviewPanel activation event for panel restore', () => {
  assert.ok(
    Array.isArray(manifest.activationEvents),
    'activationEvents should be an array'
  );
  assert.ok(
    manifest.activationEvents.includes('onWebviewPanel:qapandaPanel'),
    'activationEvents must include onWebviewPanel:qapandaPanel for reload-restore'
  );
});
