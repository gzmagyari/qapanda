const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const os = require('node:os');
const { createMockServer } = require('./llm-mock-server');
const {
  readTranscriptEntriesSync,
  buildSessionReplay,
  createTranscriptRecord,
} = require('../../src/transcript');

let mock;
let tmpDir;

before(async () => {
  mock = await createMockServer();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qp-apiw-test-'));
  fs.writeFileSync(path.join(tmpDir, 'sample.txt'), 'hello from sample\nsecond line\n');
  fs.mkdirSync(path.join(tmpDir, '.qpanda', 'runs', 'test-run'), { recursive: true });
  fs.writeFileSync(path.join(tmpDir, '.qpanda', 'runs', 'test-run', 'transcript.jsonl'), '');
});
after(async () => {
  if (mock) await mock.close();
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
});

// Minimal manifest/renderer stubs
function makeManifest(handlerOverride) {
  if (handlerOverride) mock.setHandler(handlerOverride);
  fs.writeFileSync(path.join(tmpDir, '.qpanda', 'runs', 'test-run', 'transcript.jsonl'), '');
  return {
    repoRoot: tmpDir,
    files: {
      transcript: path.join(tmpDir, '.qpanda', 'runs', 'test-run', 'transcript.jsonl'),
    },
    worker: {
      cli: 'api',
      apiConfig: {
        provider: 'custom',
        apiKey: 'test',
        baseURL: mock.url + '/v1',
        model: 'test-model',
      },
      agentSessions: {},
    },
    settings: { quiet: false },
    workerMcpServers: {},
    agents: {},
    selfTesting: false,
  };
}

function makeRenderer() {
  const output = [];
  return {
    output,
    _post: (msg) => output.push(msg),
    claude: (text) => output.push({ type: 'claude', text }),
    streamMarkdown: (label, text) => output.push({ type: 'stream', label, text }),
    flushStream: () => output.push({ type: 'flush' }),
  };
}

function makeWorkerRecord() { return {}; }
function noopEmit() {}

function transcriptEntries(manifest) {
  return readTranscriptEntriesSync(manifest.files.transcript);
}

describe('API Worker — simple text response', () => {
  it('returns text with no tool calls', async () => {
    const { runApiWorkerTurn } = require('../../src/api-worker');
    const manifest = makeManifest(() => ({ text: 'I found 3 files in the project.' }));
    const renderer = makeRenderer();
    const workerRecord = makeWorkerRecord();

    const result = await runApiWorkerTurn({
      manifest,
      request: { id: 'r1' },
      loop: { controller: {} },
      workerRecord,
      prompt: 'list files',
      renderer,
      emitEvent: noopEmit,
    });

    assert.equal(result.resultText, 'I found 3 files in the project.');
    assert.equal(result.exitCode, 0);
    assert.ok(renderer.output.some(o => o.type === 'stream'), 'should have streamed text');
  });
});

describe('API Worker — single tool call', () => {
  it('calls tool, sends result back, gets final text', async () => {
    const { runApiWorkerTurn } = require('../../src/api-worker');
    let callCount = 0;
    const manifest = makeManifest((_req, body) => {
      callCount++;
      if (callCount === 1) {
        // First call: return tool call
        return {
          toolCalls: [{ id: 'call_1', name: 'read_file', arguments: { path: 'sample.txt' } }],
        };
      }
      // Second call (after tool result): return final text
      return { text: 'The file contains "hello from sample".' };
    });
    const renderer = makeRenderer();
    const workerRecord = makeWorkerRecord();

    const result = await runApiWorkerTurn({
      manifest,
      request: { id: 'r1' },
      loop: { controller: {} },
      workerRecord,
      prompt: 'read sample.txt',
      renderer,
      emitEvent: noopEmit,
    });

    assert.equal(callCount, 2, 'should make 2 API calls (tool call + final)');
    assert.ok(result.resultText.includes('hello from sample'));
    assert.ok(renderer.output.some(o => o.text && o.text.includes('read_file')), 'should show tool call');
  });
});

