#!/usr/bin/env node

const { LLMClient, resolveApiKey } = require('../src/llm-client');

const CANDIDATES = {
  openai: [
    'gpt-4.1',
    'gpt-4.1-mini',
    'gpt-4.1-nano',
    'gpt-5',
    'gpt-5-codex',
    'gpt-5-mini',
    'gpt-5.1',
    'gpt-5.1-codex',
    'gpt-5.1-codex-mini',
    'gpt-5.1-codex-max',
    'gpt-5.2',
    'gpt-5.2-codex',
    'gpt-5.3-codex',
    'gpt-5.3-codex-spark',
    'gpt-5.5',
    'gpt-5.4',
    'gpt-5.4-mini',
    'gpt-5.4-nano',
    'o3',
    'o4-mini',
  ],
  anthropic: [
    'claude-sonnet-4-6',
    'claude-opus-4-6',
    'claude-haiku-4-5',
  ],
  gemini: [
    'gemini-2.5-pro',
    'gemini-2.5-flash',
    'gemini-2.5-flash-lite',
    'gemini-3-flash-preview',
    'gemini-3.1-pro-preview',
    'gemini-3.1-flash-lite-preview',
  ],
  openrouter: [
    'openai/gpt-4.1',
    'openai/gpt-4.1-mini',
    'openai/gpt-5',
    'openai/gpt-5-mini',
    'openai/gpt-5.2',
    'openai/gpt-5.2-codex',
    'openai/gpt-5.3-codex',
    'openai/gpt-5.5',
    'openai/gpt-5.4',
    'openai/gpt-5.4-mini',
    'anthropic/claude-sonnet-4.6',
    'anthropic/claude-opus-4.6',
    'anthropic/claude-haiku-4.5',
    'google/gemini-2.5-pro',
    'google/gemini-2.5-flash',
    'google/gemini-3-flash-preview',
    'google/gemini-3.1-pro-preview',
    'google/gemini-3.1-flash-lite-preview',
    'x-ai/grok-3',
    'x-ai/grok-3-mini',
    'x-ai/grok-4',
    'x-ai/grok-4-fast',
    'x-ai/grok-code-fast-1',
    'moonshotai/kimi-k2',
    'moonshotai/kimi-k2-thinking',
    'moonshotai/kimi-k2.5',
    'qwen/qwen3-coder-next',
    'qwen/qwen3-coder',
    'qwen/qwen3-coder-plus',
    'qwen/qwen3-235b-a22b',
    'deepseek/deepseek-chat-v3.1',
    'deepseek/deepseek-r1-0528',
    'minimax/minimax-m2',
    'minimax/minimax-m2.5',
    'mistralai/mistral-medium-3.1',
    'mistralai/codestral-2508',
  ],
};

function classifyFailure(error) {
  const status = error && (error.status || error.code);
  const message = String((error && error.message) || '').trim();
  if (status === 401 || status === 403) return 'auth-or-tier-gated';
  if (status === 404) return 'unsupported-or-invalid';
  if (message.includes('aborted') || status === 20) return 'timeout-or-transient';
  return 'other';
}

async function verifyModel(provider, model, timeoutMs) {
  const apiKey = resolveApiKey(provider);
  if (!apiKey) {
    return { provider, model, status: 'skipped', reason: 'missing-api-key' };
  }

  const client = new LLMClient({ provider, apiKey, model });
  const abortController = new AbortController();
  const timer = setTimeout(() => abortController.abort(), timeoutMs);
  try {
    const result = await client.chat([{ role: 'user', content: 'Reply with OK' }], null, {
      signal: abortController.signal,
    });
    clearTimeout(timer);
    return {
      provider,
      model,
      status: 'ok',
      text: String(result.text || '').trim(),
    };
  } catch (error) {
    clearTimeout(timer);
    return {
      provider,
      model,
      status: 'fail',
      reason: classifyFailure(error),
      error: String((error && (error.status || error.code || error.message)) || 'error'),
    };
  }
}

async function main() {
  const providerArg = process.argv.find((arg) => arg.startsWith('--provider='));
  const timeoutArg = process.argv.find((arg) => arg.startsWith('--timeout='));
  const providerFilter = providerArg ? providerArg.split('=')[1] : '';
  const timeoutMs = timeoutArg ? Number(timeoutArg.split('=')[1]) : 20000;
  const providers = providerFilter ? [providerFilter] : Object.keys(CANDIDATES);

  const summary = {};
  for (const provider of providers) {
    const models = CANDIDATES[provider];
    if (!models) {
      console.error(`Unknown provider: ${provider}`);
      process.exitCode = 1;
      return;
    }
    summary[provider] = [];
    for (const model of models) {
      const result = await verifyModel(provider, model, timeoutMs);
      summary[provider].push(result);
      const suffix = result.status === 'ok' ? result.text : (result.reason || result.error || '');
      console.log(`${provider}\t${model}\t${result.status}\t${suffix}`);
    }
  }

  const passing = {};
  for (const [provider, results] of Object.entries(summary)) {
    passing[provider] = results.filter((entry) => entry.status === 'ok').map((entry) => entry.model);
  }

  console.log('\nPassing models:');
  console.log(JSON.stringify(passing, null, 2));
}

main().catch((error) => {
  console.error(error && error.stack ? error.stack : String(error));
  process.exitCode = 1;
});
