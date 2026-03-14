#!/usr/bin/env node
/**
 * CC Manager Tasks MCP Server — exposes task CRUD as MCP tools.
 *
 * Protocol: JSON-RPC 2.0 over stdio (one JSON message per line).
 * No external dependencies — uses only Node.js built-ins.
 *
 * Env vars:
 *   TASKS_FILE — absolute path to the tasks.json file
 */

const fs = require('node:fs');
const readline = require('node:readline');
const path = require('node:path');

const TASKS_FILE = process.env.TASKS_FILE || '';

const VALID_STATUSES = ['backlog', 'todo', 'in_progress', 'review', 'testing', 'done'];

// ─── Data helpers ────────────────────────────────────────────────────────────

function loadData() {
  try {
    return JSON.parse(fs.readFileSync(TASKS_FILE, 'utf8'));
  } catch {
    return { nextId: 1, nextCommentId: 1, nextProgressId: 1, tasks: [] };
  }
}

function saveData(data) {
  const dir = path.dirname(TASKS_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(TASKS_FILE, JSON.stringify(data, null, 2), 'utf8');
}

function nowIso() {
  return new Date().toISOString();
}

// ─── Tool definitions ───────────────────────────────────────────────────────

const TOOLS = [
  {
    name: 'list_tasks',
    description: 'List tasks, optionally filtered by status',
    inputSchema: {
      type: 'object',
      properties: {
        status: { type: 'string', description: 'Filter by status (backlog, todo, in_progress, review, testing, done)' },
      },
    },
  },
  {
    name: 'get_task',
    description: 'Get task details by ID, including comments and progress updates',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: { type: 'string', description: 'The task ID' },
      },
      required: ['task_id'],
    },
  },
  {
    name: 'create_task',
    description: 'Create a new task',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Task title' },
        description: { type: 'string', description: 'Short description' },
        detail_text: { type: 'string', description: 'Detailed notes / acceptance criteria' },
        status: { type: 'string', description: 'Initial status (default: todo)' },
      },
      required: ['title'],
    },
  },
  {
    name: 'update_task_status',
    description: 'Move a task to a new status column',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: { type: 'string', description: 'The task ID' },
        status: { type: 'string', description: 'New status (backlog, todo, in_progress, review, testing, done)' },
      },
      required: ['task_id', 'status'],
    },
  },
  {
    name: 'update_task_fields',
    description: 'Update task title, description, or detail_text',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: { type: 'string', description: 'The task ID' },
        title: { type: 'string', description: 'New title' },
        description: { type: 'string', description: 'New description' },
        detail_text: { type: 'string', description: 'New detail text' },
      },
      required: ['task_id'],
    },
  },
  {
    name: 'delete_task',
    description: 'Delete a task',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: { type: 'string', description: 'The task ID' },
      },
      required: ['task_id'],
    },
  },
  {
    name: 'add_comment',
    description: 'Add a comment to a task',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: { type: 'string', description: 'The task ID' },
        text: { type: 'string', description: 'Comment text' },
        author: { type: 'string', description: 'Author name (default: agent)' },
      },
      required: ['task_id', 'text'],
    },
  },
  {
    name: 'add_progress_update',
    description: 'Add a progress update to a task',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: { type: 'string', description: 'The task ID' },
        text: { type: 'string', description: 'Progress update text' },
        author: { type: 'string', description: 'Author name (default: agent)' },
      },
      required: ['task_id', 'text'],
    },
  },
  {
    name: 'edit_comment',
    description: 'Edit an existing comment on a task',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: { type: 'string', description: 'The task ID' },
        comment_id: { type: 'number', description: 'The comment ID' },
        text: { type: 'string', description: 'New comment text' },
      },
      required: ['task_id', 'comment_id', 'text'],
    },
  },
  {
    name: 'delete_comment',
    description: 'Delete a comment from a task',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: { type: 'string', description: 'The task ID' },
        comment_id: { type: 'number', description: 'The comment ID' },
      },
      required: ['task_id', 'comment_id'],
    },
  },
  {
    name: 'edit_progress_update',
    description: 'Edit an existing progress update on a task',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: { type: 'string', description: 'The task ID' },
        progress_id: { type: 'number', description: 'The progress update ID' },
        text: { type: 'string', description: 'New progress update text' },
      },
      required: ['task_id', 'progress_id', 'text'],
    },
  },
  {
    name: 'delete_progress_update',
    description: 'Delete a progress update from a task',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: { type: 'string', description: 'The task ID' },
        progress_id: { type: 'number', description: 'The progress update ID' },
      },
      required: ['task_id', 'progress_id'],
    },
  },
];

