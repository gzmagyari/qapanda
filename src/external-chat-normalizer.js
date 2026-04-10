const fs = require('node:fs');
const readline = require('node:readline');

const { safeJsonParse } = require('./utils');
const { normalizeExternalChatRecord } = require('./external-chat-parser');

async function normalizeExternalChatSession(descriptor) {
  if (!descriptor || !descriptor.filePath || !descriptor.provider) {
    throw new Error('normalizeExternalChatSession requires provider and filePath.');
  }

  const messages = [];
  const context = {
    provider: descriptor.provider,
    sessionId: descriptor.sessionId || null,
    cwd: descriptor.cwd || null,
    startedAt: descriptor.startedAt || null,
  };

  const input = fs.createReadStream(descriptor.filePath, { encoding: 'utf8' });
  const rl = readline.createInterface({ input, crlfDelay: Infinity });

  try {
    for await (const line of rl) {
      if (!line) continue;
      const parsed = safeJsonParse(line);
      if (!parsed) continue;

      normalizeExternalChatRecord(descriptor.provider, parsed, context, messages);
    }
  } finally {
    rl.close();
    input.destroy();
  }

  return {
    provider: descriptor.provider,
    sessionId: context.sessionId || descriptor.sessionId || null,
    filePath: descriptor.filePath,
    cwd: context.cwd || descriptor.cwd || null,
    startedAt: context.startedAt || descriptor.startedAt || null,
    updatedAt: descriptor.updatedAt || null,
    title: descriptor.title || descriptor.preview || `${descriptor.provider} session ${context.sessionId || descriptor.sessionId || ''}`.trim(),
    preview: descriptor.preview || '',
    messages,
  };
}

module.exports = {
  normalizeExternalChatSession,
};
