const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createTempDir, readJson } = require('../helpers/test-utils');

// The tasks MCP server uses file-based storage. We test the data layer directly.
// The loadData/saveData functions are internal to tasks-mcp-server.js,
// so we replicate the logic here for testing the data format.

const VALID_STATUSES = ['backlog', 'todo', 'in_progress', 'review', 'testing', 'done'];

function loadTasks(filePath) {
  try { return JSON.parse(fs.readFileSync(filePath, 'utf8')); }
  catch { return { nextId: 1, nextCommentId: 1, nextProgressId: 1, tasks: [] }; }
}

function saveTasks(filePath, data) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
}

function createTask(data, { title, description, detail_text, status }) {
  const id = 'TASK-' + String(data.nextId++).padStart(3, '0');
  const task = {
    id, title, description: description || '', detail_text: detail_text || '',
    status: VALID_STATUSES.includes(status) ? status : 'todo',
    comments: [], progress_updates: [],
    created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
  };
  data.tasks.push(task);
  return task;
}

let tmp;
let tasksFile;

beforeEach(() => {
  tmp = createTempDir();
  tasksFile = path.join(tmp.ccDir, 'tasks.json');
});
afterEach(() => { tmp.cleanup(); });

describe('tasks data CRUD', () => {
  it('loads default data for missing file', () => {
    const data = loadTasks(tasksFile);
    assert.equal(data.nextId, 1);
    assert.deepEqual(data.tasks, []);
  });

  it('creates a task', () => {
    const data = loadTasks(tasksFile);
    const task = createTask(data, { title: 'Fix login bug' });
    saveTasks(tasksFile, data);
    assert.equal(task.id, 'TASK-001');
    assert.equal(task.title, 'Fix login bug');
    assert.equal(task.status, 'todo');
    const loaded = loadTasks(tasksFile);
    assert.equal(loaded.tasks.length, 1);
    assert.equal(loaded.tasks[0].title, 'Fix login bug');
  });

  it('creates multiple tasks with incrementing IDs', () => {
    const data = loadTasks(tasksFile);
    createTask(data, { title: 'Task 1' });
    createTask(data, { title: 'Task 2' });
    createTask(data, { title: 'Task 3' });
    saveTasks(tasksFile, data);
    const loaded = loadTasks(tasksFile);
    assert.equal(loaded.tasks.length, 3);
    assert.equal(loaded.tasks[0].id, 'TASK-001');
    assert.equal(loaded.tasks[1].id, 'TASK-002');
    assert.equal(loaded.tasks[2].id, 'TASK-003');
    assert.equal(loaded.nextId, 4);
  });

  it('creates task with custom status', () => {
    const data = loadTasks(tasksFile);
    const task = createTask(data, { title: 'Urgent', status: 'in_progress' });
    assert.equal(task.status, 'in_progress');
  });

  it('defaults invalid status to todo', () => {
    const data = loadTasks(tasksFile);
    const task = createTask(data, { title: 'Bad status', status: 'invalid' });
    assert.equal(task.status, 'todo');
  });

  it('updates task status', () => {
    const data = loadTasks(tasksFile);
    createTask(data, { title: 'Test' });
    data.tasks[0].status = 'in_progress';
    data.tasks[0].updated_at = new Date().toISOString();
    saveTasks(tasksFile, data);
    const loaded = loadTasks(tasksFile);
    assert.equal(loaded.tasks[0].status, 'in_progress');
  });

  it('updates task fields', () => {
    const data = loadTasks(tasksFile);
    createTask(data, { title: 'Original', description: 'Old desc' });
    data.tasks[0].title = 'Updated';
    data.tasks[0].description = 'New desc';
    data.tasks[0].detail_text = 'Some details';
    saveTasks(tasksFile, data);
    const loaded = loadTasks(tasksFile);
    assert.equal(loaded.tasks[0].title, 'Updated');
    assert.equal(loaded.tasks[0].description, 'New desc');
    assert.equal(loaded.tasks[0].detail_text, 'Some details');
  });

  it('adds comment to task', () => {
    const data = loadTasks(tasksFile);
    createTask(data, { title: 'Test' });
    data.tasks[0].comments.push({
      id: data.nextCommentId++,
      text: 'This is a comment',
      author: 'agent',
      created_at: new Date().toISOString(),
    });
    saveTasks(tasksFile, data);
    const loaded = loadTasks(tasksFile);
    assert.equal(loaded.tasks[0].comments.length, 1);
    assert.equal(loaded.tasks[0].comments[0].text, 'This is a comment');
  });

  it('adds multiple comments', () => {
    const data = loadTasks(tasksFile);
    createTask(data, { title: 'Test' });
    for (let i = 0; i < 3; i++) {
      data.tasks[0].comments.push({
        id: data.nextCommentId++,
        text: `Comment ${i + 1}`,
        author: 'agent',
        created_at: new Date().toISOString(),
      });
    }
    saveTasks(tasksFile, data);
    const loaded = loadTasks(tasksFile);
    assert.equal(loaded.tasks[0].comments.length, 3);
  });

  it('deletes a task', () => {
    const data = loadTasks(tasksFile);
    createTask(data, { title: 'Keep' });
    createTask(data, { title: 'Remove' });
    data.tasks = data.tasks.filter(t => t.title !== 'Remove');
    saveTasks(tasksFile, data);
    const loaded = loadTasks(tasksFile);
    assert.equal(loaded.tasks.length, 1);
    assert.equal(loaded.tasks[0].title, 'Keep');
  });

  it('handles empty tasks array', () => {
    saveTasks(tasksFile, { nextId: 1, nextCommentId: 1, nextProgressId: 1, tasks: [] });
    const loaded = loadTasks(tasksFile);
    assert.equal(loaded.tasks.length, 0);
  });

  it('all valid statuses are accepted', () => {
    const data = loadTasks(tasksFile);
    for (const status of VALID_STATUSES) {
      const task = createTask(data, { title: `Status: ${status}`, status });
      assert.equal(task.status, status);
    }
    assert.equal(data.tasks.length, VALID_STATUSES.length);
  });

  it('task has timestamps', () => {
    const data = loadTasks(tasksFile);
    const task = createTask(data, { title: 'Timestamped' });
    assert.ok(task.created_at, 'should have created_at');
    assert.ok(task.updated_at, 'should have updated_at');
    // Should be valid ISO timestamps
    assert.ok(!isNaN(new Date(task.created_at).getTime()));
    assert.ok(!isNaN(new Date(task.updated_at).getTime()));
  });
});
