const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildContinueDirective,
  sanitizePersistedControllerSystemPrompt,
} = require('../../src/prompts');

test('manual continue guidance remains explicit delegate-only behavior', () => {
  const text = buildContinueDirective('fix the login bug', 'dev', {
    loopMode: true,
    loopObjective: 'Finish A-03',
  });

  assert.match(text, /The user clicked Continue with this guidance/i);
  assert.match(text, /You MUST delegate \(action: "delegate"\)/i);
  assert.match(text, /You MUST use agent_id: "dev"/i);
  assert.doesNotMatch(text, /Stop only when this objective is achieved/i);
});

test('loop mode without objective keeps driving the overall task forward', () => {
  const text = buildContinueDirective('', 'dev', {
    loopMode: true,
  });

  assert.match(text, /KEEP DRIVING THE OVERALL TASK FORWARD/i);
  assert.match(text, /Stop only if the overall task is complete/i);
  assert.doesNotMatch(text, /Stop\. The task is done\./i);
});

test('loop mode with objective uses the objective as the stop condition', () => {
  const text = buildContinueDirective('', 'dev', {
    loopMode: true,
    loopObjective: 'Finish A-01 through A-03',
  });

  assert.match(text, /Finish A-01 through A-03/);
  assert.match(text, /Stop only when this objective is achieved/i);
  assert.match(text, /Do NOT simply restate the full objective back to the agent/i);
  assert.match(text, /infer current progress against the objective/i);
  assert.match(text, /finish tickets 1 to 10/i);
  assert.doesNotMatch(text, /Stop\. The task is done\./i);
});

test('continue directive can lock the default worker', () => {
  const text = buildContinueDirective('', 'default', {
    loopMode: false,
  });

  assert.match(text, /default worker/i);
  assert.match(text, /Set agent_id to null or "default"/i);
  assert.doesNotMatch(text, /most appropriate available agent/i);
});

test('sanitizePersistedControllerSystemPrompt strips stale generated continue directives', () => {
  const prompt = [
    'persistent prompt',
    '',
    'CONTINUE DIRECTIVE — stale',
    'Use agent_id: "QA-Browser"',
  ].join('\n');

  assert.equal(sanitizePersistedControllerSystemPrompt(prompt), 'persistent prompt');
  assert.equal(sanitizePersistedControllerSystemPrompt('clean prompt'), 'clean prompt');
});
