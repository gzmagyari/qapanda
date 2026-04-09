const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
  BUILTIN_PROVIDER_IDS,
  isKnownApiProvider,
  listApiProviders,
  normalizeSettingsData,
  resolveApiProvider,
  resolveRuntimeApiProvider,
  sanitizeCustomProviderId,
} = require('../../src/api-provider-registry');

describe('api-provider-registry', () => {
  it('sanitizes custom provider ids', () => {
    assert.equal(sanitizeCustomProviderId('LM Studio'), 'lm-studio');
    assert.equal(sanitizeCustomProviderId('  My_Local API  '), 'my-local-api');
  });

  it('normalizes settings custom providers and drops invalid entries', () => {
    const normalized = normalizeSettingsData({
      customProviders: [
        { id: 'LM Studio', name: 'LM Studio', baseURL: 'http://localhost:1234/v1' },
        { id: 'openai', name: 'Collision', baseURL: 'http://localhost:9999/v1' },
        { id: 'LM Studio', name: 'Duplicate', baseURL: 'http://localhost:1234/v1' },
        { id: 'missing-url', name: 'Missing URL' },
      ],
    });
    assert.deepEqual(normalized.customProviders, [
      { id: 'lm-studio', name: 'LM Studio', baseURL: 'http://localhost:1234/v1' },
    ]);
  });

  it('lists built-ins first and appends named custom providers', () => {
    const providers = listApiProviders({
      customProviders: [
        { id: 'lmstudio', name: 'LM Studio', baseURL: 'http://localhost:1234/v1' },
      ],
    });
    assert.deepEqual(providers.slice(0, BUILTIN_PROVIDER_IDS.length).map((provider) => provider.id), BUILTIN_PROVIDER_IDS);
    assert.equal(providers[providers.length - 1].id, 'lmstudio');
    assert.equal(providers[providers.length - 1].catalogKey, 'custom');
    assert.equal(providers[providers.length - 1].apiKeyOptional, true);
  });

  it('resolves named custom providers for runtime', () => {
    const settings = {
      customProviders: [
        { id: 'lmstudio', name: 'LM Studio', baseURL: 'http://localhost:1234/v1' },
      ],
    };
    const provider = resolveApiProvider('lmstudio', settings);
    const runtime = resolveRuntimeApiProvider('lmstudio', settings);
    assert.equal(provider.id, 'lmstudio');
    assert.equal(provider.baseURL, 'http://localhost:1234/v1');
    assert.equal(runtime.clientProvider, 'custom');
    assert.equal(isKnownApiProvider('lmstudio', settings), true);
    assert.equal(isKnownApiProvider('missing-provider', settings), false);
  });
});
