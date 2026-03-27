/**
 * HTTP version of the QA Panda Tasks MCP Server.
 * Reuses the same tool definitions and handler logic as the stdio version,
 * but serves over HTTP so container-based agents can reach it via host.docker.internal.
 */
const fs = require('node:fs');
const path = require('node:path');
const { createMcpHttpServer } = require('./mcp-http-server');

const VALID_STATUSES = ['backlog', 'todo', 'in_progress', 'review', 'testing', 'done'];

function nowIso() { return new Date().toISOString(); }

function loadData(tasksFile) {
  try {
    return JSON.parse(fs.readFileSync(tasksFile, 'utf8'));
  } catch {
    return { nextId: 1, nextCommentId: 1, nextProgressId: 1, tasks: [] };
  }
}

function saveData(tasksFile, data) {
  const dir = path.dirname(tasksFile);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(tasksFile, JSON.stringify(data, null, 2), 'utf8');
}

const TOOLS = [
  { name: 'list_tasks', description: 'List tasks, optionally filtered by status', inputSchema: { type: 'object', properties: { status: { type: 'string', description: 'Filter by status (backlog, todo, in_progress, review, testing, done)' } } } },
  { name: 'get_task', description: 'Get task details by ID, including comments and progress updates', inputSchema: { type: 'object', properties: { task_id: { type: 'string', description: 'The task ID' } }, required: ['task_id'] } },
  { name: 'create_task', description: 'Create a new task', inputSchema: { type: 'object', properties: { title: { type: 'string', description: 'Task title' }, description: { type: 'string', description: 'Short description' }, detail_text: { type: 'string', description: 'Detailed notes / acceptance criteria' }, status: { type: 'string', description: 'Initial status (default: todo)' } }, required: ['title'] } },
  { name: 'update_task_status', description: 'Move a task to a new status column', inputSchema: { type: 'object', properties: { task_id: { type: 'string', description: 'The task ID' }, status: { type: 'string', description: 'New status' } }, required: ['task_id', 'status'] } },
  { name: 'update_task_fields', description: 'Update task title, description, or detail_text', inputSchema: { type: 'object', properties: { task_id: { type: 'string', description: 'The task ID' }, title: { type: 'string' }, description: { type: 'string' }, detail_text: { type: 'string' } }, required: ['task_id'] } },
  { name: 'delete_task', description: 'Delete a task', inputSchema: { type: 'object', properties: { task_id: { type: 'string', description: 'The task ID' } }, required: ['task_id'] } },
  { name: 'add_comment', description: 'Add a comment to a task', inputSchema: { type: 'object', properties: { task_id: { type: 'string' }, text: { type: 'string' }, author: { type: 'string', description: 'Author name (default: agent)' } }, required: ['task_id', 'text'] } },
  { name: 'add_progress_update', description: 'Add a progress update to a task', inputSchema: { type: 'object', properties: { task_id: { type: 'string' }, text: { type: 'string' }, author: { type: 'string' } }, required: ['task_id', 'text'] } },
  { name: 'edit_comment', description: 'Edit an existing comment on a task', inputSchema: { type: 'object', properties: { task_id: { type: 'string' }, comment_id: { type: 'number' }, text: { type: 'string' } }, required: ['task_id', 'comment_id', 'text'] } },
  { name: 'delete_comment', description: 'Delete a comment from a task', inputSchema: { type: 'object', properties: { task_id: { type: 'string' }, comment_id: { type: 'number' } }, required: ['task_id', 'comment_id'] } },
  { name: 'edit_progress_update', description: 'Edit an existing progress update on a task', inputSchema: { type: 'object', properties: { task_id: { type: 'string' }, progress_id: { type: 'number' }, text: { type: 'string' } }, required: ['task_id', 'progress_id', 'text'] } },
  { name: 'delete_progress_update', description: 'Delete a progress update from a task', inputSchema: { type: 'object', properties: { task_id: { type: 'string' }, progress_id: { type: 'number' } }, required: ['task_id', 'progress_id'] } },
];

