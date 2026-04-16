/**
 * Unified tool bridge for API mode.
 * ALL tools come through MCP servers — built-in tools via stdio MCP,
 * external tools via HTTP or stdio MCP servers. One code path for everything.
 */
const fs = require('node:fs');
const path = require('node:path');
const { sortToolDefinitions } = require('./prompt-cache');

// Tool registry: maps prefixed tool name → { serverName, originalName, type }
let _toolRegistry = {};

// Active MCP client connections (for stdio MCPs that need to stay alive)
let _activeClients = {};
const SEARCH_MCP_TOOLS_NAME = 'search_mcp_tools';
const MCP_BATCH_NAME = 'mcp_batch';

function _isChromeDevtoolsServer(serverName, toolName) {
  const serverText = String(serverName || '').toLowerCase();
  const toolText = String(toolName || '').toLowerCase();
  return serverText.includes('chrome-devtools')
    || serverText.includes('chrome_devtools')
    || toolText.includes('chrome_devtools')
    || toolText.includes('chrome-devtools');
}

function _isRecoverableStdioMcpError(serverName, toolName, error) {
  if (!_isChromeDevtoolsServer(serverName, toolName)) return false;
  const message = String(error && error.message ? error.message : error || '').toLowerCase();
  return message.includes('request timed out')
    || message.includes('connection closed')
    || message.includes('connection lost')
    || message.includes('socket hang up')
    || message.includes('transport closed')
    || message.includes('terminated');
}

async function _disposeActiveClient(serverName) {
  const clientInfo = _activeClients[serverName];
  if (!clientInfo) return;
  try {
    await clientInfo.client.close();
  } catch {}
  delete _activeClients[serverName];
}

// ── MCP tool loading ─────────────────────────────────────────────

/** Convert MCP tool definition to OpenAI function-calling format */
function _sanitizeToolNamePart(value) {
  let output = '';
  for (const char of String(value || '')) {
    if (/^[a-zA-Z0-9_-]$/.test(char)) {
      output += char;
    } else {
      output += `_x${char.codePointAt(0).toString(16)}_`;
    }
  }
  return output;
}

function _mcpToolToOpenAI(serverName, mcpTool) {
  const prefix = _sanitizeToolNamePart(String(serverName || '').replace(/-/g, '_'));
  const safeName = _sanitizeToolNamePart(mcpTool.name);
  return {
    type: 'function',
    function: {
      name: `${prefix}__${safeName}`,
      description: mcpTool.description || '',
      parameters: mcpTool.inputSchema || { type: 'object', properties: {} },
    },
    _mcpServer: serverName,
    _mcpOriginalName: mcpTool.name,
  };
}

function _isLikelyRelativeFileArg(value) {
  const text = String(value || '').trim();
  if (!text || path.isAbsolute(text)) return false;
  if (text.startsWith('-')) return false;
  if (text.includes('://')) return false;
  if (text.startsWith('{') && text.endsWith('}')) return false;
  if (text.startsWith('.') || text.includes('/') || text.includes('\\')) return true;
  return /\.(?:[cm]?[jt]s|json|mjs|cjs|py|sh|mts|cts)$/i.test(text);
}

function _resolveMcpWorkingDir(config, fallbackCwd) {
  const configDir = config && config.__configDir ? String(config.__configDir) : '';
  const explicitCwd = config && config.cwd ? String(config.cwd).trim() : '';
  if (explicitCwd) {
    return path.resolve(configDir || fallbackCwd || process.cwd(), explicitCwd);
  }
  if (configDir) return configDir;
  return fallbackCwd || process.cwd();
}

function _prepareStdioMcpLaunch(config, fallbackCwd) {
  const launchCwd = _resolveMcpWorkingDir(config || {}, fallbackCwd);
  const resolvedArgs = Array.isArray(config && config.args)
    ? config.args.map((arg) => {
        if (!_isLikelyRelativeFileArg(arg)) return arg;
        const candidate = path.resolve(launchCwd, String(arg));
        return fs.existsSync(candidate) ? candidate : arg;
      })
    : [];
  const resolvedCommand = (config && config.command && _isLikelyRelativeFileArg(config.command))
    ? (() => {
        const candidate = path.resolve(launchCwd, String(config.command));
        return fs.existsSync(candidate) ? candidate : config.command;
      })()
    : config.command;
  return {
    command: resolvedCommand,
    args: resolvedArgs,
    cwd: launchCwd,
    env: { ...process.env, ...((config && config.env) || {}) },
  };
}

