const { truncate } = require('./utils');

function extractTextBlocks(content) {
  if (content == null) return '';
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((part) => {
    if (typeof part === 'string') return part;
    if (!part || typeof part !== 'object') return '';
    if (typeof part.text === 'string') return part.text;
    if (typeof part.content === 'string') return part.content;
    return '';
  }).filter(Boolean).join('');
}

function isEnvironmentContextOnly(text) {
  const trimmed = String(text || '').trim();
  return !!trimmed && /^<environment_context>[\s\S]*<\/environment_context>$/i.test(trimmed);
}

function summarizeTool(name, payload) {
  const toolName = String(name || 'tool');
  const detail = payload && typeof payload === 'object'
    ? (payload.description || payload.command || payload.name || '')
    : '';
  const suffix = detail ? `: ${String(detail).trim()}` : '';
  return `[Tool] ${toolName}${suffix}`;
}

function summarizeToolResult(content) {
  if (content == null) return '[Tool result]';
  if (typeof content === 'string') return `[Tool result] ${truncate(content.trim(), 500)}`;
  if (Array.isArray(content)) {
    const text = extractTextBlocks(content).trim();
    return text ? `[Tool result] ${truncate(text, 500)}` : '[Tool result]';
  }
  if (typeof content === 'object') {
    if (typeof content.content === 'string') {
      return `[Tool result] ${truncate(content.content.trim(), 500)}`;
    }
    return `[Tool result] ${truncate(JSON.stringify(content), 500)}`;
  }
  return `[Tool result] ${truncate(String(content), 500)}`;
}

function pushIfText(messages, entry) {
  if (!entry || !entry.text || !String(entry.text).trim()) return;
  messages.push({
    ...entry,
    text: String(entry.text),
  });
}

function normalizeCodexRecord(record, context, messages) {
  if (!record || typeof record !== 'object') return;

  if (record.type === 'session_meta' && record.payload && typeof record.payload === 'object') {
    if (record.payload.id) context.sessionId = String(record.payload.id);
    if (record.payload.cwd) context.cwd = String(record.payload.cwd);
    if (record.payload.timestamp && !context.startedAt) context.startedAt = String(record.payload.timestamp);
    return;
  }

  if (record.type === 'turn_context' && record.payload && typeof record.payload === 'object') {
    if (record.payload.cwd) context.cwd = String(record.payload.cwd);
    return;
  }

  if (record.type === 'message') {
    const text = extractTextBlocks(record.content);
    if (!text || isEnvironmentContextOnly(text)) return;
    pushIfText(messages, {
      timestamp: record.timestamp || null,
      role: record.role === 'assistant' ? 'assistant' : 'user',
      type: record.role === 'assistant' ? 'assistant' : 'user',
      text,
    });
    return;
  }

  if (record.type === 'response_item' && record.payload && typeof record.payload === 'object') {
    const payload = record.payload;
    if (payload.type === 'message') {
      const text = extractTextBlocks(payload.content);
      if (!text || isEnvironmentContextOnly(text)) return;
      pushIfText(messages, {
        timestamp: record.timestamp || null,
        role: payload.role === 'assistant' ? 'assistant' : 'user',
        type: payload.role === 'assistant' ? 'assistant' : 'user',
        text,
      });
      return;
    }
    if (payload.type === 'function_call') {
      pushIfText(messages, {
        timestamp: record.timestamp || null,
        role: 'system',
        type: 'tool_call',
        text: summarizeTool(payload.name, payload.arguments || payload.input),
      });
      return;
    }
    if (payload.type === 'function_call_output') {
      pushIfText(messages, {
        timestamp: record.timestamp || null,
        role: 'system',
        type: 'tool_result',
        text: summarizeToolResult(payload.output || payload.content),
      });
    }
    return;
  }

  if (record.type === 'function_call') {
    pushIfText(messages, {
      timestamp: record.timestamp || null,
      role: 'system',
      type: 'tool_call',
      text: summarizeTool(record.name, record.arguments),
    });
    return;
  }

  if (record.type === 'function_call_output') {
    pushIfText(messages, {
      timestamp: record.timestamp || null,
      role: 'system',
      type: 'tool_result',
      text: summarizeToolResult(record.output),
    });
  }
}

function normalizeClaudeRecord(record, context, messages) {
  if (!record || typeof record !== 'object') return;
  if (record.sessionId && !context.sessionId) context.sessionId = String(record.sessionId);
  if (record.cwd && !context.cwd) context.cwd = String(record.cwd);

  if (record.type === 'user' && record.message && typeof record.message === 'object') {
    const content = record.message.content;
    if (Array.isArray(content) && content.every((part) => part && part.type === 'tool_result')) {
      for (const part of content) {
        pushIfText(messages, {
          timestamp: record.timestamp || null,
          role: 'system',
          type: 'tool_result',
          text: summarizeToolResult(part.content),
        });
      }
      return;
    }
    const text = extractTextBlocks(content);
    if (!text || isEnvironmentContextOnly(text)) return;
    pushIfText(messages, {
      timestamp: record.timestamp || null,
      role: 'user',
      type: 'user',
      text,
    });
    return;
  }

  if (record.type === 'assistant' && record.message && Array.isArray(record.message.content)) {
    for (const part of record.message.content) {
      if (!part || typeof part !== 'object') continue;
      if (part.type === 'text' && typeof part.text === 'string') {
        pushIfText(messages, {
          timestamp: record.timestamp || null,
          role: 'assistant',
          type: 'assistant',
          text: part.text,
        });
        continue;
      }
      if (part.type === 'tool_use') {
        pushIfText(messages, {
          timestamp: record.timestamp || null,
          role: 'system',
          type: 'tool_call',
          text: summarizeTool(part.name, part.input),
        });
      }
    }
    return;
  }

  if (record.type === 'system' && record.subtype === 'local_command' && record.content) {
    pushIfText(messages, {
      timestamp: record.timestamp || null,
      role: 'system',
      type: 'system',
      text: truncate(String(record.content).replace(/\s+/g, ' ').trim(), 500),
    });
  }
}

function normalizeExternalChatRecord(provider, record, context, messages) {
  if (provider === 'codex') {
    normalizeCodexRecord(record, context, messages);
    return;
  }
  if (provider === 'claude') {
    normalizeClaudeRecord(record, context, messages);
  }
}

module.exports = {
  extractTextBlocks,
  isEnvironmentContextOnly,
  normalizeExternalChatRecord,
  summarizeTool,
  summarizeToolResult,
};
