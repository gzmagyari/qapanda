const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
  callSafely,
  cleanupPanelSession,
  shutdownExtensionResources,
} = require('../../extension/lifecycle-utils');

describe('lifecycle utils', () => {
  it('callSafely swallows sync and async failures', async () => {
    await assert.doesNotReject(() => callSafely('sync ok', () => {}));
    await assert.doesNotReject(() => callSafely('sync fail', () => { throw new Error('boom'); }));
    await assert.doesNotReject(() => callSafely('async ok', async () => {}));
    await assert.doesNotReject(() => callSafely('async fail', async () => { throw new Error('async boom'); }));
  });

  it('cleanupPanelSession continues through all cleanup steps even when earlier ones fail', async () => {
    const calls = [];
    await assert.doesNotReject(() => cleanupPanelSession({
      repoRoot: 'repo',
      panelId: 'panel-1',
      session: {
        dispose() {
          calls.push('dispose');
        },
      },
      instanceName(repoRoot, panelId) {
        calls.push(`instanceName:${repoRoot}:${panelId}`);
        return 'inst-panel-1';
      },
      stopInstance(name) {
        calls.push(`stopInstance:${name}`);
        throw new Error('stop failed');
      },
      clearPanel(panelId) {
        calls.push(`clearPanel:${panelId}`);
      },
      killChrome(panelId) {
        calls.push(`killChrome:${panelId}`);
      },
    }));

    assert.deepEqual(calls, [
      'instanceName:repo:panel-1',
      'stopInstance:inst-panel-1',
      'clearPanel:panel-1',
      'killChrome:panel-1',
      'dispose',
    ]);
  });

  it('shutdownExtensionResources supports mixed sync and async stop helpers', async () => {
    const calls = [];
    await assert.doesNotReject(() => shutdownExtensionResources({
      stopTasksMcpServer() {
        calls.push('tasks');
      },
      stopTestsMcpServer: async () => {
        calls.push('tests');
      },
      stopMemoryMcpServer() {
        calls.push('memory');
        throw new Error('memory failed');
      },
      stopQaDesktopMcpServer: async () => {
        calls.push('desktop');
      },
      killAll() {
        calls.push('killAll');
      },
      closeAllConnections: async () => {
        calls.push('closeAllConnections');
      },
    }));

    assert.deepEqual(calls, [
      'tasks',
      'tests',
      'memory',
      'desktop',
      'killAll',
      'closeAllConnections',
    ]);
  });
});
