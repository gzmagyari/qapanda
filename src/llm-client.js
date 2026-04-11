/**
 * Multi-provider LLM client using OpenAI SDK.
 * Supports OpenAI, Anthropic, OpenRouter, Google Gemini, and any OpenAI-compatible endpoint.
 */
const OpenAI = require('openai');
const {
  API_PROVIDER_MODELS: PROVIDER_MODELS,
  API_PROVIDER_THINKING: THINKING_TIERS,
} = require('./model-catalog');
const {
  BUILTIN_PROVIDER_DEFS,
  LEGACY_CUSTOM_PROVIDER,
  loadProviderSettings,
  providerCatalogKey,
  resolveApiProvider,
} = require('./api-provider-registry');

// Provider definitions
const PROVIDERS = {
  openai: { name: BUILTIN_PROVIDER_DEFS.openai.name, baseURL: BUILTIN_PROVIDER_DEFS.openai.baseURL, envKey: BUILTIN_PROVIDER_DEFS.openai.envKey },
  anthropic: { name: BUILTIN_PROVIDER_DEFS.anthropic.name, baseURL: BUILTIN_PROVIDER_DEFS.anthropic.baseURL, envKey: BUILTIN_PROVIDER_DEFS.anthropic.envKey },
  openrouter: { name: BUILTIN_PROVIDER_DEFS.openrouter.name, baseURL: BUILTIN_PROVIDER_DEFS.openrouter.baseURL, envKey: BUILTIN_PROVIDER_DEFS.openrouter.envKey },
  gemini: { name: BUILTIN_PROVIDER_DEFS.gemini.name, baseURL: BUILTIN_PROVIDER_DEFS.gemini.baseURL, envKey: BUILTIN_PROVIDER_DEFS.gemini.envKey },
  custom: { name: LEGACY_CUSTOM_PROVIDER.name, baseURL: LEGACY_CUSTOM_PROVIDER.baseURL, envKey: LEGACY_CUSTOM_PROVIDER.envKey },
};

const ANTHROPIC_THINKING_BUDGETS = {
  low: 4096,
  medium: 10000,
  high: 20000,
  xhigh: 50000,
};

class LLMClient {
  /**
   * @param {object} opts
   * @param {string} opts.provider - Provider key (openai, anthropic, openrouter, gemini, custom)
   * @param {string} opts.apiKey - API key
   * @param {string} [opts.baseURL] - Custom base URL (overrides provider default)
   * @param {string} opts.model - Model name
   */
  constructor({ provider, apiKey, baseURL, model }) {
    const providerConfig = PROVIDERS[provider] || PROVIDERS.custom;
    this.provider = provider || 'custom';
    this.model = model;
    this.client = new OpenAI({
      apiKey: apiKey || process.env[providerConfig.envKey] || 'dummy',
      baseURL: baseURL || providerConfig.baseURL,
    });
  }

  /**
   * Stream a chat completion. Yields events as they arrive.
   * @param {Array} messages - OpenAI-format messages
   * @param {Array} [tools] - OpenAI-format tool definitions
   * @param {object} [options] - { thinking, response_format, signal }
   * @yields {{ type: 'text', content: string } | { type: 'tool_call', index, id, name, args } | { type: 'done', text, toolCalls, usage }}
   */
  async *streamChat(messages, tools, options = {}) {
    const params = {
      model: this.model,
      messages,
      stream: true,
      stream_options: { include_usage: true },
    };
    if (tools && tools.length > 0) {
      params.tools = tools;
      params.tool_choice = options.tool_choice || 'auto';
    }
    if (options.response_format) {
      params.response_format = options.response_format;
    }
    this._applyThinking(params, options.thinking);
    this._applyCaching(params, messages);
    if (typeof options.onRequest === 'function') {
      await options.onRequest({
        mode: 'stream',
        params: _cloneForLog(params),
      });
    }

    const stream = await this.client.chat.completions.create(params, {
      signal: options.signal,
    });

    const pending = {};
    const textParts = [];
    let usage = null;
    const finishReasons = [];

    for await (const chunk of stream) {
      if (typeof options.onChunk === 'function') {
        await options.onChunk(_cloneForLog(chunk));
      }
      if (chunk.usage) usage = chunk.usage;
      const choice = chunk.choices && chunk.choices[0];
      if (!choice) continue;
      if (choice.finish_reason != null) {
        finishReasons.push(choice.finish_reason);
      }

      const delta = choice.delta;
      if (delta && delta.content) {
        textParts.push(delta.content);
        yield { type: 'text', content: delta.content };
      }

      const tcs = delta && delta.tool_calls;
      if (tcs) {
        for (const tc of tcs) {
          const idx = tc.index;
          if (!pending[idx]) pending[idx] = { id: null, name: null, args: '' };
          if (tc.id) pending[idx].id = tc.id;
          const fn = tc.function;
          if (fn && fn.name) pending[idx].name = fn.name;
          if (fn && fn.arguments) {
            pending[idx].args += fn.arguments;
            yield {
              type: 'tool_call_delta',
              index: idx,
              id: pending[idx].id,
              name: pending[idx].name,
              argsDelta: fn.arguments,
            };
          }
        }
      }
    }

    const toolCalls = Object.keys(pending).length > 0
      ? Object.keys(pending).sort((a, b) => a - b).map((idx) => {
          const p = pending[idx];
          return {
            id: p.id,
            type: 'function',
            function: { name: p.name, arguments: p.args },
          };
        })
      : null;

    yield {
      type: 'done',
      text: textParts.join(''),
      toolCalls,
      finishReason: finishReasons.length > 0 ? finishReasons[finishReasons.length - 1] : null,
      finishReasons,
      usage: usage ? {
        promptTokens: usage.prompt_tokens,
        completionTokens: usage.completion_tokens,
        totalTokens: usage.total_tokens,
      } : null,
    };
  }

