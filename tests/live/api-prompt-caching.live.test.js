/**
 * Live prompt caching verification for built-in API providers.
 *
 * This test consumes real API tokens. Skip with:
 * - SKIP_REAL_API=1
 * - SKIP_LIVE_PROMPT_CACHE_TEST=1
 *
 * Keys are loaded from process.env first, then from:
 *   C:\xampp\htdocs\CopilotClone\.env
 */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { LLMClient } = require('../../src/llm-client');
const { buildPromptCacheContext } = require('../../src/prompt-cache');

const EXTERNAL_ENV_PATH = 'C:\\xampp\\htdocs\\CopilotClone\\.env';
const SKIP_ALL =
  process.env.SKIP_REAL_API === '1' ||
  process.env.SKIP_LIVE_PROMPT_CACHE_TEST === '1';

function loadEnvValue(name) {
  if (process.env[name]) {
    return String(process.env[name]).trim();
  }
  try {
    const raw = fs.readFileSync(EXTERNAL_ENV_PATH, 'utf8');
    const match = raw.match(new RegExp(`^${name}=([^\\r\\n]+)$`, 'm'));
    return match ? String(match[1]).trim() : '';
  } catch {
    return '';
  }
}

function buildLargeStablePrefix(nonce) {
  const repeatedBlock = Array.from({ length: 320 }, (_, index) =>
    `Cache probe ${nonce} stable prefix section ${index + 1}: alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi omicron pi rho sigma tau upsilon phi chi psi omega.`
  ).join('\n');
  return [
    `You are running a live prompt cache verification for nonce ${nonce}.`,
    'Preserve this entire message as stable context across repeated requests.',
    'Do not summarize or transform it.',
    repeatedBlock,
  ].join('\n\n');
}

function buildProbeMessages(nonce) {
  return [
    {
      role: 'system',
      content: buildLargeStablePrefix(nonce),
    },
    {
      role: 'user',
      content: `Prompt caching probe ${nonce}. Reply with exactly CACHE_OK.`,
    },
  ];
}

