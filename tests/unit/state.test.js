const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { listRunManifests, saveManifest } = require('../../src/state');

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

describe('listRunManifests', () => {
  it('skips corrupt manifests instead of failing the whole run list', async () => {
    const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'qp-state-root-'));
    const runsRoot = path.join(stateRoot, 'runs');
    const goodRunDir = path.join(runsRoot, 'good-run');
    const badRunDir = path.join(runsRoot, 'bad-run');

    fs.mkdirSync(goodRunDir, { recursive: true });
    fs.mkdirSync(badRunDir, { recursive: true });
    fs.writeFileSync(
      path.join(goodRunDir, 'manifest.json'),
      `${JSON.stringify({ runId: 'good-run', updatedAt: '2026-04-11T10:00:00.000Z', status: 'idle' }, null, 2)}\n`,
      'utf8',
    );
    fs.writeFileSync(
      path.join(badRunDir, 'manifest.json'),
      '{"runId":"bad-run","updatedAt":"2026-04-11T09:00:00.000Z","status":"idle","broken":"line1\nline2"}',
      'utf8',
    );

    try {
      const manifests = await listRunManifests(stateRoot);
      assert.equal(manifests.length, 1);
      assert.equal(manifests[0].runId, 'good-run');
    } finally {
      fs.rmSync(stateRoot, { recursive: true, force: true });
    }
  });
});