function _describeStdioMcpLaunch(serverName, launch) {
  const renderedArgs = Array.isArray(launch.args) ? launch.args.join(' ') : '';
  return `server=${serverName} command=${launch.command}${renderedArgs ? ` args=${renderedArgs}` : ''} cwd=${launch.cwd}`;
}

/** Load tools from an HTTP MCP server */
async function _loadHttpMcpTools(serverName, config) {
  const url = config.url.replace(/\/mcp$/, '') + '/mcp';
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
      signal: AbortSignal.timeout(10000),
    });
    const data = await response.json();
    const tools = (data.result && data.result.tools) || [];
    return tools.map(t => _mcpToolToOpenAI(serverName, t));
  } catch (err) {
    console.error(`[mcp-tool-bridge] HTTP MCP "${serverName}" tools/list failed:`, err.message);
    return [];
  }
}

/** Load tools from a stdio MCP server */
async function _loadStdioMcpTools(serverName, config) {
  try {
    const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
    const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');
    const launch = _prepareStdioMcpLaunch(config);

    const transport = new StdioClientTransport({
      command: launch.command,
      args: launch.args,
      cwd: launch.cwd,
      env: launch.env,
      stderr: 'ignore',
    });
    const client = new Client({ name: 'qapanda', version: '1.0' });
    await client.connect(transport);

    // Keep connection alive for tool execution
    _activeClients[serverName] = { client, type: 'stdio' };

    const result = await client.listTools();
    return (result.tools || []).map(t => _mcpToolToOpenAI(serverName, t));
  } catch (err) {
    const launch = _prepareStdioMcpLaunch(config);
    console.error(`[mcp-tool-bridge] Stdio MCP "${serverName}" failed (${_describeStdioMcpLaunch(serverName, launch)}):`, err.message);
    return [];
  }
}

// ── MCP tool execution ───────────────────────────────────────────

/** Execute a tool call on an HTTP MCP server */
async function _executeHttpMcpTool(serverConfig, toolName, args) {
  const url = serverConfig.url.replace(/\/mcp$/, '') + '/mcp';
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0', id: 1,
      method: 'tools/call',
      params: { name: toolName, arguments: args },
    }),
    signal: AbortSignal.timeout(30000),
  });
  const data = await response.json();
  if (data.error) return _errorToolResult(`Error: ${data.error.message || JSON.stringify(data.error)}`);
  return _processToolResult(data.result);
}

/** Execute a tool call on a stdio MCP server (reuse cached client) */
async function _executeStdioMcpTool(serverName, serverConfig, toolName, args, options = {}) {
  let clientInfo = _activeClients[serverName];
  if (!clientInfo) {
    // Reconnect
    const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
    const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');
    const launch = _prepareStdioMcpLaunch(serverConfig);
    const transport = new StdioClientTransport({
      command: launch.command,
      args: launch.args,
      cwd: launch.cwd,
      env: launch.env,
    });
    const client = new Client({ name: 'qapanda', version: '1.0' });
    await client.connect(transport);
    clientInfo = { client, type: 'stdio' };
    _activeClients[serverName] = clientInfo;
  }
  try {
    const result = await clientInfo.client.callTool({ name: toolName, arguments: args });
    return _processToolResult(result);
  } catch (err) {
    if (!_isRecoverableStdioMcpError(serverName, toolName, err)) {
      throw err;
    }
    await _disposeActiveClient(serverName);
    if (_isChromeDevtoolsServer(serverName, toolName) && typeof options.onRecoverChromeDevtools === 'function') {
      await options.onRecoverChromeDevtools({ serverName, toolName, args, error: err });
    }
    const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
    const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');
    const launch = _prepareStdioMcpLaunch(serverConfig);
    const transport = new StdioClientTransport({
      command: launch.command,
      args: launch.args,
      cwd: launch.cwd,
      env: launch.env,
    });
    const client = new Client({ name: 'qapanda', version: '1.0' });
    await client.connect(transport);
    clientInfo = { client, type: 'stdio' };
    _activeClients[serverName] = clientInfo;
    const retryResult = await clientInfo.client.callTool({ name: toolName, arguments: args });
    return _processToolResult(retryResult);
  }
}