function handleToolCall(tasksFile, name, args) {
  const data = loadData(tasksFile);

  switch (name) {
    case 'list_tasks': {
      let tasks = data.tasks;
      if (args.status) tasks = tasks.filter(t => t.status === args.status);
      const summary = tasks.map(t => ({
        id: t.id, title: t.title, description: t.description, status: t.status,
        comments_count: (t.comments || []).length, progress_count: (t.progress_updates || []).length,
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
      const task = { id, title: args.title, description: args.description || '', detail_text: args.detail_text || '', status, created_at: nowIso(), updated_at: nowIso(), comments: [], progress_updates: [] };
      data.tasks.push(task);
      saveData(tasksFile, data);
      return JSON.stringify(task, null, 2);
    }
    case 'update_task_status': {
      if (!VALID_STATUSES.includes(args.status)) throw new Error(`Invalid status: ${args.status}`);
      const task = data.tasks.find(t => t.id === args.task_id);
      if (!task) throw new Error(`Task not found: ${args.task_id}`);
      task.status = args.status;
      task.updated_at = nowIso();
      saveData(tasksFile, data);
      return JSON.stringify(task, null, 2);
    }
    case 'update_task_fields': {
      const task = data.tasks.find(t => t.id === args.task_id);
      if (!task) throw new Error(`Task not found: ${args.task_id}`);
      if (args.title !== undefined) task.title = args.title;
      if (args.description !== undefined) task.description = args.description;
      if (args.detail_text !== undefined) task.detail_text = args.detail_text;
      task.updated_at = nowIso();
      saveData(tasksFile, data);
      return JSON.stringify(task, null, 2);
    }
    case 'delete_task': {
      const idx = data.tasks.findIndex(t => t.id === args.task_id);
      if (idx === -1) throw new Error(`Task not found: ${args.task_id}`);
      const removed = data.tasks.splice(idx, 1)[0];
      saveData(tasksFile, data);
      return JSON.stringify({ deleted: removed.id });
    }
    case 'add_comment': {
      const task = data.tasks.find(t => t.id === args.task_id);
      if (!task) throw new Error(`Task not found: ${args.task_id}`);
      if (!task.comments) task.comments = [];
      const comment = { id: data.nextCommentId++, author: args.author || 'agent', text: args.text, created_at: nowIso() };
      task.comments.push(comment);
      task.updated_at = nowIso();
      saveData(tasksFile, data);
      return JSON.stringify(comment, null, 2);
    }
    case 'add_progress_update': {
      const task = data.tasks.find(t => t.id === args.task_id);
      if (!task) throw new Error(`Task not found: ${args.task_id}`);
      if (!task.progress_updates) task.progress_updates = [];
      const update = { id: data.nextProgressId++, author: args.author || 'agent', text: args.text, created_at: nowIso() };
      task.progress_updates.push(update);
      task.updated_at = nowIso();
      saveData(tasksFile, data);
      return JSON.stringify(update, null, 2);
    }
    case 'edit_comment': {
      const task = data.tasks.find(t => t.id === args.task_id);
      if (!task) throw new Error(`Task not found: ${args.task_id}`);
      const comment = (task.comments || []).find(c => c.id === args.comment_id);
      if (!comment) throw new Error(`Comment not found: ${args.comment_id}`);
      comment.text = args.text;
      task.updated_at = nowIso();
      saveData(tasksFile, data);
      return JSON.stringify(comment, null, 2);
    }
    case 'delete_comment': {
      const task = data.tasks.find(t => t.id === args.task_id);
      if (!task) throw new Error(`Task not found: ${args.task_id}`);
      const idx = (task.comments || []).findIndex(c => c.id === args.comment_id);
      if (idx === -1) throw new Error(`Comment not found: ${args.comment_id}`);
      task.comments.splice(idx, 1);
      task.updated_at = nowIso();
      saveData(tasksFile, data);
      return JSON.stringify({ deleted: args.comment_id });
    }
    case 'edit_progress_update': {
      const task = data.tasks.find(t => t.id === args.task_id);
      if (!task) throw new Error(`Task not found: ${args.task_id}`);
      const update = (task.progress_updates || []).find(p => p.id === args.progress_id);
      if (!update) throw new Error(`Progress update not found: ${args.progress_id}`);
      update.text = args.text;
      task.updated_at = nowIso();
      saveData(tasksFile, data);
      return JSON.stringify(update, null, 2);
    }
    case 'delete_progress_update': {
      const task = data.tasks.find(t => t.id === args.task_id);
      if (!task) throw new Error(`Task not found: ${args.task_id}`);
      const idx = (task.progress_updates || []).findIndex(p => p.id === args.progress_id);
      if (idx === -1) throw new Error(`Progress update not found: ${args.progress_id}`);
      task.progress_updates.splice(idx, 1);
      task.updated_at = nowIso();
      saveData(tasksFile, data);
      return JSON.stringify({ deleted: args.progress_id });
    }
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

// --- Server lifecycle ---

let _server = null;

/**
 * Start the HTTP tasks MCP server.
 * @param {string} tasksFile - Absolute path to tasks.json
 * @returns {Promise<{port: number, close: function}>}
 */
async function startTasksMcpServer(tasksFile) {
  if (_server) return { port: _server.port, close: _server.close };

  const result = await createMcpHttpServer({
    tools: TOOLS,
    handleToolCall: (name, args) => handleToolCall(tasksFile, name, args),
    serverName: 'cc-tasks',
  });

  _server = result;
  console.log(`[cc-tasks-http] Started on port ${result.port}, tasks file: ${tasksFile}`);
  return { port: result.port, close: result.close };
}

async function stopTasksMcpServer() {
  if (!_server) return;
  await _server.close();
  _server = null;
}

module.exports = { startTasksMcpServer, stopTasksMcpServer };
