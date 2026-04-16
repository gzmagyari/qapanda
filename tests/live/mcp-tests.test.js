const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { createTempDir } = require('../helpers/test-utils');
const { startTasksMcp } = require('../helpers/live-test-utils');

// Reuse the startTasksMcp pattern for the tests MCP
function startTestsMcp(testsFile, tasksFile) {
  const { spawn } = require('node:child_process');
  const readline = require('node:readline');
  const serverPath = path.join(__dirname, '../../extension/tests-mcp-server.js');
  const child = spawn('node', [serverPath], {
    env: { ...process.env, TESTS_FILE: testsFile, TASKS_FILE: tasksFile || testsFile.replace('tests.json', 'tasks.json') },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const rl = readline.createInterface({ input: child.stdout });
  const pending = [];
  const received = [];
  rl.on('line', (line) => {
    try {
      const msg = JSON.parse(line);
      if (pending.length > 0) pending.shift()(msg);
      else received.push(msg);
    } catch {}
  });
  return {
    send(msg) { child.stdin.write(JSON.stringify(msg) + '\n'); },
    receive(timeoutMs = 5000) {
      if (received.length > 0) return Promise.resolve(received.shift());
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('MCP receive timeout')), timeoutMs);
        pending.push((msg) => { clearTimeout(timer); resolve(msg); });
      });
    },
    async call(method, params = {}) {
      const id = Math.random().toString(36).slice(2, 8);
      this.send({ jsonrpc: '2.0', id, method, params });
      return this.receive();
    },
    async callTool(name, args = {}) { return this.call('tools/call', { name, arguments: args }); },
    close() { try { child.kill(); } catch {} },
    child,
  };
}

let tmp;
let mcp;

beforeEach(() => { tmp = createTempDir(); });
afterEach(() => { if (mcp) { mcp.close(); mcp = null; } tmp.cleanup(); });

