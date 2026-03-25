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
    assert.ok(names.includes('list_tests'));
    assert.ok(names.includes('add_test_step'));
    assert.ok(names.includes('run_test'));
    assert.ok(names.includes('update_step_result'));
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
