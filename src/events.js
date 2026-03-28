const { safeJsonParse } = require('./utils');

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
      text: raw.message || raw.error || JSON.stringify(raw),
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
        text: started ? `Running command: ${item.command}` : `${prefix}${item.command}`,
      };
    }

    if (item.type === 'mcp_tool_call') {
      const server = item.server || '';
      const tool = item.tool || '';
      const label = server && tool ? `${server}:${tool}` : server || tool || 'MCP tool';
      return {
        source: 'controller',
        kind: 'status',
        text: started ? `Calling ${label}` : `Finished ${label}`,
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
        text: item.text,
      };
    }

    if (item.type === 'reasoning' && item.text) {
      return {
        source: 'controller',
        kind: 'reasoning',
        text: item.text,
      };
    }

    if (item.type === 'agent_message' && item.text) {
      return {
        source: 'controller',
        kind: 'agent-message',
        text: item.text,
      };
    }
  }

  return null;
}

/**
 * Like summarizeCodexEvent but for worker turns — omits controller-specific
 * lifecycle messages (session started, turn started/completed) that are noise
 * in the worker context. Only surfaces tool activity, reasoning, and output.
 */
function summarizeCodexWorkerEvent(raw) {
  if (!raw || typeof raw !== 'object') return null;

  // Skip controller lifecycle noise — not meaningful for a worker turn
  if (raw.type === 'thread.started') return null;
  if (raw.type === 'turn.started') return null;
  if (raw.type === 'turn.completed') return null;
  if (raw.type === 'turn.failed') return null;

  // Errors are still worth showing
  if (raw.type === 'error') {
    return { kind: 'error', text: raw.message || raw.error || JSON.stringify(raw) };
  }

  if (raw.type === 'item.started' || raw.type === 'item.completed') {
    const item = raw.item || {};
    const started = raw.type === 'item.started';

    if (item.type === 'command_execution' && item.command) {
      return { kind: 'status', text: started ? `Running: ${item.command}` : `Done: ${item.command}` };
    }
    if (item.type === 'mcp_tool_call') {
      const label = [item.server, item.tool].filter(Boolean).join(':') || 'MCP tool';
      return { kind: 'status', text: started ? `Calling ${label}` : `Finished ${label}` };
    }
    if (item.type === 'web_search') {
      return { kind: 'status', text: started ? 'Searching...' : 'Search done.' };
    }
    if (item.type === 'file_change') {
      const p = item.path || item.file || item.target || 'a file';
      return { kind: 'status', text: started ? `Checking ${p}` : `Reviewed ${p}` };
    }
    if (item.type === 'plan_update' && item.text) {
      return { kind: 'status', text: item.text };
    }
    if (item.type === 'reasoning' && item.text) {
      return { kind: 'reasoning', text: item.text };
    }
    if (item.type === 'agent_message' && item.text) {
      return { kind: 'agent-message', text: item.text };
    }
  }

  return null;
}

function summarizeClaudeEvent(raw) {
  if (!raw || typeof raw !== 'object') {
    return null;
  }

  if (raw.type === 'result_message' || raw.type === 'result') {
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

  if (raw.type === 'assistant_message' || raw.type === 'assistant') {
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
    if (event.type === 'content_block_delta' && event.delta?.type === 'input_json_delta') {
      return { source: 'worker', kind: 'tool-input-delta', text: event.delta.partial_json || '', index: event.index };
    }
    if (event.type === 'content_block_start' && event.content_block?.type === 'tool_use') {
      const block = event.content_block;
      const name = block.name || 'tool';
      return { source: 'worker', kind: 'tool-start', toolName: name, index: event.index };
    }
    if (event.type === 'content_block_stop') {
      return { source: 'worker', kind: 'block-stop', index: event.index };
    }
  }

  if (raw.type === 'error') {
    return {
      source: 'worker',
      kind: 'error',
      text: raw.message || raw.error || JSON.stringify(raw),
    };
  }

  return null;
}

/**
 * Format a tool call into a human-readable one-liner (same format the UI shows).
 * Used by both the renderer and the orchestrator for transcript building.
 */
function formatToolCall(name, input) {
  if (!input) input = {};
  if (name === 'Bash' && input.command) return `Running command: ${input.command}`;
  if (name === 'Read' && input.file_path) return `Reading ${input.file_path}`;
  if (name === 'Write' && input.file_path) return `Writing ${input.file_path}`;
  if (name === 'Edit' && input.file_path) return `Editing ${input.file_path}`;
  if (name === 'Glob' && input.pattern) return `Glob: ${input.pattern}`;
  if (name === 'Grep' && input.pattern) {
    const p = input.path || input.include || '';
    return `Grep: ${input.pattern}${p ? ` in ${p}` : ''}`;
  }
  if (name === 'TodoWrite') return 'Updating todos';
  // MCP tools: show server:tool(brief args)
  const filePath = input.file_path || input.path || input.target_file || input.filename;
  if (filePath) return `${name}: ${filePath}`;
  const keys = Object.keys(input);
  if (keys.length > 0) {
    const brief = keys.map(k => `${k}=${String(input[k])}`).join(', ');
    return `${name}: ${brief}`;
  }
  return `Using ${name}`;
}

/**
 * Map a Codex app-server notification to the existing event format used by
 * summarizeCodexEvent() and summarizeCodexWorkerEvent().
 *
 * App-server notifications arrive as { method, params } with camelCase item
 * types. This normalizes them to the snake_case format the CLI outputs.
 */
function mapAppServerNotification(notification) {
  if (!notification || !notification.method) return null;

  const method = notification.method;
  const params = notification.params || {};

  if (method === 'thread/started') {
    const threadId = params.thread && params.thread.id;
    return { type: 'thread.started', thread_id: threadId };
  }

  if (method === 'turn/started') {
    return { type: 'turn.started', turn: params.turn || {} };
  }

  if (method === 'turn/completed') {
    return { type: 'turn.completed', turn: params.turn || {} };
  }

  if (method === 'item/agentMessage/delta') {
    return { type: 'item.agentMessage.delta', text: params.text || '' };
  }

  if (method === 'item/started' || method === 'item/completed') {
    const item = params.item ? { ...params.item } : {};
    // Normalize camelCase item types to snake_case
    item.type = _normalizeItemType(item.type);
    const type = method === 'item/started' ? 'item.started' : 'item.completed';
    return { type, item };
  }

  if (method === 'thread/status/changed') {
    return { type: 'thread.status.changed', threadId: params.threadId, status: params.status };
  }

  if (method === 'thread/closed') {
    return { type: 'thread.closed', threadId: params.threadId };
  }

  // Pass through anything else with the method as type
  return { type: method.replace(/\//g, '.'), ...params };
}

const _itemTypeMap = {
  commandExecution: 'command_execution',
  mcpToolCall: 'mcp_tool_call',
  agentMessage: 'agent_message',
  fileChange: 'file_change',
  webSearch: 'web_search',
  userMessage: 'user_message',
  contextCompaction: 'context_compaction',
  enteredReviewMode: 'entered_review_mode',
  exitedReviewMode: 'exited_review_mode',
  dynamicToolCall: 'dynamic_tool_call',
  collabToolCall: 'collab_tool_call',
  imageView: 'image_view',
  // Already snake_case types pass through unchanged
};

function _normalizeItemType(type) {
  if (!type) return type;
  return _itemTypeMap[type] || type;
}

module.exports = {
  extractTextFromClaudeContent,
  formatToolCall,
  mapAppServerNotification,
  parseJsonLine,
  summarizeClaudeEvent,
  summarizeCodexEvent,
  summarizeCodexWorkerEvent,
};
