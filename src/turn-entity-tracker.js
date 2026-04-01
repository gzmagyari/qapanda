const fs = require('node:fs');
const path = require('node:path');
const { parseCanonicalToolResult } = require('./tool-result-normalizer');
const {
  mergeQaArtifactIds,
  normalizeQaArtifactIds,
} = require('./qa-report');

const TEST_MUTATION_TOOLS = new Set([
  'create_test',
  'add_test_step',
  'update_test_step',
  'run_test',
  'update_step_result',
  'complete_test_run',
  'create_bug_from_test',
  'link_test_to_task',
  'unlink_test_from_task',
]);

const TASK_MUTATION_TOOLS = new Set([
  'create_task',
  'update_task_status',
  'update_task_fields',
  'add_comment',
  'add_progress_update',
  'edit_comment',
  'edit_progress_update',
  'delete_comment',
  'delete_progress_update',
]);

const DISPLAY_TEST_TOOLS = new Set(['display_test_summary']);
const DISPLAY_TASK_TOOLS = new Set(['display_task']);
const DISPLAY_BUG_TOOLS = new Set(['display_bug_report']);

function baseToolName(fullToolName) {
  if (!fullToolName) return '';
  const parts = String(fullToolName).split('__');
  return parts.length >= 2 ? parts[parts.length - 1] : String(fullToolName);
}

function testsFilePath(repoRoot) {
  return path.join(repoRoot, '.qpanda', 'tests.json');
}

function tasksFilePath(repoRoot) {
  return path.join(repoRoot, '.qpanda', 'tasks.json');
}

