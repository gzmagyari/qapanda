const { rankSearchResults } = require('./mcp-search');
const {
  VALID_ENVIRONMENTS,
  VALID_STEP_STATUSES,
  computeOverallStatus,
  loadTasksData,
  loadTestsData,
  nowIso,
  saveTasksData,
  saveTestsData,
} = require('./src/tests-store');

const TOOLS = [
  { name: 'list_tests', description: 'List tests, optionally filtered by status, environment, or tag', inputSchema: { type: 'object', properties: { status: { type: 'string', description: 'Filter: untested, passing, failing, partial' }, environment: { type: 'string', description: 'Filter: browser, computer' }, tag: { type: 'string', description: 'Filter by tag' } } } },
  { name: 'get_test', description: 'Get full test details including steps, runs, and linked tasks', inputSchema: { type: 'object', properties: { test_id: { type: 'string' } }, required: ['test_id'] } },
  { name: 'search_tests', description: 'Search for likely reusable existing tests before creating a new one', inputSchema: { type: 'object', properties: { query: { type: 'string' }, environment: { type: 'string', description: 'Optional environment filter: browser or computer' }, limit: { type: 'number', description: 'Maximum results to return (default 5)' } }, required: ['query'] } },
  { name: 'create_test', description: 'Create a new test case', inputSchema: { type: 'object', properties: { title: { type: 'string' }, description: { type: 'string' }, environment: { type: 'string', description: 'browser or computer' }, tags: { type: 'array', items: { type: 'string' } } }, required: ['title', 'environment'] } },
  { name: 'create_test_with_steps', description: 'Create a new test case and add multiple steps in one call', inputSchema: { type: 'object', properties: { title: { type: 'string' }, description: { type: 'string' }, environment: { type: 'string', description: 'browser or computer' }, tags: { type: 'array', items: { type: 'string' } }, steps: { type: 'array', items: { type: 'object', properties: { description: { type: 'string' }, expectedResult: { type: 'string' } }, required: ['description', 'expectedResult'] } } }, required: ['title', 'environment', 'steps'] } },
  { name: 'update_test', description: 'Update test fields (title, description, environment, tags)', inputSchema: { type: 'object', properties: { test_id: { type: 'string' }, title: { type: 'string' }, description: { type: 'string' }, environment: { type: 'string' }, tags: { type: 'array', items: { type: 'string' } } }, required: ['test_id'] } },
  { name: 'delete_test', description: 'Delete a test case', inputSchema: { type: 'object', properties: { test_id: { type: 'string' } }, required: ['test_id'] } },
  { name: 'add_test_step', description: 'Add a step to a test case', inputSchema: { type: 'object', properties: { test_id: { type: 'string' }, description: { type: 'string' }, expectedResult: { type: 'string' } }, required: ['test_id', 'description', 'expectedResult'] } },
  { name: 'update_test_step', description: 'Update a test step definition', inputSchema: { type: 'object', properties: { test_id: { type: 'string' }, step_id: { type: 'number' }, description: { type: 'string' }, expectedResult: { type: 'string' } }, required: ['test_id', 'step_id'] } },
  { name: 'delete_test_step', description: 'Delete a step from a test', inputSchema: { type: 'object', properties: { test_id: { type: 'string' }, step_id: { type: 'number' } }, required: ['test_id', 'step_id'] } },
  { name: 'update_test_steps_batch', description: 'Add, update, or delete many test steps in one ordered batch', inputSchema: { type: 'object', properties: { test_id: { type: 'string' }, operations: { type: 'array', items: { type: 'object', properties: { action: { type: 'string', enum: ['add', 'update', 'delete'] }, step_id: { type: 'number' }, description: { type: 'string' }, expectedResult: { type: 'string' } }, required: ['action'] } } }, required: ['test_id', 'operations'] } },
  { name: 'run_test', description: 'Start a new test run for a test case', inputSchema: { type: 'object', properties: { test_id: { type: 'string' }, agent: { type: 'string', description: 'Agent name performing the test' } }, required: ['test_id'] } },
  { name: 'reset_test_steps', description: 'Reset stored step results on a test before rerunning it', inputSchema: { type: 'object', properties: { test_id: { type: 'string' }, clear_actual_results: { type: 'boolean', description: 'Clear stored actual results (default true)' } }, required: ['test_id'] } },
  { name: 'update_step_result', description: 'Record pass/fail result for a step in a test run', inputSchema: { type: 'object', properties: { test_id: { type: 'string' }, run_id: { type: 'number' }, step_id: { type: 'number' }, status: { type: 'string', description: 'pass, fail, or skip' }, actualResult: { type: 'string', description: 'Actual result if different from expected' } }, required: ['test_id', 'run_id', 'step_id', 'status'] } },
  { name: 'record_test_run', description: 'Create or resume a test run, record many step results, and optionally complete it in one call', inputSchema: { type: 'object', properties: { test_id: { type: 'string' }, run_id: { type: 'number' }, agent: { type: 'string' }, reset_first: { type: 'boolean' }, step_results: { type: 'array', items: { type: 'object', properties: { step_id: { type: 'number' }, status: { type: 'string', enum: ['pass', 'fail', 'skip'] }, actualResult: { type: 'string' } }, required: ['step_id', 'status'] } }, notes: { type: 'string' }, complete: { type: 'boolean' } }, required: ['test_id', 'step_results'] } },
  { name: 'complete_test_run', description: 'Finalize a test run and compute overall status', inputSchema: { type: 'object', properties: { test_id: { type: 'string' }, run_id: { type: 'number' }, notes: { type: 'string' } }, required: ['test_id', 'run_id'] } },
  { name: 'link_test_to_task', description: 'Link a test to a task (bug ticket)', inputSchema: { type: 'object', properties: { test_id: { type: 'string' }, task_id: { type: 'string' } }, required: ['test_id', 'task_id'] } },
  { name: 'unlink_test_from_task', description: 'Remove link between test and task', inputSchema: { type: 'object', properties: { test_id: { type: 'string' }, task_id: { type: 'string' } }, required: ['test_id', 'task_id'] } },
  { name: 'create_bug_from_test', description: 'Create a bug ticket (task) from a failing test and auto-link them', inputSchema: { type: 'object', properties: { test_id: { type: 'string' }, title: { type: 'string' }, description: { type: 'string' } }, required: ['test_id', 'title'] } },
  { name: 'get_test_history', description: 'Get all run history for a test', inputSchema: { type: 'object', properties: { test_id: { type: 'string' } }, required: ['test_id'] } },
  { name: 'get_test_summary', description: 'Get overall test suite statistics', inputSchema: { type: 'object', properties: {} } },
  { name: 'display_test_summary', description: 'Display a styled test summary card in the chat. Call this after completing a test run to show results visually.', inputSchema: { type: 'object', properties: { title: { type: 'string', description: 'Test name' }, passed: { type: 'number', description: 'Number of passed steps' }, failed: { type: 'number', description: 'Number of failed steps' }, skipped: { type: 'number', description: 'Number of skipped steps' }, steps: { type: 'array', description: 'Individual step results', items: { type: 'object', properties: { name: { type: 'string', description: 'Step name' }, status: { type: 'string', enum: ['pass', 'fail', 'skip'], description: 'Step result: pass, fail, or skip' } }, required: ['name', 'status'] } } }, required: ['title'] } },
  { name: 'display_bug_report', description: 'Display a styled bug report card in the chat. Call this when filing a bug to show it visually.', inputSchema: { type: 'object', properties: { title: { type: 'string', description: 'Bug title' }, task_id: { type: 'string', description: 'Task ID if already created' }, description: { type: 'string', description: 'Bug description' }, severity: { type: 'string', enum: ['critical', 'high', 'medium', 'low'], description: 'Bug severity' } }, required: ['title'] } },
];

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function buildTestCard(test) {
  const steps = Array.isArray(test && test.steps) ? test.steps : [];
  return {
    title: test && test.title ? test.title : 'Test',
    test_id: test && test.id ? test.id : '',
    passed: steps.filter((step) => step.status === 'pass').length,
    failed: steps.filter((step) => step.status === 'fail').length,
    skipped: steps.filter((step) => !step.status || step.status === 'skip' || step.status === 'untested').length,
    steps: steps.map((step) => ({
      name: step.description,
      status: step.status === 'untested' ? 'skip' : (step.status || 'skip'),
    })),
  };
}

