const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { buildGeminiCacheUsage } = require('../../src/gemini-cache-store');
const { stableHash } = require('../../src/prompt-cache');

describe('gemini cache store', () => {
  it('reuses cached content only when the current messages still share the cached prefix', () => {
    const systemPrompt = 'sys';
    const cachedMessages = [
      { role: 'user', content: 'one' },
      { role: 'assistant', content: 'two' },
    ];
    const entry = {
      cacheName: 'cachedContents/demo',
      systemPrompt,
      systemPromptHash: stableHash(systemPrompt),
      cachedMessageCount: cachedMessages.length,
      prefixHash: stableHash(cachedMessages),
    };

    const reusable = buildGeminiCacheUsage(entry, [
      ...cachedMessages,
      { role: 'user', content: 'three' },
    ]);
    assert.equal(reusable.cachedContentName, 'cachedContents/demo');
    assert.deepEqual(reusable.uncachedMessages, [{ role: 'user', content: 'three' }]);

    const invalidated = buildGeminiCacheUsage(entry, [
      { role: 'user', content: 'different' },
      { role: 'assistant', content: 'two' },
    ]);
    assert.equal(invalidated.cachedContentName, null);
    assert.equal(invalidated.uncachedMessages.length, 2);
  });
});
