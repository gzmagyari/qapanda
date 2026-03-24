const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { createTempDir } = require('../helpers/test-utils');
const { startTasksMcp } = require('../helpers/live-test-utils');

let tmp;
let mcp;

function initMcp(tasksFile) {
  mcp = startTasksMcp(tasksFile);
  return mcp.call('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test' } });
}

function getToolText(res) {
  return res.result.content[0].text;
}

beforeEach(() => {
  tmp = createTempDir();
});
afterEach(() => {
  if (mcp) { mcp.close(); mcp = null; }
  tmp.cleanup();
});

describe('Tasks MCP server (stdio)', () => {
  it('initializes successfully', async () => {
    const tasksFile = path.join(tmp.ccDir, 'tasks.json');
    await initMcp(tasksFile);
    // If we get here without timeout, init succeeded
    assert.ok(true);
  });

  it('lists available tools', async () => {
    await initMcp(path.join(tmp.ccDir, 'tasks.json'));
    const res = await mcp.call('tools/list', {});
    const toolNames = res.result.tools.map(t => t.name);
    assert.ok(toolNames.includes('create_task'));
    assert.ok(toolNames.includes('list_tasks'));
    assert.ok(toolNames.includes('get_task'));
    assert.ok(toolNames.includes('update_task_status'));
    assert.ok(toolNames.includes('add_comment'));
    assert.ok(toolNames.includes('delete_task'));
  });

  it('creates a task and returns it', async () => {
    await initMcp(path.join(tmp.ccDir, 'tasks.json'));
    const res = await mcp.callTool('create_task', { title: 'Test task', description: 'A test' });
    const text = getToolText(res);
    const task = JSON.parse(text);
    assert.ok(task.id, 'should have an id');
    assert.equal(task.title, 'Test task');
    assert.equal(task.description, 'A test');
    assert.equal(task.status, 'todo');
  });

  it('lists tasks after creation', async () => {
    await initMcp(path.join(tmp.ccDir, 'tasks.json'));
    await mcp.callTool('create_task', { title: 'Task 1' });
    await mcp.callTool('create_task', { title: 'Task 2' });
    const res = await mcp.callTool('list_tasks', {});
    const tasks = JSON.parse(getToolText(res));
    assert.equal(tasks.length, 2);
    assert.equal(tasks[0].title, 'Task 1');
    assert.equal(tasks[1].title, 'Task 2');
  });

  it('updates task status', async () => {
    await initMcp(path.join(tmp.ccDir, 'tasks.json'));
    const createRes = await mcp.callTool('create_task', { title: 'Move me' });
    const created = JSON.parse(getToolText(createRes));

    await mcp.callTool('update_task_status', { task_id: created.id, status: 'in_progress' });

    const getRes = await mcp.callTool('get_task', { task_id: created.id });
    const task = JSON.parse(getToolText(getRes));
    assert.equal(task.status, 'in_progress');
  });

  it('adds a comment to a task', async () => {
    await initMcp(path.join(tmp.ccDir, 'tasks.json'));
    const createRes = await mcp.callTool('create_task', { title: 'Commentable' });
    const created = JSON.parse(getToolText(createRes));

    await mcp.callTool('add_comment', { task_id: created.id, text: 'This is my comment' });

    const getRes = await mcp.callTool('get_task', { task_id: created.id });
    const task = JSON.parse(getToolText(getRes));
    assert.ok(task.comments.length > 0, 'should have comments');
    assert.equal(task.comments[0].text, 'This is my comment');
  });

  it('gets task details', async () => {
    await initMcp(path.join(tmp.ccDir, 'tasks.json'));
    const createRes = await mcp.callTool('create_task', { title: 'Detailed task', description: 'Has details' });
    const created = JSON.parse(getToolText(createRes));

    const getRes = await mcp.callTool('get_task', { task_id: created.id });
    const task = JSON.parse(getToolText(getRes));
    assert.equal(task.title, 'Detailed task');
    assert.equal(task.description, 'Has details');
    assert.ok(task.created_at);
  });

  it('deletes a task', async () => {
    await initMcp(path.join(tmp.ccDir, 'tasks.json'));
    const createRes = await mcp.callTool('create_task', { title: 'Delete me' });
    const created = JSON.parse(getToolText(createRes));

    await mcp.callTool('delete_task', { task_id: created.id });

    const listRes = await mcp.callTool('list_tasks', {});
    const tasks = JSON.parse(getToolText(listRes));
    assert.equal(tasks.length, 0);
  });

  it('filters tasks by status', async () => {
    await initMcp(path.join(tmp.ccDir, 'tasks.json'));
    await mcp.callTool('create_task', { title: 'Todo task', status: 'todo' });
    await mcp.callTool('create_task', { title: 'Done task', status: 'done' });

    const res = await mcp.callTool('list_tasks', { status: 'done' });
    const tasks = JSON.parse(getToolText(res));
    assert.equal(tasks.length, 1);
    assert.equal(tasks[0].title, 'Done task');
  });

  it('adds progress update to a task', async () => {
    await initMcp(path.join(tmp.ccDir, 'tasks.json'));
    const createRes = await mcp.callTool('create_task', { title: 'Progress task' });
    const created = JSON.parse(getToolText(createRes));

    await mcp.callTool('add_progress_update', { task_id: created.id, text: 'Step 1 done' });

    const getRes = await mcp.callTool('get_task', { task_id: created.id });
    const task = JSON.parse(getToolText(getRes));
    assert.ok(task.progress_updates.length > 0);
    assert.equal(task.progress_updates[0].text, 'Step 1 done');
  });
});