function requireArray(value, fieldName) {
  if (!Array.isArray(value)) throw new Error(`${fieldName} must be an array`);
  return value;
}

function findTest(data, testId) {
  return data.tests.find((test) => test.id === testId);
}

function findRun(test, runId) {
  return (test.runs || []).find((run) => run.id === runId);
}

function addTestStepInPlace(data, test, description, expectedResult) {
  if (!description || !expectedResult) throw new Error('Step description and expectedResult are required');
  const step = {
    id: data.nextStepId++,
    description,
    expectedResult,
    status: 'untested',
    actualResult: null,
  };
  test.steps.push(step);
  return step;
}

function resetTestStepsInPlace(test, clearActualResults = true) {
  for (const step of test.steps || []) {
    step.status = 'untested';
    if (clearActualResults) step.actualResult = null;
  }
  test.status = 'untested';
}

function createRunInPlace(data, test, agentName) {
  const run = {
    id: data.nextRunId++,
    date: nowIso(),
    agent: agentName || 'agent',
    status: 'running',
    stepResults: (test.steps || []).map((step) => ({ stepId: step.id, status: 'untested', actualResult: null })),
    notes: null,
  };
  test.runs.push(run);
  test.lastTestedAt = run.date;
  test.lastTestedBy = run.agent;
  return run;
}

