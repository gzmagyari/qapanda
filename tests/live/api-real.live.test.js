/**
 * Real API live tests — uses actual OpenRouter API to verify the full pipeline.
 * These tests consume real API tokens. Skip with SKIP_REAL_API=1.
 *
 * Requires OPENROUTER_API_KEY environment variable.
 */
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createApiTestDir, createApiTestRenderer, createEventCollector } = require('../helpers/api-test-utils');
const { runApiWorkerTurn } = require('../../src/api-worker');
const { runApiControllerTurn } = require('../../src/api-controller');
const { loadAllTools } = require('../../src/mcp-tool-bridge');

// Load API key from CopilotClone .env or environment
let API_KEY = process.env.OPENROUTER_API_KEY;
if (!API_KEY) {
  try {
    const envFile = fs.readFileSync('C:\\xampp\\htdocs\\CopilotClone\\.env', 'utf8');
    const match = envFile.match(/^OPENROUTER_API_KEY=(.+)$/m);
    if (match) API_KEY = match[1].trim();
  } catch {}
}

const SKIP = process.env.SKIP_REAL_API === '1' || !API_KEY;
const MODEL = 'openai/gpt-4.1-mini'; // cheap and fast

let tmp;
before(() => { tmp = createApiTestDir(); });
after(() => { if (tmp) tmp.cleanup(); });

function makeManifest(overrides = {}) {
  const apiConfig = {
    provider: 'openrouter',
    apiKey: API_KEY,
    model: MODEL,
  };
  return {
    runId: 'real-test',
    repoRoot: tmp.dir,
    stateRoot: path.join(tmp.dir, '.qpanda'),
    runDir: path.join(tmp.dir, '.qpanda', 'runs', 'real-test'),
    controller: {
      cli: 'api', bin: 'api', model: null, sessionId: null,
      claudeSessionId: null, lastSeenChatLine: 0, codexMode: 'app-server',
      appServerThreadId: null, config: [], apiConfig,
    },
    worker: {
      cli: 'api', bin: 'api', model: null, sessionId: 'real-sess',
      allowedTools: 'Bash,Read,Edit', runMode: 'print', agentSessions: {},
      apiConfig,
    },
    apiConfig,
    agents: {
      dev: { name: 'Developer', description: 'Dev', system_prompt: 'You are a helpful developer. Be very concise.', mcps: {}, cli: 'api', enabled: true },
      'QA-Browser': { name: 'QA Engineer', description: 'QA', system_prompt: 'You are a QA engineer. Be very concise.', mcps: {}, cli: 'api', enabled: true },
    },
    settings: { rawEvents: false, quiet: false, color: true },
    mcpServers: {}, controllerMcpServers: {}, workerMcpServers: {},
    controllerSystemPrompt: null, selfTesting: false, panelId: 'test',
    files: {
      events: path.join(tmp.dir, '.qpanda', 'runs', 'real-test', 'events.jsonl'),
      transcript: path.join(tmp.dir, '.qpanda', 'runs', 'real-test', 'transcript.jsonl'),
    },
    counters: { request: 1, loop: 1, controllerTurn: 0, workerTurn: 0 },
    requests: [],
    ...overrides,
  };
}

describe('Real API — Worker simple response', { skip: SKIP ? 'No OPENROUTER_API_KEY' : false }, () => {
  it('responds to a simple question with streaming text', async () => {
    const manifest = makeManifest();
    const renderer = createApiTestRenderer();
    const result = await runApiWorkerTurn({
      manifest, request: { id: 'r1' }, loop: { controller: {} },
      workerRecord: {}, prompt: 'What is 2+2? Reply with just the number.',
      renderer, emitEvent: () => {},
    });
    assert.ok(result.resultText.includes('4'), 'should contain the answer 4, got: ' + result.resultText);
    assert.ok(renderer.output.some(o => o.type === 'stream'), 'should have streamed');
  });
});

describe('Real API — Worker tool calling (read_file)', { skip: SKIP ? 'No OPENROUTER_API_KEY' : false }, () => {
  it('reads a file using the read_file tool', async () => {
    const manifest = makeManifest();
    const renderer = createApiTestRenderer();
    const collector = createEventCollector();
    const result = await runApiWorkerTurn({
      manifest, request: { id: 'r1' }, loop: { controller: {} },
      workerRecord: {},
      prompt: 'Read the file hello.txt in the current directory and tell me what it says. Use the read_file tool.',
      renderer, emitEvent: collector.emit,
    });
    // The model should have called read_file and seen "Hello world"
    assert.ok(result.resultText.toLowerCase().includes('hello') || result.resultText.includes('Hello'),
      'should mention file content, got: ' + result.resultText.slice(0, 200));
    // Verify tool was called
    const toolEvents = collector.events.filter(e => e.type === 'tool_call');
    assert.ok(toolEvents.length > 0, 'should have called at least one tool');
    assert.ok(toolEvents.some(e => e.name === 'read_file'), 'should have called read_file');
  });
});

