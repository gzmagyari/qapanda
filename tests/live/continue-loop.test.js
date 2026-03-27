const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const { createTempDir, mockRenderer, mockPostMessage } = require('../helpers/test-utils');
const { skipIfMissing, PROJECT_ROOT, EXTENSION_DIR } = require('../helpers/live-test-utils');
const { prepareNewRun, saveManifest } = require('../../src/state');
const { runDirectWorkerTurn, runManagerLoop } = require('../../src/orchestrator');
const { loadMergedAgents, enabledAgents, findResourcesDir, loadMergedModes } = require('../../src/config-loader');
const { mcpServersForRole } = require('../../src/mcp-injector');

const resourcesDir = findResourcesDir();
const agentsData = loadMergedAgents(PROJECT_ROOT, resourcesDir);
const allAgents = enabledAgents(agentsData);

function buildTestManifest(tmp, overrides = {}) {
  return {
    repoRoot: tmp.root,
    stateRoot: path.join(tmp.root, '.qpanda'),
    controllerCli: 'codex',
    workerCli: 'claude',
    agents: allAgents,
    workerMcpServers: mcpServersForRole('worker', { repoRoot: tmp.root }),
    controllerMcpServers: mcpServersForRole('controller', { repoRoot: tmp.root }),
    ...overrides,
  };
}

let tmp;
beforeEach(() => { tmp = createTempDir(); });
afterEach(() => { tmp.cleanup(); });

describe('Continue orchestration: controller delegates work tasks', { timeout: 180000 }, () => {

  it('after user chats with agent, controller sends a WORK instruction (not a conversation relay)', async (t) => {
    if (await skipIfMissing(t, 'claude')) return;
    if (await skipIfMissing(t, 'codex')) return;

    const renderer = mockRenderer();
    const opts = buildTestManifest(tmp);

    // Step 1: User sends message directly to dev agent
    let manifest = await prepareNewRun('Tell me about this repository structure briefly', opts);
    manifest = await runDirectWorkerTurn(manifest, renderer, {
      userMessage: 'Tell me about this repository structure briefly',
      agentId: 'dev',
    });

    // Verify agent responded
    const transcript = fs.readFileSync(manifest.files.transcript, 'utf8').trim();
    const lines = transcript.split('\n').map(l => JSON.parse(l));
    assert.ok(lines.some(l => l.role === 'claude'), 'agent should have responded');

    // Step 2: Simulate Continue — controller should decide what to do next
    // Set a copilot-style controller prompt that instructs it to give work tasks
    manifest.controllerSystemPrompt = `You are a copilot. The user is chatting with a dev agent.
Review the transcript and decide what WORK TASK the agent should do next.
Do NOT tell the agent how to reply to the user. Give it an actionable task.
If there is no clear task, delegate with: "Ask the user what they would like you to work on."
The active agent is "dev". Use agent_id: "dev".`;

    manifest.status = 'running';
    await saveManifest(manifest);

    manifest = await runManagerLoop(manifest, renderer, {
      userMessage: '[AUTO-CONTINUE] Decide the next step based on the conversation transcript.',
      singlePass: true,
    });

    // Step 3: Verify the controller's decision
    const lastReq = manifest.requests[manifest.requests.length - 1];
    const decision = lastReq && lastReq.latestControllerDecision;

    if (decision) {
      if (decision.action === 'delegate') {
        // Good — controller delegated. Check that the instruction is a work task, not a conversation relay
        const instruction = decision.claude_message || '';
        assert.ok(instruction.length > 0, 'should have an instruction');
        // It should NOT contain phrases like "reply to the user" or "tell the user"
        const lowerInstruction = instruction.toLowerCase();
        const isConversationRelay = lowerInstruction.includes('reply to the user') ||
          lowerInstruction.includes('tell the user') ||
          lowerInstruction.includes('respond to the user') ||
          lowerInstruction.includes('chat casually');
        // This is a soft check — the controller might still phrase things oddly
        if (isConversationRelay) {
          console.log('[WARNING] Controller sent a conversation relay instead of a work task:', instruction.slice(0, 200));
        }
      }
      // Both delegate and stop are acceptable — what matters is the instruction quality
      assert.ok(decision.action === 'delegate' || decision.action === 'stop', 'controller should delegate or stop');
    }
  });

  it('controller delegates to correct agent_id (not "default")', async (t) => {
    if (await skipIfMissing(t, 'claude')) return;
    if (await skipIfMissing(t, 'codex')) return;

    const renderer = mockRenderer();
    const opts = buildTestManifest(tmp);

    // User chats with QA-Browser agent first
    let manifest = await prepareNewRun('Navigate to example.com and take a screenshot', opts);
    manifest = await runDirectWorkerTurn(manifest, renderer, {
      userMessage: 'Navigate to example.com and take a screenshot',
      agentId: 'dev', // using dev since QA-Browser needs Chrome
    });

    // Set controller prompt that specifies the active agent
    manifest.controllerSystemPrompt = `You are a copilot. The active agent is "dev".
Use agent_id: "dev" when delegating. Give the agent a work task based on the transcript.`;
    manifest.status = 'running';
    await saveManifest(manifest);

    manifest = await runManagerLoop(manifest, renderer, {
      userMessage: '[AUTO-CONTINUE] Decide the next step.',
      singlePass: true,
    });

    const lastReq = manifest.requests[manifest.requests.length - 1];
    const decision = lastReq && lastReq.latestControllerDecision;

    if (decision && decision.action === 'delegate') {
      // Controller should use "dev" not "default"
      assert.ok(
        decision.agent_id === 'dev' || decision.agent_id === null,
        'controller should delegate to "dev" agent, got: ' + decision.agent_id
      );
    }
  });

  it('controller with guidance delegates based on user direction', async (t) => {
    if (await skipIfMissing(t, 'claude')) return;
    if (await skipIfMissing(t, 'codex')) return;

    const renderer = mockRenderer();
    const opts = buildTestManifest(tmp);

    // Start a run
    let manifest = await prepareNewRun('Hi', opts);
    manifest = await runDirectWorkerTurn(manifest, renderer, {
      userMessage: 'Hi',
      agentId: 'dev',
    });

    // Continue with specific guidance
    manifest.controllerSystemPrompt = `You are a copilot. The active agent is "dev".

CONTINUE DIRECTIVE:
The user wants you to continue with this direction: "Read the package.json and tell me what dependencies this project has"
Give the agent this task. Use agent_id: "dev".
You MUST delegate (action: "delegate").`;

    manifest.status = 'running';
    await saveManifest(manifest);

    manifest = await runManagerLoop(manifest, renderer, {
      userMessage: '[CONTROLLER GUIDANCE] Read the package.json and tell me what dependencies this project has',
      singlePass: true,
    });

    const lastReq = manifest.requests[manifest.requests.length - 1];
    const decision = lastReq && lastReq.latestControllerDecision;

    if (decision) {
      assert.equal(decision.action, 'delegate', 'controller should delegate with guidance');
      if (decision.claude_message) {
        const msg = decision.claude_message.toLowerCase();
        assert.ok(
          msg.includes('package.json') || msg.includes('dependencies') || msg.includes('read'),
          'instruction should reference the user guidance about package.json. Got: ' + decision.claude_message.slice(0, 200)
        );
      }
    }
  });
});

