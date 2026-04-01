/**
 * Multi-provider LLM client using OpenAI SDK.
 * Supports OpenAI, Anthropic, OpenRouter, Google Gemini, and any OpenAI-compatible endpoint.
 */
const OpenAI = require('openai');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const {
  API_PROVIDER_MODELS: PROVIDER_MODELS,
  API_PROVIDER_THINKING: THINKING_TIERS,
} = require('./model-catalog');

// Provider definitions
const PROVIDERS = {
  openai: { name: 'OpenAI', baseURL: undefined, envKey: 'OPENAI_API_KEY' },
  anthropic: { name: 'Anthropic', baseURL: 'https://api.anthropic.com/v1/', envKey: 'ANTHROPIC_API_KEY' },
  openrouter: { name: 'OpenRouter', baseURL: 'https://openrouter.ai/api/v1', envKey: 'OPENROUTER_API_KEY' },
  gemini: { name: 'Google Gemini', baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai', envKey: 'GEMINI_API_KEY' },
  custom: { name: 'Custom', baseURL: undefined, envKey: null },
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

    const stream = await this.client.chat.completions.create(params, {
      signal: options.signal,
    });

    const pending = {};
    const textParts = [];
    let usage = null;

    for await (const chunk of stream) {
      if (chunk.usage) usage = chunk.usage;
      const choice = chunk.choices && chunk.choices[0];
      if (!choice) continue;

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

    const response = await this.client.chat.completions.create(params, {
      signal: options.signal,
    });

    const choice = response.choices && response.choices[0];
    const message = choice && choice.message;
    return {
      text: message ? (message.content || '') : '',
      toolCalls: message && message.tool_calls ? message.tool_calls : null,
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

/**
 * Resolve API key for a provider.
 * Checks: ~/.qpanda/settings.json → environment variable → fallback.
 * @param {string} provider
 * @param {string} [fallback]
 * @returns {string|null}
 */
function resolveApiKey(provider, fallback) {
  try {
    const settingsPath = path.join(os.homedir(), '.qpanda', 'settings.json');
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    if (settings.apiKeys && settings.apiKeys[provider]) return settings.apiKeys[provider];
  } catch {}

  const providerConfig = PROVIDERS[provider];
  if (providerConfig && providerConfig.envKey && process.env[providerConfig.envKey]) {
    return process.env[providerConfig.envKey];
  }
  if (fallback) return fallback;
  return null;
}

function defaultModelForProvider(provider) {
  const models = PROVIDER_MODELS[provider] || PROVIDER_MODELS.openrouter;
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