describe('Real API — Worker tool calling (list_directory)', { skip: SKIP ? 'No OPENROUTER_API_KEY' : false }, () => {
  it('lists directory contents', async () => {
    const manifest = makeManifest();
    const renderer = createApiTestRenderer();
    const result = await runApiWorkerTurn({
      manifest, request: { id: 'r1' }, loop: { controller: {} },
      workerRecord: {},
      prompt: 'List all files in the current directory using the list_directory tool. Then tell me what you found.',
      renderer, emitEvent: () => {},
    });
    assert.ok(
      result.resultText.includes('hello') || result.resultText.includes('code') || result.resultText.includes('subdir'),
      'should mention files found, got: ' + result.resultText.slice(0, 200)
    );
  });
});

describe('Real API — Worker tool calling (run_command)', { skip: SKIP ? 'No OPENROUTER_API_KEY' : false }, () => {
  it('executes a shell command', async () => {
    const manifest = makeManifest();
    const renderer = createApiTestRenderer();
    const result = await runApiWorkerTurn({
      manifest, request: { id: 'r1' }, loop: { controller: {} },
      workerRecord: {},
      prompt: 'Run the command "echo real_api_test_success" using the run_command tool and tell me the output.',
      renderer, emitEvent: () => {},
    });
    assert.ok(result.resultText.includes('real_api_test_success') || result.resultText.includes('success'),
      'should report command output, got: ' + result.resultText.slice(0, 200));
  });
});

describe('Real API — Worker multi-turn tool loop', { skip: SKIP ? 'No OPENROUTER_API_KEY' : false }, () => {
  it('reads multiple files in sequence', async () => {
    const manifest = makeManifest();
    const renderer = createApiTestRenderer();
    const collector = createEventCollector();
    const result = await runApiWorkerTurn({
      manifest, request: { id: 'r1' }, loop: { controller: {} },
      workerRecord: {},
      prompt: 'First list the directory, then read hello.txt and code.js. Tell me what each file contains. Use the tools.',
      renderer, emitEvent: collector.emit,
    });
    const toolCalls = collector.events.filter(e => e.type === 'tool_call');
    assert.ok(toolCalls.length >= 2, 'should have made at least 2 tool calls, got: ' + toolCalls.length);
    assert.ok(result.resultText.length > 20, 'should have a meaningful response');
  });
});

describe('Real API — Worker knows all built-in tools', { skip: SKIP ? 'No OPENROUTER_API_KEY' : false }, () => {
  it('lists all 7 built-in tools by name', async () => {
    const manifest = makeManifest();
    const renderer = createApiTestRenderer();
    const result = await runApiWorkerTurn({
      manifest, request: { id: 'r1' }, loop: { controller: {} },
      workerRecord: {},
      prompt: 'List ALL the tool/function names you have access to. Output ONLY the exact function names, one per line, nothing else.',
      renderer, emitEvent: () => {},
    });
    const text = result.resultText.toLowerCase();
    const expected = ['read_file', 'write_file', 'edit_file', 'run_command', 'glob_search', 'grep_search', 'list_directory'];
    const found = expected.filter(t => text.includes(t));
    const missing = expected.filter(t => !text.includes(t));
    assert.ok(found.length >= 5,
      `should find at least 5 of 7 built-in tools. Found: [${found.join(', ')}]. Missing: [${missing.join(', ')}]. Response: ${result.resultText.slice(0, 400)}`);
  });
});

