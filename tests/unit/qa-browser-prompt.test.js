const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { buildAgentWorkerSystemPrompt } = require('../../src/prompts');
const { buildPromptsDirs } = require('../../src/prompt-tags');

describe('QA Browser prompt activation rules', () => {
  it('requires explicit user intent before entering formal testing mode', () => {
    const repoRoot = path.resolve(__dirname, '../..');
    const prompt = buildAgentWorkerSystemPrompt(
      { name: 'QA Engineer (Browser)', system_prompt: '@@qa_browser', mcps: {} },
      undefined,
      buildPromptsDirs(repoRoot)
    );

    assert.match(prompt, /\*\*Testing mode\*\* starts only when the user explicitly asks you to test/i);
    assert.match(prompt, /In non-testing mode, you must \*\*not\*\*:/i);
    assert.match(prompt, /create tests/i);
    assert.match(prompt, /start test runs/i);
    assert.match(prompt, /If the user later narrows scope, only test that requested scope/i);
    assert.match(prompt, /After a meaningful exploration or testing session, save the durable facts you learned without waiting for the user to ask/i);
    assert.match(prompt, /important navigation structure, major feature areas, and how screens connect/i);
    assert.match(prompt, /hard-won knowledge about how to perform or verify important tasks in the app/i);
    assert.match(prompt, /Do not treat Project Memory as a bug tracker/i);
  });
});