/**
 * Normalize MCP tool result into canonical structured content.
 */
function _processToolResult(result) {
  if (result && typeof result === 'object' && Array.isArray(result.content)) {
    return result;
  }
  if (typeof result === 'string') {
    return { content: [{ type: 'text', text: result }] };
  }
  if (result == null) {
    return { content: [] };
  }
  return {
    content: [{
      type: 'text',
      text: typeof result === 'object' ? JSON.stringify(result) : String(result),
    }],
  };
}

function _errorToolResult(text) {
  return {
    isError: true,
    content: [{ type: 'text', text }],
  };
}

function _cloneToolDefinition(tool) {
  if (!tool || typeof tool !== 'object') return null;
  return {
    type: tool.type,
    function: {
      name: tool.function && tool.function.name ? tool.function.name : '',
      description: tool.function && tool.function.description ? tool.function.description : '',
      parameters: tool.function && tool.function.parameters ? tool.function.parameters : { type: 'object', properties: {} },
    },
  };
}

function _buildSearchText(entry) {
  return [
    entry.name,
    entry.originalName,
    entry.serverName,
    entry.description,
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
}

function _toolCatalogFromDefinitions(fingerprint, toolDefs) {
  const definitions = sortToolDefinitions((toolDefs || []).map((tool) => _cloneToolDefinition(tool)).filter(Boolean));
  const entries = definitions.map((tool) => {
    const meta = _toolRegistry[tool.function.name] || {};
    const entry = {
      name: tool.function.name,
      serverName: meta.serverName || null,
      originalName: meta.originalName || tool.function.name,
      type: meta.type || null,
      description: tool.function.description || '',
      parameters: tool.function.parameters || { type: 'object', properties: {} },
      definition: _cloneToolDefinition(tool),
    };
    entry.searchText = _buildSearchText(entry);
    return entry;
  });
  const byName = Object.fromEntries(entries.map((entry) => [entry.name, entry]));
  return {
    fingerprint,
    toolCount: entries.length,
    toolNames: entries.map((entry) => entry.name),
    entries,
    byName,
    tools: entries.map((entry) => _cloneToolDefinition(entry.definition)),
  };
}

function _searchScore(entry, queryText) {
  const query = String(queryText || '').trim().toLowerCase();
  if (!query) return 0;
  const name = String(entry.name || '').toLowerCase();
  const originalName = String(entry.originalName || '').toLowerCase();
  const serverName = String(entry.serverName || '').toLowerCase();
  const description = String(entry.description || '').toLowerCase();
  const tokens = query.split(/[^a-z0-9_]+/i).filter(Boolean);
  let score = 0;

  if (name === query || originalName === query) score += 1000;
  if (name.startsWith(query) || originalName.startsWith(query)) score += 500;
  if (name.includes(query) || originalName.includes(query)) score += 250;
  if (serverName === query) score += 200;
  if (serverName.includes(query)) score += 120;

  for (const token of tokens) {
    if (name.includes(token) || originalName.includes(token)) score += 50;
    else if (serverName.includes(token)) score += 25;
    else if (description.includes(token)) score += 10;
  }

  return score;
}

function buildSearchMcpToolDefinition() {
  return {
    type: 'function',
    function: {
      name: SEARCH_MCP_TOOLS_NAME,
      description: 'Search the hidden MCP tool catalog and activate relevant tools for later turns.',
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'Capability or tool you need, such as "read command output", "take screenshot", or "search tests".',
          },
          maxResults: {
            type: 'integer',
            description: 'Maximum number of matches to return.',
            minimum: 1,
            maximum: 5,
          },
          server: {
            type: 'string',
            description: 'Optional MCP server name to narrow the search.',
          },
        },
        required: ['query'],
      },
    },
  };
}

