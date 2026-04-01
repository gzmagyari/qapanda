/**
 * Multi-provider LLM client using OpenAI SDK.
 * Supports OpenAI, Anthropic, OpenRouter, Google Gemini, and any OpenAI-compatible endpoint.
 */
const OpenAI = require('openai');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

// ── Provider definitions ─────────────────────────────────────────

const PROVIDERS = {
  openai: { name: 'OpenAI', baseURL: undefined, envKey: 'OPENAI_API_KEY' },
  anthropic: { name: 'Anthropic', baseURL: 'https://api.anthropic.com/v1/', envKey: 'ANTHROPIC_API_KEY' },
  openrouter: { name: 'OpenRouter', baseURL: 'https://openrouter.ai/api/v1', envKey: 'OPENROUTER_API_KEY' },
  gemini: { name: 'Google Gemini', baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai', envKey: 'GEMINI_API_KEY' },
  custom: { name: 'Custom', baseURL: undefined, envKey: null },
};

// ── Model lists per provider ─────────────────────────────────────

const PROVIDER_MODELS = {
  openai: [
    { value: '', label: 'Model: default' },
    { value: 'gpt-4.1', label: 'GPT-4.1' },
    { value: 'gpt-4.1-mini', label: 'GPT-4.1 Mini' },
    { value: 'gpt-4.1-nano', label: 'GPT-4.1 Nano' },
    { value: 'gpt-5', label: 'GPT-5' },
    { value: 'gpt-5-mini', label: 'GPT-5 Mini' },
    { value: 'o3', label: 'o3' },
    { value: 'o4-mini', label: 'o4 Mini' },
  ],
  anthropic: [
    { value: '', label: 'Model: default' },
    { value: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6' },
    { value: 'claude-opus-4-6', label: 'Claude Opus 4.6' },
    { value: 'claude-haiku-4-5', label: 'Claude Haiku 4.5' },
  ],
  openrouter: [
    { value: '', label: 'Model: default' },
    { value: 'openai/gpt-4.1', label: 'GPT-4.1' },
    { value: 'openai/gpt-4.1-mini', label: 'GPT-4.1 Mini' },
    { value: 'openai/gpt-5', label: 'GPT-5' },
    { value: 'anthropic/claude-sonnet-4-6', label: 'Claude Sonnet 4.6' },
    { value: 'anthropic/claude-opus-4-6', label: 'Claude Opus 4.6' },
    { value: 'anthropic/claude-haiku-4-5', label: 'Claude Haiku 4.5' },
    { value: 'google/gemini-3-pro-preview', label: 'Gemini 3 Pro' },
    { value: 'google/gemini-3-flash', label: 'Gemini 3 Flash' },
    { value: 'x-ai/grok-code-fast-1', label: 'Grok Code Fast' },
  ],
  gemini: [
    { value: '', label: 'Model: default' },
    { value: 'gemini-3-flash', label: 'Gemini 3 Flash' },
    { value: 'gemini-3-pro', label: 'Gemini 3 Pro' },
  ],
  custom: [
    { value: '', label: 'Model: enter below' },
  ],
};

// ── Thinking / reasoning config per provider ─────────────────────

const THINKING_TIERS = {
  openai: [
    { value: '', label: 'Thinking: off' },
    { value: 'low', label: 'Low' },
    { value: 'medium', label: 'Medium' },
    { value: 'high', label: 'High' },
  ],
  anthropic: [
    { value: '', label: 'Thinking: off' },
    { value: 'low', label: 'Low (4K budget)' },
    { value: 'medium', label: 'Medium (10K budget)' },
    { value: 'high', label: 'High (20K budget)' },
    { value: 'xhigh', label: 'XHigh (50K budget)' },
  ],
  openrouter: [
    { value: '', label: 'Thinking: off' },
    { value: 'low', label: 'Low' },
    { value: 'medium', label: 'Medium' },
    { value: 'high', label: 'High' },
  ],
  gemini: [
    { value: '', label: 'Thinking: off' },
    { value: 'minimal', label: 'Minimal' },
    { value: 'low', label: 'Low' },
    { value: 'medium', label: 'Medium' },
    { value: 'high', label: 'High' },
  ],
  custom: [
    { value: '', label: 'Thinking: off' },
    { value: 'low', label: 'Low' },
    { value: 'medium', label: 'Medium' },
    { value: 'high', label: 'High' },
  ],
};

const ANTHROPIC_THINKING_BUDGETS = {
  low: 4096,
  medium: 10000,
  high: 20000,
  xhigh: 50000,
};

// ── LLM Client ───────────────────────────────────────────────────

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

      // Accumulate tool calls
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
            yield { type: 'tool_call_delta', index: idx, id: pending[idx].id, name: pending[idx].name, argsDelta: fn.arguments };
          }
        }
      }
    }

    // Build final tool calls array
    const toolCalls = Object.keys(pending).length > 0
      ? Object.keys(pending).sort((a, b) => a - b).map(idx => {
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

  /** Apply thinking/reasoning config based on provider */
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
      // OpenAI and others: reasoning_effort
      params.reasoning_effort = thinking;
    }
  }

  /** Apply prompt caching for supported providers */
  _applyCaching(params, messages) {
    if (this.provider === 'anthropic') {
      // Anthropic auto-caching
      params.cache_control = { type: 'ephemeral', ttl: '1h' };
    } else if (this.provider === 'openrouter' && this.model && this.model.includes('anthropic')) {
      params.cache_control_injection_points = [{ location: 'message', index: -1 }];
    }
  }
}

/**
 * Resolve API key for a provider.
 * Checks: ~/.qpanda/settings.json → environment variable → fallback.
 * @param {string} provider - Provider key (openai, anthropic, openrouter, gemini)
 * @param {string} [fallback] - Fallback key (e.g. from manifest config)
 * @returns {string|null}
 */
function resolveApiKey(provider, fallback) {
  // 1. Settings file
  try {
    const settingsPath = path.join(os.homedir(), '.qpanda', 'settings.json');
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    if (settings.apiKeys && settings.apiKeys[provider]) return settings.apiKeys[provider];
  } catch {}
  // 2. Environment variable
  const providerConfig = PROVIDERS[provider];
  if (providerConfig && providerConfig.envKey && process.env[providerConfig.envKey]) {
    return process.env[providerConfig.envKey];
  }
  // 3. Fallback from manifest/config
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
