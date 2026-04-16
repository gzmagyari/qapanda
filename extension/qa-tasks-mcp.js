const { rankSearchResults } = require('./mcp-search');
const {
  loadTasksData,
  nowIso,
  saveTasksData,
} = require('./src/tests-store');

const VALID_STATUSES = ['backlog', 'todo', 'in_progress', 'review', 'testing', 'done'];

const TOOLS = [
  { name: 'list_tasks', description: 'List tasks, optionally filtered by status', inputSchema: { type: 'object', properties: { status: { type: 'string', description: 'Filter by status (backlog, todo, in_progress, review, testing, done)' } } } },
  { name: 'get_task', description: 'Get task details by ID, including comments and progress updates', inputSchema: { type: 'object', properties: { task_id: { type: 'string', description: 'The task ID' } }, required: ['task_id'] } },
  { name: 'search_tasks', description: 'Search for likely duplicate existing tasks before creating a new one', inputSchema: { type: 'object', properties: { query: { type: 'string', description: 'Search text describing the issue' }, status: { type: 'string', description: 'Optional status filter' }, limit: { type: 'number', description: 'Maximum results to return (default 5)' } }, required: ['query'] } },
  { name: 'create_task', description: 'Create a new task', inputSchema: { type: 'object', properties: { title: { type: 'string', description: 'Task title' }, description: { type: 'string', description: 'Short description' }, detail_text: { type: 'string', description: 'Detailed notes / acceptance criteria' }, status: { type: 'string', description: 'Initial status (default: todo)' } }, required: ['title'] } },
  { name: 'update_task_status', description: 'Move a task to a new status column', inputSchema: { type: 'object', properties: { task_id: { type: 'string', description: 'The task ID' }, status: { type: 'string', description: 'New status' } }, required: ['task_id', 'status'] } },
  { name: 'update_task_fields', description: 'Update task title, description, or detail_text', inputSchema: { type: 'object', properties: { task_id: { type: 'string', description: 'The task ID' }, title: { type: 'string' }, description: { type: 'string' }, detail_text: { type: 'string' } }, required: ['task_id'] } },
  { name: 'update_task_batch', description: 'Update task status, fields, comments, and progress updates in one call', inputSchema: { type: 'object', properties: { task_id: { type: 'string' }, status: { type: 'string' }, fields: { type: 'object', properties: { title: { type: 'string' }, description: { type: 'string' }, detail_text: { type: 'string' } } }, comments: { type: 'array', items: { type: 'object', properties: { text: { type: 'string' }, author: { type: 'string' } }, required: ['text'] } }, progress_updates: { type: 'array', items: { type: 'object', properties: { text: { type: 'string' }, author: { type: 'string' } }, required: ['text'] } } }, required: ['task_id'] } },
  { name: 'delete_task', description: 'Delete a task', inputSchema: { type: 'object', properties: { task_id: { type: 'string', description: 'The task ID' } }, required: ['task_id'] } },
  { name: 'add_comment', description: 'Add a comment to a task', inputSchema: { type: 'object', properties: { task_id: { type: 'string' }, text: { type: 'string' }, author: { type: 'string', description: 'Author name (default: agent)' } }, required: ['task_id', 'text'] } },
  { name: 'add_progress_update', description: 'Add a progress update to a task', inputSchema: { type: 'object', properties: { task_id: { type: 'string' }, text: { type: 'string' }, author: { type: 'string' } }, required: ['task_id', 'text'] } },
  { name: 'edit_comment', description: 'Edit an existing comment on a task', inputSchema: { type: 'object', properties: { task_id: { type: 'string' }, comment_id: { type: 'number' }, text: { type: 'string' } }, required: ['task_id', 'comment_id', 'text'] } },
  { name: 'delete_comment', description: 'Delete a comment from a task', inputSchema: { type: 'object', properties: { task_id: { type: 'string' }, comment_id: { type: 'number' } }, required: ['task_id', 'comment_id'] } },
  { name: 'edit_progress_update', description: 'Edit an existing progress update on a task', inputSchema: { type: 'object', properties: { task_id: { type: 'string' }, progress_id: { type: 'number' }, text: { type: 'string' } }, required: ['task_id', 'progress_id', 'text'] } },
  { name: 'delete_progress_update', description: 'Delete a progress update from a task', inputSchema: { type: 'object', properties: { task_id: { type: 'string' }, progress_id: { type: 'number' } }, required: ['task_id', 'progress_id'] } },
  { name: 'display_task', description: 'Display a styled task card in the chat. Call this to show a task visually.', inputSchema: { type: 'object', properties: { task_id: { type: 'string', description: 'Task ID' }, title: { type: 'string', description: 'Task title' }, status: { type: 'string', enum: VALID_STATUSES, description: 'Task status' }, description: { type: 'string', description: 'Brief description' } }, required: ['title'] } },
];

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function requireArray(value, fieldName) {
  if (!Array.isArray(value)) throw new Error(`${fieldName} must be an array`);
  return value;
}

