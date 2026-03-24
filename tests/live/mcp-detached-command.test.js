const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { createTempDir } = require('../helpers/test-utils');
const { startDetachedCommandMcp } = require('../helpers/live-test-utils');

let tmp;
let mcp;

function getToolText(res) {
  return res.result.content[0].text;
}
function getStructured(res) {
  return res.result.structuredContent || null;
}

async function initMcp(dataDir) {
  mcp = startDetachedCommandMcp(dataDir);
  // detached-command requires clientInfo.version
  await mcp.call('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'test', version: '1.0.0' },
  });
  return mcp;
}

beforeEach(() => {
  tmp = createTempDir();
});
afterEach(() => {
  if (mcp) { mcp.close(); mcp = null; }
  tmp.cleanup();
});

describe('Detached Command MCP server', () => {
  it('initializes successfully', async () => {
    const dataDir = path.join(tmp.ccDir, '.detached-jobs');
    await initMcp(dataDir);
    assert.ok(true, 'init completed without error');
  });

  it('lists available tools', async () => {
    await initMcp(path.join(tmp.ccDir, '.detached-jobs'));
    const res = await mcp.call('tools/list', {});
    const toolNames = res.result.tools.map(t => t.name);
    assert.ok(toolNames.includes('start_command'));
    assert.ok(toolNames.includes('list_jobs'));
    assert.ok(toolNames.includes('get_job'));
    assert.ok(toolNames.includes('read_output'));
    assert.ok(toolNames.includes('stop_job'));
  });

  it('starts a command and gets output', async () => {
    await initMcp(path.join(tmp.ccDir, '.detached-jobs'));

    const startRes = await mcp.callTool('start_command', { command: 'echo hello-from-test' });
    const startText = getToolText(startRes);
    assert.ok(startText, 'should get response text');
    // Extract job_id from structured content or text
    const structured = getStructured(startRes);
    const jobId = structured ? structured.job.jobId : null;
    assert.ok(jobId, 'should have job_id in structured content');

    // Wait for command to finish
    await new Promise(r => setTimeout(r, 2000));

    // Read output
    const readRes = await mcp.callTool('read_output', { job_id: jobId });
    const readText = getToolText(readRes);
    assert.ok(readText.includes('hello-from-test'), 'output should contain echo text');
  });

  it('lists jobs', async () => {
    await initMcp(path.join(tmp.ccDir, '.detached-jobs'));

    await mcp.callTool('start_command', { command: 'echo job-list-test' });
    await new Promise(r => setTimeout(r, 1000));

    const listRes = await mcp.callTool('list_jobs', {});
    const listText = getToolText(listRes);
    assert.ok(listText.length > 0, 'should have list output');
    // Should mention the command or job
    assert.ok(listText.includes('echo') || listText.includes('job'), 'should list jobs');
  });

  it('gets job details', async () => {
    await initMcp(path.join(tmp.ccDir, '.detached-jobs'));

    const startRes = await mcp.callTool('start_command', { command: 'echo detail-test' });
    const structured = getStructured(startRes);
    const jobId = structured ? structured.job.jobId : null;
    assert.ok(jobId);

    // Poll until job finishes (instead of fixed sleep — handles system load)
    let status = 'starting';
    for (let i = 0; i < 15; i++) {
      await new Promise(r => setTimeout(r, 1000));
      const pollRes = await mcp.callTool('get_job', { job_id: jobId });
      const pollStructured = getStructured(pollRes);
      if (pollStructured && pollStructured.job) {
        status = pollStructured.job.status;
        if (status === 'exited' || status === 'completed' || status === 'killed') break;
      }
    }

    const getRes = await mcp.callTool('get_job', { job_id: jobId });
    const getText = getToolText(getRes);
    assert.ok(getText.includes(jobId) || getText.includes('detail-test'), 'should show job details');

    const getStructuredRes = getStructured(getRes);
    assert.ok(getStructuredRes && getStructuredRes.job, 'should have structured job data');
    assert.equal(getStructuredRes.job.status, 'exited', 'echo command should have exited after polling');
  });

  it('stops a running command', async () => {
    await initMcp(path.join(tmp.ccDir, '.detached-jobs'));

    // Start a long-running command
    const cmd = process.platform === 'win32' ? 'ping -n 100 127.0.0.1' : 'sleep 100';
    const startRes = await mcp.callTool('start_command', { command: cmd });
    const structured = getStructured(startRes);
    const jobId = structured ? structured.job.jobId : null;
    assert.ok(jobId);

    await new Promise(r => setTimeout(r, 1000));

    // Stop it
    const stopRes = await mcp.callTool('stop_job', { job_id: jobId });
    assert.ok(stopRes.result, 'stop should return result');
  });
});
