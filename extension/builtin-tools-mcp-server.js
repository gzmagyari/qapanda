#!/usr/bin/env node
/**
 * Stdio MCP server for built-in coding tools.
 * Wraps the tools from src/builtin-tools-mcp.js as a proper MCP stdio server.
 * Injected automatically when any agent/controller uses API mode.
 *
 * Environment: CWD = working directory for tool execution
 */
const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { ListToolsRequestSchema, CallToolRequestSchema } = require('@modelcontextprotocol/sdk/types.js');
const path = require('node:path');
const fs = require('node:fs');

function loadBuiltinToolsModule() {
  const candidates = [
    path.resolve(__dirname, 'src', 'builtin-tools-mcp.js'),
    path.resolve(__dirname, '..', 'src', 'builtin-tools-mcp.js'),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return require(candidate);
    }
  }
  throw new Error(`builtin-tools-mcp.js not found. Looked in: ${candidates.join(', ')}`);
}

// Import tool definitions from the shared module.
const { TOOLS } = loadBuiltinToolsModule();

// Resolve working directory from env or fallback to process.cwd()
const cwd = process.env.CWD || process.cwd();

// Dynamically import executeTool (it's async, defined in the module)
async function executeTool(name, args) {
  // Re-require to get the execute function (uses same TOOLS definitions)
  const { promisify } = require('node:util');
  const { exec } = require('node:child_process');
  const execAsync = promisify(exec);

  // Execute inline — same logic as builtin-tools-mcp.js executeTool
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

async function main() {
  const server = new Server(
    { name: 'builtin-tools', version: '1.0.0' },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    try {
      const result = await executeTool(name, args || {});
      return { content: [{ type: 'text', text: result }] };
    } catch (err) {
      return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error('[builtin-tools-mcp] Fatal:', err);
  process.exit(1);
});
