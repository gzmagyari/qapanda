const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { createMockServer } = require('./llm-mock-server');
const { LLMClient, PROVIDERS, PROVIDER_MODELS, THINKING_TIERS, resolveApiKey, defaultModelForProvider } = require('../../src/llm-client');

let mock;

before(async () => {
  mock = await createMockServer();
});
after(async () => {
  if (mock) await mock.close();
});

function makeClient(handler) {
  if (handler) mock.setHandler(handler);
  return new LLMClient({
    provider: 'custom',
    apiKey: 'test-key',
    baseURL: mock.url + '/v1',
    model: 'test-model',
  });
}

function makeProviderClient(provider, model, handler, extra = {}) {
  if (handler) mock.setHandler(handler);
  return new LLMClient({
    provider,
    apiKey: 'test-key',
    baseURL: mock.url + (provider === 'anthropic' ? '' : '/v1'),
    model,
    ...extra,
  });
}

describe('LLMClient streaming', () => {
  it('streams text chunks correctly', async () => {
    const client = makeClient(() => ({ text: 'Hello world from the API' }));
    const events = [];
    for await (const event of client.streamChat([{ role: 'user', content: 'hi' }])) {
      events.push(event);
    }
    const textEvents = events.filter(e => e.type === 'text');
    assert.ok(textEvents.length > 0, 'should have text events');
    const done = events.find(e => e.type === 'done');
    assert.ok(done, 'should have done event');
    assert.equal(done.text, 'Hello world from the API');
    assert.equal(done.toolCalls, null);
  });

  it('parses tool_calls from streaming chunks', async () => {
    const client = makeClient(() => ({
      toolCalls: [
        { id: 'call_1', name: 'read_file', arguments: { path: '/tmp/test.txt' } },
      ],
    }));
    const events = [];
    for await (const event of client.streamChat([{ role: 'user', content: 'read' }], [{ type: 'function', function: { name: 'read_file', parameters: {} } }])) {
      events.push(event);
    }
    const done = events.find(e => e.type === 'done');
    assert.ok(done.toolCalls, 'should have tool calls');
    assert.equal(done.toolCalls.length, 1);
    assert.equal(done.toolCalls[0].function.name, 'read_file');
    const args = JSON.parse(done.toolCalls[0].function.arguments);
    assert.equal(args.path, '/tmp/test.txt');
  });

  it('handles multiple tool calls in single response', async () => {
    const client = makeClient(() => ({
      toolCalls: [
        { id: 'call_1', name: 'read_file', arguments: { path: 'a.txt' } },
        { id: 'call_2', name: 'grep_search', arguments: { pattern: 'foo' } },
      ],
    }));
    const events = [];
    for await (const event of client.streamChat([{ role: 'user', content: 'search' }], [{}])) {
      events.push(event);
    }
    const done = events.find(e => e.type === 'done');
    assert.equal(done.toolCalls.length, 2);
    assert.equal(done.toolCalls[0].function.name, 'read_file');
    assert.equal(done.toolCalls[1].function.name, 'grep_search');
  });

  it('includes usage data in done event', async () => {
    const client = makeClient(() => ({
      text: 'hi',
      usage: { prompt_tokens: 50, completion_tokens: 10, total_tokens: 60 },
    }));
    const events = [];
    for await (const event of client.streamChat([{ role: 'user', content: 'hi' }])) {
      events.push(event);
    }
    const done = events.find(e => e.type === 'done');
    assert.ok(done.usage, 'should have usage');
    assert.equal(done.usage.promptTokens, 50);
    assert.equal(done.usage.completionTokens, 10);
  });

  it('yields tool_call_delta events during streaming', async () => {
    const client = makeClient(() => ({
      toolCalls: [{ id: 'call_1', name: 'read_file', arguments: { path: '/long/path/to/file.txt' } }],
    }));
    const events = [];
    for await (const event of client.streamChat([{ role: 'user', content: 'read' }], [{}])) {
      events.push(event);
    }
    const deltas = events.filter(e => e.type === 'tool_call_delta');
    assert.ok(deltas.length > 0, 'should have tool_call_delta events');
    assert.equal(deltas[0].name, 'read_file');
  });

  it('captures finish reason and raw request/chunk hooks', async () => {
    const client = makeClient(() => ({ text: 'done' }));
    let requestPayload = null;
    let chunkCount = 0;
    const events = [];
    for await (const event of client.streamChat(
      [{ role: 'user', content: 'hi' }],
      null,
      {
        onRequest: async (payload) => { requestPayload = payload; },
        onChunk: async () => { chunkCount += 1; },
      }
    )) {
      events.push(event);
    }
    const done = events.find(e => e.type === 'done');
    assert.equal(done.finishReason, 'stop');
    assert.deepEqual(done.finishReasons, ['stop']);
    assert.ok(requestPayload, 'should capture request payload');
    assert.equal(requestPayload.mode, 'stream');
    assert.equal(requestPayload.params.model, 'test-model');
    assert.ok(chunkCount > 0, 'should capture raw chunks');
  });
});

