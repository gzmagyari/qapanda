const fs = require('node:fs/promises');
const path = require('node:path');

const { prepareNewRun, saveManifest } = require('./state');
const {
  createTranscriptRecord,
  countJsonlLinesSync,
  countTranscriptLinesSync,
} = require('./transcript');
const { nowIso, truncate } = require('./utils');
const { findExternalChatSession } = require('./external-chat-discovery');
const { normalizeExternalChatSession } = require('./external-chat-normalizer');

function importBannerText(provider, sessionId) {
  const label = provider === 'codex' ? 'Codex' : 'Claude';
  return `Imported ${label} session ${sessionId}.`;
}

function importedLabel(provider) {
  return provider === 'codex' ? 'Imported Codex' : 'Imported Claude';
}

function importSessionKey(provider, sessionId) {
  return `import:${provider}:${sessionId}`;
}

function getImportedCodexSessionId(manifest) {
  if (!manifest || !manifest.importSource || manifest.importSource.provider !== 'codex') {
    return null;
  }
  const value = String(manifest.importSource.sessionId || '').trim();
  return value || null;
}

function isCodexCliBackend(cli) {
  return String(cli || '').trim().toLowerCase() === 'codex';
}

function safeText(value) {
  return value == null ? '' : String(value);
}

function buildImportSummary(normalized) {
  const firstUser = normalized.messages.find((message) => message && message.role === 'user' && message.text);
  if (firstUser) return truncate(firstUser.text.replace(/\s+/g, ' ').trim(), 120);
  return truncate(importBannerText(normalized.provider, normalized.sessionId), 120);
}

function buildChatEntries(normalized) {
  const entries = [{
    ts: normalized.startedAt || nowIso(),
    type: 'banner',
    text: importBannerText(normalized.provider, normalized.sessionId),
  }];
  const label = importedLabel(normalized.provider);
  for (const message of normalized.messages) {
    if (!message || !message.text) continue;
    if (message.type === 'user') {
      entries.push({
        ts: message.timestamp || nowIso(),
        type: 'user',
        text: safeText(message.text),
      });
      continue;
    }
    if (message.type === 'assistant') {
      entries.push({
        ts: message.timestamp || nowIso(),
        type: 'claude',
        label,
        text: safeText(message.text),
      });
      continue;
    }
    entries.push({
      ts: message.timestamp || nowIso(),
      type: 'line',
      label,
      text: safeText(message.text),
    });
  }
  return entries;
}

function buildTranscriptEntries(normalized) {
  const sessionKey = importSessionKey(normalized.provider, normalized.sessionId);
  const label = importedLabel(normalized.provider);
  const entries = [
    createTranscriptRecord({
      ts: normalized.startedAt || nowIso(),
      kind: 'ui_message',
      sessionKey,
      backend: `import:${normalized.provider}`,
      labelHint: label,
      payload: { type: 'banner', text: importBannerText(normalized.provider, normalized.sessionId) },
    }),
  ];

  for (const message of normalized.messages) {
    if (!message || !message.text) continue;
    if (message.type === 'user') {
      entries.push(createTranscriptRecord({
        ts: message.timestamp || nowIso(),
        kind: 'user_message',
        sessionKey,
        backend: `import:${normalized.provider}`,
        labelHint: label,
        text: safeText(message.text),
        payload: { role: 'user', content: [{ type: 'text', text: safeText(message.text) }] },
      }));
      continue;
    }
    if (message.type === 'assistant') {
      entries.push(createTranscriptRecord({
        ts: message.timestamp || nowIso(),
        kind: 'assistant_message',
        sessionKey,
        backend: `import:${normalized.provider}`,
        labelHint: label,
        text: safeText(message.text),
        payload: { role: 'assistant', content: [{ type: 'text', text: safeText(message.text) }] },
      }));
      continue;
    }
    entries.push(createTranscriptRecord({
      ts: message.timestamp || nowIso(),
      kind: 'ui_message',
      sessionKey,
      backend: `import:${normalized.provider}`,
      labelHint: label,
      payload: { type: 'line', label, text: safeText(message.text) },
    }));
  }
  return entries;
}

function buildImportedRunOptions(baseOptions, provider) {
  const options = {
    ...(baseOptions || {}),
    chatTarget: (baseOptions && baseOptions.chatTarget) || (provider === 'claude' ? 'claude' : 'controller'),
  };
  if (provider === 'codex') {
    options.controllerCli = 'codex';
  } else if (provider === 'claude') {
    options.workerCli = 'claude';
  }
  return options;
}

async function writeJsonl(filePath, entries) {
  const lines = (entries || []).map((entry) => JSON.stringify(entry));
  const text = lines.length > 0 ? `${lines.join('\n')}\n` : '';
  await fs.writeFile(filePath, text, 'utf8');
}

function seedImportedContinuationState(manifest, normalized) {
  if (normalized.provider === 'codex') {
    manifest.controller.cli = 'codex';
    manifest.controller.sessionId = normalized.sessionId;
    manifest.controller.appServerThreadId = normalized.sessionId;
    manifest.controller.threadSandbox = null;
    manifest.controller.approvalPolicy = null;
    manifest.controller.lastSeenTranscriptLine = countTranscriptLinesSync(manifest.files && manifest.files.transcript);
    manifest.controller.lastSeenChatLine = countJsonlLinesSync(manifest.files && manifest.files.chatLog);
    return;
  }

  manifest.chatTarget = 'claude';
  manifest.worker.cli = 'claude';
  manifest.worker.hasStarted = false;
  manifest.worker.lastSeenTranscriptLine = 0;
  manifest.worker.lastSeenChatLine = 0;
}

async function importExternalChatSession(options = {}) {
  const provider = String(options.provider || '').trim().toLowerCase();
  if (provider !== 'codex' && provider !== 'claude') {
    throw new Error('importExternalChatSession requires provider "codex" or "claude".');
  }

  const descriptor = options.filePath
    ? {
        provider,
        sessionId: options.sessionId || null,
        filePath: path.resolve(options.filePath),
        cwd: options.repoRoot || null,
        startedAt: null,
        updatedAt: null,
        title: '',
        preview: '',
      }
    : await findExternalChatSession({
        repoRoot: options.repoRoot,
        provider,
        sessionId: options.sessionId,
        homeDir: options.homeDir,
        limit: 1,
      });

  if (!descriptor) {
    throw new Error(`Could not find ${provider} session ${options.sessionId || ''}`.trim());
  }

  const normalized = await normalizeExternalChatSession(descriptor);
  if (!normalized.sessionId) {
    throw new Error(`Could not determine ${provider} session id for import.`);
  }

  const manifest = await prepareNewRun(
    `[IMPORT] ${importBannerText(provider, normalized.sessionId)}`,
    buildImportedRunOptions(options.runOptions, provider),
  );

  manifest.transcriptSummary = buildImportSummary(normalized);
  manifest.importSource = {
    provider,
    sessionId: normalized.sessionId,
    filePath: descriptor.filePath,
    importedAt: nowIso(),
  };

  await writeJsonl(manifest.files.chatLog, buildChatEntries(normalized));
  await writeJsonl(manifest.files.transcript, buildTranscriptEntries(normalized));
  seedImportedContinuationState(manifest, normalized);
  await saveManifest(manifest);

  return {
    manifest,
    imported: normalized,
  };
}

module.exports = {
  buildImportedRunOptions,
  getImportedCodexSessionId,
  importExternalChatSession,
  isCodexCliBackend,
};
