#!/usr/bin/env node
/**
 * QA Panda Tests MCP Server — manages repeatable test cases with steps,
 * pass/fail tracking, run history, and task linking.
 *
 * Protocol: JSON-RPC 2.0 over stdio (one JSON message per line).
 *
 * Env vars:
 *   TESTS_FILE — absolute path to the tests.json file
 *   TASKS_FILE — absolute path to the tasks.json file (for create_bug_from_test)
 */

const fs = require('node:fs');
const readline = require('node:readline');
const path = require('node:path');

const TESTS_FILE = process.env.TESTS_FILE || '';
const TASKS_FILE = process.env.TASKS_FILE || '';

const VALID_TEST_STATUSES = ['untested', 'passing', 'failing', 'partial'];
const VALID_STEP_STATUSES = ['untested', 'pass', 'fail', 'skip'];
const VALID_ENVIRONMENTS = ['browser', 'computer'];

// ─── Data helpers ────────────────────────────────────────────────

function loadData() {
  try { return JSON.parse(fs.readFileSync(TESTS_FILE, 'utf8')); }
  catch { return { nextId: 1, nextStepId: 1, nextRunId: 1, tests: [] }; }
}

function saveData(data) {
  const dir = path.dirname(TESTS_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(TESTS_FILE, JSON.stringify(data, null, 2), 'utf8');
}

function loadTasksData() {
  try { return JSON.parse(fs.readFileSync(TASKS_FILE, 'utf8')); }
  catch { return { nextId: 1, nextCommentId: 1, nextProgressId: 1, tasks: [] }; }
}

function saveTasksData(data) {
  const dir = path.dirname(TASKS_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(TASKS_FILE, JSON.stringify(data, null, 2), 'utf8');
}

function nowIso() { return new Date().toISOString(); }

function computeOverallStatus(steps) {
  if (!steps || steps.length === 0) return 'untested';
  const statuses = steps.map(s => s.status);
  if (statuses.every(s => s === 'untested')) return 'untested';
  if (statuses.every(s => s === 'pass' || s === 'skip')) return 'passing';
  if (statuses.every(s => s === 'fail')) return 'failing';
  if (statuses.some(s => s === 'fail')) return 'partial';
  if (statuses.some(s => s === 'pass')) return 'partial';
  return 'untested';
}

// ─── Tool definitions ────────────────────────────────────────────

const TOOLS = [
  // CRUD
  { name: 'list_tests', description: 'List tests, optionally filtered by status, environment, or tag', inputSchema: { type: 'object', properties: { status: { type: 'string', description: 'Filter: untested, passing, failing, partial' }, environment: { type: 'string', description: 'Filter: browser, computer' }, tag: { type: 'string', description: 'Filter by tag' } } } },
  { name: 'get_test', description: 'Get full test details including steps, runs, and linked tasks', inputSchema: { type: 'object', properties: { test_id: { type: 'string' } }, required: ['test_id'] } },
  { name: 'create_test', description: 'Create a new test case', inputSchema: { type: 'object', properties: { title: { type: 'string' }, description: { type: 'string' }, environment: { type: 'string', description: 'browser or computer' }, tags: { type: 'array', items: { type: 'string' } } }, required: ['title', 'environment'] } },
  { name: 'update_test', description: 'Update test fields (title, description, environment, tags)', inputSchema: { type: 'object', properties: { test_id: { type: 'string' }, title: { type: 'string' }, description: { type: 'string' }, environment: { type: 'string' }, tags: { type: 'array', items: { type: 'string' } } }, required: ['test_id'] } },
  { name: 'delete_test', description: 'Delete a test case', inputSchema: { type: 'object', properties: { test_id: { type: 'string' } }, required: ['test_id'] } },
  // Steps
  { name: 'add_test_step', description: 'Add a step to a test case', inputSchema: { type: 'object', properties: { test_id: { type: 'string' }, description: { type: 'string' }, expectedResult: { type: 'string' } }, required: ['test_id', 'description', 'expectedResult'] } },
  { name: 'update_test_step', description: 'Update a test step definition', inputSchema: { type: 'object', properties: { test_id: { type: 'string' }, step_id: { type: 'number' }, description: { type: 'string' }, expectedResult: { type: 'string' } }, required: ['test_id', 'step_id'] } },
  { name: 'delete_test_step', description: 'Delete a step from a test', inputSchema: { type: 'object', properties: { test_id: { type: 'string' }, step_id: { type: 'number' } }, required: ['test_id', 'step_id'] } },
  // Execution
  { name: 'run_test', description: 'Start a new test run for a test case', inputSchema: { type: 'object', properties: { test_id: { type: 'string' }, agent: { type: 'string', description: 'Agent name performing the test' } }, required: ['test_id'] } },
  { name: 'update_step_result', description: 'Record pass/fail result for a step in a test run', inputSchema: { type: 'object', properties: { test_id: { type: 'string' }, run_id: { type: 'number' }, step_id: { type: 'number' }, status: { type: 'string', description: 'pass, fail, or skip' }, actualResult: { type: 'string', description: 'Actual result if different from expected' } }, required: ['test_id', 'run_id', 'step_id', 'status'] } },
  { name: 'complete_test_run', description: 'Finalize a test run and compute overall status', inputSchema: { type: 'object', properties: { test_id: { type: 'string' }, run_id: { type: 'number' }, notes: { type: 'string' } }, required: ['test_id', 'run_id'] } },
  // Linking
  { name: 'link_test_to_task', description: 'Link a test to a task (bug ticket)', inputSchema: { type: 'object', properties: { test_id: { type: 'string' }, task_id: { type: 'string' } }, required: ['test_id', 'task_id'] } },
  { name: 'unlink_test_from_task', description: 'Remove link between test and task', inputSchema: { type: 'object', properties: { test_id: { type: 'string' }, task_id: { type: 'string' } }, required: ['test_id', 'task_id'] } },
  { name: 'create_bug_from_test', description: 'Create a bug ticket (task) from a failing test and auto-link them', inputSchema: { type: 'object', properties: { test_id: { type: 'string' }, title: { type: 'string' }, description: { type: 'string' } }, required: ['test_id', 'title'] } },
  // Queries
  { name: 'get_test_history', description: 'Get all run history for a test', inputSchema: { type: 'object', properties: { test_id: { type: 'string' } }, required: ['test_id'] } },
  { name: 'get_test_summary', description: 'Get overall test suite statistics', inputSchema: { type: 'object', properties: {} } },
  // Display cards (rendered as styled cards in the chat UI)
  { name: 'display_test_summary', description: 'Display a styled test summary card in the chat. Call this after completing a test run to show results visually.', inputSchema: { type: 'object', properties: { title: { type: 'string', description: 'Test name' }, passed: { type: 'number' }, failed: { type: 'number' }, skipped: { type: 'number' }, steps: { type: 'array', items: { type: 'object', properties: { name: { type: 'string' }, status: { type: 'string', description: 'pass, fail, or skip' } } } } }, required: ['title'] } },
  { name: 'display_bug_report', description: 'Display a styled bug report card in the chat. Call this when filing a bug to show it visually.', inputSchema: { type: 'object', properties: { title: { type: 'string' }, task_id: { type: 'string' }, description: { type: 'string' }, severity: { type: 'string', description: 'critical, high, medium, or low' } }, required: ['title'] } },
];

// ─── Tool handlers ───────────────────────────────────────────────

function handleToolCall(name, args) {
  const data = loadData();

  switch (name) {
    case 'list_tests': {
      let tests = data.tests;
      if (args.status) tests = tests.filter(t => t.status === args.status);
      if (args.environment) tests = tests.filter(t => t.environment === args.environment);
      if (args.tag) tests = tests.filter(t => t.tags && t.tags.includes(args.tag));
      const summary = tests.map(t => ({
        id: t.id, title: t.title, description: t.description, environment: t.environment,
        status: t.status, steps_count: (t.steps || []).length,
        steps_passing: (t.steps || []).filter(s => s.status === 'pass').length,
        tags: t.tags || [], linkedTaskIds: t.linkedTaskIds || [],
        lastTestedAt: t.lastTestedAt, created_at: t.created_at,
      }));
      return JSON.stringify(summary, null, 2);
    }

    case 'get_test': {
      const test = data.tests.find(t => t.id === args.test_id);
      if (!test) return JSON.stringify({ error: `Test ${args.test_id} not found` });
      return JSON.stringify(test, null, 2);
    }

    case 'create_test': {
      const id = 'test-' + data.nextId++;
      const test = {
        id, title: args.title, description: args.description || '',
        environment: VALID_ENVIRONMENTS.includes(args.environment) ? args.environment : 'browser',
        status: 'untested', steps: [], linkedTaskIds: [], tags: args.tags || [],
        lastTestedAt: null, lastTestedBy: null,
        created_at: nowIso(), updated_at: nowIso(), runs: [],
      };
      data.tests.push(test);
      saveData(data);
      return JSON.stringify(test, null, 2);
    }

    case 'update_test': {
      const test = data.tests.find(t => t.id === args.test_id);
      if (!test) return JSON.stringify({ error: `Test ${args.test_id} not found` });
      if (args.title !== undefined) test.title = args.title;
      if (args.description !== undefined) test.description = args.description;
      if (args.environment !== undefined && VALID_ENVIRONMENTS.includes(args.environment)) test.environment = args.environment;
      if (args.tags !== undefined) test.tags = args.tags;
      test.updated_at = nowIso();
      saveData(data);
      return JSON.stringify(test, null, 2);
    }

    case 'delete_test': {
      data.tests = data.tests.filter(t => t.id !== args.test_id);
      saveData(data);
      return JSON.stringify({ deleted: args.test_id });
    }

    case 'add_test_step': {
      const test = data.tests.find(t => t.id === args.test_id);
      if (!test) return JSON.stringify({ error: `Test ${args.test_id} not found` });
      const step = {
        id: data.nextStepId++, description: args.description,
        expectedResult: args.expectedResult, status: 'untested', actualResult: null,
      };
      test.steps.push(step);
      test.updated_at = nowIso();
      saveData(data);
      return JSON.stringify(step, null, 2);
    }

    case 'update_test_step': {
      const test = data.tests.find(t => t.id === args.test_id);
      if (!test) return JSON.stringify({ error: `Test ${args.test_id} not found` });
      const step = test.steps.find(s => s.id === args.step_id);
      if (!step) return JSON.stringify({ error: `Step ${args.step_id} not found` });
      if (args.description !== undefined) step.description = args.description;
      if (args.expectedResult !== undefined) step.expectedResult = args.expectedResult;
      test.updated_at = nowIso();
      saveData(data);
      return JSON.stringify(step, null, 2);
    }

    case 'delete_test_step': {
      const test = data.tests.find(t => t.id === args.test_id);
      if (!test) return JSON.stringify({ error: `Test ${args.test_id} not found` });
      test.steps = test.steps.filter(s => s.id !== args.step_id);
      test.status = computeOverallStatus(test.steps);
      test.updated_at = nowIso();
      saveData(data);
      return JSON.stringify({ deleted: args.step_id });
    }

    case 'run_test': {
      const test = data.tests.find(t => t.id === args.test_id);
      if (!test) return JSON.stringify({ error: `Test ${args.test_id} not found` });
      const run = {
        id: data.nextRunId++, date: nowIso(), agent: args.agent || 'agent',
        status: 'running',
        stepResults: test.steps.map(s => ({ stepId: s.id, status: 'untested', actualResult: null })),
        notes: null,
      };
      test.runs.push(run);
      test.lastTestedAt = run.date;
      test.lastTestedBy = run.agent;
      test.updated_at = nowIso();
      saveData(data);
      return JSON.stringify({ run_id: run.id, test_id: test.id, steps_to_test: test.steps.length }, null, 2);
    }

    case 'update_step_result': {
      const test = data.tests.find(t => t.id === args.test_id);
      if (!test) return JSON.stringify({ error: `Test ${args.test_id} not found` });
      const run = test.runs.find(r => r.id === args.run_id);
      if (!run) return JSON.stringify({ error: `Run ${args.run_id} not found` });
      const stepResult = run.stepResults.find(sr => sr.stepId === args.step_id);
      if (!stepResult) return JSON.stringify({ error: `Step ${args.step_id} not in this run` });
      if (VALID_STEP_STATUSES.includes(args.status)) stepResult.status = args.status;
      if (args.actualResult !== undefined) stepResult.actualResult = args.actualResult;
      // Also update the step's latest status on the test itself
      const step = test.steps.find(s => s.id === args.step_id);
      if (step) {
        step.status = stepResult.status;
        if (args.actualResult !== undefined) step.actualResult = args.actualResult;
      }
      test.updated_at = nowIso();
      saveData(data);
      return JSON.stringify({ step_id: args.step_id, status: stepResult.status });
    }

    case 'complete_test_run': {
      const test = data.tests.find(t => t.id === args.test_id);
      if (!test) return JSON.stringify({ error: `Test ${args.test_id} not found` });
      const run = test.runs.find(r => r.id === args.run_id);
      if (!run) return JSON.stringify({ error: `Run ${args.run_id} not found` });
      if (args.notes) run.notes = args.notes;
      // Compute run status from step results
      const statuses = run.stepResults.map(sr => sr.status);
      if (statuses.every(s => s === 'pass' || s === 'skip')) run.status = 'passing';
      else if (statuses.every(s => s === 'fail')) run.status = 'failing';
      else if (statuses.some(s => s === 'fail')) run.status = 'partial';
      else run.status = 'untested';
      // Update overall test status
      test.status = computeOverallStatus(test.steps);
      test.updated_at = nowIso();
      saveData(data);
      return JSON.stringify({ test_id: test.id, run_id: run.id, status: run.status, test_status: test.status }, null, 2);
    }

    case 'link_test_to_task': {
      const test = data.tests.find(t => t.id === args.test_id);
      if (!test) return JSON.stringify({ error: `Test ${args.test_id} not found` });
      if (!test.linkedTaskIds) test.linkedTaskIds = [];
      if (!test.linkedTaskIds.includes(args.task_id)) test.linkedTaskIds.push(args.task_id);
      test.updated_at = nowIso();
      saveData(data);
      return JSON.stringify({ test_id: test.id, linkedTaskIds: test.linkedTaskIds });
    }

    case 'unlink_test_from_task': {
      const test = data.tests.find(t => t.id === args.test_id);
      if (!test) return JSON.stringify({ error: `Test ${args.test_id} not found` });
      test.linkedTaskIds = (test.linkedTaskIds || []).filter(id => id !== args.task_id);
      test.updated_at = nowIso();
      saveData(data);
      return JSON.stringify({ test_id: test.id, linkedTaskIds: test.linkedTaskIds });
    }

    case 'create_bug_from_test': {
      const test = data.tests.find(t => t.id === args.test_id);
      if (!test) return JSON.stringify({ error: `Test ${args.test_id} not found` });
      // Create task in tasks.json
      const tasksData = loadTasksData();
      const taskId = 'task-' + tasksData.nextId++;
      const failingSteps = test.steps.filter(s => s.status === 'fail');
      const bugDescription = args.description || `Bug from test: ${test.title}\n\nFailing steps:\n${failingSteps.map(s => `- ${s.description}: expected "${s.expectedResult}", got "${s.actualResult || 'N/A'}"`).join('\n')}`;
      const task = {
        id: taskId, title: args.title, description: bugDescription, detail_text: '',
        status: 'todo', created_at: nowIso(), updated_at: nowIso(),
        comments: [], progress_updates: [], linkedTestIds: [test.id],
      };
      tasksData.tasks.push(task);
      saveTasksData(tasksData);
      // Link test to task
      if (!test.linkedTaskIds) test.linkedTaskIds = [];
      test.linkedTaskIds.push(taskId);
      test.updated_at = nowIso();
      saveData(data);
      return JSON.stringify({ task_id: taskId, test_id: test.id, title: args.title }, null, 2);
    }

    case 'get_test_history': {
      const test = data.tests.find(t => t.id === args.test_id);
      if (!test) return JSON.stringify({ error: `Test ${args.test_id} not found` });
      return JSON.stringify(test.runs || [], null, 2);
    }

    case 'get_test_summary': {
      const total = data.tests.length;
      const passing = data.tests.filter(t => t.status === 'passing').length;
      const failing = data.tests.filter(t => t.status === 'failing').length;
      const partial = data.tests.filter(t => t.status === 'partial').length;
      const untested = data.tests.filter(t => t.status === 'untested').length;
      return JSON.stringify({ total, passing, failing, partial, untested }, null, 2);
    }

    // Display cards — these are rendered visually in the chat UI via tool call interception
    case 'display_test_summary':
      return 'Displayed test summary card.';
    case 'display_bug_report':
      return 'Displayed bug report card.';

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

// ─── JSON-RPC protocol ───────────────────────────────────────────

function handleRequest(msg) {
  if (msg.method === 'initialize') {
    return { jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'cc-tests', version: '1.0.0' } } };
  }
  if (msg.method === 'notifications/initialized') return null;
  if (msg.method === 'tools/list') {
    return { jsonrpc: '2.0', id: msg.id, result: { tools: TOOLS } };
  }
  if (msg.method === 'tools/call') {
    try {
      const text = handleToolCall(msg.params.name, msg.params.arguments || {});
      return { jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text }] } };
    } catch (e) {
      return { jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: JSON.stringify({ error: e.message }) }], isError: true } };
    }
  }
  return { jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: `Unknown method: ${msg.method}` } };
}

// ─── Startup ─────────────────────────────────────────────────────

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  const response = handleRequest(msg);
  if (response) process.stdout.write(JSON.stringify(response) + '\n');
});

process.stderr.write(`[cc-tests-mcp] Server started, tests file: ${TESTS_FILE}\n`);
