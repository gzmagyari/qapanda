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
const { createEmptyUsageSummary } = require('../../src/usage-summary');

let mock;
let tmpDir;

before(async () => {
  mock = await createMockServer();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qp-apiw-test-'));
  fs.writeFileSync(path.join(tmpDir, 'sample.txt'), 'hello from sample\nsecond line\n');
  fs.mkdirSync(path.join(tmpDir, '.qpanda', 'runs', 'test-run'), { recursive: true });
  fs.writeFileSync(path.join(tmpDir, '.qpanda', 'runs', 'test-run', 'transcript.jsonl'), '');
});

describe('API Worker - lazy MCP tools', () => {
  it('starts with only search_mcp_tools, then activates and persists matched tools', async () => {
    const { runApiWorkerTurn } = require('../../src/api-worker');
    const builtinServerPath = path.resolve(__dirname, '../../extension/builtin-tools-mcp-server.js');
    const seenTools = [];
    let apiCalls = 0;
    const manifest = makeManifest((_req, body) => {
      apiCalls += 1;
      seenTools.push((body.tools || []).map((tool) => tool.function && tool.function.name).filter(Boolean));
      if (apiCalls === 1) {
        return {
          toolCalls: [{ id: 'search_1', name: 'search_mcp_tools', arguments: { query: 'read file' } }],
        };
      }
      if (apiCalls === 2) {
        return {
          toolCalls: [{ id: 'read_1', name: 'builtin_tools__read_file', arguments: { path: 'sample.txt' } }],
        };
      }
      if (apiCalls === 3) {
        return { text: 'Read the sample file.' };
      }
      return { text: 'The read tool is still available.' };
    });
    manifest.lazyMcpToolsEnabled = true;
    manifest.agents = {
      dev: {
        id: 'dev',
        name: 'Developer',
        cli: 'api',
        apiLazyTools: true,
      },
    };
    manifest.workerMcpServers = {
      'builtin-tools': { command: 'node', args: [builtinServerPath], env: { CWD: tmpDir } },
    };

    await runApiWorkerTurn({
      manifest,
      request: { id: 'r1' },
      loop: { index: 1, controller: {} },
      workerRecord: makeWorkerRecord(),
      prompt: 'find and read the sample file',
      renderer: makeRenderer(),
      emitEvent: noopEmit,
      agentId: 'dev',
    });

    await runApiWorkerTurn({
      manifest,
      request: { id: 'r2' },
      loop: { index: 2, controller: {} },
      workerRecord: makeWorkerRecord(),
      prompt: 'is the read tool still visible?',
      renderer: makeRenderer(),
      emitEvent: noopEmit,
      agentId: 'dev',
    });

    assert.equal(seenTools[0].includes('search_mcp_tools'), true);
    assert.deepEqual(seenTools[0], ['search_mcp_tools']);
    assert.equal(seenTools[0].includes('builtin_tools__read_file'), false);
    assert.equal(seenTools[1].includes('builtin_tools__read_file'), true);
    assert.equal(seenTools[3].includes('builtin_tools__read_file'), true);
    assert.ok(manifest.worker.agentSessions.dev.apiVisibleToolNames.includes('builtin_tools__read_file'));
  });

  it('rejects fabricated hidden tool calls until they are activated', async () => {
    const { runApiWorkerTurn } = require('../../src/api-worker');
    const builtinServerPath = path.resolve(__dirname, '../../extension/builtin-tools-mcp-server.js');
    let apiCalls = 0;
    const manifest = makeManifest(() => {
      apiCalls += 1;
      if (apiCalls === 1) {
        return {
          toolCalls: [{ id: 'read_hidden', name: 'builtin_tools__read_file', arguments: { path: 'sample.txt' } }],
        };
      }
      return { text: 'Handled the hidden-tool error.' };
    });
    manifest.lazyMcpToolsEnabled = true;
    manifest.agents = {
      dev: {
        id: 'dev',
        name: 'Developer',
        cli: 'api',
        apiLazyTools: true,
      },
    };
    manifest.workerMcpServers = {
      'builtin-tools': { command: 'node', args: [builtinServerPath], env: { CWD: tmpDir } },
    };

    await runApiWorkerTurn({
      manifest,
      request: { id: 'r-hidden' },
      loop: { index: 1, controller: {} },
      workerRecord: makeWorkerRecord(),
      prompt: 'call a hidden tool directly',
      renderer: makeRenderer(),
      emitEvent: noopEmit,
      agentId: 'dev',
    });

    const entries = transcriptEntries(manifest);
    const hiddenToolResult = entries.find((entry) => entry.kind === 'tool_result' && entry.toolName === 'builtin_tools__read_file');
    assert.ok(hiddenToolResult);
    assert.equal(hiddenToolResult.result && hiddenToolResult.result.isError, true);
    assert.match(JSON.stringify(hiddenToolResult.result), /search_mcp_tools/i);
  });

  it('injects a grouped MCP capability index into the lazy API worker system prompt', async () => {
    const { runApiWorkerTurn } = require('../../src/api-worker');
    const builtinServerPath = path.resolve(__dirname, '../../extension/builtin-tools-mcp-server.js');
    const seenSystemPrompts = [];
    const taskServer = http.createServer((req, res) => {
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
              tools: [
                {
                  name: 'search_tasks',
                  description: 'Search tasks',
                  inputSchema: { type: 'object', properties: {} },
                },
                {
                  name: 'add_comment',
                  description: 'Add a comment',
                  inputSchema: { type: 'object', properties: {} },
                },
              ],
            },
          }));
          return;
        }
        res.statusCode = 404;
        res.end();
      });
    });
    await new Promise((resolve) => taskServer.listen(0, '127.0.0.1', resolve));
    const address = taskServer.address();
    const manifest = makeManifest((_req, body) => {
      seenSystemPrompts.push(body.messages[0].content);
      return { text: 'ok' };
    });
    manifest.lazyMcpToolsEnabled = true;
    manifest.agents = {
      'QA-Browser': {
        id: 'QA-Browser',
        name: 'QA Engineer (Browser)',
        cli: 'api',
        apiLazyTools: true,
      },
    };
    manifest.workerMcpServers = {
      'builtin-tools': { command: 'node', args: [builtinServerPath], env: { CWD: tmpDir } },
      cc_tasks: { url: `http://127.0.0.1:${address.port}/mcp` },
    };

    try {
      await runApiWorkerTurn({
        manifest,
        request: { id: 'r-cap-1' },
        loop: { index: 1, controller: {} },
        workerRecord: makeWorkerRecord(),
        prompt: 'hi',
        renderer: makeRenderer(),
        emitEvent: noopEmit,
        agentId: 'QA-Browser',
      });

      await runApiWorkerTurn({
        manifest,
        request: { id: 'r-cap-2' },
        loop: { index: 2, controller: {} },
        workerRecord: makeWorkerRecord(),
        prompt: 'hi again',
        renderer: makeRenderer(),
        emitEvent: noopEmit,
        agentId: 'QA-Browser',
      });
    } finally {
      await new Promise((resolve) => taskServer.close(resolve));
    }

    assert.equal(seenSystemPrompts.length, 2);
    assert.equal(seenSystemPrompts[0], seenSystemPrompts[1]);
    assert.match(seenSystemPrompts[0], /only one visible tool: `search_mcp_tools`/);
    assert.match(seenSystemPrompts[0], /## MCP Capability Index/);
    assert.match(seenSystemPrompts[0], /builtin-tools: .*grep_search.*read_file/i);
    assert.match(seenSystemPrompts[0], /cc_tasks: add_comment, search_tasks/);
    assert.doesNotMatch(seenSystemPrompts[0], /cc_tasks__search_tasks/);
  });
});
after(async () => {
  if (mock) await mock.close();
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
});

