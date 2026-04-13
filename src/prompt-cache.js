const crypto = require('node:crypto');

const OPENAI_24H_MODEL_PATTERNS = [
  /^gpt-4\.1(?:$|-)/i,
  /^gpt-5(?:$|[.-])/i,
];

function stableClone(value) {
  if (Array.isArray(value)) {
    return value.map(stableClone);
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, stableClone(value[key])])
    );
  }
  return value;
}

function stableStringify(value) {
  return JSON.stringify(stableClone(value));
}

function stableHash(value) {
  return crypto.createHash('sha256').update(stableStringify(value), 'utf8').digest('hex');
}

function sortToolDefinitions(tools) {
  return (Array.isArray(tools) ? tools : [])
    .map((tool) => stableClone(tool))
    .sort((left, right) => {
      const leftName = String(left && left.function && left.function.name ? left.function.name : '');
      const rightName = String(right && right.function && right.function.name ? right.function.name : '');
      return leftName.localeCompare(rightName);
    });
}

function buildPromptCacheKey({ runId, providerId, model, sessionKey, purpose }) {
  return [
    'qapanda',
    String(runId || 'run'),
    String(providerId || 'provider'),
    String(model || 'model'),
    String(purpose || 'turn'),
    String(sessionKey || 'session'),
  ].join(':');
}

function supportsOpenAi24hRetention(model) {
  const text = String(model || '').trim();
  return OPENAI_24H_MODEL_PATTERNS.some((pattern) => pattern.test(text));
}

function openRouterModelFamily(model) {
  const text = String(model || '').trim().toLowerCase();
  if (!text) return 'unknown';
  const slash = text.indexOf('/');
  if (slash === -1) return 'unknown';
  return text.slice(0, slash);
}

function buildPromptCacheContext({
  providerId,
  model,
  runId,
  sessionKey,
  purpose,
  geminiCachedContentName = null,
}) {
  const cacheKey = buildPromptCacheKey({ runId, providerId, model, sessionKey, purpose });
  const family = openRouterModelFamily(model);
  if (providerId === 'openai') {
    return {
      cacheSupport: 'supported',
      cacheMode: 'automatic',
      promptCacheKey: cacheKey,
      promptCacheRetention: supportsOpenAi24hRetention(model) ? '24h' : null,
    };
  }
  if (providerId === 'anthropic') {
    return {
      cacheSupport: 'supported',
      cacheMode: 'native',
      promptCacheKey: cacheKey,
      cacheControl: { type: 'ephemeral', ttl: '1h' },
    };
  }
  if (providerId === 'openrouter') {
    if (family === 'anthropic') {
      return {
        cacheSupport: 'supported',
        cacheMode: 'native',
        promptCacheKey: cacheKey,
        cacheControl: { type: 'ephemeral', ttl: '1h' },
      };
    }
    if (family === 'openai' || family === 'google') {
      return {
        cacheSupport: 'supported',
        cacheMode: 'automatic',
        promptCacheKey: cacheKey,
      };
    }
    return {
      cacheSupport: 'unsupported',
      cacheMode: 'unsupported',
      promptCacheKey: cacheKey,
    };
  }
  if (providerId === 'gemini') {
    return {
      cacheSupport: 'supported',
      cacheMode: geminiCachedContentName ? 'explicit' : 'implicit',
      promptCacheKey: cacheKey,
      geminiCachedContentName: geminiCachedContentName || null,
    };
  }
  return {
    cacheSupport: 'unsupported',
    cacheMode: 'unsupported',
    promptCacheKey: cacheKey,
  };
}

function normalizeOpenAiCompatibleUsage(usage, cacheContext = {}) {
  const promptTokensDetails = usage && usage.prompt_tokens_details && typeof usage.prompt_tokens_details === 'object'
    ? stableClone(usage.prompt_tokens_details)
    : null;
  return {
    promptTokens: usage && Number.isFinite(usage.prompt_tokens) ? usage.prompt_tokens : 0,
    completionTokens: usage && Number.isFinite(usage.completion_tokens) ? usage.completion_tokens : 0,
    totalTokens: usage && Number.isFinite(usage.total_tokens) ? usage.total_tokens : 0,
    promptTokensDetails,
    cacheSupport: cacheContext.cacheSupport || 'unsupported',
    cacheMode: cacheContext.cacheMode || 'unsupported',
    promptCacheKey: cacheContext.promptCacheKey || null,
    cachedTokens: promptTokensDetails && Number.isFinite(promptTokensDetails.cached_tokens)
      ? promptTokensDetails.cached_tokens
      : 0,
    cacheWriteTokens: promptTokensDetails && Number.isFinite(promptTokensDetails.cache_write_tokens)
      ? promptTokensDetails.cache_write_tokens
      : 0,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
    uncachedTailTokens: usage && Number.isFinite(usage.prompt_tokens) ? usage.prompt_tokens : 0,
    raw: stableClone(usage),
  };
}

function normalizeAnthropicUsage(usage, cacheContext = {}) {
  const uncachedTailTokens = usage && Number.isFinite(usage.input_tokens) ? usage.input_tokens : 0;
  const completionTokens = usage && Number.isFinite(usage.output_tokens) ? usage.output_tokens : 0;
  const cacheReadInputTokens = usage && Number.isFinite(usage.cache_read_input_tokens)
    ? usage.cache_read_input_tokens
    : 0;
  const cacheCreationInputTokens = usage && Number.isFinite(usage.cache_creation_input_tokens)
    ? usage.cache_creation_input_tokens
    : 0;
  return {
    promptTokens: uncachedTailTokens + cacheReadInputTokens + cacheCreationInputTokens,
    completionTokens,
    totalTokens: uncachedTailTokens + cacheReadInputTokens + cacheCreationInputTokens + completionTokens,
    promptTokensDetails: null,
    cacheSupport: cacheContext.cacheSupport || 'supported',
    cacheMode: cacheContext.cacheMode || 'native',
    promptCacheKey: cacheContext.promptCacheKey || null,
    cachedTokens: cacheReadInputTokens,
    cacheWriteTokens: cacheCreationInputTokens,
    cacheReadInputTokens,
    cacheCreationInputTokens,
    uncachedTailTokens,
    raw: stableClone(usage),
  };
}

module.exports = {
  buildPromptCacheContext,
  buildPromptCacheKey,
  normalizeAnthropicUsage,
  normalizeOpenAiCompatibleUsage,
  openRouterModelFamily,
  sortToolDefinitions,
  stableClone,
  stableHash,
  stableStringify,
  supportsOpenAi24hRetention,
};