function applyStepResultInPlace(test, run, stepId, status, actualResult) {
  if (!VALID_STEP_STATUSES.includes(status)) throw new Error(`Invalid step status: ${status}`);
  const stepResult = run.stepResults.find((entry) => entry.stepId === stepId);
  if (!stepResult) throw new Error(`Step ${stepId} not in this run`);
  stepResult.status = status;
  if (actualResult !== undefined) stepResult.actualResult = actualResult;
  const step = test.steps.find((entry) => entry.id === stepId);
  if (step) {
    step.status = status;
    if (actualResult !== undefined) step.actualResult = actualResult;
  }
}

function finalizeRunInPlace(test, run, notes) {
  if (notes !== undefined) run.notes = notes;
  const statuses = (run.stepResults || []).map((entry) => entry.status);
  if (statuses.every((status) => status === 'pass' || status === 'skip')) run.status = 'passing';
  else if (statuses.every((status) => status === 'fail')) run.status = 'failing';
  else if (statuses.some((status) => status === 'fail')) run.status = 'partial';
  else run.status = 'untested';
  test.status = computeOverallStatus(test.steps);
  return { test_id: test.id, run_id: run.id, status: run.status, test_status: test.status, _testCard: buildTestCard(test) };
}

function validateEnvironment(environment) {
  return VALID_ENVIRONMENTS.includes(environment) ? environment : 'browser';
}