describe('LLMClient non-streaming', () => {
  it('returns complete text response', async () => {
    const client = makeClient(() => ({ text: 'Complete response' }));
    const result = await client.chat([{ role: 'user', content: 'hi' }]);
    assert.equal(result.text, 'Complete response');
    assert.equal(result.toolCalls, null);
  });

  it('returns tool calls', async () => {
    const client = makeClient(() => ({
      text: '',
      toolCalls: [{ id: 'call_1', name: 'read_file', arguments: { path: 'x.txt' } }],
    }));
    const result = await client.chat([{ role: 'user', content: 'read' }], [{}]);
    assert.ok(result.toolCalls, 'should have tool calls');
    assert.equal(result.toolCalls.length, 1);
    assert.equal(result.toolCalls[0].function.name, 'read_file');
  });

  it('includes usage data', async () => {
    const client = makeClient(() => ({ text: 'hi', usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 } }));
    const result = await client.chat([{ role: 'user', content: 'hi' }]);
    assert.equal(result.usage.totalTokens, 7);
  });

  it('captures finish reason and raw request/response hooks', async () => {
    const client = makeClient(() => ({ text: 'ok' }));
    let requestPayload = null;
    let responsePayload = null;
    const result = await client.chat(
      [{ role: 'user', content: 'hi' }],
      null,
      {
        onRequest: async (payload) => { requestPayload = payload; },
        onResponse: async (payload) => { responsePayload = payload; },
      }
    );
    assert.equal(result.finishReason, 'stop');
    assert.ok(requestPayload, 'should capture request payload');
    assert.ok(responsePayload, 'should capture response payload');
  });
});

describe('LLMClient error handling', () => {
  it('handles auth errors (401)', async () => {
    const client = makeClient(() => ({ error: 'Invalid API key', status: 401, errorType: 'authentication_error' }));
    await assert.rejects(
      async () => { for await (const _ of client.streamChat([{ role: 'user', content: 'hi' }])) {} },
      (err) => err.status === 401 || err.message.includes('401')
    );
  });

  it('handles rate limit errors (429)', async () => {
    const client = makeClient(() => ({ error: 'Rate limit exceeded', status: 429, errorType: 'rate_limit_error' }));
    await assert.rejects(
      async () => { for await (const _ of client.streamChat([{ role: 'user', content: 'hi' }])) {} },
      (err) => err.status === 429 || err.message.includes('429')
    );
  });
});

describe('LLMClient provider routing', () => {
  it('uses correct baseURL for each provider', () => {
    for (const [key, config] of Object.entries(PROVIDERS)) {
      if (key === 'custom') continue;
      const client = new LLMClient({ provider: key, apiKey: 'test', model: 'test' });
      if (config.baseURL) {
        assert.equal(client.client.baseURL, config.baseURL, `${key} should use ${config.baseURL}`);
      }
    }
  });

  it('allows custom baseURL override', () => {
    const client = new LLMClient({ provider: 'openai', apiKey: 'test', baseURL: 'http://localhost:9999/v1', model: 'test' });
    assert.equal(client.client.baseURL, 'http://localhost:9999/v1');
  });
});

describe('LLMClient thinking config', () => {
  it('applies OpenAI reasoning_effort', async () => {
    let capturedParams;
    const client = makeClient((_req, body) => {
      capturedParams = body;
      return { text: 'ok' };
    });
    await client.chat([{ role: 'user', content: 'hi' }], null, { thinking: 'high' });
    assert.equal(capturedParams.reasoning_effort, 'high');
  });
});