async function runThreeCalls({ providerId, provider, apiKey, model, promptCache }) {
  const client = new LLMClient({ provider, apiKey, model });
  const nonce = `${providerId}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const messages = buildProbeMessages(nonce);
  const capturedRequests = [];

  async function invoke() {
    return client.chat(messages, null, {
      promptCache,
      onRequest: async ({ params }) => {
        capturedRequests.push(params);
      },
    });
  }

  const first = await invoke();
  const second = await invoke();
  const third = await invoke();

  return {
    messages,
    first,
    second,
    third,
    capturedRequests,
  };
}

function usageSummary(result) {
  const usage = result && result.usage ? result.usage : {};
  return {
    promptTokens: usage.promptTokens || 0,
    completionTokens: usage.completionTokens || 0,
    cachedTokens: usage.cachedTokens || 0,
    cacheWriteTokens: usage.cacheWriteTokens || 0,
    cacheReadInputTokens: usage.cacheReadInputTokens || 0,
    cacheCreationInputTokens: usage.cacheCreationInputTokens || 0,
    uncachedTailTokens: usage.uncachedTailTokens || 0,
    cacheMode: usage.cacheMode || null,
    cacheSupport: usage.cacheSupport || null,
    finishReason: result && result.finishReason ? result.finishReason : null,
    text: result && result.text ? result.text : '',
  };
}

function maxCachedTokens(...results) {
  return Math.max(
    ...results.map((result) => {
      const usage = result && result.usage ? result.usage : {};
      return Math.max(
        usage.cachedTokens || 0,
        usage.cacheReadInputTokens || 0,
      );
    }),
  );
}

const OPENAI_API_KEY = loadEnvValue('OPENAI_API_KEY');
const OPENROUTER_API_KEY = loadEnvValue('OPENROUTER_API_KEY');
const OPENAI_MODEL = process.env.OPENAI_CACHE_TEST_MODEL || 'gpt-4.1';
const OPENROUTER_MODEL = process.env.OPENROUTER_CACHE_TEST_MODEL || 'anthropic/claude-haiku-4.5';

describe('Live API prompt caching - OpenAI', {
  skip: SKIP_ALL || !OPENAI_API_KEY ? 'No OpenAI API key available' : false,
}, () => {
  it('reuses cached prompt tokens on repeated calls', { timeout: 180000 }, async (t) => {
    const promptCache = buildPromptCacheContext({
      providerId: 'openai',
      model: OPENAI_MODEL,
      runId: 'live-cache-openai',
      sessionKey: `worker:live:${Date.now()}`,
      purpose: 'worker',
    });

    const probe = await runThreeCalls({
      providerId: 'openai',
      provider: 'openai',
      apiKey: OPENAI_API_KEY,
      model: OPENAI_MODEL,
      promptCache,
    });

    const summaries = {
      first: usageSummary(probe.first),
      second: usageSummary(probe.second),
      third: usageSummary(probe.third),
    };
    t.diagnostic(`OpenAI prompt cache usage: ${JSON.stringify(summaries)}`);

    assert.equal(probe.capturedRequests.length, 3);
    assert.equal(probe.capturedRequests[0].prompt_cache_key, promptCache.promptCacheKey);
    assert.equal(probe.capturedRequests[1].prompt_cache_key, promptCache.promptCacheKey);
    assert.equal(probe.capturedRequests[2].prompt_cache_key, promptCache.promptCacheKey);
    assert.equal(probe.capturedRequests[0].prompt_cache_retention, '24h');
    assert.match(probe.first.text, /CACHE_OK/i);
    assert.match(probe.second.text, /CACHE_OK/i);
    assert.match(probe.third.text, /CACHE_OK/i);
    assert.ok(
      summaries.first.promptTokens >= 1024,
      `OpenAI prompt was too small for caching. promptTokens=${summaries.first.promptTokens}`,
    );
    assert.ok(
      maxCachedTokens(probe.second, probe.third) > 0,
      `Expected cached tokens on a repeated OpenAI call. Usage: ${JSON.stringify(summaries)}`,
    );
  });
});

describe('Live API prompt caching - OpenRouter Claude', {
  skip: SKIP_ALL || !OPENROUTER_API_KEY ? 'No OpenRouter API key available' : false,
}, () => {
  it('uses cache_control and reports cache hits on repeated calls', { timeout: 180000 }, async (t) => {
    const promptCache = buildPromptCacheContext({
      providerId: 'openrouter',
      model: OPENROUTER_MODEL,
      runId: 'live-cache-openrouter',
      sessionKey: `worker:live:${Date.now()}`,
      purpose: 'worker',
    });

    const probe = await runThreeCalls({
      providerId: 'openrouter',
      provider: 'openrouter',
      apiKey: OPENROUTER_API_KEY,
      model: OPENROUTER_MODEL,
      promptCache,
    });

    const summaries = {
      first: usageSummary(probe.first),
      second: usageSummary(probe.second),
      third: usageSummary(probe.third),
    };
    t.diagnostic(`OpenRouter prompt cache usage: ${JSON.stringify(summaries)}`);

    assert.equal(probe.capturedRequests.length, 3);
    assert.deepEqual(probe.capturedRequests[0].cache_control, { type: 'ephemeral', ttl: '1h' });
    assert.equal(probe.capturedRequests[0].provider, undefined);
    assert.equal(probe.capturedRequests[1].provider, undefined);
    assert.equal(probe.capturedRequests[2].provider, undefined);
    assert.match(probe.first.text, /CACHE_OK/i);
    assert.match(probe.second.text, /CACHE_OK/i);
    assert.match(probe.third.text, /CACHE_OK/i);
    assert.ok(
      summaries.first.promptTokens >= 1024,
      `OpenRouter prompt was unexpectedly small. promptTokens=${summaries.first.promptTokens}`,
    );
    assert.ok(
      maxCachedTokens(probe.second, probe.third) > 0,
      `Expected cached tokens on a repeated OpenRouter call. Usage: ${JSON.stringify(summaries)}`,
    );
  });
});