describe('Tests MCP server (stdio)', () => {
  it('initializes successfully', async () => {
    mcp = startTestsMcp(path.join(tmp.ccDir, 'tests.json'));
    const res = await mcp.call('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test' } });
    assert.ok(res.result);
    assert.equal(res.result.serverInfo.name, 'cc-tests');
  });

  it('lists tools', async () => {
    mcp = startTestsMcp(path.join(tmp.ccDir, 'tests.json'));
    await mcp.call('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test' } });
    const res = await mcp.call('tools/list', {});
    const names = res.result.tools.map(t => t.name);
    assert.ok(names.includes('create_test'));
    assert.ok(names.includes('create_test_with_steps'));
    assert.ok(names.includes('list_tests'));
    assert.ok(names.includes('add_test_step'));
    assert.ok(names.includes('run_test'));
    assert.ok(names.includes('search_tests'));
    assert.ok(names.includes('reset_test_steps'));
    assert.ok(names.includes('update_step_result'));
    assert.ok(names.includes('update_test_steps_batch'));
    assert.ok(names.includes('record_test_run'));
    assert.ok(names.includes('complete_test_run'));
    assert.ok(names.includes('create_bug_from_test'));
    assert.ok(names.includes('get_test_summary'));
  });

  it('creates a test', async () => {
    mcp = startTestsMcp(path.join(tmp.ccDir, 'tests.json'));
    await mcp.call('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test' } });
    const res = await mcp.callTool('create_test', { title: 'Login test', environment: 'browser' });
    const test = JSON.parse(res.result.content[0].text);
    assert.ok(test.id.startsWith('test-'));
    assert.equal(test.title, 'Login test');
    assert.equal(test.environment, 'browser');
    assert.equal(test.status, 'untested');
  });

  it('adds steps to a test', async () => {
    mcp = startTestsMcp(path.join(tmp.ccDir, 'tests.json'));
    await mcp.call('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test' } });
    await mcp.callTool('create_test', { title: 'Test', environment: 'browser' });
    const stepRes = await mcp.callTool('add_test_step', { test_id: 'test-1', description: 'Open page', expectedResult: 'Page loads' });
    const step = JSON.parse(stepRes.result.content[0].text);
    assert.ok(step.id);
    assert.equal(step.description, 'Open page');
    assert.equal(step.status, 'untested');
  });

  it('runs a test and records results', async () => {
    mcp = startTestsMcp(path.join(tmp.ccDir, 'tests.json'));
    await mcp.call('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test' } });
    await mcp.callTool('create_test', { title: 'Test', environment: 'browser' });
    await mcp.callTool('add_test_step', { test_id: 'test-1', description: 'Step 1', expectedResult: 'OK' });
    await mcp.callTool('add_test_step', { test_id: 'test-1', description: 'Step 2', expectedResult: 'OK' });

    // Start run
    const runRes = await mcp.callTool('run_test', { test_id: 'test-1', agent: 'QA Browser' });
    const run = JSON.parse(runRes.result.content[0].text);
    assert.ok(run.run_id);

    // Record results
    await mcp.callTool('update_step_result', { test_id: 'test-1', run_id: run.run_id, step_id: 1, status: 'pass' });
    await mcp.callTool('update_step_result', { test_id: 'test-1', run_id: run.run_id, step_id: 2, status: 'fail', actualResult: 'Error 500' });

    // Complete run
    const completeRes = await mcp.callTool('complete_test_run', { test_id: 'test-1', run_id: run.run_id, notes: 'Step 2 broke' });
    const result = JSON.parse(completeRes.result.content[0].text);
    assert.equal(result.status, 'partial');

    // Verify test status updated
    const testRes = await mcp.callTool('get_test', { test_id: 'test-1' });
    const test = JSON.parse(testRes.result.content[0].text);
    assert.equal(test.steps[0].status, 'pass');
    assert.equal(test.steps[1].status, 'fail');
  });

  it('creates bug from failing test', async () => {
    mcp = startTestsMcp(path.join(tmp.ccDir, 'tests.json'), path.join(tmp.ccDir, 'tasks.json'));
    await mcp.call('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test' } });
    await mcp.callTool('create_test', { title: 'Broken test', environment: 'browser' });
    await mcp.callTool('add_test_step', { test_id: 'test-1', description: 'Click button', expectedResult: 'Form submits' });

    // Mark step as failing
    const runRes = await mcp.callTool('run_test', { test_id: 'test-1' });
    const run = JSON.parse(runRes.result.content[0].text);
    await mcp.callTool('update_step_result', { test_id: 'test-1', run_id: run.run_id, step_id: 1, status: 'fail', actualResult: 'Button not found' });
    await mcp.callTool('complete_test_run', { test_id: 'test-1', run_id: run.run_id });

    // Create bug
    const bugRes = await mcp.callTool('create_bug_from_test', { test_id: 'test-1', title: 'Button missing on form' });
    const bug = JSON.parse(bugRes.result.content[0].text);
    assert.ok(bug.task_id.startsWith('task-'));
    assert.equal(bug.test_id, 'test-1');

    // Verify linking
    const testRes = await mcp.callTool('get_test', { test_id: 'test-1' });
    const test = JSON.parse(testRes.result.content[0].text);
    assert.ok(test.linkedTaskIds.includes(bug.task_id));
  });

  it('gets test summary', async () => {
    mcp = startTestsMcp(path.join(tmp.ccDir, 'tests.json'));
    await mcp.call('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test' } });
    await mcp.callTool('create_test', { title: 'Test 1', environment: 'browser' });
    await mcp.callTool('create_test', { title: 'Test 2', environment: 'computer' });

    const summaryRes = await mcp.callTool('get_test_summary', {});
    const summary = JSON.parse(summaryRes.result.content[0].text);
    assert.equal(summary.total, 2);
    assert.equal(summary.untested, 2);
  });

  it('filters tests by environment', async () => {
    mcp = startTestsMcp(path.join(tmp.ccDir, 'tests.json'));
    await mcp.call('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test' } });
    await mcp.callTool('create_test', { title: 'Browser test', environment: 'browser' });
    await mcp.callTool('create_test', { title: 'Desktop test', environment: 'computer' });

    const res = await mcp.callTool('list_tests', { environment: 'browser' });
    const tests = JSON.parse(res.result.content[0].text);
    assert.equal(tests.length, 1);
    assert.equal(tests[0].title, 'Browser test');
  });

  it('creates a test with steps in one call', async () => {
    mcp = startTestsMcp(path.join(tmp.ccDir, 'tests.json'));
    await mcp.call('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test' } });

    const res = await mcp.callTool('create_test_with_steps', {
      title: 'Batch-created login test',
      environment: 'browser',
      steps: [
        { description: 'Open login page', expectedResult: 'Login page loads' },
        { description: 'Submit invalid credentials', expectedResult: 'Inline error is shown' },
      ],
    });
    const created = JSON.parse(res.result.content[0].text);
    assert.equal(created.steps.length, 2);
    assert.equal(created.steps_added, 2);
  });

  it('updates test steps in one ordered batch', async () => {
    mcp = startTestsMcp(path.join(tmp.ccDir, 'tests.json'));
    await mcp.call('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test' } });
    await mcp.callTool('create_test_with_steps', {
      title: 'Reusable login test',
      environment: 'browser',
      steps: [
        { description: 'Open page', expectedResult: 'Page loads' },
        { description: 'Submit form', expectedResult: 'Form submits' },
      ],
    });

    const batchRes = await mcp.callTool('update_test_steps_batch', {
      test_id: 'test-1',
      operations: [
        { action: 'update', step_id: 1, description: 'Open login page' },
        { action: 'delete', step_id: 2 },
        { action: 'add', description: 'Submit invalid credentials', expectedResult: 'Validation error is shown' },
      ],
    });
    const summary = JSON.parse(batchRes.result.content[0].text);
    assert.equal(summary.added, 1);
    assert.equal(summary.updated, 1);
    assert.equal(summary.deleted, 1);

    const testRes = await mcp.callTool('get_test', { test_id: 'test-1' });
    const test = JSON.parse(testRes.result.content[0].text);
    assert.equal(test.steps.length, 2);
    assert.equal(test.steps[0].description, 'Open login page');
  });

  it('records an entire test run in one call', async () => {
    mcp = startTestsMcp(path.join(tmp.ccDir, 'tests.json'));
    await mcp.call('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test' } });
    await mcp.callTool('create_test_with_steps', {
      title: 'One-shot run test',
      environment: 'browser',
      steps: [
        { description: 'Open page', expectedResult: 'Page loads' },
        { description: 'Submit form', expectedResult: 'Validation is shown' },
      ],
    });

    const runRes = await mcp.callTool('record_test_run', {
      test_id: 'test-1',
      agent: 'QA Browser',
      step_results: [
        { step_id: 1, status: 'pass' },
        { step_id: 2, status: 'fail', actualResult: 'Submitted successfully' },
      ],
      notes: 'Validation bug reproduced',
    });
    const summary = JSON.parse(runRes.result.content[0].text);
    assert.equal(summary.created_run, true);
    assert.equal(summary.status, 'partial');
    assert.equal(summary.updated_steps, 2);
  });

  it('searches for reusable tests and resets steps before rerun', async () => {
    mcp = startTestsMcp(path.join(tmp.ccDir, 'tests.json'));
    await mcp.call('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test' } });
    await mcp.callTool('create_test', { title: 'Login validation flow', description: 'Covers invalid password and redirect behavior', environment: 'browser', tags: ['auth', 'regression'] });
    await mcp.callTool('add_test_step', { test_id: 'test-1', description: 'Submit invalid password', expectedResult: 'Inline error is shown' });
    await mcp.callTool('add_test_step', { test_id: 'test-1', description: 'Open protected route', expectedResult: 'Redirects to login' });

    let runRes = await mcp.callTool('run_test', { test_id: 'test-1', agent: 'QA Browser' });
    let run = JSON.parse(runRes.result.content[0].text);
    await mcp.callTool('update_step_result', { test_id: 'test-1', run_id: run.run_id, step_id: 1, status: 'fail', actualResult: 'No validation message' });
    await mcp.callTool('complete_test_run', { test_id: 'test-1', run_id: run.run_id });

    const searchRes = await mcp.callTool('search_tests', { query: 'login invalid password validation', environment: 'browser' });
    const matches = JSON.parse(searchRes.result.content[0].text);
    assert.equal(matches[0].id, 'test-1');
    assert.match(matches[0].match_reason, /Matched/);

    const resetRes = await mcp.callTool('reset_test_steps', { test_id: 'test-1' });
    const reset = JSON.parse(resetRes.result.content[0].text);
    assert.equal(reset.reset_steps, 2);
    assert.equal(reset.status, 'untested');

    const testRes = await mcp.callTool('get_test', { test_id: 'test-1' });
    const test = JSON.parse(testRes.result.content[0].text);
    assert.equal(test.steps[0].status, 'untested');
    assert.equal(test.steps[0].actualResult, null);
    assert.equal(test.runs.length, 1, 'should preserve run history');
    assert.equal(test.runs[0].stepResults[0].status, 'fail', 'reset should not rewrite historical run evidence');
    assert.equal(test.runs[0].stepResults[0].actualResult, 'No validation message');
  });

  it('record_test_run reset_first preserves earlier run evidence', async () => {
    mcp = startTestsMcp(path.join(tmp.ccDir, 'tests.json'));
    await mcp.call('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test' } });
    await mcp.callTool('create_test_with_steps', {
      title: 'Login rerun history',
      environment: 'browser',
      steps: [
        { description: 'Open login page', expectedResult: 'Page loads' },
        { description: 'Submit invalid credentials', expectedResult: 'Validation error appears' },
      ],
    });

    const firstRunRes = await mcp.callTool('record_test_run', {
      test_id: 'test-1',
      agent: 'QA Browser',
      step_results: [
        { step_id: 1, status: 'pass' },
        { step_id: 2, status: 'fail', actualResult: 'No validation shown' },
      ],
      notes: 'Initial failure',
    });
    const firstRun = JSON.parse(firstRunRes.result.content[0].text);

    const rerunRes = await mcp.callTool('record_test_run', {
      test_id: 'test-1',
      agent: 'QA Browser',
      reset_first: true,
      step_results: [
        { step_id: 1, status: 'pass' },
        { step_id: 2, status: 'pass', actualResult: 'Validation shown correctly' },
      ],
      notes: 'Rerun passing',
    });
    const rerun = JSON.parse(rerunRes.result.content[0].text);
    assert.equal(firstRun.run_id, 1);
    assert.equal(rerun.run_id, 2);

    const testRes = await mcp.callTool('get_test', { test_id: 'test-1' });
    const test = JSON.parse(testRes.result.content[0].text);
    assert.equal(test.runs.length, 2);
    assert.equal(test.runs[0].stepResults[1].status, 'fail');
    assert.equal(test.runs[0].stepResults[1].actualResult, 'No validation shown');
    assert.equal(test.runs[1].stepResults[1].status, 'pass');
    assert.equal(test.runs[1].stepResults[1].actualResult, 'Validation shown correctly');
    assert.equal(test.steps[0].status, 'pass');
    assert.equal(test.steps[1].status, 'pass');
  });

  it('links and unlinks tests to tasks', async () => {
    mcp = startTestsMcp(path.join(tmp.ccDir, 'tests.json'));
    await mcp.call('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test' } });
    await mcp.callTool('create_test', { title: 'Test', environment: 'browser' });

    await mcp.callTool('link_test_to_task', { test_id: 'test-1', task_id: 'task-42' });
    let testRes = await mcp.callTool('get_test', { test_id: 'test-1' });
    let test = JSON.parse(testRes.result.content[0].text);
    assert.ok(test.linkedTaskIds.includes('task-42'));

    await mcp.callTool('unlink_test_from_task', { test_id: 'test-1', task_id: 'task-42' });
    testRes = await mcp.callTool('get_test', { test_id: 'test-1' });
    test = JSON.parse(testRes.result.content[0].text);
    assert.ok(!test.linkedTaskIds.includes('task-42'));
  });
});