  /**
   * Non-streaming chat completion.
   * @returns {{ text, toolCalls, usage }}
   */
  async chat(messages, tools, options = {}) {
    const params = {
      model: this.model,
      messages,
    };
    if (tools && tools.length > 0) {
      params.tools = tools;
      params.tool_choice = options.tool_choice || 'auto';
    }
    if (options.response_format) {
      params.response_format = options.response_format;
    }
    this._applyThinking(params, options.thinking);
    this._applyCaching(params, messages);
    if (typeof options.onRequest === 'function') {
      await options.onRequest({
        mode: 'chat',
        params: _cloneForLog(params),
      });
    }

    const response = await this.client.chat.completions.create(params, {
      signal: options.signal,
    });
    if (typeof options.onResponse === 'function') {
      await options.onResponse(_cloneForLog(response));
    }

    const choice = response.choices && response.choices[0];
    const message = choice && choice.message;
    return {
      text: message ? (message.content || '') : '',
      toolCalls: message && message.tool_calls ? message.tool_calls : null,
      finishReason: choice ? (choice.finish_reason || null) : null,
      usage: response.usage ? {
        promptTokens: response.usage.prompt_tokens,
        completionTokens: response.usage.completion_tokens,
        totalTokens: response.usage.total_tokens,
      } : null,
    };
  }

  _applyThinking(params, thinking) {
    if (!thinking) return;

    if (this.provider === 'anthropic') {
      const budget = ANTHROPIC_THINKING_BUDGETS[thinking] || 10000;
      params.thinking = { type: 'enabled', budget_tokens: budget };
    } else if (this.provider === 'openrouter') {
      if (!params.extra_body) params.extra_body = {};
      params.extra_body.reasoning = { effort: thinking, exclude: false };
      params.extra_body.include_reasoning = true;
    } else if (this.provider === 'gemini') {
      if (!params.extra_body) params.extra_body = {};
      params.extra_body.thinking_level = thinking;
    } else {
      params.reasoning_effort = thinking;
    }
  }

  _applyCaching(params, messages) {
    if (this.provider === 'anthropic') {
      params.cache_control = { type: 'ephemeral', ttl: '1h' };
    } else if (this.provider === 'openrouter' && this.model && this.model.includes('anthropic')) {
      params.cache_control_injection_points = [{ location: 'message', index: -1 }];
    }
  }
}

function _cloneForLog(value) {
  if (value == null) return value;
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return null;
  }
}

/**
 * Resolve API key for a provider.
 * Checks: ~/.qpanda/settings.json → environment variable → fallback.
 * @param {string} provider
 * @param {string} [fallback]
 * @returns {string|null}
 */
function resolveApiKey(provider, fallback, settings = loadProviderSettings()) {
  if (settings && settings.apiKeys && Object.prototype.hasOwnProperty.call(settings.apiKeys, provider)) {
    return String(settings.apiKeys[provider] || '').trim();
  }

  const resolvedProvider = resolveApiProvider(provider, settings);
  const providerConfig = resolvedProvider || PROVIDERS[provider];
  if (providerConfig && providerConfig.envKey && process.env[providerConfig.envKey]) {
    return process.env[providerConfig.envKey];
  }
  if (fallback) return fallback;
  return null;
}

function defaultModelForProvider(provider, settings = null) {
  const models = PROVIDER_MODELS[providerCatalogKey(provider, settings)] || PROVIDER_MODELS.openrouter;
  const firstNamedModel = models.find((entry) => entry && entry.value && entry.value !== '_custom');
  return firstNamedModel ? firstNamedModel.value : null;
}

module.exports = {
  LLMClient,
  PROVIDERS,
  PROVIDER_MODELS,
  THINKING_TIERS,
  ANTHROPIC_THINKING_BUDGETS,
  resolveApiKey,
  defaultModelForProvider,
};