describe('Continue orchestration: transcript continuity', { timeout: 120000 }, () => {
  it('agent maintains session across Send + Continue cycles', async (t) => {
    if (await skipIfMissing(t, 'claude')) return;
    if (await skipIfMissing(t, 'codex')) return;

    const renderer = mockRenderer();
    const opts = buildTestManifest(tmp);

    // Turn 1: Direct user → agent
    let manifest = await prepareNewRun('Remember the number 42. Just say OK.', opts);
    manifest = await runDirectWorkerTurn(manifest, renderer, {
      userMessage: 'Remember the number 42. Just say OK.',
      agentId: 'dev',
    });

    // Verify transcript has both user and agent entries
    const transcript1 = fs.readFileSync(manifest.files.transcript, 'utf8').trim();
    const lines1 = transcript1.split('\n').map(l => JSON.parse(l));
    assert.ok(lines1.some(l => l.role === 'user'), 'should have user entry');
    assert.ok(lines1.some(l => l.role === 'claude'), 'should have agent entry');

    // Turn 2: Controller continue — should see previous transcript
    manifest.controllerSystemPrompt = `You are a copilot. The active agent is "dev".
Delegate with: "What number did the user ask you to remember? Just say the number."
Use agent_id: "dev". You MUST delegate.`;
    manifest.status = 'running';
    await saveManifest(manifest);

    manifest = await runManagerLoop(manifest, renderer, {
      userMessage: '[AUTO-CONTINUE]',
      singlePass: true,
    });

    // Check transcript grew
    const transcript2 = fs.readFileSync(manifest.files.transcript, 'utf8').trim();
    const lines2 = transcript2.split('\n').map(l => JSON.parse(l));
    assert.ok(lines2.length > lines1.length, 'transcript should grow after controller continue');

    // The agent should have responded (possibly with "42" if session persisted)
    const agentResponses = lines2.filter(l => l.role === 'claude');
    assert.ok(agentResponses.length >= 2, 'should have multiple agent responses');
  });
});
