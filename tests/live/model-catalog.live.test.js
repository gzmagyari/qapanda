const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
  LLMClient,
  resolveApiKey,
} = require('../../src/llm-client');
const { API_PROVIDER_MODELS } = require('../../src/model-catalog');

const RUN_LIVE = process.env.RUN_MODEL_CATALOG_LIVE === '1';
const PROVIDER_FILTER = (process.env.MODEL_CATALOG_PROVIDER || '').trim();
const TIMEOUT_MS = Number(process.env.MODEL_CATALOG_TIMEOUT_MS || 15000);

function catalogModelsFor(provider) {
  return (API_PROVIDER_MODELS[provider] || [])
    .map((entry) => entry && entry.value)
    .filter((value) => value && value !== '_custom');
}

async function smokeModel(provider, model) {
  const apiKey = resolveApiKey(provider);
  assert.ok(apiKey, `missing API key for ${provider}`);

  const client = new LLMClient({ provider, apiKey, model });
  const abortController = new AbortController();
  const timer = setTimeout(() => abortController.abort(), TIMEOUT_MS);
  try {
    const result = await client.chat([{ role: 'user', content: 'Reply with OK' }], null, {
      signal: abortController.signal,
    });
    return String(result && result.text ? result.text : '').trim();
  } finally {
    clearTimeout(timer);
  }
}

const providers = Object.keys(API_PROVIDER_MODELS)
  .filter((provider) => provider !== 'custom')
  .filter((provider) => !PROVIDER_FILTER || provider === PROVIDER_FILTER);

describe('live model catalog smoke', {
  skip: RUN_LIVE ? false : 'Set RUN_MODEL_CATALOG_LIVE=1 to enable live model verification',
}, () => {
  for (const provider of providers) {
    const apiKey = resolveApiKey(provider);
    describe(provider, {
      skip: apiKey ? false : `No API key configured for ${provider}`,
    }, () => {
      for (const model of catalogModelsFor(provider)) {
        it(`accepts ${model}`, async () => {
          const text = await smokeModel(provider, model);
          assert.ok(text.length > 0, `expected non-empty response from ${provider}/${model}`);
        });
      }
    });
  }
});
