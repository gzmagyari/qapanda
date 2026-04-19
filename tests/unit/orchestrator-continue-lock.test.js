const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');

const { createTempDir, mockRenderer } = require('../helpers/test-utils');

const orchestratorPath = path.resolve(__dirname, '../../src/orchestrator.js');
const codexPath = path.resolve(__dirname, '../../src/codex.js');
const codexWorkerPath = path.resolve(__dirname, '../../src/codex-worker.js');
const statePath = path.resolve(__dirname, '../../src/state.js');

const origCodex = require(codexPath);
const origCodexWorker = require(codexWorkerPath);
const { prepareNewRun } = require(statePath);

function loadOrchestratorWithStubs({ controllerDecisions, onWorkerCall }) {
  const controllerCalls = [];
  delete require.cache[orchestratorPath];
  require.cache[codexPath] = {
    id: codexPath,
    filename: codexPath,
    loaded: true,
    exports: {
      ...origCodex,
      runControllerTurn: async ({ controllerPromptOverride }) => {
        controllerCalls.push(controllerPromptOverride || '');
        const next = controllerDecisions.shift();
        if (!next) throw new Error('No stubbed controller decision remaining.');
        return {
          prompt: controllerPromptOverride || '',
          decision: next.decision,
          sessionId: next.sessionId || 'controller-session-test',
        };
      },
      runControllerTurnAppServer: async () => {
        throw new Error('runControllerTurnAppServer should not be used in this test.');
      },
    },
  };
  require.cache[codexWorkerPath] = {
    id: codexWorkerPath,
    filename: codexWorkerPath,
    loaded: true,
    exports: {
      ...origCodexWorker,
      runCodexWorkerTurn: async ({ agentId, prompt }) => {
        if (typeof onWorkerCall === 'function') onWorkerCall({ agentId, prompt });
        return {
          exitCode: 0,
          resultText: `worker:${agentId || 'default'}:${prompt}`,
        };
      },
      runCodexWorkerTurnAppServer: async () => {
        throw new Error('runCodexWorkerTurnAppServer should not be used in this test.');
      },
    },
  };
  return { ...require(orchestratorPath), controllerCalls };
}

function restoreOrchestratorStubs() {
  delete require.cache[orchestratorPath];
  require.cache[codexPath] = { id: codexPath, filename: codexPath, loaded: true, exports: origCodex };
  require.cache[codexWorkerPath] = { id: codexWorkerPath, filename: codexWorkerPath, loaded: true, exports: origCodexWorker };
}

test('runManagerLoop retries once when Continue returns the wrong locked agent', async () => {
  const tmp = createTempDir();
  const workerCalls = [];
  const controllerDecisions = [
    {
      decision: {
        action: 'delegate',
        agent_id: 'QA-Browser',
        claude_message: 'wrong agent task',
        controller_messages: ['wrong agent'],
        stop_reason: null,
        progress_updates: [],
      },
    },
    {
      decision: {
        action: 'delegate',
        agent_id: 'dev',
        claude_message: 'correct agent task',
        controller_messages: ['correct agent'],
        stop_reason: null,
        progress_updates: [],
      },
    },
  ];

  try {
    const { runManagerLoop, controllerCalls } = loadOrchestratorWithStubs({
      controllerDecisions,
      onWorkerCall: (call) => workerCalls.push(call),
    });
    const manifest = await prepareNewRun('seed', {
      repoRoot: tmp.root,
      stateRoot: path.join(tmp.root, '.qpanda'),
      controllerCli: 'codex',
      controllerCodexMode: 'cli',
      workerCli: 'codex',
      agents: {
        dev: { name: 'Developer', cli: 'codex' },
        'QA-Browser': { name: 'QA Engineer (Browser)', cli: 'codex' },
      },
    });

    const updated = await runManagerLoop(manifest, mockRenderer(), {
      userMessage: '[AUTO-CONTINUE] Decide the next step based on the conversation transcript.',
      singlePass: true,
      controllerPromptOverride: 'BASE PROMPT',
      continueLock: { agentId: 'dev' },
    });

    assert.equal(workerCalls.length, 1);
    assert.equal(workerCalls[0].agentId, 'dev');
    assert.equal(updated.requests.at(-1).latestControllerDecision.agent_id, 'dev');
    assert.equal(controllerCalls.length, 2);
    assert.match(controllerCalls[1], /CONTINUE VALIDATION CORRECTION/);
    assert.match(controllerCalls[1], /agent_id to "dev"/i);

    const events = fs.readFileSync(updated.files.events, 'utf8');
    assert.match(events, /controller-continue-lock-mismatch/);
  } finally {
    restoreOrchestratorStubs();
    tmp.cleanup();
  }
});

test('runManagerLoop leaves non-Continue controller delegation unlocked', async () => {
  const tmp = createTempDir();
  const workerCalls = [];

  try {
    const { runManagerLoop } = loadOrchestratorWithStubs({
      controllerDecisions: [
        {
          decision: {
            action: 'delegate',
            agent_id: 'QA-Browser',
            claude_message: 'qa task',
            controller_messages: ['qa task'],
            stop_reason: null,
            progress_updates: [],
          },
        },
      ],
      onWorkerCall: (call) => workerCalls.push(call),
    });
    const manifest = await prepareNewRun('seed', {
      repoRoot: tmp.root,
      stateRoot: path.join(tmp.root, '.qpanda'),
      controllerCli: 'codex',
      controllerCodexMode: 'cli',
      workerCli: 'codex',
      agents: {
        dev: { name: 'Developer', cli: 'codex' },
        'QA-Browser': { name: 'QA Engineer (Browser)', cli: 'codex' },
      },
    });

    const updated = await runManagerLoop(manifest, mockRenderer(), {
      userMessage: 'orchestrate next step',
      singlePass: true,
    });

    assert.equal(workerCalls.length, 1);
    assert.equal(workerCalls[0].agentId, 'QA-Browser');
    assert.equal(updated.requests.at(-1).latestControllerDecision.agent_id, 'QA-Browser');
  } finally {
    restoreOrchestratorStubs();
    tmp.cleanup();
  }
});
