/**
 * Multi-provider LLM client.
 * OpenAI/OpenRouter/Gemini/custom use the OpenAI SDK compatibility path.
 * Anthropic uses the native Messages API so prompt caching works correctly.
 */
const OpenAI = require('openai');
const Anthropic = require('@anthropic-ai/sdk');
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
const {
  normalizeAnthropicUsage,
  normalizeOpenAiCompatibleUsage,
} = require('./prompt-cache');

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
  constructor({ provider, apiKey, baseURL, model }) {
    const providerConfig = PROVIDERS[provider] || PROVIDERS.custom;
    this.provider = provider || 'custom';
    this.model = model;
    if (this.provider === 'anthropic') {
      this.client = new Anthropic({
        apiKey: apiKey || process.env[providerConfig.envKey] || 'dummy',
        baseURL: baseURL || providerConfig.baseURL,
      });
    } else {
      this.client = new OpenAI({
        apiKey: apiKey || process.env[providerConfig.envKey] || 'dummy',
        baseURL: baseURL || providerConfig.baseURL,
      });
    }
  }

  async *streamChat(messages, tools, options = {}) {
    if (this.provider === 'anthropic') {
      yield* this._streamAnthropic(messages, tools, options);
      return;
    }
    yield* this._streamOpenAiCompatible(messages, tools, options);
  }

  async chat(messages, tools, options = {}) {
    if (this.provider === 'anthropic') {
      return this._chatAnthropic(messages, tools, options);
    }
    return this._chatOpenAiCompatible(messages, tools, options);
  }

  async *_streamOpenAiCompatible(messages, tools, options = {}) {
    const params = this._buildOpenAiCompatibleParams(messages, tools, options, 'stream');
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
      usage: normalizeOpenAiCompatibleUsage(usage, options.promptCache || {}),
    };
  }

  async _chatOpenAiCompatible(messages, tools, options = {}) {
    const params = this._buildOpenAiCompatibleParams(messages, tools, options, 'chat');
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
      usage: normalizeOpenAiCompatibleUsage(response.usage, options.promptCache || {}),
    };
  }

  _buildOpenAiCompatibleParams(messages, tools, options = {}, mode = 'stream') {
    const params = {
      model: this.model,
      messages,
    };
    if (mode === 'stream') {
      params.stream = true;
      params.stream_options = { include_usage: true };
    }
    if (tools && tools.length > 0) {
      params.tools = tools;
      params.tool_choice = options.tool_choice || 'auto';
    }
    if (options.response_format) {
      params.response_format = options.response_format;
    }
    this._applyThinking(params, options.thinking);
    this._applyCaching(params, options.promptCache || {});
    return params;
  }

  async *_streamAnthropic(messages, tools, options = {}) {
    const params = this._buildAnthropicParams(messages, tools, options);
    if (typeof options.onRequest === 'function') {
      await options.onRequest({
        mode: 'stream',
        params: _cloneForLog(params),
      });
    }
    const response = await this.client.messages.create(params, {
      signal: options.signal,
    });
    if (typeof options.onChunk === 'function') {
      await options.onChunk(_cloneForLog(response));
    }
    const toolCalls = [];
    const textParts = [];
    for (const block of Array.isArray(response.content) ? response.content : []) {
      if (!block || typeof block !== 'object') continue;
      if (block.type === 'text' && typeof block.text === 'string') {
        textParts.push(block.text);
        yield { type: 'text', content: block.text };
        continue;
      }
      if (block.type === 'tool_use') {
        const openAiToolCall = {
          id: block.id || null,
          type: 'function',
          function: {
            name: block.name,
            arguments: JSON.stringify(block.input || {}),
          },
        };
        toolCalls.push(openAiToolCall);
        yield {
          type: 'tool_call_delta',
          index: toolCalls.length - 1,
          id: openAiToolCall.id,
          name: openAiToolCall.function.name,
          argsDelta: openAiToolCall.function.arguments,
        };
      }
    }
    yield {
      type: 'done',
      text: textParts.join(''),
      toolCalls: toolCalls.length > 0 ? toolCalls : null,
      finishReason: response.stop_reason || null,
      finishReasons: response.stop_reason ? [response.stop_reason] : [],
      usage: normalizeAnthropicUsage(response.usage, options.promptCache || {}),
    };
  }

  async _chatAnthropic(messages, tools, options = {}) {
    const params = this._buildAnthropicParams(messages, tools, options);
    if (typeof options.onRequest === 'function') {
      await options.onRequest({
        mode: 'chat',
        params: _cloneForLog(params),
      });
    }
    const response = await this.client.messages.create(params, {
      signal: options.signal,
    });
    if (typeof options.onResponse === 'function') {
      await options.onResponse(_cloneForLog(response));
    }
    const toolCalls = [];
    const textParts = [];
    for (const block of Array.isArray(response.content) ? response.content : []) {
      if (!block || typeof block !== 'object') continue;
      if (block.type === 'text' && typeof block.text === 'string') {
        textParts.push(block.text);
      } else if (block.type === 'tool_use') {
        toolCalls.push({
          id: block.id || null,
          type: 'function',
          function: {
            name: block.name,
            arguments: JSON.stringify(block.input || {}),
          },
        });
      }
    }
    return {
      text: textParts.join(''),
      toolCalls: toolCalls.length > 0 ? toolCalls : null,
      finishReason: response.stop_reason || null,
      usage: normalizeAnthropicUsage(response.usage, options.promptCache || {}),
    };
  }

  _buildAnthropicParams(messages, tools, options = {}) {
    const { system, anthropicMessages } = _splitAnthropicMessages(messages);
    const params = {
      model: this.model,
      max_tokens: options.max_tokens || 4096,
      system,
      messages: anthropicMessages,
    };
    if (tools && tools.length > 0) {
      params.tools = tools.map(_openAiToolToAnthropicTool);
      params.tool_choice = _anthropicToolChoice(options.tool_choice);
    }
    if (options.thinking) {
      const budget = ANTHROPIC_THINKING_BUDGETS[options.thinking] || 10000;
      params.thinking = { type: 'enabled', budget_tokens: budget };
    }
    if (options.promptCache && options.promptCache.cacheControl) {
      params.cache_control = _cloneForLog(options.promptCache.cacheControl);
    }
    return params;
  }

  _applyThinking(params, thinking) {
    if (!thinking) return;
    if (this.provider === 'openrouter') {
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

  _applyCaching(params, cacheContext = {}) {
    if (this.provider === 'openai') {
      params.prompt_cache_key = cacheContext.promptCacheKey;
      if (cacheContext.promptCacheRetention) {
        params.prompt_cache_retention = cacheContext.promptCacheRetention;
      }
      return;
    }
    if (this.provider === 'openrouter' && cacheContext.cacheControl) {
      params.cache_control = _cloneForLog(cacheContext.cacheControl);
      return;
    }
    if (this.provider === 'gemini' && cacheContext.geminiCachedContentName) {
      if (!params.extra_body) params.extra_body = {};
      params.extra_body.extra_body = {
        ...(params.extra_body.extra_body || {}),
        google: {
          ...((params.extra_body.extra_body && params.extra_body.extra_body.google) || {}),
          cached_content: cacheContext.geminiCachedContentName,
        },
      };
    }
  }
}

function _openAiToolToAnthropicTool(tool) {
  return {
    name: tool.function.name,
    description: tool.function.description || '',
    input_schema: tool.function.parameters || { type: 'object', properties: {} },
  };
}

function _anthropicToolChoice(toolChoice) {
  if (!toolChoice || toolChoice === 'auto') return { type: 'auto' };
  if (toolChoice === 'required') return { type: 'any' };
  if (typeof toolChoice === 'object') return toolChoice;
  return { type: 'auto' };
}

function _splitAnthropicMessages(messages) {
  const systemParts = [];
  const anthropicMessages = [];
  for (const message of Array.isArray(messages) ? messages : []) {
    if (!message) continue;
    if (message.role === 'system' || message.role === 'developer') {
      const text = _messageText(message);
      if (text) systemParts.push(text);
      continue;
    }
    if (message.role === 'tool') {
      anthropicMessages.push({
        role: 'user',
        content: [{
          type: 'tool_result',
          tool_use_id: message.tool_call_id,
          content: String(message.content || ''),
        }],
      });
      continue;
    }
    anthropicMessages.push({
      role: message.role === 'assistant' ? 'assistant' : 'user',
      content: _anthropicContentBlocks(message),
    });
  }
  return {
    system: systemParts.join('\n\n'),
    anthropicMessages,
  };
}

function _messageText(message) {
  if (!message) return '';
  if (typeof message.content === 'string') return message.content;
  if (!Array.isArray(message.content)) return '';
  return message.content
    .map((part) => {
      if (!part || typeof part !== 'object') return '';
      if (part.type === 'text' && typeof part.text === 'string') return part.text;
      return '';
    })
    .filter(Boolean)
    .join('\n');
}

function _dataUrlToAnthropicImage(url) {
  const match = String(url || '').match(/^data:([^;]+);base64,(.+)$/);
  if (!match) return null;
  return {
    type: 'image',
    source: {
      type: 'base64',
      media_type: match[1],
      data: match[2],
    },
  };
}

function _anthropicContentBlocks(message) {
  const blocks = [];
  if (typeof message.content === 'string') {
    if (message.content) blocks.push({ type: 'text', text: message.content });
  } else if (Array.isArray(message.content)) {
    for (const part of message.content) {
      if (!part || typeof part !== 'object') continue;
      if (part.type === 'text' && typeof part.text === 'string' && part.text) {
        blocks.push({ type: 'text', text: part.text });
        continue;
      }
      if (part.type === 'image_url' && part.image_url && part.image_url.url) {
        const image = _dataUrlToAnthropicImage(part.image_url.url);
        if (image) blocks.push(image);
      }
    }
  }
  if (message.role === 'assistant' && Array.isArray(message.tool_calls)) {
    for (const toolCall of message.tool_calls) {
      if (!toolCall || !toolCall.function || !toolCall.function.name) continue;
      let input = {};
      try {
        input = typeof toolCall.function.arguments === 'string'
          ? JSON.parse(toolCall.function.arguments || '{}')
          : (toolCall.function.arguments || {});
      } catch {
        input = {};
      }
      blocks.push({
        type: 'tool_use',
        id: toolCall.id || null,
        name: toolCall.function.name,
        input,
      });
    }
  }
  return blocks.length > 0 ? blocks : [{ type: 'text', text: '' }];
}

function _cloneForLog(value) {
  if (value == null) return value;
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return null;
  }
}

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
