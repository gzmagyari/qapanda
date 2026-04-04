const test = require('node:test');
const assert = require('node:assert/strict');

const { SessionRegistry } = require('../../web/session-registry');

test('reattach within grace period reuses the same session entry', async () => {
  const registry = new SessionRegistry({ graceMs: 40 });
  const wsA = { id: 'ws-a' };
  const wsB = { id: 'ws-b' };
  let createCalls = 0;
  let disposeCalls = 0;

  const first = registry.attach('panel-1', {
    ws: wsA,
    createEntry(panelId, connection) {
      createCalls += 1;
      return {
        connectionSeen: connection,
        session: { dispose() { disposeCalls += 1; } },
        panelConfig: {},
      };
    },
  });

  assert.equal(first.created, true);
  assert.equal(createCalls, 1);
  assert.equal(first.entry.connection.ws, wsA);

  registry.detach('panel-1');
  await new Promise((resolve) => setTimeout(resolve, 10));

  const second = registry.attach('panel-1', {
    ws: wsB,
    createEntry() {
      throw new Error('should not create a new session during the reconnect grace period');
    },
  });

  assert.equal(second.created, false);
  assert.equal(second.entry, first.entry);
  assert.equal(second.entry.connection.ws, wsB);
  assert.equal(createCalls, 1);
  assert.equal(disposeCalls, 0);

  registry.disposeAll();
  assert.equal(disposeCalls, 1);
});

test('rekey moves an attached session to the manifest-owned panel id', () => {
  const registry = new SessionRegistry({ graceMs: 20 });
  const first = registry.attach('panel-temp', {
    ws: { id: 'ws-a' },
    createEntry(_panelId, connection) {
      return {
        connectionSeen: connection,
        session: { dispose() {} },
        panelConfig: {},
      };
    },
  });

  const moved = registry.rekey('panel-temp', 'panel-final');
  assert.equal(moved, first.entry);
  assert.equal(registry.get('panel-temp'), null);
  assert.equal(registry.get('panel-final'), first.entry);
  assert.equal(first.entry.panelId, 'panel-final');

  registry.disposeAll();
});

test('detached sessions are disposed after the reconnect grace period', async () => {
  const registry = new SessionRegistry({ graceMs: 20 });
  let disposeCalls = 0;

  registry.attach('panel-2', {
    ws: { id: 'ws-a' },
    createEntry(_panelId, connection) {
      return {
        connectionSeen: connection,
        session: { dispose() { disposeCalls += 1; } },
        panelConfig: {},
      };
    },
  });

  registry.detach('panel-2');
  await new Promise((resolve) => setTimeout(resolve, 50));

  assert.equal(disposeCalls, 1);
  assert.equal(registry.get('panel-2'), null);
});
