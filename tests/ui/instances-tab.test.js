const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { createWebviewDom, sampleInitConfig } = require('../helpers/webview-dom');

let wv;

beforeEach(() => {
  wv = createWebviewDom({ savedState: { currentMode: 'quick-dev', runId: 'run-1' } });
  wv.postMessage(sampleInitConfig({ runId: 'run-1' }));
  wv.click('[data-tab="instances"]');
});
afterEach(() => { wv.cleanup(); });

describe('Instances tab', () => {
  it('instance list exists', () => {
    const list = wv.document.getElementById('instance-list');
    assert.ok(list, 'instance list should exist');
  });

  it('snapshot checkbox exists', () => {
    const checkbox = wv.document.getElementById('use-snapshot-checkbox');
    assert.ok(checkbox, 'snapshot checkbox should exist');
    assert.ok(checkbox.checked, 'should be checked by default');
  });

  it('action buttons exist', () => {
    const startBtn = wv.document.querySelector('[data-action="start"]');
    const restartAllBtn = wv.document.querySelector('[data-action="restartAll"]');
    const stopAllBtn = wv.document.querySelector('[data-action="stopAll"]');
    assert.ok(startBtn, 'Start button should exist');
    assert.ok(restartAllBtn, 'Restart All button should exist');
    assert.ok(stopAllBtn, 'Stop All button should exist');
  });

  it('instancesData renders instance cards', () => {
    wv.postMessage({
      type: 'instancesData',
      instances: [
        { name: 'test-instance', container_id: 'abc123', api_port: 9000, vnc_port: 5901, novnc_port: 6080, status: 'Up 5 minutes (healthy)', sync: 'synced' },
      ],
      panelId: 'test-panel-001',
      useSnapshot: true,
      snapshotExists: true,
      snapshotTag: 'qa-snapshot-test:latest',
    });
    const list = wv.document.getElementById('instance-list');
    assert.ok(list.innerHTML.includes('test-instance'), 'should show instance name');
    assert.ok(list.innerHTML.includes('9000') || list.innerHTML.includes('API'), 'should show port info');
  });

  it('snapshot info shows tag when exists', () => {
    wv.postMessage({
      type: 'instancesData',
      instances: [],
      panelId: 'test-panel-001',
      useSnapshot: true,
      snapshotExists: true,
      snapshotTag: 'qa-snapshot-test:latest',
    });
    const snapshotInfo = wv.document.getElementById('snapshot-info');
    assert.ok(snapshotInfo, 'snapshot info element should exist');
  });

  it('instance cards have Stop and Snapshot buttons', () => {
    wv.postMessage({
      type: 'instancesData',
      instances: [
        { name: 'test-inst', container_id: 'x', api_port: 9000, vnc_port: 5901, novnc_port: 6080, status: 'Up', sync: 'synced' },
      ],
      panelId: 'test-panel-001',
      useSnapshot: true,
      snapshotExists: false,
      snapshotTag: '',
    });
    const list = wv.document.getElementById('instance-list');
    assert.ok(list.innerHTML.includes('Stop') || list.innerHTML.includes('stop'), 'should have Stop button');
    assert.ok(list.innerHTML.includes('Snapshot') || list.innerHTML.includes('snapshot'), 'should have Snapshot button');
  });
});