describe('API Worker — multi-turn tool calls', () => {
  it('handles multiple rounds of tool calls', async () => {
    const { runApiWorkerTurn } = require('../../src/api-worker');
    let callCount = 0;
    const manifest = makeManifest((_req, body) => {
      callCount++;
      if (callCount === 1) {
        return { toolCalls: [{ id: 'c1', name: 'list_directory', arguments: {} }] };
      }
      if (callCount === 2) {
        return { toolCalls: [{ id: 'c2', name: 'read_file', arguments: { path: 'sample.txt' } }] };
      }
      return { text: 'Done reading everything.' };
    });
    const renderer = makeRenderer();

    const result = await runApiWorkerTurn({
      manifest,
      request: { id: 'r1' },
      loop: { controller: {} },
      workerRecord: makeWorkerRecord(),
      prompt: 'explore the project',
      renderer,
      emitEvent: noopEmit,
    });

    assert.equal(callCount, 3, 'should make 3 API calls');
    assert.equal(result.resultText, 'Done reading everything.');
  });
});

describe('API Worker — tool error recovery', () => {
  it('sends error back to LLM and recovers', async () => {
    const { runApiWorkerTurn } = require('../../src/api-worker');
    let callCount = 0;
    const manifest = makeManifest((_req, body) => {
      callCount++;
      if (callCount === 1) {
        return { toolCalls: [{ id: 'c1', name: 'read_file', arguments: { path: 'nonexistent.txt' } }] };
      }
      return { text: 'File not found, trying another approach.' };
    });
    const renderer = makeRenderer();

    const result = await runApiWorkerTurn({
      manifest,
      request: { id: 'r1' },
      loop: { controller: {} },
      workerRecord: makeWorkerRecord(),
      prompt: 'read something',
      renderer,
      emitEvent: noopEmit,
    });

    assert.equal(callCount, 2);
    assert.ok(result.resultText.includes('another approach'));
  });
});

describe('API Worker — streaming events', () => {
  it('streams text deltas to renderer', async () => {
    const { runApiWorkerTurn } = require('../../src/api-worker');
    const manifest = makeManifest(() => ({ text: 'word1 word2 word3 word4' }));
    const renderer = makeRenderer();

    await runApiWorkerTurn({
      manifest,
      request: { id: 'r1' },
      loop: { controller: {} },
      workerRecord: makeWorkerRecord(),
      prompt: 'hi',
      renderer,
      emitEvent: noopEmit,
    });

    const streams = renderer.output.filter(o => o.type === 'stream');
    assert.ok(streams.length > 1, 'should have multiple stream events (chunked)');
  });
});

