const test = require('node:test');
const assert = require('node:assert/strict');
const { createSidebarLauncherDom } = require('../helpers/sidebar-launcher-dom');

test('sidebar launcher shows empty state and disables resume latest when there are no runs', async () => {
  const wv = createSidebarLauncherDom();
  try {
    await wv.flush();
    wv.postMessage({ type: 'launcherData', runs: [], namedWorkspacesEnabled: false });
    await wv.flush();

    assert.equal(wv.document.getElementById('launcher-empty').textContent.trim(), 'No previous sessions found for this repository.');
    assert.equal(wv.document.getElementById('launcher-resume-latest').disabled, true);
    assert.equal(wv.document.getElementById('launcher-open-workspace').style.display, 'none');
  } finally {
    wv.cleanup();
  }
});

test('sidebar launcher renders runs, open badge, and optional workspace action', async () => {
  const wv = createSidebarLauncherDom();
  try {
    await wv.flush();
    wv.postMessage({
      type: 'launcherData',
      namedWorkspacesEnabled: true,
      runs: [
        { runId: 'run-1', title: 'Login flow', status: 'idle', updatedAt: new Date().toISOString(), isOpen: true },
        { runId: 'run-2', title: 'Checkout', status: 'running', updatedAt: new Date().toISOString(), isOpen: false },
      ],
    });
    await wv.flush();

    const titles = Array.from(wv.document.querySelectorAll('.launcher-run-title')).map((el) => el.textContent.trim());
    assert.deepEqual(titles, ['Login flow', 'Checkout']);
    assert.equal(wv.document.querySelectorAll('.launcher-pill-open').length, 1);
    assert.notEqual(wv.document.getElementById('launcher-open-workspace').style.display, 'none');
  } finally {
    wv.cleanup();
  }
});

test('sidebar launcher filters runs client-side from the search box', async () => {
  const wv = createSidebarLauncherDom();
  try {
    await wv.flush();
    wv.postMessage({
      type: 'launcherData',
      namedWorkspacesEnabled: false,
      runs: [
        { runId: 'run-1', title: 'Login flow', status: 'idle', updatedAt: new Date().toISOString(), isOpen: false },
        { runId: 'run-2', title: 'Checkout table', status: 'idle', updatedAt: new Date().toISOString(), isOpen: false },
      ],
    });
    await wv.flush();

    const input = wv.document.getElementById('launcher-search');
    input.value = 'checkout';
    input.dispatchEvent(new wv.window.Event('input', { bubbles: true }));
    await wv.flush();

    const titles = Array.from(wv.document.querySelectorAll('.launcher-run-title')).map((el) => el.textContent.trim());
    assert.deepEqual(titles, ['Checkout table']);
  } finally {
    wv.cleanup();
  }
});

test('sidebar launcher posts actions for new session, latest, workspace, refresh, and row clicks', async () => {
  const wv = createSidebarLauncherDom();
  try {
    await wv.flush();
    wv.postMessage({
      type: 'launcherData',
      namedWorkspacesEnabled: true,
      runs: [
        { runId: 'run-1', title: 'Login flow', status: 'idle', updatedAt: new Date().toISOString(), isOpen: false },
      ],
    });
    await wv.flush();

    wv.click('#launcher-refresh');
    wv.click('#launcher-new-session');
    wv.click('#launcher-resume-latest');
    wv.click('#launcher-open-workspace');
    wv.click('.launcher-run');

    assert.ok(wv.messagesOfType('launcherReady').length >= 1);
    assert.equal(wv.messagesOfType('launcherRefresh').length, 1);
    assert.equal(wv.messagesOfType('launcherNewSession').length, 1);
    assert.equal(wv.messagesOfType('launcherResumeLatest').length, 1);
    assert.equal(wv.messagesOfType('launcherOpenWorkspace').length, 1);
    assert.deepEqual(wv.messagesOfType('launcherOpenRun').map((msg) => msg.runId), ['run-1']);
  } finally {
    wv.cleanup();
  }
});
