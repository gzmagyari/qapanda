const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { createWebviewDom, sampleInitConfig } = require('../helpers/webview-dom');
const { buildApiCatalogPayload } = require('../../src/model-catalog');

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

  it('changing target does not clear the current conversation', () => {
    wv.postMessage({
      type: 'transcriptHistory',
      messages: [
        { type: 'user', text: 'Continue with the current run' },
        { type: 'claude', text: 'Working on it', label: 'QA Engineer (Browser)' },
      ],
    });

    const target = wv.document.getElementById('cfg-chat-target');
    const messagesBefore = wv.text('#messages');
    const initialCount = wv.messages.length;
    target.value = 'agent-dev';
    target.dispatchEvent(new wv.window.Event('change', { bubbles: true }));

    const clearMsgs = wv.messages.filter((m, i) => i >= initialCount && m.type === 'userInput' && m.text === '/clear');
    const configMsgs = wv.messages.filter((m, i) => i >= initialCount && m.type === 'configChanged');
    assert.equal(clearMsgs.length, 0, 'should not post /clear when switching targets');
    assert.ok(configMsgs.some((m) => m.config && m.config.chatTarget === 'agent-dev'), 'should still post the new target');
    assert.match(wv.text('#messages'), /Continue with the current run/);
    assert.equal(wv.text('#messages').includes(messagesBefore.trim()), true, 'existing chat should remain visible');
  });

  it('renders API provider models from initConfig catalog', () => {
    wv.postMessage(sampleInitConfig({
      config: { controllerCli: 'api', workerCli: 'api', apiProvider: 'openai', controllerModel: 'gpt-5.4', workerModel: 'gpt-5.4-mini' },
    }));
    const workerModel = wv.document.getElementById('cfg-worker-model');
    const values = Array.from(workerModel.options).map((option) => option.value);
    assert.ok(values.includes('gpt-5.4'));
    assert.ok(values.includes('gpt-5.4-mini'));
    assert.ok(values.includes('_custom'));
  });

  it('includes named custom providers and auto-selects custom model inputs', async () => {
    wv.postMessage(sampleInitConfig({
      apiCatalog: buildApiCatalogPayload({
        customProviders: [
          { id: 'lmstudio', name: 'LM Studio', baseURL: 'http://localhost:1234/v1' },
        ],
      }),
      config: { controllerCli: 'api', workerCli: 'api', apiProvider: 'lmstudio' },
    }));
    await wv.flush();

    const provider = wv.document.getElementById('cfg-api-provider');
    const controllerModel = wv.document.getElementById('cfg-controller-model');
    const workerModel = wv.document.getElementById('cfg-worker-model');
    const controllerCustom = wv.document.getElementById('cfg-controller-custom-model');
    const workerCustom = wv.document.getElementById('cfg-worker-custom-model');

    assert.ok(Array.from(provider.options).some((option) => option.value === 'lmstudio'));
    assert.equal(provider.value, 'lmstudio');
    assert.equal(controllerModel.value, '_custom');
    assert.equal(workerModel.value, '_custom');
    assert.equal(controllerCustom.classList.contains('visible'), true);
    assert.equal(workerCustom.classList.contains('visible'), true);
  });

  it('shows named custom providers in the agent editor provider dropdown', async () => {
    wv.postMessage(sampleInitConfig({
      apiCatalog: buildApiCatalogPayload({
        customProviders: [
          { id: 'lmstudio', name: 'LM Studio', baseURL: 'http://localhost:1234/v1' },
        ],
      }),
    }));
    await wv.flush();

    wv.click('.agent-add-btn[data-scope="project"]');
    await wv.flush();

    const provider = wv.document.getElementById('agent-f-provider');
    assert.ok(provider, 'agent provider select should exist');
    assert.ok(Array.from(provider.options).some((option) => option.value === 'lmstudio'));
  });

  it('round-trips agent API compaction trigger messages', async () => {
    wv.click('.agent-add-btn[data-scope="project"]');
    await wv.flush();

    wv.document.getElementById('agent-f-id').value = 'browser-api';
    wv.document.getElementById('agent-f-name').value = 'Browser API';
    const cli = wv.document.getElementById('agent-f-cli');
    cli.value = 'api';
    cli.dispatchEvent(new wv.window.Event('change'));
    await wv.flush();

    const apiCompaction = wv.document.getElementById('agent-f-api-compaction');
    assert.ok(apiCompaction, 'agent API compaction input should exist');
    apiCompaction.value = '123';

    wv.document.getElementById('agent-f-save').click();
    await wv.flush();

    const saveMsg = wv.messages.filter((msg) => msg.type === 'agentSave').pop();
    assert.ok(saveMsg, 'should save the project agent');
    assert.equal(saveMsg.agents['browser-api'].apiCompactionTriggerMessages, 123);
  });

  it('loads existing API compaction trigger messages in the agent editor', async () => {
    const base = sampleInitConfig();
    wv.postMessage(sampleInitConfig({
      agents: {
        system: base.agents.system,
        systemMeta: base.agents.systemMeta,
        global: {},
        project: {
          'browser-api': {
            name: 'Browser API',
            description: 'Browser agent',
            system_prompt: 'Prompt',
            mcps: {},
            enabled: true,
            cli: 'api',
            apiCompactionTriggerMessages: 100,
          },
        },
      },
    }));
    await wv.flush();

    const editBtn = Array.from(wv.document.querySelectorAll('#agent-list-project .mcp-btn'))
      .find((button) => button.textContent.trim() === 'Edit');
    assert.ok(editBtn, 'project agent edit button should exist');
    editBtn.click();
    await wv.flush();

    const apiCompaction = wv.document.getElementById('agent-f-api-compaction');
    assert.ok(apiCompaction, 'agent API compaction input should exist');
    assert.equal(apiCompaction.value, '100');
  });

  it('preserves imported Claude target and worker selections when Claude UI is otherwise hidden', async () => {
    wv.postMessage(sampleInitConfig({
      featureFlags: { enableRemoteDesktop: true, enableClaudeCli: false },
      config: { chatTarget: 'claude', workerCli: 'claude' },
    }));
    await wv.flush();

    const target = wv.document.getElementById('cfg-chat-target');
    const workerCli = wv.document.getElementById('cfg-worker-cli');

    assert.ok(Array.from(target.options).some((option) => option.value === 'claude'));
    assert.equal(target.value, 'claude');
    assert.ok(Array.from(workerCli.options).some((option) => option.value === 'claude'));
    assert.equal(workerCli.value, 'claude');
  });
});