// ── HTTP variant ──────────────────────────────────────────────────

describe('Tasks MCP server (HTTP)', { timeout: 15000 }, () => {
  let httpServer;

  afterEach(() => {
    if (httpServer) { httpServer.close(); httpServer = null; }
  });

  it('starts HTTP server and handles CRUD via POST /mcp', async () => {
    const { startTasksMcpServer, stopTasksMcpServer } = require('../../extension/tasks-mcp-http');
    const { httpPost } = require('../helpers/live-test-utils');

    const tasksFile = path.join(tmp.ccDir, 'tasks-http.json');
    httpServer = await startTasksMcpServer(tasksFile);
    assert.ok(httpServer.port, 'should return a port');

    const baseUrl = `http://127.0.0.1:${httpServer.port}/mcp`;

    // Initialize
    const initRes = await httpPost(baseUrl, { jsonrpc: '2.0', id: '1', method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '1.0' } } });
    assert.ok(initRes.result, 'should initialize');

    // Create task
    const createRes = await httpPost(baseUrl, { jsonrpc: '2.0', id: '2', method: 'tools/call', params: { name: 'create_task', arguments: { title: 'HTTP task' } } });
    const created = JSON.parse(createRes.result.content[0].text);
    assert.equal(created.title, 'HTTP task');

    // List tasks
    const listRes = await httpPost(baseUrl, { jsonrpc: '2.0', id: '3', method: 'tools/call', params: { name: 'list_tasks', arguments: {} } });
    const tasks = JSON.parse(listRes.result.content[0].text);
    assert.equal(tasks.length, 1);
    assert.equal(tasks[0].title, 'HTTP task');

    // Delete task
    await httpPost(baseUrl, { jsonrpc: '2.0', id: '4', method: 'tools/call', params: { name: 'delete_task', arguments: { task_id: created.id } } });
    const listRes2 = await httpPost(baseUrl, { jsonrpc: '2.0', id: '5', method: 'tools/call', params: { name: 'list_tasks', arguments: {} } });
    const tasks2 = JSON.parse(listRes2.result.content[0].text);
    assert.equal(tasks2.length, 0);

    stopTasksMcpServer();
    httpServer = null;
  });
});
