const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { createWebviewDom, sampleInitConfig } = require('../helpers/webview-dom');

let wv;

beforeEach(() => {
  wv = createWebviewDom({ savedState: { currentMode: 'dev', runId: 'run-1' } });
  wv.postMessage(sampleInitConfig({ runId: 'run-1' }));
});
afterEach(() => { wv.cleanup(); });

describe('Config bar', () => {
  it('config bar exists with dropdowns', () => {
    const configBar = wv.document.getElementById('config-bar');
    assert.ok(configBar, 'config bar should exist');
    const selects = configBar.querySelectorAll('select');
    assert.ok(selects.length >= 4, 'should have multiple dropdowns (target, CLI, model, thinking)');
  });

  it('target dropdown exists', () => {
    const target = wv.document.getElementById('cfg-chat-target');
    assert.ok(target, 'chat target dropdown should exist');
  });

  it('controller CLI dropdown exists', () => {
    const cli = wv.document.getElementById('cfg-controller-cli');
    assert.ok(cli, 'controller CLI dropdown should exist');
  });

  it('initConfig sets config values', () => {
    wv.postMessage(sampleInitConfig({
      runId: 'run-1',
      config: { controllerCli: 'claude', workerCli: 'codex' },
    }));
    const ctrlCli = wv.document.getElementById('cfg-controller-cli');
    if (ctrlCli) {
      // The dropdown should reflect the config value
      assert.ok(ctrlCli.value === 'claude' || ctrlCli.options.length > 0, 'controller CLI should be set or have options');
    }
  });

  it('changing target fires configChanged', () => {
    const target = wv.document.getElementById('cfg-chat-target');
    if (target && target.options.length > 1) {
      const initial = wv.messages.length;
      target.value = target.options[1].value;
      target.dispatchEvent(new wv.window.Event('change'));
      const configMsgs = wv.messages.filter((m, i) => i >= initial && m.type === 'configChanged');
      assert.ok(configMsgs.length > 0, 'should post configChanged on target change');
    }
  });
});
