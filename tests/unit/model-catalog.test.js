const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
  API_PROVIDER_MODELS,
  API_PROVIDER_THINKING,
  buildApiCatalogPayload,
} = require('../../src/model-catalog');

describe('model catalog', () => {
  it('includes refreshed direct OpenAI and Gemini models', () => {
    const openaiValues = API_PROVIDER_MODELS.openai.map((entry) => entry.value);
    const geminiValues = API_PROVIDER_MODELS.gemini.map((entry) => entry.value);
    assert.ok(openaiValues.includes('gpt-5.4'));
    assert.ok(openaiValues.includes('gpt-5.1'));
    assert.ok(!openaiValues.includes('gpt-5.3-codex'));
    assert.ok(!geminiValues.includes('gemini-3-pro-preview'));
    assert.ok(geminiValues.includes('gemini-3.1-pro-preview'));
    assert.ok(geminiValues.includes('gemini-3.1-flash-lite-preview'));
  });

  it('includes curated OpenRouter families', () => {
    const openrouterValues = API_PROVIDER_MODELS.openrouter.map((entry) => entry.value);
    assert.ok(openrouterValues.includes('openai/gpt-5.3-codex'));
    assert.ok(openrouterValues.includes('x-ai/grok-4-fast'));
    assert.ok(openrouterValues.includes('moonshotai/kimi-k2.5'));
    assert.ok(openrouterValues.includes('qwen/qwen3-coder-next'));
    assert.ok(openrouterValues.includes('minimax/minimax-m2.5'));
  });

  it('buildApiCatalogPayload returns cloned arrays', () => {
    const payload = buildApiCatalogPayload();
    assert.deepEqual(payload.models.openai, API_PROVIDER_MODELS.openai);
    assert.deepEqual(payload.thinking.openai, API_PROVIDER_THINKING.openai);
    assert.notEqual(payload.models.openai, API_PROVIDER_MODELS.openai);
    assert.notEqual(payload.thinking.openai, API_PROVIDER_THINKING.openai);
  });

  it('buildApiCatalogPayload includes named custom providers with custom catalog behavior', () => {
    const payload = buildApiCatalogPayload({
      customProviders: [
        { id: 'lmstudio', name: 'LM Studio', baseURL: 'http://localhost:1234/v1' },
      ],
    });
    const lmstudio = payload.providers.find((provider) => provider.id === 'lmstudio');
    assert.ok(lmstudio);
    assert.equal(lmstudio.name, 'LM Studio');
    assert.equal(lmstudio.catalogKey, 'custom');
    assert.equal(lmstudio.apiKeyOptional, true);
  });
});