// ─── Tool handlers ──────────────────────────────────────────────────────────

function handleToolCall(name, args) {
  const data = loadData();

  switch (name) {
    case 'list_tasks': {
      let tasks = data.tasks;
      if (args.status) {
        tasks = tasks.filter(t => t.status === args.status);
      }
      // Return summary (without full comments/progress)
      const summary = tasks.map(t => ({
        id: t.id, title: t.title, description: t.description, status: t.status,
        comments_count: (t.comments || []).length,
        progress_count: (t.progress_updates || []).length,
        created_at: t.created_at, updated_at: t.updated_at,
      }));
      return JSON.stringify(summary, null, 2);
    }

    case 'get_task': {
      const task = data.tasks.find(t => t.id === args.task_id);
      if (!task) throw new Error(`Task not found: ${args.task_id}`);
      return JSON.stringify(task, null, 2);
    }

    case 'create_task': {
      const status = args.status || 'todo';
      if (!VALID_STATUSES.includes(status)) throw new Error(`Invalid status: ${status}`);
      const id = `task-${data.nextId++}`;
      const task = {
        id,
        title: args.title,
        description: args.description || '',
        detail_text: args.detail_text || '',
        status,
        created_at: nowIso(),
        updated_at: nowIso(),
        comments: [],
        progress_updates: [],
      };
      data.tasks.push(task);
      saveData(data);
      return JSON.stringify(task, null, 2);
    }

    case 'update_task_status': {
      if (!VALID_STATUSES.includes(args.status)) throw new Error(`Invalid status: ${args.status}`);
      const task = data.tasks.find(t => t.id === args.task_id);
      if (!task) throw new Error(`Task not found: ${args.task_id}`);
      task.status = args.status;
      task.updated_at = nowIso();
      saveData(data);
      return JSON.stringify(task, null, 2);
    }

    case 'update_task_fields': {
      const task = data.tasks.find(t => t.id === args.task_id);
      if (!task) throw new Error(`Task not found: ${args.task_id}`);
      if (args.title !== undefined) task.title = args.title;
      if (args.description !== undefined) task.description = args.description;
      if (args.detail_text !== undefined) task.detail_text = args.detail_text;
      task.updated_at = nowIso();
      saveData(data);
      return JSON.stringify(task, null, 2);
    }

    case 'delete_task': {
      const idx = data.tasks.findIndex(t => t.id === args.task_id);
      if (idx === -1) throw new Error(`Task not found: ${args.task_id}`);
      const removed = data.tasks.splice(idx, 1)[0];
      saveData(data);
      return JSON.stringify({ deleted: removed.id });
    }

    case 'add_comment': {
      const task = data.tasks.find(t => t.id === args.task_id);
      if (!task) throw new Error(`Task not found: ${args.task_id}`);
      if (!task.comments) task.comments = [];
      const comment = {
        id: data.nextCommentId++,
        author: args.author || 'agent',
        text: args.text,
        created_at: nowIso(),
      };
      task.comments.push(comment);
      task.updated_at = nowIso();
      saveData(data);
      return JSON.stringify(comment, null, 2);
    }

    case 'add_progress_update': {
      const task = data.tasks.find(t => t.id === args.task_id);
      if (!task) throw new Error(`Task not found: ${args.task_id}`);
      if (!task.progress_updates) task.progress_updates = [];
      const update = {
        id: data.nextProgressId++,
        author: args.author || 'agent',
        text: args.text,
        created_at: nowIso(),
      };
      task.progress_updates.push(update);
      task.updated_at = nowIso();
      saveData(data);
      return JSON.stringify(update, null, 2);
    }

    case 'edit_comment': {
      const task = data.tasks.find(t => t.id === args.task_id);
      if (!task) throw new Error(`Task not found: ${args.task_id}`);
      const comment = (task.comments || []).find(c => c.id === args.comment_id);
      if (!comment) throw new Error(`Comment not found: ${args.comment_id}`);
      comment.text = args.text;
      task.updated_at = nowIso();
      saveData(data);
      return JSON.stringify(comment, null, 2);
    }

    case 'delete_comment': {
      const task = data.tasks.find(t => t.id === args.task_id);
      if (!task) throw new Error(`Task not found: ${args.task_id}`);
      const idx = (task.comments || []).findIndex(c => c.id === args.comment_id);
      if (idx === -1) throw new Error(`Comment not found: ${args.comment_id}`);
      task.comments.splice(idx, 1);
      task.updated_at = nowIso();
      saveData(data);
      return JSON.stringify({ deleted: args.comment_id });
    }

    case 'edit_progress_update': {
      const task = data.tasks.find(t => t.id === args.task_id);
      if (!task) throw new Error(`Task not found: ${args.task_id}`);
      const update = (task.progress_updates || []).find(p => p.id === args.progress_id);
      if (!update) throw new Error(`Progress update not found: ${args.progress_id}`);
      update.text = args.text;
      task.updated_at = nowIso();
      saveData(data);
      return JSON.stringify(update, null, 2);
    }

    case 'delete_progress_update': {
      const task = data.tasks.find(t => t.id === args.task_id);
      if (!task) throw new Error(`Task not found: ${args.task_id}`);
      const idx = (task.progress_updates || []).findIndex(p => p.id === args.progress_id);
      if (idx === -1) throw new Error(`Progress update not found: ${args.progress_id}`);
      task.progress_updates.splice(idx, 1);
      task.updated_at = nowIso();
      saveData(data);
      return JSON.stringify({ deleted: args.progress_id });
    }

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

// ─── JSON-RPC / MCP protocol ───────────────────────────────────────────────

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + '\n');
}