describe('Real API — Worker with MCP tools injected', { skip: SKIP ? 'No OPENROUTER_API_KEY' : false }, () => {
  it('sees both built-in and MCP tools', async () => {
    // Start a fresh tests MCP HTTP server (avoid singleton issues)
    const http = require('node:http');
    const { createMcpHttpServer } = require('../../extension/mcp-http-server');
    const tasksFile = path.join(tmp.dir, '.qpanda', 'tasks.json');
    const testsFile = path.join(tmp.dir, '.qpanda', 'tests.json');
    fs.writeFileSync(tasksFile, JSON.stringify({ nextId: 1, tasks: [] }));
    fs.writeFileSync(testsFile, JSON.stringify({ nextId: 1, tests: [] }));

    // Minimal MCP with just 2 tools to keep it fast
    const mcpResult = await createMcpHttpServer({
      tools: [
        { name: 'list_tests', description: 'List all tests', inputSchema: { type: 'object', properties: {} } },
        { name: 'create_test', description: 'Create a test', inputSchema: { type: 'object', properties: { title: { type: 'string' } }, required: ['title'] } },
      ],
      handleToolCall: (name, args) => JSON.stringify({ ok: true, name }),
      serverName: 'test-mcp',
    });

    try {
      const manifest = makeManifest({
        workerMcpServers: {
          'test-mcp': { type: 'http', url: `http://127.0.0.1:${mcpResult.port}/mcp` },
        },
      });
      const renderer = createApiTestRenderer();
      const result = await runApiWorkerTurn({
        manifest, request: { id: 'r1' }, loop: { controller: {} },
        workerRecord: {},
        prompt: 'List ALL tool/function names you have access to. Output ONLY the exact function names, one per line.',
        renderer, emitEvent: () => {},
      });
      const text = result.resultText.toLowerCase();
      // Should have built-in tools
      assert.ok(text.includes('read_file'), 'should have read_file, got: ' + result.resultText.slice(0, 500));
      // Should have MCP tools (prefixed with test_mcp__)
      assert.ok(
        text.includes('test_mcp') || text.includes('list_tests') || text.includes('create_test'),
        'should have MCP tools, got: ' + result.resultText.slice(0, 500)
      );
    } finally {
      mcpResult.close();
    }
  });
});

describe('Real API — Worker calls HTTP MCP tool', { skip: SKIP ? 'No OPENROUTER_API_KEY' : false }, () => {
  it('calls an MCP tool and gets the result back', async () => {
    const { createMcpHttpServer } = require('../../extension/mcp-http-server');
    const taskStore = [];
    const mcpResult = await createMcpHttpServer({
      tools: [
        { name: 'create_task', description: 'Create a new task', inputSchema: { type: 'object', properties: { title: { type: 'string', description: 'Task title' } }, required: ['title'] } },
        { name: 'list_tasks', description: 'List all tasks', inputSchema: { type: 'object', properties: {} } },
      ],
      handleToolCall: (name, args) => {
        if (name === 'create_task') {
          const task = { id: taskStore.length + 1, title: args.title };
          taskStore.push(task);
          return JSON.stringify({ created: task });
        }
        if (name === 'list_tasks') return JSON.stringify(taskStore);
        return JSON.stringify({ error: 'unknown tool' });
      },
      serverName: 'task-mcp',
    });

    try {
      const manifest = makeManifest({
        workerMcpServers: {
          'task-mcp': { type: 'http', url: `http://127.0.0.1:${mcpResult.port}/mcp` },
        },
      });
      const renderer = createApiTestRenderer();
      const collector = createEventCollector();
      const result = await runApiWorkerTurn({
        manifest, request: { id: 'r1' }, loop: { controller: {} },
        workerRecord: {},
        prompt: 'Create a task with the title "Fix login bug" using the task_mcp__create_task tool. Then list all tasks using task_mcp__list_tasks. Report what you find.',
        renderer, emitEvent: collector.emit,
      });
      // Verify tool was called
      const toolEvents = collector.events.filter(e => e.type === 'tool_call');
      assert.ok(toolEvents.length >= 1, 'should have called at least 1 MCP tool, got: ' + toolEvents.length);
      assert.ok(
        toolEvents.some(e => e.name.includes('create_task')) || toolEvents.some(e => e.name.includes('list_task')),
        'should have called create_task or list_tasks MCP tool'
      );
      // Verify the task was actually created in the store
      assert.ok(taskStore.length >= 1, 'MCP tool should have created a task in the store');
      assert.ok(taskStore[0].title.includes('login') || taskStore[0].title.includes('Login') || taskStore[0].title.includes('bug'),
        'task title should mention login bug, got: ' + taskStore[0].title);
      // Verify LLM reported back
      assert.ok(result.resultText.length > 10, 'should have a meaningful response');
    } finally {
      mcpResult.close();
    }
  });
});

describe('Real API — Controller decision', { skip: SKIP ? 'No OPENROUTER_API_KEY' : false }, () => {
  it('returns a valid delegate or stop decision', async () => {
    const manifest = makeManifest();
    const renderer = createApiTestRenderer();
    const promptFile = path.join(tmp.dir, 'ctrl-prompt.txt');
    const result = await runApiControllerTurn({
      manifest,
      request: { id: 'r1', message: 'List all files in the project', loopIndex: 0, workerResults: [], loops: [] },
      loop: { controller: { promptFile } },
      renderer, emitEvent: () => {},
    });
    assert.ok(result.decision, 'should have a decision');
    assert.ok(['delegate', 'stop'].includes(result.decision.action), 'action should be delegate or stop, got: ' + result.decision.action);
    if (result.decision.action === 'delegate') {
      assert.ok(result.decision.claude_message, 'delegate should have claude_message');
      assert.ok(result.decision.agent_id, 'delegate should have agent_id');
    }
  });
});