function buildMcpBatchToolDefinition() {
  return {
    type: 'function',
    function: {
      name: MCP_BATCH_NAME,
      description: 'Execute multiple already-visible MCP tools in one model turn. Use only for independent calls that do not require model reasoning between subcalls.',
      parameters: {
        type: 'object',
        properties: {
          calls: {
            type: 'array',
            description: 'Ordered list of MCP tool calls to execute.',
            items: {
              type: 'object',
              properties: {
                id: { type: 'string', description: 'Optional client-side subcall id.' },
                tool: { type: 'string', description: 'Visible MCP tool name, such as cc_tests__search_tests.' },
                arguments: { type: 'object', description: 'Arguments for the tool call.' },
              },
              required: ['tool'],
            },
          },
          continueOnError: {
            type: 'boolean',
            description: 'When false, stop after the first failed subcall. Defaults to false.',
          },
        },
        required: ['calls'],
      },
    },
  };
}

// ── Unified API ──────────────────────────────────────────────────

/**
 * Load ALL tools: built-in MCP + all external MCP servers.
 * @param {object} mcpServers - { serverName: { command, args, url, ... }, ... }
 * @param {string} cwd - Working directory (for built-in tools)
 * @returns {Promise<Array>} OpenAI-format tool definitions
 */
let _lastMcpFingerprint = null;
let _cachedCatalog = null;

function _stableFingerprintValue(value) {
  if (Array.isArray(value)) return value.map(_stableFingerprintValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, _stableFingerprintValue(value[key])])
    );
  }
  return value;
}

async function loadAllTools(mcpServers, cwd) {
  const catalog = await loadToolCatalog(mcpServers, cwd);
  return catalog.tools.map((tool) => _cloneToolDefinition(tool));
}

async function loadToolCatalog(mcpServers, cwd) {
  const fingerprint = JSON.stringify({
    cwd: cwd || '',
    servers: _stableFingerprintValue(mcpServers || {}),
  });
  if (fingerprint === _lastMcpFingerprint && _cachedCatalog) {
    return _cachedCatalog;
  }

  _toolRegistry = {};
  // Close old active clients only if config changed
  for (const [name, info] of Object.entries(_activeClients)) {
    try { await info.client.close(); } catch {}
  }
  _activeClients = {};

  const tools = [];

  // All tools come through MCP servers in the manifest.

  // Load MCP tools in parallel
  const mcpEntries = Object.entries(mcpServers || {});
  const mcpResults = await Promise.allSettled(
    mcpEntries.map(([name, config]) => {
      if (config.url) return _loadHttpMcpTools(name, config);
      if (config.command) return _loadStdioMcpTools(name, config);
      return Promise.resolve([]);
    })
  );

  for (let i = 0; i < mcpResults.length; i++) {
    if (mcpResults[i].status === 'fulfilled') {
      for (const tool of mcpResults[i].value) {
        const type = mcpEntries[i][1].url ? 'http' : 'stdio';
        _toolRegistry[tool.function.name] = {
          serverName: tool._mcpServer,
          originalName: tool._mcpOriginalName,
          type,
        };
        tools.push({ type: tool.type, function: tool.function });
      }
    }
  }

  const catalog = _toolCatalogFromDefinitions(fingerprint, tools);
  _lastMcpFingerprint = fingerprint;
  _cachedCatalog = catalog;
  return catalog;
}

function materializeToolDefinitions(catalog, visibleToolNames) {
  const source = catalog && catalog.byName ? catalog.byName : {};
  const selected = Array.isArray(visibleToolNames)
    ? visibleToolNames
        .map((name) => source[name])
        .filter(Boolean)
        .map((entry) => _cloneToolDefinition(entry.definition))
    : [];
  return sortToolDefinitions(selected);
}