describe('API Worker — transcript-backed replay', () => {
  it('replays prior screenshot tool results as image messages on later turns', async () => {
    const { runApiWorkerTurn } = require('../../src/api-worker');
    let apiCalls = [];
    const mcpServer = http.createServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', () => {
        const parsed = JSON.parse(body || '{}');
        if (parsed.method === 'tools/list') {
          res.setHeader('content-type', 'application/json');
          res.end(JSON.stringify({
            jsonrpc: '2.0',
            id: parsed.id,
            result: {
              tools: [{
                name: 'take_screenshot',
                description: 'Take a screenshot',
                inputSchema: { type: 'object', properties: {} },
              }],
            },
          }));
          return;
        }
        if (parsed.method === 'tools/call') {
          res.setHeader('content-type', 'application/json');
          res.end(JSON.stringify({
            jsonrpc: '2.0',
            id: parsed.id,
            result: {
              content: [{ type: 'image', mimeType: 'image/png', data: 'ZmFrZS1pbWFnZQ==' }],
            },
          }));
          return;
        }
        res.statusCode = 404;
        res.end();
      });
    });
    await new Promise((resolve) => mcpServer.listen(0, '127.0.0.1', resolve));
    const address = mcpServer.address();
    const manifest = makeManifest((_req, body) => {
      apiCalls.push(body);
      if (apiCalls.length === 1) {
        return {
          toolCalls: [{ id: 'shot_1', name: 'chrome_devtools__take_screenshot', arguments: {} }],
        };
      }
      if (apiCalls.length === 2) {
        return { text: 'Captured the screenshot.' };
      }
      return { text: 'The previous screenshot is still available.' };
    });
    manifest.workerMcpServers = {
      'chrome-devtools': {
        url: `http://127.0.0.1:${address.port}/mcp`,
      },
    };

    try {
      await runApiWorkerTurn({
        manifest,
        request: { id: 'r1' },
        loop: { index: 1, controller: {} },
        workerRecord: makeWorkerRecord(),
        prompt: 'take a screenshot',
        renderer: makeRenderer(),
        emitEvent: noopEmit,
      });

      await runApiWorkerTurn({
        manifest,
        request: { id: 'r2' },
        loop: { index: 2, controller: {} },
        workerRecord: makeWorkerRecord(),
        prompt: 'can you still see the previous screenshot?',
        renderer: makeRenderer(),
        emitEvent: noopEmit,
      });
    } finally {
      await new Promise((resolve) => mcpServer.close(resolve));
    }

    assert.equal(apiCalls.length, 3);
    const secondTurnMessages = apiCalls[2].messages;
    assert.ok(
      secondTurnMessages.some((msg) =>
        msg.role === 'user' &&
        Array.isArray(msg.content) &&
        msg.content.some((part) => part.type === 'image_url')
      ),
      'second turn should include the previous screenshot as an image message'
    );

    const replay = buildSessionReplay(transcriptEntries(manifest), 'worker:default');
    assert.ok(
      replay.some((msg) =>
        msg.role === 'user' &&
        Array.isArray(msg.content) &&
        msg.content.some((part) => part.type === 'image_url')
      ),
      'canonical transcript replay should preserve screenshot history'
    );
  });
});

describe('API Worker — live card rendering for prefixed MCP tools', () => {
  it('renders MCP cards for chrome_devtools tool names during the live API run', async () => {
    const { runApiWorkerTurn } = require('../../src/api-worker');
    let apiCalls = 0;
    const mcpServer = http.createServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', () => {
        const parsed = JSON.parse(body || '{}');
        if (parsed.method === 'tools/list') {
          res.setHeader('content-type', 'application/json');
          res.end(JSON.stringify({
            jsonrpc: '2.0',
            id: parsed.id,
            result: {
              tools: [{
                name: 'list_pages',
                description: 'List pages',
                inputSchema: { type: 'object', properties: {} },
              }],
            },
          }));
          return;
        }
        if (parsed.method === 'tools/call') {
          res.setHeader('content-type', 'application/json');
          res.end(JSON.stringify({
            jsonrpc: '2.0',
            id: parsed.id,
            result: {
              content: [{ type: 'text', text: 'Listed 1 page.' }],
            },
          }));
          return;
        }
        res.statusCode = 404;
        res.end();
      });
    });
    await new Promise((resolve) => mcpServer.listen(0, '127.0.0.1', resolve));
    const address = mcpServer.address();
    const manifest = makeManifest(() => {
      apiCalls++;
      if (apiCalls === 1) {
        return {
          toolCalls: [{ id: 'pages_1', name: 'chrome_devtools__list_pages', arguments: {} }],
        };
      }
      return { text: 'There is one page open.' };
    });
    manifest.workerMcpServers = {
      'chrome-devtools': {
        url: `http://127.0.0.1:${address.port}/mcp`,
      },
    };
    const renderer = makeRenderer();

    try {
      await runApiWorkerTurn({
        manifest,
        request: { id: 'r1' },
        loop: { index: 1, controller: {} },
        workerRecord: makeWorkerRecord(),
        prompt: 'list the browser pages',
        renderer,
        emitEvent: noopEmit,
      });
    } finally {
      await new Promise((resolve) => mcpServer.close(resolve));
    }

    assert.ok(renderer.output.some((msg) => msg.type === 'mcpCardStart' && msg.text === 'Listing pages'));
    assert.ok(renderer.output.some((msg) => msg.type === 'mcpCardComplete' && msg.text === 'Listed pages'));
    assert.ok(!renderer.output.some((msg) => msg.type === 'claude' && /Calling chrome_devtools__list_pages/.test(msg.text || '')));
  });
});