function loadJsonFile(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function mapById(list) {
  return new Map((list || [])
    .filter((item) => item && item.id)
    .map((item) => [item.id, item]));
}

function loadState(repoRoot) {
  const testsDoc = loadJsonFile(testsFilePath(repoRoot), { tests: [] });
  const tasksDoc = loadJsonFile(tasksFilePath(repoRoot), { tasks: [] });
  const tests = Array.isArray(testsDoc.tests) ? testsDoc.tests : [];
  const tasks = Array.isArray(tasksDoc.tasks) ? tasksDoc.tasks : [];
  return {
    tests,
    tasks,
    testsById: mapById(tests),
    tasksById: mapById(tasks),
    testsSig: JSON.stringify(tests),
    tasksSig: JSON.stringify(tasks),
  };
}

function stateDiffers(a, b) {
  if (!a || !b) return true;
  return a.testsSig !== b.testsSig || a.tasksSig !== b.tasksSig;
}

function normalizeStepStatus(status) {
  const normalized = String(status || '').toLowerCase();
  if (normalized === 'pass' || normalized === 'passed' || normalized === 'passing') return 'pass';
  if (normalized === 'fail' || normalized === 'failed' || normalized === 'failing') return 'fail';
  return 'skip';
}

function buildTestCardData(test) {
  const steps = Array.isArray(test && test.steps) ? test.steps : [];
  let passed = 0;
  let failed = 0;
  let skipped = 0;
  const cardSteps = steps.map((step) => {
    const status = normalizeStepStatus(step && step.status);
    if (status === 'pass') passed++;
    else if (status === 'fail') failed++;
    else skipped++;
    return {
      id: step && step.id,
      name: (step && step.description) || '',
      expectedResult: (step && step.expectedResult) || '',
      actualResult: step && step.actualResult != null ? String(step.actualResult) : '',
      status,
    };
  });
  return {
    test_id: test && test.id,
    title: (test && test.title) || 'Test Results',
    description: (test && test.description) || '',
    environment: (test && test.environment) || '',
    status: (test && test.status) || '',
    linkedTaskIds: Array.isArray(test && test.linkedTaskIds) ? test.linkedTaskIds : [],
    passed,
    failed,
    skipped,
    steps: cardSteps,
  };
}

function buildTaskCardData(task) {
  const comments = Array.isArray(task && task.comments) ? task.comments : [];
  const progressUpdates = Array.isArray(task && task.progress_updates) ? task.progress_updates : [];
  return {
    task_id: task && task.id,
    title: (task && task.title) || 'Task',
    status: (task && task.status) || '',
    description: (task && task.description) || '',
    detail_text: (task && task.detail_text) || '',
    comments_count: comments.length,
    progress_updates_count: progressUpdates.length,
    comments,
    progress_updates: progressUpdates,
  };
}

function newestUntouchedId(currentItems, startById, touchedIds) {
  for (let i = currentItems.length - 1; i >= 0; i--) {
    const item = currentItems[i];
    if (!item || !item.id) continue;
    if (startById.has(item.id)) continue;
    if (touchedIds.has(item.id)) continue;
    return item.id;
  }
  return null;
}

function changedIds(previousById, nextById) {
  const ids = [];
  for (const [id, nextValue] of nextById.entries()) {
    const prevValue = previousById.get(id);
    if (JSON.stringify(prevValue || null) !== JSON.stringify(nextValue || null)) {
      ids.push(id);
    }
  }
  return ids;
}

function hasMutationTool(toolName) {
  return TEST_MUTATION_TOOLS.has(toolName) || TASK_MUTATION_TOOLS.has(toolName);
}

class TurnEntityTracker {
  constructor({ manifest, renderer, request }) {
    this.manifest = manifest;
    this.repoRoot = manifest.repoRoot;
    this.renderer = renderer || null;
    this.request = request || null;
    this.startState = loadState(this.repoRoot);
    this.currentState = this.startState;
    this.touchedTestIds = new Set();
    this.touchedTaskIds = new Set();
    this.touchOrder = [];
    this.lastLabel = 'Worker';
    this.pendingMutations = [];
    this.displayedTestIds = new Set();
    this.displayedTestTitles = new Set();
    this.displayedTaskIds = new Set();
    this.displayedTaskTitles = new Set();
    this.displayedBugTaskIds = new Set();
    this.displayedBugTitles = new Set();
    this.requestQaArtifacts = normalizeQaArtifactIds(this.request && this.request.qaReportArtifacts);
  }

  setLabel(label) {
    if (label) this.lastLabel = label;
  }

  noteRenderedToolCard(toolName, input, label) {
    const tool = baseToolName(toolName);
    this.setLabel(label);
    if (DISPLAY_TEST_TOOLS.has(tool)) {
      if (input && input.test_id) this.displayedTestIds.add(input.test_id);
      if (input && input.title) this.displayedTestTitles.add(String(input.title));
      return;
    }
    if (DISPLAY_TASK_TOOLS.has(tool)) {
      if (input && input.task_id) this.displayedTaskIds.add(input.task_id);
      if (input && input.title) this.displayedTaskTitles.add(String(input.title));
      return;
    }
    if (DISPLAY_BUG_TOOLS.has(tool)) {
      if (input && input.task_id) this.displayedBugTaskIds.add(input.task_id);
      if (input && input.title) this.displayedBugTitles.add(String(input.title));
    }
  }

  queueMutation(toolName, input, label) {
    const tool = baseToolName(toolName);
    if (!hasMutationTool(tool)) return;
    this.setLabel(label);
    this.pendingMutations.push({ tool, input: input || {} });
  }

  async noteToolCompletion(toolName, input, output, label) {
    const tool = baseToolName(toolName);
    this.setLabel(label);
    if (!hasMutationTool(tool)) return;
    const state = loadState(this.repoRoot);
    if (!stateDiffers(state, this.currentState)) return;
    this._applyMutation(tool, input || {}, output || {}, state);
    this.currentState = state;
  }

  async flushPendingMutations() {
    if (!this.pendingMutations.length) return;
    const state = loadState(this.repoRoot);
    if (!stateDiffers(state, this.currentState)) return;
    const queued = this.pendingMutations.splice(0);
    for (const pending of queued) {
      this._applyMutation(pending.tool, pending.input || {}, {}, state);
    }
    this.currentState = state;
  }

  async finalize({ emitFinalCards = true } = {}) {
    await this.flushPendingMutations();
    this._clearLiveCard();
    if (!emitFinalCards) return;

    const endState = loadState(this.repoRoot);
    this.currentState = endState;
    for (const entry of this.touchOrder) {
      if (!entry || !entry.type || !entry.id) continue;
      if (entry.type === 'test') {
        const test = endState.testsById.get(entry.id);
        if (!test) continue;
        if (!this._entityChanged('test', entry.id, test)) continue;
        if (this.displayedTestIds.has(entry.id) || this.displayedTestTitles.has(String(test.title || ''))) continue;
        this._postEntityCard('test', buildTestCardData(test));
        continue;
      }
      const task = endState.tasksById.get(entry.id);
      if (!task) continue;
      if (!this._entityChanged('task', entry.id, task)) continue;
      const taskTitle = String(task.title || '');
      if (this.displayedBugTaskIds.has(entry.id) || this.displayedBugTitles.has(taskTitle)) continue;
      if (this.displayedTaskIds.has(entry.id) || this.displayedTaskTitles.has(taskTitle)) continue;
      this._postEntityCard('task', buildTaskCardData(task));
    }
  }

  _entityChanged(type, id, currentEntity) {
    const startEntity = type === 'test'
      ? this.startState.testsById.get(id)
      : this.startState.tasksById.get(id);
    return JSON.stringify(startEntity || null) !== JSON.stringify(currentEntity || null);
  }

  _touch(type, id) {
    if (!id) return;
    if (type === 'test') {
      if (!this.touchedTestIds.has(id)) {
        this.touchedTestIds.add(id);
        this.touchOrder.push({ type, id });
      }
      return;
    }
    if (!this.touchedTaskIds.has(id)) {
      this.touchedTaskIds.add(id);
      this.touchOrder.push({ type, id });
    }
  }

  _applyMutation(tool, input, output, state) {
    const parsedOutput = parseCanonicalToolResult(output) || output || {};
    const affected = this._resolveAffectedEntities(tool, input, parsedOutput, state);
    for (const testId of affected.testIds) this._touch('test', testId);
    for (const taskId of affected.taskIds) this._touch('task', taskId);
    this._updateQaArtifacts(affected);
    if (affected.live) {
      const liveEntity = affected.live.type === 'test'
        ? state.testsById.get(affected.live.id)
        : state.tasksById.get(affected.live.id);
      if (liveEntity) {
        const payload = affected.live.type === 'test'
          ? buildTestCardData(liveEntity)
          : buildTaskCardData(liveEntity);
        this._postLiveCard(affected.live.type, payload);
      }
    }
  }

  _resolveAffectedEntities(tool, input, output, state) {
    const testIds = new Set();
    const taskIds = new Set();
    let live = null;

    const addTest = (id) => {
      if (!id || !state.testsById.has(id)) return;
      testIds.add(id);
      if (!live) live = { type: 'test', id };
    };
    const addTask = (id) => {
      if (!id || !state.tasksById.has(id)) return;
      taskIds.add(id);
      live = { type: 'task', id };
    };

    if (input && input.test_id) addTest(input.test_id);
    if (output && output.test_id) addTest(output.test_id);
    if (input && input.task_id) addTask(input.task_id);
    if (output && output.task_id) addTask(output.task_id);

    if (tool === 'create_test') {
      addTest(output && output.id);
      if (testIds.size === 0) {
        addTest(newestUntouchedId(state.tests, this.startState.testsById, this.touchedTestIds));
      }
    }

    if (tool === 'create_task') {
      addTask(output && output.id);
      if (taskIds.size === 0) {
        addTask(newestUntouchedId(state.tasks, this.startState.tasksById, this.touchedTaskIds));
      }
    }

    if (tool === 'create_bug_from_test') {
      if (output && output.test_id) addTest(output.test_id);
      if (testIds.size === 0 && input && input.test_id) addTest(input.test_id);
      addTask(output && output.task_id);
      if (taskIds.size === 0) {
        addTask(newestUntouchedId(state.tasks, this.startState.tasksById, this.touchedTaskIds));
      }
    }

    if ((tool === 'add_comment' || tool === 'add_progress_update' || tool === 'edit_comment' || tool === 'edit_progress_update' || tool === 'delete_comment' || tool === 'delete_progress_update')
        && input && input.task_id) {
      live = { type: 'task', id: input.task_id };
    }

    if (testIds.size === 0 && TEST_MUTATION_TOOLS.has(tool)) {
      for (const id of changedIds(this.currentState.testsById, state.testsById)) addTest(id);
    }

    if (taskIds.size === 0 && TASK_MUTATION_TOOLS.has(tool)) {
      for (const id of changedIds(this.currentState.tasksById, state.tasksById)) addTask(id);
    }

    return {
      testIds: Array.from(testIds),
      taskIds: Array.from(taskIds),
      live,
    };
  }

  _postLiveCard(type, data) {
    if (!this.renderer || !this.renderer._post) return;
    this.renderer._post({
      type: 'liveEntityCard',
      label: this.lastLabel,
      entityType: type,
      data,
    });
  }

  _updateQaArtifacts(affected) {
    this.requestQaArtifacts = mergeQaArtifactIds(this.requestQaArtifacts, {
      tests: affected && Array.isArray(affected.testIds) ? affected.testIds : [],
      tasks: affected && Array.isArray(affected.taskIds) ? affected.taskIds : [],
    });
    if (this.request) {
      this.request.qaReportArtifacts = { ...this.requestQaArtifacts };
      this.request.qaReportLabel = this.lastLabel;
    }
  }

  _clearLiveCard() {
    if (!this.renderer || !this.renderer._post) return;
    this.renderer._post({ type: 'clearLiveEntityCard' });
  }

  _postEntityCard(type, data) {
    if (!this.renderer || !this.renderer._post) return;
    if (type === 'test') {
      this.renderer._post({ type: 'testCard', label: this.lastLabel, data });
      return;
    }
    this.renderer._post({ type: 'taskCard', label: this.lastLabel, data });
  }
}

module.exports = {
  TurnEntityTracker,
  TEST_MUTATION_TOOLS,
  TASK_MUTATION_TOOLS,
  baseToolName,
  buildTaskCardData,
  buildTestCardData,
  hasMutationTool,
};
