/**
 * Built-in coding tools as a proper MCP server.
 * Uses @modelcontextprotocol/sdk with in-memory transport — same process, zero network,
 * but full MCP protocol compliance. Swappable and overridable.
 *
 * Tools: read_file, write_file, edit_file, run_command, glob_search, grep_search, list_directory
 */
const fs = require('node:fs');
const path = require('node:path');
const { exec } = require('node:child_process');
const { promisify } = require('node:util');
const execAsync = promisify(exec);

const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { InMemoryTransport } = require('@modelcontextprotocol/sdk/inMemory.js');
const { ListToolsRequestSchema, CallToolRequestSchema } = require('@modelcontextprotocol/sdk/types.js');

// ── Tool definitions (MCP format) ────────────────────────────────

const TOOLS = [
  {
    name: 'read_file',
    description: 'Read the contents of a file. Returns the file content with line numbers. Use start_line/end_line to read a specific range.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path (absolute or relative to working directory)' },
        start_line: { type: 'integer', description: 'Starting line number (1-based, optional)' },
        end_line: { type: 'integer', description: 'Ending line number (inclusive, optional)' },
      },
      required: ['path'],
    },
  },
  {
    name: 'write_file',
    description: 'Create or overwrite a file with the given content.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path (absolute or relative to working directory)' },
        content: { type: 'string', description: 'The full content to write to the file' },
      },
      required: ['path', 'content'],
    },
  },
  {
    name: 'edit_file',
    description: 'Edit a file by replacing an exact string match with new content. The old_string must match exactly (including whitespace and indentation).',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path' },
        old_string: { type: 'string', description: 'The exact string to find and replace' },
        new_string: { type: 'string', description: 'The replacement string' },
        replace_all: { type: 'boolean', description: 'Replace all occurrences (default: false)' },
      },
      required: ['path', 'old_string', 'new_string'],
    },
  },
  {
    name: 'run_command',
    description: 'Execute a shell command and return its output. Use for running tests, installing packages, git operations, etc.',
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'The shell command to execute' },
        timeout: { type: 'integer', description: 'Timeout in milliseconds (default: 30000)' },
      },
      required: ['command'],
    },
  },
  {
    name: 'glob_search',
    description: 'Find files matching a glob pattern. Returns a list of matching file paths.',
    inputSchema: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Glob pattern (e.g. "**/*.js", "src/**/*.test.ts")' },
        path: { type: 'string', description: 'Directory to search in (default: working directory)' },
      },
      required: ['pattern'],
    },
  },
  {
    name: 'grep_search',
    description: 'Search file contents using a regular expression. Returns matching lines with file paths and line numbers.',
    inputSchema: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Regular expression pattern to search for' },
        path: { type: 'string', description: 'File or directory to search in (default: working directory)' },
        glob: { type: 'string', description: 'Only search files matching this glob (e.g. "*.js")' },
        max_results: { type: 'integer', description: 'Maximum number of results (default: 50)' },
      },
      required: ['pattern'],
    },
  },
  {
    name: 'list_directory',
    description: 'List files and directories in a given path. Returns names with type indicators (file/directory).',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Directory path (default: working directory)' },
      },
    },
  },
];

// ── Tool implementations ─────────────────────────────────────────