function assertValidStatus(status) {
  if (!VALID_STATUSES.includes(status)) throw new Error(`Invalid status: ${status}`);
}

function findTask(data, taskId) {
  return data.tasks.find((task) => task.id === taskId);
}

function handleToolCall(tasksFile, name, args = {}) {
  const data = loadTasksData(tasksFile);

  switch (name) {
    case 'list_tasks': {
      let tasks = data.tasks;
      if (args.status) tasks = tasks.filter((task) => task.status === args.status);
      const summary = tasks.map((task) => ({
        id: task.id,
        title: task.title,
        description: task.description,
        status: task.status,
        comments_count: (task.comments || []).length,
        progress_count: (task.progress_updates || []).length,
        created_at: task.created_at,
        updated_at: task.updated_at,
      }));
      return JSON.stringify(summary, null, 2);
    }

    case 'get_task': {
      const task = findTask(data, args.task_id);
      if (!task) throw new Error(`Task not found: ${args.task_id}`);
      return JSON.stringify(task, null, 2);
    }

    case 'search_tasks': {
      let tasks = data.tasks;
      if (args.status) tasks = tasks.filter((task) => task.status === args.status);
      const matches = rankSearchResults(
        tasks,
        args.query,
        (task) => ([
          { label: 'title', value: task.title, weight: 5 },
          { label: 'description', value: task.description, weight: 3 },
          { label: 'details', value: task.detail_text, weight: 2 },
        ]),
        args.limit || 5
      );
      return JSON.stringify(matches.map(({ item, score, matchReason }) => ({
        id: item.id,
        title: item.title,
        description: item.description,
        status: item.status,
        updated_at: item.updated_at,
        linkedTestIds: item.linkedTestIds || [],
        match_score: score,
        match_reason: matchReason,
      })), null, 2);
    }

    case 'create_task': {
      const status = args.status || 'todo';
      assertValidStatus(status);
      const task = {
        id: `task-${data.nextId++}`,
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
      saveTasksData(tasksFile, data);
      return JSON.stringify(task, null, 2);
    }

    case 'update_task_status': {
      assertValidStatus(args.status);
      const task = findTask(data, args.task_id);
      if (!task) throw new Error(`Task not found: ${args.task_id}`);
      task.status = args.status;
      task.updated_at = nowIso();
      saveTasksData(tasksFile, data);
      return JSON.stringify(task, null, 2);
    }

    case 'update_task_fields': {
      const task = findTask(data, args.task_id);
      if (!task) throw new Error(`Task not found: ${args.task_id}`);
      if (args.title !== undefined) task.title = args.title;
      if (args.description !== undefined) task.description = args.description;
      if (args.detail_text !== undefined) task.detail_text = args.detail_text;
      task.updated_at = nowIso();
      saveTasksData(tasksFile, data);
      return JSON.stringify(task, null, 2);
    }

    case 'update_task_batch': {
      const working = clone(data);
      const task = findTask(working, args.task_id);
      if (!task) throw new Error(`Task not found: ${args.task_id}`);
      if (args.status !== undefined) assertValidStatus(args.status);
      const fields = args.fields && typeof args.fields === 'object' ? args.fields : {};
      const comments = args.comments === undefined ? [] : requireArray(args.comments, 'comments');
      const progressUpdates = args.progress_updates === undefined ? [] : requireArray(args.progress_updates, 'progress_updates');

      if (args.status !== undefined) task.status = args.status;
      if (fields.title !== undefined) task.title = fields.title;
      if (fields.description !== undefined) task.description = fields.description;
      if (fields.detail_text !== undefined) task.detail_text = fields.detail_text;
      if (!Array.isArray(task.comments)) task.comments = [];
      if (!Array.isArray(task.progress_updates)) task.progress_updates = [];

      for (const comment of comments) {
        if (!comment || !comment.text) throw new Error('Each comment requires text');
        task.comments.push({
          id: working.nextCommentId++,
          author: comment.author || 'agent',
          text: comment.text,
          created_at: nowIso(),
        });
      }
      for (const update of progressUpdates) {
        if (!update || !update.text) throw new Error('Each progress update requires text');
        task.progress_updates.push({
          id: working.nextProgressId++,
          author: update.author || 'agent',
          text: update.text,
          created_at: nowIso(),
        });
      }

      task.updated_at = nowIso();
      saveTasksData(tasksFile, working);
      return JSON.stringify({
        task_id: task.id,
        status: task.status,
        title: task.title,
        comments_added: comments.length,
        progress_updates_added: progressUpdates.length,
        fields_updated: Object.keys(fields).filter((key) => fields[key] !== undefined).length,
      }, null, 2);
    }

    case 'delete_task': {
      const index = data.tasks.findIndex((task) => task.id === args.task_id);
      if (index === -1) throw new Error(`Task not found: ${args.task_id}`);
      const removed = data.tasks.splice(index, 1)[0];
      saveTasksData(tasksFile, data);
      return JSON.stringify({ deleted: removed.id });
    }

    case 'add_comment': {
      const task = findTask(data, args.task_id);
      if (!task) throw new Error(`Task not found: ${args.task_id}`);
      if (!Array.isArray(task.comments)) task.comments = [];
      const comment = {
        id: data.nextCommentId++,
        author: args.author || 'agent',
        text: args.text,
        created_at: nowIso(),
      };
      task.comments.push(comment);
      task.updated_at = nowIso();
      saveTasksData(tasksFile, data);
      return JSON.stringify(comment, null, 2);
    }

    case 'add_progress_update': {
      const task = findTask(data, args.task_id);
      if (!task) throw new Error(`Task not found: ${args.task_id}`);
      if (!Array.isArray(task.progress_updates)) task.progress_updates = [];
      const update = {
        id: data.nextProgressId++,
        author: args.author || 'agent',
        text: args.text,
        created_at: nowIso(),
      };
      task.progress_updates.push(update);
      task.updated_at = nowIso();
      saveTasksData(tasksFile, data);
      return JSON.stringify(update, null, 2);
    }

    case 'edit_comment': {
      const task = findTask(data, args.task_id);
      if (!task) throw new Error(`Task not found: ${args.task_id}`);
      const comment = (task.comments || []).find((entry) => entry.id === args.comment_id);
      if (!comment) throw new Error(`Comment not found: ${args.comment_id}`);
      comment.text = args.text;
      task.updated_at = nowIso();
      saveTasksData(tasksFile, data);
      return JSON.stringify(comment, null, 2);
    }

    case 'delete_comment': {
      const task = findTask(data, args.task_id);
      if (!task) throw new Error(`Task not found: ${args.task_id}`);
      const index = (task.comments || []).findIndex((entry) => entry.id === args.comment_id);
      if (index === -1) throw new Error(`Comment not found: ${args.comment_id}`);
      task.comments.splice(index, 1);
      task.updated_at = nowIso();
      saveTasksData(tasksFile, data);
      return JSON.stringify({ deleted: args.comment_id });
    }

    case 'edit_progress_update': {
      const task = findTask(data, args.task_id);
      if (!task) throw new Error(`Task not found: ${args.task_id}`);
      const update = (task.progress_updates || []).find((entry) => entry.id === args.progress_id);
      if (!update) throw new Error(`Progress update not found: ${args.progress_id}`);
      update.text = args.text;
      task.updated_at = nowIso();
      saveTasksData(tasksFile, data);
      return JSON.stringify(update, null, 2);
    }

    case 'delete_progress_update': {
      const task = findTask(data, args.task_id);
      if (!task) throw new Error(`Task not found: ${args.task_id}`);
      const index = (task.progress_updates || []).findIndex((entry) => entry.id === args.progress_id);
      if (index === -1) throw new Error(`Progress update not found: ${args.progress_id}`);
      task.progress_updates.splice(index, 1);
      task.updated_at = nowIso();
      saveTasksData(tasksFile, data);
      return JSON.stringify({ deleted: args.progress_id });
    }

    case 'display_task':
      return 'Displayed task card.';

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

module.exports = {
  TOOLS,
  VALID_STATUSES,
  handleToolCall,
};