function makeResult(id, result) {
  return { jsonrpc: '2.0', id, result };
}

function makeError(id, code, message) {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

function handleMessage(msg) {
  const { id, method, params } = msg;

  switch (method) {
    case 'initialize':
      send(makeResult(id, {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'cc-tasks', version: '1.0.0' },
      }));
      break;

    case 'notifications/initialized':
      break;

    case 'tools/list':
      send(makeResult(id, { tools: TOOLS }));
      break;

    case 'tools/call': {
      const toolName = params?.name;
      const args = params?.arguments || {};
      try {
        const text = handleToolCall(toolName, args);
        send(makeResult(id, {
          content: [{ type: 'text', text }],
        }));
      } catch (e) {
        send(makeResult(id, {
          content: [{ type: 'text', text: `Error: ${e.message}` }],
          isError: true,
        }));
      }
      break;
    }

    default:
      if (id !== undefined) {
        send(makeError(id, -32601, `Method not found: ${method}`));
      }
  }
}

// ─── Main ───────────────────────────────────────────────────────────────────

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  if (!line.trim()) return;
  try {
    const msg = JSON.parse(line);
    handleMessage(msg);
  } catch (e) {
    send(makeError(null, -32700, `Parse error: ${e.message}`));
  }
});

process.stderr.write(`[cc-tasks-mcp] Server started, tasks file: ${TASKS_FILE}\n`);
