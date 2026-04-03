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
  });
});