describe('Tests MCP server (HTTP)', { timeout: 15000 }, () => {
  let httpServer;

  afterEach(async () => {
    if (httpServer) { await httpServer.close(); httpServer = null; }
  });

  it('searches and resets tests via POST /mcp', async () => {
    const { startTestsMcpServer, stopTestsMcpServer } = require('../../extension/tests-mcp-http');
    const { httpPost } = require('../helpers/live-test-utils');

    const testsFile = path.join(tmp.ccDir, 'tests-http.json');
    const tasksFile = path.join(tmp.ccDir, 'tasks-http.json');
    httpServer = await startTestsMcpServer(testsFile, tasksFile);

    const baseUrl = `http://127.0.0.1:${httpServer.port}/mcp`;
    await httpPost(baseUrl, { jsonrpc: '2.0', id: '1', method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '1.0' } } });
    await httpPost(baseUrl, { jsonrpc: '2.0', id: '2', method: 'tools/call', params: { name: 'create_test', arguments: { title: 'Forgot password flow', description: 'Reset email validation', environment: 'browser' } } });
    await httpPost(baseUrl, { jsonrpc: '2.0', id: '3', method: 'tools/call', params: { name: 'add_test_step', arguments: { test_id: 'test-1', description: 'Submit empty email', expectedResult: 'Validation shows' } } });
    const runRes = await httpPost(baseUrl, { jsonrpc: '2.0', id: '4', method: 'tools/call', params: { name: 'run_test', arguments: { test_id: 'test-1' } } });
    const run = JSON.parse(runRes.result.content[0].text);
    await httpPost(baseUrl, { jsonrpc: '2.0', id: '5', method: 'tools/call', params: { name: 'update_step_result', arguments: { test_id: 'test-1', run_id: run.run_id, step_id: 1, status: 'fail', actualResult: 'Submitted without error' } } });

    const searchRes = await httpPost(baseUrl, { jsonrpc: '2.0', id: '6', method: 'tools/call', params: { name: 'search_tests', arguments: { query: 'forgot password empty email validation' } } });
    const matches = JSON.parse(searchRes.result.content[0].text);
    assert.equal(matches[0].id, 'test-1');

    const resetRes = await httpPost(baseUrl, { jsonrpc: '2.0', id: '7', method: 'tools/call', params: { name: 'reset_test_steps', arguments: { test_id: 'test-1' } } });
    const reset = JSON.parse(resetRes.result.content[0].text);
    assert.equal(reset.status, 'untested');

    await httpServer.close();
    stopTestsMcpServer();
    httpServer = null;
  });
});