describe('API Worker - canonical cc-tests card rendering', () => {
  it('renders progress cards without appending permanent test cards from mutation results', async () => {
    const { runApiWorkerTurn } = require('../../src/api-worker');
    let apiCalls = 0;
    const mcpServer = http.createServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', () => {
        const parsed = JSON.parse(body || '{}');
        if (parsed.method === 'tools/list') {
          res.setHeader('content-type', 'application/json');
          res.end(JSON.stringify({
            jsonrpc: '2.0',
            id: parsed.id,
            result: {
              tools: [{
                name: 'update_step_result',
                description: 'Update step result',
                inputSchema: { type: 'object', properties: {} },
              }],
            },
          }));
          return;
        }
        if (parsed.method === 'tools/call') {
          res.setHeader('content-type', 'application/json');
          res.end(JSON.stringify({
            jsonrpc: '2.0',
            id: parsed.id,
            result: {
              content: [{
                type: 'text',
                text: JSON.stringify({
                  step_id: 1,
                  status: 'pass',
                  _testCard: {
                    title: 'Consent dialog',
                    test_id: 'test-1',
                    passed: 1,
                    failed: 0,
                    skipped: 0,
                    steps: [{ name: 'Open page', status: 'pass' }],
                  },
                }),
              }],
            },
          }));
          return;
        }
        res.statusCode = 404;
        res.end();
      });
    });
    await new Promise((resolve) => mcpServer.listen(0, '127.0.0.1', resolve));
    const address = mcpServer.address();
    const manifest = makeManifest(() => {
      apiCalls++;
      if (apiCalls === 1) {
        return {
          toolCalls: [{
            id: 'step_1',
            name: 'cc_tests__update_step_result',
            arguments: { test_id: 'test-1', run_id: 1, step_id: 1, status: 'pass' },
          }],
        };
      }
      return { text: 'Step recorded.' };
    });
    manifest.workerMcpServers = {
      'cc-tests': {
        url: `http://127.0.0.1:${address.port}/mcp`,
      },
    };
    const renderer = makeRenderer();

    try {
      await runApiWorkerTurn({
        manifest,
        request: { id: 'r1' },
        loop: { index: 1, controller: {} },
        workerRecord: makeWorkerRecord(),
        prompt: 'record the passing step',
        renderer,
        emitEvent: noopEmit,
      });
    } finally {
      await new Promise((resolve) => mcpServer.close(resolve));
    }

    assert.ok(renderer.output.some((msg) => msg.type === 'mcpCardStart' && msg.text === 'Updating step result'));
    assert.ok(renderer.output.some((msg) => msg.type === 'mcpCardComplete' && msg.text === 'Step result updated'));
    assert.ok(renderer.output.some((msg) => msg.type === 'liveEntityCard' && msg.entityType === 'test' && msg.data && msg.data.test_id === 'test-1'));
    assert.equal(renderer.output.filter((msg) => msg.type === 'testCard').length, 0);
  });
});

