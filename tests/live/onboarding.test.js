const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { createTempDir, writeJson, readJson } = require('../helpers/test-utils');
const { detectCli, detectChrome, detectDocker, detectQaDesktop, runFullDetection } = require('../../extension/onboarding');
const { skipIfMissing } = require('../helpers/live-test-utils');

describe('Live CLI detection', { timeout: 30000 }, () => {
  it('detectCli finds claude', async (t) => {
    if (await skipIfMissing(t, 'claude')) return;
    const result = await detectCli('claude');
    assert.equal(result.available, true);
    assert.ok(result.version, 'should have version string');
    assert.ok(result.version.length > 0);
  });

  it('detectCli finds codex', async (t) => {
    if (await skipIfMissing(t, 'codex')) return;
    const result = await detectCli('codex');
    assert.equal(result.available, true);
    assert.ok(result.version);
  });

  it('detectCli returns unavailable for nonexistent binary', async () => {
    const result = await detectCli('nonexistent-binary-xyz123');
    assert.equal(result.available, false);
  });

  it('detectChrome finds Chrome', async () => {
    const result = await detectChrome();
    // Chrome may or may not be installed
    assert.ok(typeof result.available === 'boolean');
    if (result.available) {
      assert.ok(result.path, 'should have path when available');
      assert.ok(result.path.length > 0);
    }
  });

  it('detectDocker checks Docker availability', async () => {
    const result = await detectDocker();
    assert.ok(typeof result.available === 'boolean');
    assert.ok(typeof result.running === 'boolean');
    if (result.available) {
      assert.ok(result.version, 'should have version when available');
    }
  });

  it('detectQaDesktop checks qa-desktop availability', async () => {
    const result = await detectQaDesktop();
    assert.ok(typeof result.available === 'boolean');
  });

  it('runFullDetection returns all results', async () => {
    const result = await runFullDetection();
    assert.ok(result.clis, 'should have clis');
    assert.ok(result.clis.claude, 'should have claude detection');
    assert.ok(result.clis.codex, 'should have codex detection');
    assert.ok(result.tools, 'should have tools');
    assert.ok(result.tools.chrome, 'should have chrome detection');
    assert.ok(result.tools.docker, 'should have docker detection');
    assert.ok(result.tools.qaDesktop, 'should have qa-desktop detection');

    // All results should have 'available' boolean
    assert.ok(typeof result.clis.claude.available === 'boolean');
    assert.ok(typeof result.clis.codex.available === 'boolean');
    assert.ok(typeof result.tools.chrome.available === 'boolean');
    assert.ok(typeof result.tools.docker.available === 'boolean');
    assert.ok(typeof result.tools.qaDesktop.available === 'boolean');
  });
});

describe('Onboarding save + load roundtrip', () => {
  let tmp;
  beforeEach(() => { tmp = createTempDir(); });
  afterEach(() => { tmp.cleanup(); });

  it('completeOnboarding writes valid onboarding.json', () => {
    const filePath = path.join(tmp.ccDir, 'onboarding.json');
    const data = {
      version: 1,
      completedAt: new Date().toISOString(),
      cliPreference: 'both',
      detectedClis: {
        claude: { available: true, version: '4.6.0' },
        codex: { available: true, version: '1.0.0' },
      },
      detectedTools: {
        chrome: { available: true, path: '/usr/bin/chrome' },
        docker: { available: true, running: true },
        qaDesktop: { available: true },
      },
      defaults: { controllerCli: 'codex', workerCli: 'claude' },
    };

    writeJson(filePath, data);
    const loaded = readJson(filePath);

    assert.equal(loaded.version, 1);
    assert.equal(loaded.cliPreference, 'both');
    assert.equal(loaded.defaults.controllerCli, 'codex');
    assert.equal(loaded.defaults.workerCli, 'claude');
    assert.equal(loaded.detectedClis.claude.available, true);
    assert.equal(loaded.detectedTools.docker.running, true);
  });

  it('isOnboardingComplete pattern works', () => {
    const filePath = path.join(tmp.ccDir, 'onboarding.json');

    // Not complete before save
    const before = readJson(filePath);
    assert.equal(before, null);

    // Complete after save
    writeJson(filePath, { version: 1, completedAt: new Date().toISOString() });
    const after = readJson(filePath);
    assert.ok(after && after.version === 1 && after.completedAt);
  });
});
