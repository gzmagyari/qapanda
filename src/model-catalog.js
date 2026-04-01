const API_PROVIDER_MODELS = {
  openai: [
    // Curated to models that pass the current direct chat-completions smoke tests.
    { value: '', label: 'Model: default' },
    { value: 'gpt-4.1', label: 'GPT-4.1' },
    { value: 'gpt-4.1-mini', label: 'GPT-4.1 Mini' },
    { value: 'gpt-4.1-nano', label: 'GPT-4.1 Nano' },
    { value: 'gpt-5', label: 'GPT-5' },
    { value: 'gpt-5-mini', label: 'GPT-5 Mini' },
    { value: 'gpt-5.1', label: 'GPT-5.1' },
    { value: 'gpt-5.2', label: 'GPT-5.2' },
    { value: 'gpt-5.4', label: 'GPT-5.4' },
    { value: 'gpt-5.4-mini', label: 'GPT-5.4 Mini' },
    { value: 'gpt-5.4-nano', label: 'GPT-5.4 Nano' },
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
    { value: 'openai/gpt-4.1', label: 'OpenAI · GPT-4.1' },
    { value: 'openai/gpt-4.1-mini', label: 'OpenAI · GPT-4.1 Mini' },
    { value: 'openai/gpt-5', label: 'OpenAI · GPT-5' },
    { value: 'openai/gpt-5-mini', label: 'OpenAI · GPT-5 Mini' },
    { value: 'openai/gpt-5.2', label: 'OpenAI · GPT-5.2' },
    { value: 'openai/gpt-5.2-codex', label: 'OpenAI · GPT-5.2 Codex' },
    { value: 'openai/gpt-5.3-codex', label: 'OpenAI · GPT-5.3 Codex' },
    { value: 'openai/gpt-5.4', label: 'OpenAI · GPT-5.4' },
    { value: 'openai/gpt-5.4-mini', label: 'OpenAI · GPT-5.4 Mini' },
    { value: 'anthropic/claude-sonnet-4.6', label: 'Anthropic · Claude Sonnet 4.6' },
    { value: 'anthropic/claude-opus-4.6', label: 'Anthropic · Claude Opus 4.6' },
    { value: 'anthropic/claude-haiku-4.5', label: 'Anthropic · Claude Haiku 4.5' },
    { value: 'google/gemini-2.5-pro', label: 'Google · Gemini 2.5 Pro' },
    { value: 'google/gemini-2.5-flash', label: 'Google · Gemini 2.5 Flash' },
    { value: 'google/gemini-3-flash-preview', label: 'Google · Gemini 3 Flash Preview' },
    { value: 'google/gemini-3.1-pro-preview', label: 'Google · Gemini 3.1 Pro Preview' },
    { value: 'google/gemini-3.1-flash-lite-preview', label: 'Google · Gemini 3.1 Flash Lite Preview' },
    { value: 'x-ai/grok-3', label: 'xAI · Grok 3' },
    { value: 'x-ai/grok-3-mini', label: 'xAI · Grok 3 Mini' },
    { value: 'x-ai/grok-4', label: 'xAI · Grok 4' },
    { value: 'x-ai/grok-4-fast', label: 'xAI · Grok 4 Fast' },
    { value: 'x-ai/grok-code-fast-1', label: 'xAI · Grok Code Fast 1' },
    { value: 'moonshotai/kimi-k2-thinking', label: 'Moonshot · Kimi K2 Thinking' },
    { value: 'moonshotai/kimi-k2.5', label: 'Moonshot · Kimi K2.5' },
    { value: 'qwen/qwen3-coder-next', label: 'Qwen · Qwen3 Coder Next' },
    { value: 'qwen/qwen3-coder', label: 'Qwen · Qwen3 Coder' },
    { value: 'qwen/qwen3-coder-plus', label: 'Qwen · Qwen3 Coder Plus' },
    { value: 'qwen/qwen3-235b-a22b', label: 'Qwen · Qwen3 235B A22B' },
    { value: 'deepseek/deepseek-chat-v3.1', label: 'DeepSeek · Chat V3.1' },
    { value: 'deepseek/deepseek-r1-0528', label: 'DeepSeek · R1 0528' },
    { value: 'minimax/minimax-m2', label: 'MiniMax · M2' },
    { value: 'minimax/minimax-m2.5', label: 'MiniMax · M2.5' },
    { value: 'mistralai/mistral-medium-3.1', label: 'Mistral · Medium 3.1' },
    { value: 'mistralai/codestral-2508', label: 'Mistral · Codestral 2508' },
  ],
  gemini: [
    { value: '', label: 'Model: default' },
    { value: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro' },
    { value: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash' },
    { value: 'gemini-2.5-flash-lite', label: 'Gemini 2.5 Flash Lite' },
    { value: 'gemini-3-flash-preview', label: 'Gemini 3 Flash Preview' },
    { value: 'gemini-3.1-pro-preview', label: 'Gemini 3.1 Pro Preview' },
    { value: 'gemini-3.1-flash-lite-preview', label: 'Gemini 3.1 Flash Lite Preview' },
  ],
  custom: [
    { value: '', label: 'Model: enter below' },
  ],
};

const API_PROVIDER_THINKING = {
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

function cloneCatalogEntries(entries) {
  return (entries || []).map((entry) => ({ ...entry }));
}

function buildApiCatalogPayload() {
  const models = {};
  const thinking = {};
  for (const provider of Object.keys(API_PROVIDER_MODELS)) {
    models[provider] = cloneCatalogEntries(API_PROVIDER_MODELS[provider]);
  }
  for (const provider of Object.keys(API_PROVIDER_THINKING)) {
    thinking[provider] = cloneCatalogEntries(API_PROVIDER_THINKING[provider]);
  }
  return { models, thinking };
}

module.exports = {
  API_PROVIDER_MODELS,
  API_PROVIDER_THINKING,
  buildApiCatalogPayload,
};