async function executeTool(name, args, cwd) {
  switch (name) {
    case 'read_file': {
      const filePath = path.resolve(cwd, args.path);
      const content = fs.readFileSync(filePath, 'utf8');
      const lines = content.split('\n');
      const start = (args.start_line || 1) - 1;
      const end = args.end_line || lines.length;
      return lines.slice(start, end).map((line, i) => `${start + i + 1}\t${line}`).join('\n');
    }
    case 'write_file': {
      const filePath = path.resolve(cwd, args.path);
      const dir = path.dirname(filePath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(filePath, args.content, 'utf8');
      return `File written: ${args.path}`;
    }
    case 'edit_file': {
      const filePath = path.resolve(cwd, args.path);
      let content = fs.readFileSync(filePath, 'utf8');
      if (!content.includes(args.old_string)) return `Error: old_string not found in ${args.path}`;
      if (args.replace_all) content = content.split(args.old_string).join(args.new_string);
      else content = content.replace(args.old_string, args.new_string);
      fs.writeFileSync(filePath, content, 'utf8');
      return `File edited: ${args.path}`;
    }
    case 'run_command': {
      const timeout = args.timeout || 30000;
      try {
        const { stdout, stderr } = await execAsync(args.command, {
          cwd, timeout, maxBuffer: 1024 * 1024,
          shell: process.platform === 'win32' ? true : '/bin/bash',
        });
        let result = '';
        if (stdout) result += stdout;
        if (stderr) result += (result ? '\n' : '') + stderr;
        return result || '(no output)';
      } catch (err) {
        let result = '';
        if (err.stdout) result += err.stdout;
        if (err.stderr) result += (result ? '\n' : '') + err.stderr;
        if (err.killed) result += '\n(command timed out)';
        return result || `Error: ${err.message}`;
      }
    }
    case 'glob_search': {
      const searchDir = args.path ? path.resolve(cwd, args.path) : cwd;
      try {
        const cmd = process.platform === 'win32'
          ? `dir /s /b "${args.pattern}" 2>nul`
          : `find . -name "${args.pattern.replace(/\*\*/g, '*')}" -type f 2>/dev/null | head -100`;
        const { stdout } = await execAsync(cmd, { cwd: searchDir, timeout: 10000 });
        return stdout.trim() || 'No matches found';
      } catch { return 'No matches found'; }
    }
    case 'grep_search': {
      const searchPath = args.path ? path.resolve(cwd, args.path) : cwd;
      const maxResults = args.max_results || 50;
      if (fs.existsSync(searchPath) && fs.statSync(searchPath).isFile()) {
        const content = fs.readFileSync(searchPath, 'utf8');
        const lines = content.split('\n');
        const regex = new RegExp(args.pattern, 'gi');
        const matches = [];
        for (let i = 0; i < lines.length && matches.length < maxResults; i++) {
          if (regex.test(lines[i])) matches.push(`${searchPath}:${i + 1}:${lines[i]}`);
          regex.lastIndex = 0;
        }
        return matches.length > 0 ? matches.join('\n') : 'No matches found';
      }
      try {
        const globArg = args.glob ? (process.platform === 'win32' ? '' : `--glob "${args.glob}"`) : '';
        const cmd = process.platform === 'win32'
          ? `findstr /s /n /r "${args.pattern}" ${args.glob || '*.*'}`
          : `grep -rn ${globArg} "${args.pattern}" . 2>/dev/null | head -${maxResults}`;
        const { stdout } = await execAsync(cmd, { cwd: searchPath, timeout: 15000, maxBuffer: 1024 * 1024 });
        return stdout.trim() || 'No matches found';
      } catch { return 'No matches found'; }
    }
    case 'list_directory': {
      const dirPath = args.path ? path.resolve(cwd, args.path) : cwd;
      const entries = fs.readdirSync(dirPath, { withFileTypes: true });
      return entries.map(e => `${e.isDirectory() ? '[dir]  ' : '[file] '}${e.name}`).join('\n');
    }
    default:
      return `Error: unknown tool "${name}"`;
  }
}

// ── MCP Server ───────────────────────────────────────────────────

/**
 * Start the built-in tools MCP server with in-memory transport.
 * @param {string} cwd - Working directory for tool execution
 * @returns {Promise<{ client: Client, close: () => Promise<void> }>}
 */
async function startBuiltinToolsServer(cwd) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  // Server
  const server = new Server(
    { name: 'builtin-tools', version: '1.0.0' },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOLS,
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    try {
      const result = await executeTool(name, args || {}, cwd);
      return { content: [{ type: 'text', text: result }] };
    } catch (err) {
      return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
    }
  });

  await server.connect(serverTransport);

  // Client
  const client = new Client({ name: 'qapanda', version: '1.0.0' });
  await client.connect(clientTransport);

  return {
    client,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

module.exports = { startBuiltinToolsServer, TOOLS };
