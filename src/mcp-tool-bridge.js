/**
 * Unified tool bridge for API mode.
 * ALL tools come through MCP servers — built-in tools via stdio MCP,
 * external tools via HTTP or stdio MCP servers. One code path for everything.
 */

// Tool registry: maps prefixed tool name → { serverName, originalName, type }
let _toolRegistry = {};

// Active MCP client connections (for stdio MCPs that need to stay alive)
let _activeClients = {};

// ── MCP tool loading ─────────────────────────────────────────────

/** Convert MCP tool definition to OpenAI function-calling format */
function _mcpToolToOpenAI(serverName, mcpTool) {
  const prefix = serverName.replace(/-/g, '_');
  return {
    type: 'function',
    function: {
      name: `${prefix}__${mcpTool.name}`,
      description: mcpTool.description || '',
      parameters: mcpTool.inputSchema || { type: 'object', properties: {} },
    },
    _mcpServer: serverName,
    _mcpOriginalName: mcpTool.name,
  };
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

    const transport = new StdioClientTransport({
      command: config.command,
      args: config.args || [],
      env: { ...process.env, ...(config.env || {}) },
      stderr: 'ignore',
    });
    const client = new Client({ name: 'qapanda', version: '1.0' });
    await client.connect(transport);

    // Keep connection alive for tool execution
    _activeClients[serverName] = { client, type: 'stdio' };

    const result = await client.listTools();
    return (result.tools || []).map(t => _mcpToolToOpenAI(serverName, t));
  } catch (err) {
    console.error(`[mcp-tool-bridge] Stdio MCP "${serverName}" failed:`, err.message);
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
async function _executeStdioMcpTool(serverName, serverConfig, toolName, args) {
  let clientInfo = _activeClients[serverName];
  if (!clientInfo) {
    // Reconnect
    const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
    const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');
    const transport = new StdioClientTransport({
      command: serverConfig.command,
      args: serverConfig.args || [],
      env: { ...process.env, ...(serverConfig.env || {}) },
    });
    const client = new Client({ name: 'qapanda', version: '1.0' });
    await client.connect(transport);
    clientInfo = { client, type: 'stdio' };
    _activeClients[serverName] = clientInfo;
  }
  const result = await clientInfo.client.callTool({ name: toolName, arguments: args });
  return _processToolResult(result);
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

// ── Unified API ──────────────────────────────────────────────────

/**
 * Load ALL tools: built-in MCP + all external MCP servers.
 * @param {object} mcpServers - { serverName: { command, args, url, ... }, ... }
 * @param {string} cwd - Working directory (for built-in tools)
 * @returns {Promise<Array>} OpenAI-format tool definitions
 */
let _lastMcpFingerprint = null;
let _cachedTools = null;

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
  // Cache: if MCP config hasn't changed, reuse existing connections and tools
  const fingerprint = JSON.stringify({
    cwd: cwd || '',
    servers: _stableFingerprintValue(mcpServers || {}),
  });
  if (fingerprint === _lastMcpFingerprint && _cachedTools && Object.keys(_activeClients).length > 0) {
    return _cachedTools;
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

  _lastMcpFingerprint = fingerprint;
  _cachedTools = tools;
  return tools;
}

/**
 * Execute a tool call. Routes to built-in MCP or external MCP automatically.
 * @param {object} toolCall - { id, type, function: { name, arguments } }
 * @param {object} mcpServers - MCP server configs
 * @param {string} cwd - Working directory
 * @returns {Promise<object>} Canonical MCP tool result
 */
async function executeTool(toolCall, mcpServers, cwd) {
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
      return await _executeStdioMcpTool(meta.serverName, serverConfig, meta.originalName, args);
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
  for (const [, info] of Object.entries(_activeClients)) {
    try { await info.client.close(); } catch {}
  }
  _activeClients = {};
  _toolRegistry = {};
  _lastMcpFingerprint = null;
  _cachedTools = null;
}

module.exports = {
  loadAllTools,
  executeTool,
  closeAll,
  // Exposed for testing
  _mcpToolToOpenAI,
  _processToolResult,
};
