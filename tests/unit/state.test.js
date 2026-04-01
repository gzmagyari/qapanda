const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { saveManifest } = require('../../src/state');

describe('saveManifest', () => {
  it('scrubs API keys before writing manifest.json', async () => {
    const runDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qp-state-test-'));
    const manifestPath = path.join(runDir, 'manifest.json');
    const manifest = {
      runDir,
      files: { manifest: manifestPath },
      controller: {
        cli: 'api',
        apiConfig: { provider: 'openai', apiKey: 'controller-secret', model: 'gpt-4.1' },
        config: [],
      },
      worker: {
        cli: 'api',
        apiConfig: { provider: 'openai', apiKey: 'worker-secret', model: 'gpt-4.1-mini' },
      },
      apiConfig: { provider: 'openai', apiKey: 'shared-secret', baseURL: 'http://localhost:9999/v1' },
    };

    try {
      await saveManifest(manifest);
      const saved = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      assert.equal(saved.apiConfig.apiKey, undefined);
      assert.equal(saved.controller.apiConfig.apiKey, undefined);
      assert.equal(saved.worker.apiConfig.apiKey, undefined);
      assert.equal(saved.apiConfig.provider, 'openai');
      assert.equal(saved.worker.apiConfig.model, 'gpt-4.1-mini');
    } finally {
      fs.rmSync(runDir, { recursive: true, force: true });
    }
  });
});
