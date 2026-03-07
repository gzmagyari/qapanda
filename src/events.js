const { truncate, safeJsonParse } = require('./utils');

function parseJsonLine(line) {
  return safeJsonParse(line);
}

function extractTextFromClaudeContent(content) {
  if (content == null) {
    return '';
  }
  if (typeof content === 'string') {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .map((block) => {
        if (!block) {
          return '';
        }
        if (typeof block === 'string') {
          return block;
        }
        if (block.type === 'text' && typeof block.text === 'string') {
          return block.text;
        }
        if (block.text && typeof block.text === 'string') {
          return block.text;
        }
        if (Array.isArray(block.content)) {
          return extractTextFromClaudeContent(block.content);
        }
        return '';
      })
      .filter(Boolean)
      .join('');
  }
  if (typeof content === 'object' && typeof content.text === 'string') {
    return content.text;
  }
  return '';
}

function summarizeCodexEvent(raw) {
  if (!raw || typeof raw !== 'object') {
    return null;
  }

  if (raw.type === 'thread.started' && raw.thread_id) {
    return { source: 'controller', kind: 'status', text: `Started controller session ${raw.thread_id}` };
  }

  if (raw.type === 'turn.started') {
    return { source: 'controller', kind: 'status', text: 'Thinking about the next step.' };
  }

  if (raw.type === 'turn.completed') {
    return { source: 'controller', kind: 'status', text: 'Finished the current controller pass.' };
  }

  if (raw.type === 'turn.failed') {
    return { source: 'controller', kind: 'error', text: 'Controller turn failed.' };
  }

  if (raw.type === 'error') {
    return {
      source: 'controller',
      kind: 'error',
      text: truncate(raw.message || raw.error || JSON.stringify(raw), 300),
    };
  }

  if (raw.type === 'item.started' || raw.type === 'item.completed') {
    const item = raw.item || {};
    const started = raw.type === 'item.started';
    const prefix = started ? '' : 'Finished: ';

    if (item.type === 'command_execution' && item.command) {
      return {
        source: 'controller',
        kind: 'status',
        text: started ? `Running command: ${truncate(item.command, 200)}` : `${prefix}${truncate(item.command, 200)}`,
      };
    }

    if (item.type === 'mcp_tool_call') {
      return {
        source: 'controller',
        kind: 'status',
        text: started ? 'Calling an MCP tool.' : 'Finished MCP tool call.',
      };
    }

    if (item.type === 'web_search') {
      return {
        source: 'controller',
        kind: 'status',
        text: started ? 'Searching for information.' : 'Finished searching for information.',
      };
    }

    if (item.type === 'file_change') {
      const pathText = item.path || item.file || item.target || 'a file';
      return {
        source: 'controller',
        kind: 'status',
        text: started ? `Inspecting change for ${pathText}` : `Reviewed change for ${pathText}`,
      };
    }

    if (item.type === 'plan_update' && item.text) {
      return {
        source: 'controller',
        kind: 'status',
        text: truncate(item.text, 200),
      };
    }
  }

  return null;
}

function summarizeClaudeEvent(raw) {
  if (!raw || typeof raw !== 'object') {
    return null;
  }

  if (raw.type === 'result_message') {
    const text =
      typeof raw.result === 'string'
        ? raw.result
        : typeof raw.result?.text === 'string'
          ? raw.result.text
          : extractTextFromClaudeContent(raw.message?.content || raw.content);
    if (text) {
      return { source: 'worker', kind: 'final-text', text };
    }
    return { source: 'worker', kind: 'status', text: 'Claude Code finished.' };
  }

  if (raw.type === 'assistant_message') {
    const text = extractTextFromClaudeContent(raw.message?.content || raw.content);
    if (text) {
      return { source: 'worker', kind: 'assistant-text', text };
    }
  }

  if (raw.type === 'stream_event') {
    const event = raw.event || {};
    if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta') {
      return { source: 'worker', kind: 'text-delta', text: event.delta.text || '' };
    }
    if (event.type === 'content_block_start' && event.content_block?.type === 'tool_use') {
      const block = event.content_block;
      const name = block.name || 'tool';
      const input = block.input || {};
      if (name === 'Bash' && input.command) {
        return {
          source: 'worker',
          kind: 'status',
          text: `Running command: ${truncate(input.command, 200)}`,
        };
      }
      const filePath = input.file_path || input.path || input.target_file || input.filename;
      if (filePath) {
        return {
          source: 'worker',
          kind: 'status',
          text: `${name} on ${filePath}`,
        };
      }
      return {
        source: 'worker',
        kind: 'status',
        text: `Using ${name}.`,
      };
    }
  }

  if (raw.type === 'error') {
    return {
      source: 'worker',
      kind: 'error',
      text: truncate(raw.message || raw.error || JSON.stringify(raw), 300),
    };
  }

  return null;
}

module.exports = {
  extractTextFromClaudeContent,
  parseJsonLine,
  summarizeClaudeEvent,
  summarizeCodexEvent,
};