describe('API Worker - unlimited tool iterations', () => {
  it('continues beyond 50 tool rounds until the model stops naturally', async () => {
    const { runApiWorkerTurn } = require('../../src/api-worker');
    let apiCalls = 0;
    const mcpServer = http.createServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', () => {
        const parsed = JSON.parse(body || '{}');
        if (parsed.method === 'tools/list') {
          res.setHeader('content-type', 'application/json');
          res.end(JSON.stringify({
            jsonrpc: '2.0',
            id: parsed.id,
            result: {
              tools: [{
                name: 'list_pages',
                description: 'List pages',
                inputSchema: { type: 'object', properties: {} },
              }],
            },
          }));
          return;
        }
        if (parsed.method === 'tools/call') {
          res.setHeader('content-type', 'application/json');
          res.end(JSON.stringify({
            jsonrpc: '2.0',
            id: parsed.id,
            result: {
              content: [{ type: 'text', text: 'Listed pages.' }],
            },
          }));
          return;
        }
        res.statusCode = 404;
        res.end();
      });
    });
    await new Promise((resolve) => mcpServer.listen(0, '127.0.0.1', resolve));
    const address = mcpServer.address();
    const manifest = makeManifest(() => {
      apiCalls++;
      if (apiCalls <= 55) {
        return {
          toolCalls: [{ id: `pages_${apiCalls}`, name: 'chrome_devtools__list_pages', arguments: {} }],
        };
      }
      return { text: 'Finished after many tool calls.' };
    });
    manifest.workerMcpServers = {
      'chrome-devtools': {
        url: `http://127.0.0.1:${address.port}/mcp`,
      },
    };
    const renderer = makeRenderer();

    try {
      const result = await runApiWorkerTurn({
        manifest,
        request: { id: 'r1' },
        loop: { index: 1, controller: {} },
        workerRecord: makeWorkerRecord(),
        prompt: 'keep listing pages until done',
        renderer,
        emitEvent: noopEmit,
      });
      assert.equal(result.resultText, 'Finished after many tool calls.');
    } finally {
      await new Promise((resolve) => mcpServer.close(resolve));
    }

    assert.equal(apiCalls, 56);
    assert.ok(!renderer.output.some((msg) => msg.type === 'claude' && /reached maximum tool call iterations/i.test(msg.text || '')));
  });
});

describe('API Worker — transcript prompt dedupe', () => {
  it('does not append a duplicate direct-turn user_message when the request prompt is already in transcript', async () => {
    const { runApiWorkerTurn } = require('../../src/api-worker');
    const manifest = makeManifest(() => ({ text: 'Hello again.' }));
    const existingPrompt = createTranscriptRecord({
      kind: 'user_message',
      sessionKey: 'worker:default',
      backend: 'user',
      requestId: 'r1',
      loopIndex: null,
      text: 'hi',
      payload: { role: 'user', content: 'hi' },
    });
    fs.appendFileSync(manifest.files.transcript, JSON.stringify(existingPrompt) + '\n');

    await runApiWorkerTurn({
      manifest,
      request: { id: 'r1' },
      loop: { index: 1, controller: {} },
      workerRecord: makeWorkerRecord(),
      prompt: 'hi',
      renderer: makeRenderer(),
      emitEvent: noopEmit,
    });

    const userEntries = transcriptEntries(manifest).filter((entry) =>
      entry.kind === 'user_message' &&
      entry.sessionKey === 'worker:default' &&
      entry.requestId === 'r1'
    );
    assert.equal(userEntries.length, 1, 'should keep only the original visible user message');
  });
});

describe('API Worker — abort signal', () => {
  it('stops on abort', async () => {
    const { runApiWorkerTurn } = require('../../src/api-worker');
    const ac = new AbortController();
    // Abort immediately
    ac.abort();

    const manifest = makeManifest(() => ({ text: 'should not see this' }));
    const renderer = makeRenderer();

    const result = await runApiWorkerTurn({
      manifest,
      request: { id: 'r1' },
      loop: { controller: {} },
      workerRecord: makeWorkerRecord(),
      prompt: 'hi',
      renderer,
      emitEvent: noopEmit,
      abortSignal: ac.signal,
    });

    assert.ok(renderer.output.some(o => o.text && o.text.includes('aborted')));
  });
});
