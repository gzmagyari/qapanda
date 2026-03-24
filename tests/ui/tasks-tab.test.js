const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { createWebviewDom, sampleInitConfig } = require('../helpers/webview-dom');

let wv;

beforeEach(() => {
  wv = createWebviewDom({ savedState: { currentMode: 'quick-dev', runId: 'run-1' } });
  wv.postMessage(sampleInitConfig({ runId: 'run-1' }));
  wv.click('[data-tab="tasks"]');
});
afterEach(() => { wv.cleanup(); });

describe('Tasks tab', () => {
  it('kanban board exists', () => {
    const board = wv.document.getElementById('kanban-board');
    assert.ok(board, 'kanban board should exist');
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
});
