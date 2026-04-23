const test = require('node:test');
const assert = require('node:assert/strict');

const { PanelRegistry } = require('../../extension/panel-registry');

test('panel registry tracks count and remove for open panels', () => {
  const registry = new PanelRegistry();
  const panelA = { id: 'a' };
  const panelB = { id: 'b' };

  registry.add(panelA, { rootIdentity: 'repo:a', title: 'A' });
  registry.add(panelB, { rootIdentity: 'repo:a', title: 'B' });

  assert.equal(registry.count(), 2);
  registry.remove(panelA);
  assert.equal(registry.count(), 1);
  assert.equal(registry.get(panelA), null);
});

test('panel registry returns the most recently focused matching panel for a run', () => {
  const registry = new PanelRegistry();
  const older = { id: 'older' };
  const newer = { id: 'newer' };

  registry.add(older, { rootIdentity: 'repo:a', runId: 'run-1', lastFocusedAt: 10 });
  registry.add(newer, { rootIdentity: 'repo:a', runId: 'run-1', lastFocusedAt: 20 });

  assert.equal(registry.findMostRecentByRun('repo:a', 'run-1').panel, newer);
  registry.markFocused(older, 30);
  assert.equal(registry.findMostRecentByRun('repo:a', 'run-1').panel, older);
});

test('panel registry open-run lookup is scoped by root identity and current run id', () => {
  const registry = new PanelRegistry();
  const panel = { id: 'panel' };

  registry.add(panel, { rootIdentity: 'repo:a', runId: 'run-1' });

  assert.equal(registry.hasOpenRun('repo:a', 'run-1'), true);
  assert.equal(registry.hasOpenRun('repo:b', 'run-1'), false);
  registry.update(panel, { runId: null });
  assert.equal(registry.hasOpenRun('repo:a', 'run-1'), false);
});