// Minimal manifest/renderer stubs
function makeManifest(handlerOverride) {
  if (handlerOverride) mock.setHandler(handlerOverride);
  fs.writeFileSync(path.join(tmpDir, '.qpanda', 'runs', 'test-run', 'transcript.jsonl'), '');
  const runDir = path.join(tmpDir, '.qpanda', 'runs', 'test-run');
  return {
    runId: 'test-run',
    repoRoot: tmpDir,
    stateRoot: path.join(tmpDir, '.qpanda'),
    runDir,
    files: {
      manifest: path.join(runDir, 'manifest.json'),
      events: path.join(runDir, 'events.jsonl'),
      transcript: path.join(tmpDir, '.qpanda', 'runs', 'test-run', 'transcript.jsonl'),
      chatLog: path.join(runDir, 'chat.jsonl'),
      progress: path.join(runDir, 'progress.md'),
    },
    controller: {
      apiConfig: null,
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
    lazyMcpToolsEnabled: false,
    usageSummary: createEmptyUsageSummary(),
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
    usageStats: (summary) => output.push({ type: 'usageStats', summary }),
  };
}

function makeWorkerRecord(overrides = {}) { return { ...overrides }; }
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

  it('writes per-iteration API request/response logs with finish reason', async () => {
    const { runApiWorkerTurn } = require('../../src/api-worker');
    const manifest = makeManifest(() => ({ text: 'logged response' }));
    const renderer = makeRenderer();
    const loopDir = path.join(tmpDir, '.qpanda', 'runs', 'test-run', 'requests', 'r-log', 'loop-0001');
    fs.mkdirSync(loopDir, { recursive: true });
    const workerRecord = makeWorkerRecord({
      promptFile: path.join(loopDir, 'worker.prompt.txt'),
    });

    const result = await runApiWorkerTurn({
      manifest,
      request: { id: 'r-log' },
      loop: { index: 1, controller: { promptFile: path.join(loopDir, 'controller.prompt.txt') } },
      workerRecord,
      prompt: 'log this API call',
      renderer,
      emitEvent: noopEmit,
    });

    assert.equal(result.resultText, 'logged response');
    const requestLogPath = path.join(loopDir, 'worker.api.iter-0001.request.json');
    const responseLogPath = path.join(loopDir, 'worker.api.iter-0001.response.jsonl');
    assert.equal(fs.existsSync(requestLogPath), true, 'should write request log');
    assert.equal(fs.existsSync(responseLogPath), true, 'should write response log');
    const requestLog = JSON.parse(fs.readFileSync(requestLogPath, 'utf8'));
    assert.equal(requestLog.provider, 'custom');
    assert.equal(requestLog.model, 'test-model');
    const responseLines = fs.readFileSync(responseLogPath, 'utf8').trim().split(/\r?\n/).map((line) => JSON.parse(line));
    const doneLine = responseLines.find((line) => line.type === 'done');
    assert.ok(doneLine, 'should include done summary');
    assert.equal(doneLine.finishReason, 'stop');
  });

  it('reuses the first API worker system prompt snapshot for the same agent session', async () => {
    const { runApiWorkerTurn } = require('../../src/api-worker');
    const seenSystemPrompts = [];
    const manifest = makeManifest((_req, body) => {
      seenSystemPrompts.push(body.messages[0].content);
      return { text: 'ok' };
    });
    manifest.agents = {
      dev: {
        id: 'dev',
        name: 'Developer',
        cli: 'api',
        system_prompt: 'First prompt snapshot',
      },
    };
    const renderer = makeRenderer();

    await runApiWorkerTurn({
      manifest,
      request: { id: 'r1' },
      loop: { index: 1, controller: {} },
      workerRecord: makeWorkerRecord(),
      prompt: 'first',
      renderer,
      emitEvent: noopEmit,
      agentId: 'dev',
    });

    manifest.agents.dev.system_prompt = 'Changed prompt later';

    await runApiWorkerTurn({
      manifest,
      request: { id: 'r2' },
      loop: { index: 2, controller: {} },
      workerRecord: makeWorkerRecord(),
      prompt: 'second',
      renderer,
      emitEvent: noopEmit,
      agentId: 'dev',
    });

    assert.equal(seenSystemPrompts.length, 2);
    assert.equal(seenSystemPrompts[0], seenSystemPrompts[1]);
    assert.match(seenSystemPrompts[0], /First prompt snapshot/);
    assert.doesNotMatch(seenSystemPrompts[1], /Changed prompt later/);
  });

  it('persists per-iteration usage summary to the manifest and renderer', async () => {
    const { runApiWorkerTurn } = require('../../src/api-worker');
    const manifest = makeManifest(() => ({
      text: 'usage tracked',
      usage: {
        prompt_tokens: 120,
        completion_tokens: 30,
        total_tokens: 150,
        prompt_tokens_details: {
          cached_tokens: 90,
          cache_write_tokens: 10,
        },
        cost: 0.0123,
        cost_details: {
          upstream_inference_prompt_cost: 0.01,
          upstream_inference_completions_cost: 0.0023,
        },
      },
    }));
    const renderer = makeRenderer();

    await runApiWorkerTurn({
      manifest,
      request: { id: 'r-usage' },
      loop: { index: 1, controller: {} },
      workerRecord: makeWorkerRecord(),
      prompt: 'track usage',
      renderer,
      emitEvent: noopEmit,
    });

    assert.equal(manifest.usageSummary.totalCostUsd, 0.0123);
    assert.equal(manifest.usageSummary.promptCostUsd, 0.01);
    assert.equal(manifest.usageSummary.completionCostUsd, 0.0023);
    assert.equal(manifest.usageSummary.promptTokens, 120);
    assert.equal(manifest.usageSummary.completionTokens, 30);
    assert.equal(manifest.usageSummary.cachedTokens, 90);
    assert.equal(manifest.usageSummary.cacheWriteTokens, 10);
    assert.equal(manifest.usageSummary.byActor.worker.totalCostUsd, 0.0123);
    assert.equal(fs.existsSync(manifest.files.manifest), true, 'should persist manifest updates');
    const usageMsg = renderer.output.find((entry) => entry.type === 'usageStats');
    assert.ok(usageMsg, 'should push live usage summary to the renderer');
    assert.equal(usageMsg.summary.totalCostUsd, 0.0123);
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
  it('replays screenshots inline only on the immediate next API turn', async () => {
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
    const immediateFollowupMessages = apiCalls[1].messages;
    assert.ok(
      immediateFollowupMessages.some((msg) =>
        msg.role === 'user' &&
        Array.isArray(msg.content) &&
        msg.content.some((part) => part.type === 'image_url')
      ),
      'the immediate follow-up turn should include the fresh screenshot as an image message'
    );

    const secondTurnMessages = apiCalls[2].messages;
    assert.equal(
      secondTurnMessages.some((msg) =>
        msg.role === 'user' &&
        Array.isArray(msg.content) &&
        msg.content.some((part) => part.type === 'image_url')
      ),
      false,
      'later requests should not replay the previous screenshot as an image message'
    );

    const canonicalReplay = buildSessionReplay(transcriptEntries(manifest), 'worker:default', {
      inlineImageReplayMode: 'tail-only',
    });
    assert.equal(
      canonicalReplay.some((msg) =>
        msg.role === 'user' &&
        Array.isArray(msg.content) &&
        msg.content.some((part) => part.type === 'image_url')
      ),
      false,
      'canonical replay should downgrade old screenshots to text provenance'
    );
  });

  it('passes per-agent API compaction thresholds into compaction', async () => {
    const { runApiWorkerTurn } = require('../../src/api-worker');
    let capturedTriggerMessages = null;
    const manifest = makeManifest(() => ({ text: 'ok' }));
    manifest.agents = {
      dev: {
        id: 'dev',
        name: 'Developer',
        cli: 'api',
        apiCompactionTriggerMessages: 123,
      },
    };

    await runApiWorkerTurn({
      manifest,
      request: { id: 'r1' },
      loop: { index: 1, controller: {} },
      workerRecord: makeWorkerRecord(),
      prompt: 'hi',
      renderer: makeRenderer(),
      emitEvent: noopEmit,
      agentId: 'dev',
      compactSessionHistory: async (options) => {
        capturedTriggerMessages = options.triggerMessages;
        return { performed: false, reason: 'below-threshold', replayMessageCount: 1 };
      },
    });

    assert.equal(capturedTriggerMessages, 123);
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