function searchToolCatalog(catalog, query, options = {}) {
  if (!catalog || !Array.isArray(catalog.entries)) return [];
  const maxResults = Math.max(1, Math.min(5, Number(options.maxResults) || 5));
  const serverFilter = options.server ? String(options.server).trim().toLowerCase() : '';
  return catalog.entries
    .filter((entry) => !serverFilter || String(entry.serverName || '').toLowerCase() === serverFilter)
    .map((entry) => ({
      entry,
      score: _searchScore(entry, query),
    }))
    .filter((item) => item.score > 0)
    .sort((left, right) => {
      if (right.score !== left.score) return right.score - left.score;
      return String(left.entry.name).localeCompare(String(right.entry.name));
    })
    .slice(0, maxResults)
    .map((item) => ({
      name: item.entry.name,
      serverName: item.entry.serverName,
      originalName: item.entry.originalName,
      description: item.entry.description,
      score: item.score,
    }));
}

function buildMcpCapabilityIndex(catalog) {
  if (!catalog || !Array.isArray(catalog.entries) || catalog.entries.length === 0) return '';
  const grouped = new Map();
  for (const entry of catalog.entries) {
    const serverName = String(entry && entry.serverName ? entry.serverName : 'unknown').trim() || 'unknown';
    const toolName = String(entry && (entry.originalName || entry.name) ? (entry.originalName || entry.name) : '').trim();
    if (!toolName) continue;
    if (!grouped.has(serverName)) grouped.set(serverName, new Set());
    grouped.get(serverName).add(toolName);
  }
  return Array.from(grouped.entries())
    .sort((left, right) => String(left[0]).localeCompare(String(right[0])))
    .map(([serverName, toolNames]) => {
      const names = Array.from(toolNames).sort((left, right) => String(left).localeCompare(String(right)));
      return `${serverName}: ${names.join(', ')}`;
    })
    .join('\n');
}

/**
 * Execute a tool call. Routes to built-in MCP or external MCP automatically.
 * @param {object} toolCall - { id, type, function: { name, arguments } }
 * @param {object} mcpServers - MCP server configs
 * @param {string} cwd - Working directory
 * @returns {Promise<object>} Canonical MCP tool result
 */
async function executeTool(toolCall, mcpServers, cwd, options = {}) {
  const name = toolCall.function.name;
  const meta = _toolRegistry[name];
  if (!meta) return _errorToolResult(`Error: unknown tool "${name}"`);

  try {
    const args = typeof toolCall.function.arguments === 'string'
      ? JSON.parse(toolCall.function.arguments)
      : (toolCall.function.arguments || {});
    if (meta.type === 'http') {
      const serverConfig = mcpServers && mcpServers[meta.serverName];
      if (!serverConfig) return _errorToolResult(`Error: MCP server "${meta.serverName}" not configured`);
      return await _executeHttpMcpTool(serverConfig, meta.originalName, args);
    }
    if (meta.type === 'stdio') {
      const serverConfig = mcpServers && mcpServers[meta.serverName];
      return await _executeStdioMcpTool(meta.serverName, serverConfig, meta.originalName, args, options);
    }
    return _errorToolResult(`Error: unknown tool type "${meta.type}" for "${name}"`);
  } catch (err) {
    return _errorToolResult(`Error executing tool "${name}": ${err.message}`);
  }
}

/**
 * Clean up all connections.
 */
async function closeAll() {
  for (const name of Object.keys(_activeClients)) {
    await _disposeActiveClient(name);
  }
  _activeClients = {};
  _toolRegistry = {};
  _lastMcpFingerprint = null;
  _cachedCatalog = null;
}

module.exports = {
  MCP_BATCH_NAME,
  SEARCH_MCP_TOOLS_NAME,
  buildMcpBatchToolDefinition,
  buildSearchMcpToolDefinition,
  buildMcpCapabilityIndex,
  loadToolCatalog,
  loadAllTools,
  materializeToolDefinitions,
  searchToolCatalog,
  executeTool,
  closeAll,
  errorToolResult: _errorToolResult,
  // Exposed for testing
  _prepareStdioMcpLaunch,
  _resolveMcpWorkingDir,
  _isLikelyRelativeFileArg,
  _describeStdioMcpLaunch,
  _mcpToolToOpenAI,
  _sanitizeToolNamePart,
  _isChromeDevtoolsServer,
  _isRecoverableStdioMcpError,
  _processToolResult,
};
