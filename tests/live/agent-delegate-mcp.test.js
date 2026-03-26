const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { startAgentDelegateMcpServer } = require('../../extension/agent-delegate-mcp');

function mcpCall(port, method, params = {}) {
  const id = Math.random().toString(36).slice(2, 8);
  const body = JSON.stringify({ jsonrpc: '2.0', id, method, params });
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1', port, path: '/mcp',
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    }, (res) => {
      let data = '';
      res.on('data', (d) => { data += d; });
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function mcpToolCall(port, name, args = {}) {
  return mcpCall(port, 'tools/call', { name, arguments: args });
}

let server;
afterEach(() => {
  if (server) { try { server.close(); } catch {} server = null; }
});

describe('Agent Delegate MCP server', () => {
  it('initializes and lists tools', async () => {
    server = await startAgentDelegateMcpServer({
      onDelegate: async () => 'mock result',
      onListAgents: () => '[]',
    });
    assert.ok(server.port > 0, 'should bind to a port');

    const initRes = await mcpCall(server.port, 'initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'test', version: '1.0.0' },
    });
    assert.ok(initRes.result, 'should return init result');

    const toolsRes = await mcpCall(server.port, 'tools/list', {});
    const toolNames = toolsRes.result.tools.map(t => t.name);
    assert.ok(toolNames.includes('delegate_to_agent'), 'should have delegate_to_agent tool');
    assert.ok(toolNames.includes('list_agents'), 'should have list_agents tool');
  });

  it('list_agents returns agent data', async () => {
    const mockAgents = [
      { id: 'dev', name: 'Developer', description: 'Writes code' },
      { id: 'QA-Browser', name: 'QA Engineer', description: 'Tests in browser' },
    ];
    server = await startAgentDelegateMcpServer({
      onDelegate: async () => 'mock result',
      onListAgents: () => JSON.stringify(mockAgents, null, 2),
    });

    await mcpCall(server.port, 'initialize', {
      protocolVersion: '2024-11-05', capabilities: {},
      clientInfo: { name: 'test', version: '1.0.0' },
    });

    const res = await mcpToolCall(server.port, 'list_agents');
    const text = res.result.content[0].text;
    const agents = JSON.parse(text);
    assert.equal(agents.length, 2);
    assert.equal(agents[0].id, 'dev');
    assert.equal(agents[1].id, 'QA-Browser');
  });

  it('delegate_to_agent calls onDelegate and returns result', async () => {
    let capturedId = null;
    let capturedMsg = null;

    server = await startAgentDelegateMcpServer({
      onDelegate: async (agentId, message) => {
        capturedId = agentId;
        capturedMsg = message;
        return 'I fixed the bug in auth.js by adding null check on line 42.';
      },
      onListAgents: () => '[]',
    });

    await mcpCall(server.port, 'initialize', {
      protocolVersion: '2024-11-05', capabilities: {},
      clientInfo: { name: 'test', version: '1.0.0' },
    });

    const res = await mcpToolCall(server.port, 'delegate_to_agent', {
      agent_id: 'dev',
      message: 'Fix the null pointer bug in auth.js',
    });

    const text = res.result.content[0].text;
    assert.ok(text.includes('fixed the bug'), 'should return the delegate result');
    assert.equal(capturedId, 'dev', 'should pass agent_id to onDelegate');
    assert.equal(capturedMsg, 'Fix the null pointer bug in auth.js', 'should pass message to onDelegate');
  });

  it('delegate_to_agent returns error when onDelegate throws', async () => {
    server = await startAgentDelegateMcpServer({
      onDelegate: async () => { throw new Error('Agent "bogus" not found'); },
      onListAgents: () => '[]',
    });

    await mcpCall(server.port, 'initialize', {
      protocolVersion: '2024-11-05', capabilities: {},
      clientInfo: { name: 'test', version: '1.0.0' },
    });

    const res = await mcpToolCall(server.port, 'delegate_to_agent', {
      agent_id: 'bogus',
      message: 'Do something',
    });

    assert.ok(res.result.isError, 'should flag as error');
    const text = res.result.content[0].text;
    assert.ok(text.includes('not found'), 'should contain error message');
  });

  it('multiple delegate calls work sequentially', async () => {
    let callCount = 0;
    server = await startAgentDelegateMcpServer({
      onDelegate: async (agentId, message) => {
        callCount++;
        return `Result #${callCount} from ${agentId}: done`;
      },
      onListAgents: () => '[]',
    });

    await mcpCall(server.port, 'initialize', {
      protocolVersion: '2024-11-05', capabilities: {},
      clientInfo: { name: 'test', version: '1.0.0' },
    });

    const res1 = await mcpToolCall(server.port, 'delegate_to_agent', {
      agent_id: 'dev', message: 'Fix bug 1',
    });
    const res2 = await mcpToolCall(server.port, 'delegate_to_agent', {
      agent_id: 'QA-Browser', message: 'Test the fix',
    });

    assert.ok(res1.result.content[0].text.includes('Result #1 from dev'));
    assert.ok(res2.result.content[0].text.includes('Result #2 from QA-Browser'));
    assert.equal(callCount, 2);
  });
});
