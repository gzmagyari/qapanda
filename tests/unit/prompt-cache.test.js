const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
  buildPromptCacheContext,
  sortToolDefinitions,
  supportsOpenAi24hRetention,
} = require('../../src/prompt-cache');

describe('prompt cache policy', () => {
  it('uses 24h retention only for supported OpenAI models', () => {
    assert.equal(supportsOpenAi24hRetention('gpt-4.1'), true);
    assert.equal(supportsOpenAi24hRetention('gpt-5.4-mini'), true);
    assert.equal(supportsOpenAi24hRetention('o3'), false);
  });

  it('builds provider-specific cache contexts', () => {
    const openai = buildPromptCacheContext({
      providerId: 'openai',
      model: 'gpt-4.1',
      runId: 'run-1',
      sessionKey: 'worker:default',
      purpose: 'worker',
    });
    assert.equal(openai.cacheMode, 'automatic');
    assert.equal(openai.promptCacheRetention, '24h');

    const openrouterClaude = buildPromptCacheContext({
      providerId: 'openrouter',
      model: 'anthropic/claude-sonnet-4.6',
      runId: 'run-1',
      sessionKey: 'worker:default',
      purpose: 'worker',
    });
    assert.equal(openrouterClaude.cacheMode, 'native');
    assert.deepEqual(openrouterClaude.cacheControl, { type: 'ephemeral', ttl: '1h' });

    const openrouterQwen = buildPromptCacheContext({
      providerId: 'openrouter',
      model: 'qwen/qwen3-coder',
      runId: 'run-1',
      sessionKey: 'worker:default',
      purpose: 'worker',
    });
    assert.equal(openrouterQwen.cacheMode, 'unsupported');

    const gemini = buildPromptCacheContext({
      providerId: 'gemini',
      model: 'gemini-2.5-flash',
      runId: 'run-1',
      sessionKey: 'worker:default',
      purpose: 'worker',
      geminiCachedContentName: 'cachedContents/demo',
    });
    assert.equal(gemini.cacheMode, 'explicit');
    assert.equal(gemini.geminiCachedContentName, 'cachedContents/demo');
  });

  it('sorts tool definitions deterministically and stabilizes schemas', () => {
    const tools = sortToolDefinitions([
      {
        type: 'function',
        function: {
          name: 'zeta',
          description: 'z',
          parameters: { type: 'object', properties: { b: { type: 'string' }, a: { type: 'string' } } },
        },
      },
      {
        type: 'function',
        function: {
          name: 'alpha',
          description: 'a',
          parameters: { properties: { y: { type: 'number' }, x: { type: 'number' } }, type: 'object' },
        },
      },
    ]);
    assert.deepEqual(tools.map((tool) => tool.function.name), ['alpha', 'zeta']);
    assert.deepEqual(Object.keys(tools[0].function.parameters.properties), ['x', 'y']);
    assert.deepEqual(Object.keys(tools[1].function.parameters.properties), ['a', 'b']);
  });
});