describe('LLMClient prompt caching config', () => {
  it('applies OpenAI prompt cache fields', async () => {
    let capturedParams;
    const client = makeProviderClient('openai', 'gpt-4.1', (_req, body) => {
      capturedParams = body;
      return { text: 'ok' };
    });
    await client.chat(
      [{ role: 'user', content: 'hi' }],
      null,
      {
        promptCache: {
          promptCacheKey: 'qapanda:test',
          promptCacheRetention: '24h',
          cacheMode: 'automatic',
          cacheSupport: 'supported',
        },
      }
    );
    assert.equal(capturedParams.prompt_cache_key, 'qapanda:test');
    assert.equal(capturedParams.prompt_cache_retention, '24h');
  });

  it('applies OpenRouter Claude top-level cache control', async () => {
    let capturedParams;
    const client = makeProviderClient('openrouter', 'anthropic/claude-sonnet-4.6', (_req, body) => {
      capturedParams = body;
      return { text: 'ok' };
    });
    await client.chat(
      [{ role: 'user', content: 'hi' }],
      null,
      {
        promptCache: {
          cacheControl: { type: 'ephemeral', ttl: '1h' },
          cacheMode: 'native',
          cacheSupport: 'supported',
        },
      }
    );
    assert.deepEqual(capturedParams.cache_control, { type: 'ephemeral', ttl: '1h' });
    assert.equal(capturedParams.provider, undefined);
  });

  it('applies Gemini cached_content through extra_body', async () => {
    let capturedParams;
    const client = makeProviderClient('gemini', 'gemini-2.5-flash', (_req, body) => {
      capturedParams = body;
      return { text: 'ok' };
    });
    await client.chat(
      [{ role: 'system', content: 'sys' }, { role: 'user', content: 'hi' }],
      null,
      {
        promptCache: {
          cacheMode: 'explicit',
          cacheSupport: 'supported',
          geminiCachedContentName: 'cachedContents/demo',
        },
      }
    );
    assert.equal(
      capturedParams.extra_body.extra_body.google.cached_content,
      'cachedContents/demo'
    );
  });

  it('uses native Anthropic cache control and usage normalization', async () => {
    const client = makeProviderClient('anthropic', 'claude-sonnet-4.6');
    let capturedParams = null;
    client.client.messages.create = async (params) => {
      capturedParams = params;
      return {
        stop_reason: 'end_turn',
        content: [{ type: 'text', text: 'ok' }],
        usage: {
          input_tokens: 12,
          output_tokens: 5,
          cache_read_input_tokens: 40,
          cache_creation_input_tokens: 80,
        },
      };
    };
    const result = await client.chat(
      [{ role: 'system', content: 'sys' }, { role: 'user', content: 'hi' }],
      null,
      {
        promptCache: {
          cacheControl: { type: 'ephemeral', ttl: '1h' },
          cacheMode: 'native',
          cacheSupport: 'supported',
        },
      }
    );
    assert.deepEqual(capturedParams.cache_control, { type: 'ephemeral', ttl: '1h' });
    assert.equal(capturedParams.system, 'sys');
    assert.equal(result.usage.cachedTokens, 40);
    assert.equal(result.usage.cacheWriteTokens, 80);
    assert.equal(result.usage.uncachedTailTokens, 12);
  });
});

describe('Provider/model data exports', () => {
  it('exports PROVIDER_MODELS for all providers', () => {
    for (const key of Object.keys(PROVIDERS)) {
      assert.ok(PROVIDER_MODELS[key], `should have models for ${key}`);
      assert.ok(Array.isArray(PROVIDER_MODELS[key]), `models for ${key} should be array`);
    }
  });

  it('exports THINKING_TIERS for all providers', () => {
    for (const key of Object.keys(PROVIDERS)) {
      assert.ok(THINKING_TIERS[key], `should have thinking tiers for ${key}`);
    }
  });

  it('all models have value and label', () => {
    for (const [provider, models] of Object.entries(PROVIDER_MODELS)) {
      for (const m of models) {
        assert.ok('value' in m, `${provider} model missing value`);
        assert.ok('label' in m, `${provider} model missing label`);
      }
    }
  });

  it('resolves named custom provider API keys from settings', () => {
    const apiKey = resolveApiKey('lmstudio', null, {
      apiKeys: { lmstudio: 'local-key' },
      customProviders: [
        { id: 'lmstudio', name: 'LM Studio', baseURL: 'http://localhost:1234/v1' },
      ],
    });
    assert.equal(apiKey, 'local-key');
  });

  it('uses custom model catalog defaults for named custom providers', () => {
    assert.equal(
      defaultModelForProvider('lmstudio', {
        customProviders: [
          { id: 'lmstudio', name: 'LM Studio', baseURL: 'http://localhost:1234/v1' },
        ],
      }),
      null
    );
  });
});