function handleToolCall(name, args = {}, files) {
  const testsFile = files.testsFile;
  const tasksFile = files.tasksFile;
  const data = loadTestsData(testsFile);

  switch (name) {
    case 'list_tests': {
      let tests = data.tests;
      if (args.status) tests = tests.filter((test) => test.status === args.status);
      if (args.environment) tests = tests.filter((test) => test.environment === args.environment);
      if (args.tag) tests = tests.filter((test) => Array.isArray(test.tags) && test.tags.includes(args.tag));
      const summary = tests.map((test) => ({
        id: test.id,
        title: test.title,
        description: test.description,
        environment: test.environment,
        status: test.status,
        steps_count: (test.steps || []).length,
        steps_passing: (test.steps || []).filter((step) => step.status === 'pass').length,
        tags: test.tags || [],
        linkedTaskIds: test.linkedTaskIds || [],
        lastTestedAt: test.lastTestedAt || null,
        created_at: test.created_at,
      }));
      return JSON.stringify(summary, null, 2);
    }

    case 'get_test': {
      const test = findTest(data, args.test_id);
      return test ? JSON.stringify(test, null, 2) : JSON.stringify({ error: `Test ${args.test_id} not found` });
    }

    case 'search_tests': {
      let tests = data.tests;
      if (args.environment) tests = tests.filter((test) => test.environment === args.environment);
      const matches = rankSearchResults(
        tests,
        args.query,
        (test) => ([
          { label: 'title', value: test.title, weight: 5 },
          { label: 'description', value: test.description, weight: 3 },
          { label: 'tags', value: (test.tags || []).join(' '), weight: 2 },
          { label: 'steps', value: (test.steps || []).map((step) => `${step.description} ${step.expectedResult}`).join(' '), weight: 2 },
        ]),
        args.limit || 5
      );
      return JSON.stringify(matches.map(({ item, score, matchReason }) => ({
        id: item.id,
        title: item.title,
        description: item.description,
        environment: item.environment,
        status: item.status,
        tags: item.tags || [],
        steps_count: (item.steps || []).length,
        lastTestedAt: item.lastTestedAt || null,
        linkedTaskIds: item.linkedTaskIds || [],
        match_score: score,
        match_reason: matchReason,
      })), null, 2);
    }

    case 'create_test': {
      const test = {
        id: `test-${data.nextId++}`,
        title: args.title,
        description: args.description || '',
        environment: validateEnvironment(args.environment),
        status: 'untested',
        steps: [],
        linkedTaskIds: [],
        tags: args.tags || [],
        lastTestedAt: null,
        lastTestedBy: null,
        created_at: nowIso(),
        updated_at: nowIso(),
        runs: [],
      };
      data.tests.push(test);
      saveTestsData(testsFile, data);
      return JSON.stringify(test, null, 2);
    }

    case 'create_test_with_steps': {
      const steps = requireArray(args.steps, 'steps');
      const test = {
        id: `test-${data.nextId++}`,
        title: args.title,
        description: args.description || '',
        environment: validateEnvironment(args.environment),
        status: 'untested',
        steps: [],
        linkedTaskIds: [],
        tags: args.tags || [],
        lastTestedAt: null,
        lastTestedBy: null,
        created_at: nowIso(),
        updated_at: nowIso(),
        runs: [],
      };
      for (const stepInput of steps) {
        addTestStepInPlace(data, test, stepInput && stepInput.description, stepInput && stepInput.expectedResult);
      }
      data.tests.push(test);
      saveTestsData(testsFile, data);
      return JSON.stringify({
        ...test,
        steps_added: test.steps.length,
        step_ids: test.steps.map((step) => step.id),
      }, null, 2);
    }

    case 'update_test': {
      const test = findTest(data, args.test_id);
      if (!test) return JSON.stringify({ error: `Test ${args.test_id} not found` });
      if (args.title !== undefined) test.title = args.title;
      if (args.description !== undefined) test.description = args.description;
      if (args.environment !== undefined) test.environment = validateEnvironment(args.environment);
      if (args.tags !== undefined) test.tags = args.tags;
      test.updated_at = nowIso();
      saveTestsData(testsFile, data);
      return JSON.stringify(test, null, 2);
    }

    case 'delete_test': {
      data.tests = data.tests.filter((test) => test.id !== args.test_id);
      saveTestsData(testsFile, data);
      return JSON.stringify({ deleted: args.test_id });
    }

    case 'add_test_step': {
      const test = findTest(data, args.test_id);
      if (!test) return JSON.stringify({ error: `Test ${args.test_id} not found` });
      const step = addTestStepInPlace(data, test, args.description, args.expectedResult);
      test.updated_at = nowIso();
      saveTestsData(testsFile, data);
      return JSON.stringify(step, null, 2);
    }

    case 'update_test_step': {
      const test = findTest(data, args.test_id);
      if (!test) return JSON.stringify({ error: `Test ${args.test_id} not found` });
      const step = test.steps.find((entry) => entry.id === args.step_id);
      if (!step) return JSON.stringify({ error: `Step ${args.step_id} not found` });
      if (args.description !== undefined) step.description = args.description;
      if (args.expectedResult !== undefined) step.expectedResult = args.expectedResult;
      test.updated_at = nowIso();
      saveTestsData(testsFile, data);
      return JSON.stringify(step, null, 2);
    }

    case 'delete_test_step': {
      const test = findTest(data, args.test_id);
      if (!test) return JSON.stringify({ error: `Test ${args.test_id} not found` });
      test.steps = test.steps.filter((step) => step.id !== args.step_id);
      test.status = computeOverallStatus(test.steps);
      test.updated_at = nowIso();
      saveTestsData(testsFile, data);
      return JSON.stringify({ deleted: args.step_id });
    }

    case 'update_test_steps_batch': {
      const working = clone(data);
      const test = findTest(working, args.test_id);
      if (!test) return JSON.stringify({ error: `Test ${args.test_id} not found` });
      const operations = requireArray(args.operations, 'operations');
      const counts = { added: 0, updated: 0, deleted: 0 };
      const addedStepIds = [];
      const updatedStepIds = [];
      const deletedStepIds = [];

      for (const operation of operations) {
        const action = String(operation && operation.action || '').trim();
        if (action === 'add') {
          const step = addTestStepInPlace(working, test, operation.description, operation.expectedResult);
          counts.added += 1;
          addedStepIds.push(step.id);
          continue;
        }
        if (action === 'update') {
          const step = test.steps.find((entry) => entry.id === operation.step_id);
          if (!step) throw new Error(`Step ${operation.step_id} not found`);
          if (operation.description !== undefined) step.description = operation.description;
          if (operation.expectedResult !== undefined) step.expectedResult = operation.expectedResult;
          counts.updated += 1;
          updatedStepIds.push(step.id);
          continue;
        }
        if (action === 'delete') {
          const before = test.steps.length;
          test.steps = test.steps.filter((entry) => entry.id !== operation.step_id);
          if (test.steps.length === before) throw new Error(`Step ${operation.step_id} not found`);
          counts.deleted += 1;
          deletedStepIds.push(operation.step_id);
          continue;
        }
        throw new Error(`Unsupported step batch action: ${action}`);
      }

      test.status = computeOverallStatus(test.steps);
      test.updated_at = nowIso();
      saveTestsData(testsFile, working);
      return JSON.stringify({
        test_id: test.id,
        added: counts.added,
        updated: counts.updated,
        deleted: counts.deleted,
        added_step_ids: addedStepIds,
        updated_step_ids: updatedStepIds,
        deleted_step_ids: deletedStepIds,
        step_count: test.steps.length,
      }, null, 2);
    }

    case 'run_test': {
      const test = findTest(data, args.test_id);
      if (!test) return JSON.stringify({ error: `Test ${args.test_id} not found` });
      const run = createRunInPlace(data, test, args.agent);
      test.updated_at = nowIso();
      saveTestsData(testsFile, data);
      return JSON.stringify({ run_id: run.id, test_id: test.id, steps_to_test: test.steps.length }, null, 2);
    }

    case 'reset_test_steps': {
      const test = findTest(data, args.test_id);
      if (!test) return JSON.stringify({ error: `Test ${args.test_id} not found` });
      const clearActualResults = args.clear_actual_results !== false;
      resetTestStepsInPlace(test, clearActualResults);
      test.updated_at = nowIso();
      saveTestsData(testsFile, data);
      return JSON.stringify({
        test_id: test.id,
        reset_steps: (test.steps || []).length,
        clear_actual_results: clearActualResults,
        status: test.status,
      }, null, 2);
    }

    case 'update_step_result': {
      const test = findTest(data, args.test_id);
      if (!test) return JSON.stringify({ error: `Test ${args.test_id} not found` });
      const run = findRun(test, args.run_id);
      if (!run) return JSON.stringify({ error: `Run ${args.run_id} not found` });
      applyStepResultInPlace(test, run, args.step_id, args.status, args.actualResult);
      test.updated_at = nowIso();
      saveTestsData(testsFile, data);
      return JSON.stringify({
        step_id: args.step_id,
        status: args.status,
        test_id: test.id,
        _testCard: buildTestCard(test),
      });
    }

    case 'record_test_run': {
      const test = findTest(data, args.test_id);
      if (!test) return JSON.stringify({ error: `Test ${args.test_id} not found` });
      const stepResults = requireArray(args.step_results, 'step_results');
      if (args.reset_first) resetTestStepsInPlace(test, true);
      const run = args.run_id != null ? findRun(test, args.run_id) : createRunInPlace(data, test, args.agent);
      if (!run) return JSON.stringify({ error: `Run ${args.run_id} not found` });
      for (const stepResult of stepResults) {
        applyStepResultInPlace(test, run, stepResult.step_id, stepResult.status, stepResult.actualResult);
      }
      if (args.notes !== undefined) run.notes = args.notes;
      const shouldComplete = args.complete !== false;
      const summary = shouldComplete
        ? finalizeRunInPlace(test, run, args.notes)
        : { test_id: test.id, run_id: run.id, status: run.status, test_status: test.status, _testCard: buildTestCard(test) };
      test.updated_at = nowIso();
      saveTestsData(testsFile, data);
      return JSON.stringify({ ...summary, updated_steps: stepResults.length, created_run: args.run_id == null });
    }

    case 'complete_test_run': {
      const test = findTest(data, args.test_id);
      if (!test) return JSON.stringify({ error: `Test ${args.test_id} not found` });
      const run = findRun(test, args.run_id);
      if (!run) return JSON.stringify({ error: `Run ${args.run_id} not found` });
      const summary = finalizeRunInPlace(test, run, args.notes);
      test.updated_at = nowIso();
      saveTestsData(testsFile, data);
      return JSON.stringify(summary, null, 2);
    }

    case 'link_test_to_task': {
      const test = findTest(data, args.test_id);
      if (!test) return JSON.stringify({ error: `Test ${args.test_id} not found` });
      if (!Array.isArray(test.linkedTaskIds)) test.linkedTaskIds = [];
      if (!test.linkedTaskIds.includes(args.task_id)) test.linkedTaskIds.push(args.task_id);
      test.updated_at = nowIso();
      saveTestsData(testsFile, data);
      return JSON.stringify({ test_id: test.id, linkedTaskIds: test.linkedTaskIds });
    }

    case 'unlink_test_from_task': {
      const test = findTest(data, args.test_id);
      if (!test) return JSON.stringify({ error: `Test ${args.test_id} not found` });
      test.linkedTaskIds = (test.linkedTaskIds || []).filter((taskId) => taskId !== args.task_id);
      test.updated_at = nowIso();
      saveTestsData(testsFile, data);
      return JSON.stringify({ test_id: test.id, linkedTaskIds: test.linkedTaskIds });
    }

    case 'create_bug_from_test': {
      const test = findTest(data, args.test_id);
      if (!test) return JSON.stringify({ error: `Test ${args.test_id} not found` });
      const tasksData = loadTasksData(tasksFile);
      const taskId = `task-${tasksData.nextId++}`;
      const failingSteps = (test.steps || []).filter((step) => step.status === 'fail');
      const bugDescription = args.description || `Bug from test: ${test.title}\n\nFailing steps:\n${failingSteps.map((step) => `- ${step.description}: expected "${step.expectedResult}", got "${step.actualResult || 'N/A'}"`).join('\n')}`;
      tasksData.tasks.push({
        id: taskId,
        title: args.title,
        description: bugDescription,
        detail_text: '',
        status: 'todo',
        created_at: nowIso(),
        updated_at: nowIso(),
        comments: [],
        progress_updates: [],
        linkedTestIds: [test.id],
      });
      saveTasksData(tasksFile, tasksData);
      if (!Array.isArray(test.linkedTaskIds)) test.linkedTaskIds = [];
      if (!test.linkedTaskIds.includes(taskId)) test.linkedTaskIds.push(taskId);
      test.updated_at = nowIso();
      saveTestsData(testsFile, data);
      return JSON.stringify({ task_id: taskId, test_id: test.id, title: args.title }, null, 2);
    }

    case 'get_test_history': {
      const test = findTest(data, args.test_id);
      return test ? JSON.stringify(test.runs || [], null, 2) : JSON.stringify({ error: `Test ${args.test_id} not found` });
    }

    case 'get_test_summary': {
      const total = data.tests.length;
      return JSON.stringify({
        total,
        passing: data.tests.filter((test) => test.status === 'passing').length,
        failing: data.tests.filter((test) => test.status === 'failing').length,
        partial: data.tests.filter((test) => test.status === 'partial').length,
        untested: data.tests.filter((test) => test.status === 'untested').length,
      }, null, 2);
    }

    case 'display_test_summary':
      return 'Displayed test summary card.';

    case 'display_bug_report':
      return 'Displayed bug report card.';

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

module.exports = {
  TOOLS,
  buildTestCard,
  handleToolCall,
};
