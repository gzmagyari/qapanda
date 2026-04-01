const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { createWebviewDom, sampleInitConfig } = require('../helpers/webview-dom');

let wv;

beforeEach(() => {
  wv = createWebviewDom({ savedState: { currentMode: 'dev', runId: 'run-1' } });
  wv.postMessage(sampleInitConfig({ runId: 'run-1' }));
  wv.click('[data-tab="tasks"]');
});
afterEach(() => { wv.cleanup(); });

describe('Issues tab', () => {
  it('kanban board exists', () => {
    const board = wv.document.getElementById('kanban-board');
    assert.ok(board, 'kanban board should exist');
  });

  it('renders the Issues tab label', () => {
    assert.equal(wv.document.querySelector('[data-tab="tasks"]').textContent.trim(), 'Issues');
  });

  it('tasksData renders tasks', () => {
    wv.postMessage({
      type: 'tasksData',
      tasks: [
        { id: 'task-1', title: 'Fix login', status: 'todo', description: '', detail_text: '', comments: [], progress_updates: [], created_at: new Date().toISOString(), updated_at: new Date().toISOString() },
        { id: 'task-2', title: 'Add tests', status: 'in_progress', description: '', detail_text: '', comments: [], progress_updates: [], created_at: new Date().toISOString(), updated_at: new Date().toISOString() },
      ],
    });
    const tabContent = wv.document.getElementById('tab-tasks').innerHTML;
    assert.ok(tabContent.includes('Fix login'), 'should render task title');
    assert.ok(tabContent.includes('Add tests'), 'should render second task');
    assert.ok(tabContent.includes('#1'), 'should render short issue badge');
    assert.ok(tabContent.includes('task-1'), 'should render raw issue id');
  });

  it('empty tasks shows empty state', () => {
    wv.postMessage({
      type: 'tasksData',
      tasks: [],
    });
    // Board should render but with no task cards
    const board = wv.document.getElementById('kanban-board');
    assert.ok(board, 'board should exist even with no tasks');
  });

  it('issue detail view shows the short badge and raw id', () => {
    wv.postMessage({
      type: 'tasksData',
      tasks: [
        { id: 'task-12', title: 'Fix login redirect', status: 'todo', description: 'Short summary', detail_text: 'Detailed notes', comments: [], progress_updates: [], created_at: new Date().toISOString(), updated_at: new Date().toISOString() },
      ],
    });
    wv.click('.kanban-card');
    assert.match(wv.text('#task-detail'), /#12/);
    assert.match(wv.text('#task-detail'), /task-12/);
  });
});
