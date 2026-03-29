/**
 * HTTP MCP server for external control of QA Panda extension instances.
 * Allows tools like Claude Code to discover open panels and send messages.
 * Singleton — started once in activate(), shared across all panels.
 */
const { createMcpHttpServer } = require('./mcp-http-server');

const TOOLS = [
  {
    name: 'list_panels',
    description: 'List all open QA Panda panels in this workspace. Returns panel IDs, active agent, run status, and repo root.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'send_message',
    description: 'Send a message to a QA Panda panel and wait for the agent to finish processing it. Returns the agent response text. The panel must not already be running a request.',
    inputSchema: {
      type: 'object',
      properties: {
        panel_id: {
          type: 'string',
          description: 'Panel ID from list_panels. Omit to use the first available panel.',
        },
        message: {
          type: 'string',
          description: 'The message to send to the active agent in the panel.',
        },
      },
      required: ['message'],
    },
  },
];

let _server = null;
let _registry = null; // Map<panelId, {session, panel, repoRoot}>

function _findEntry(panelId) {
  if (!_registry || _registry.size === 0) return null;
  if (panelId) return _registry.get(panelId) || null;
  // First available panel
  return _registry.values().next().value || null;
}

function handleListPanels() {
  if (!_registry) return '[]';
  const panels = [];
  for (const [panelId, entry] of _registry) {
    panels.push({
      panelId,
      repoRoot: entry.repoRoot,
      agent: entry.session._chatTarget || 'controller',
      running: !!entry.session._running,
      hasRun: !!entry.session._activeManifest,
      runId: (entry.session._activeManifest && entry.session._activeManifest.runId) || null,
    });
  }
  return JSON.stringify(panels, null, 2);
}

async function handleSendMessage(args) {
  const { panel_id, message } = args;
  if (!message) throw new Error('message is required');

  const entry = _findEntry(panel_id);
  if (!entry) throw new Error('No QA Panda panel found' + (panel_id ? ` with id "${panel_id}"` : ''));
  if (entry.session._running) throw new Error('Panel is already running a request. Wait for it to finish or abort it first.');

  // Wait for the run to finish after sending the message
  const resultPromise = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      clearInterval(check);
      reject(new Error('Timeout: agent did not finish within 5 minutes'));
    }, 300000);

    // Small delay before first check so _running has time to become true
    let started = false;
    const check = setInterval(() => {
      if (!started && entry.session._running) {
        started = true;
      }
      if (started && !entry.session._running) {
        clearInterval(check);
        clearTimeout(timeout);
        // Extract result from the latest request
        const manifest = entry.session._activeManifest;
        if (manifest && manifest.requests && manifest.requests.length > 0) {
          const lastReq = manifest.requests[manifest.requests.length - 1];
          const result = (lastReq.latestWorkerResult && lastReq.latestWorkerResult.resultText)
            || lastReq.stopReason
            || 'Completed';
          resolve(result);
        } else {
          resolve('Completed (no result text)');
        }
      }
    }, 500);
  });

  // Trigger the input through the normal message path (same as webview userInput)
  entry.session.handleMessage({ type: 'userInput', text: message });

  return await resultPromise;
}

/**
 * Start the QA Panda control MCP server.
 * @param {Map} registry - panelId → {session, panel, repoRoot}
 * @returns {Promise<{port: number, close: function}>}
 */
async function startQaPandaControlMcpServer(registry) {
  if (_server) return { port: _server.port, close: _server.close };
  _registry = registry;
  _server = await createMcpHttpServer({
    tools: TOOLS,
    handleToolCall: async (name, args) => {
      if (name === 'list_panels') return handleListPanels();
      if (name === 'send_message') return await handleSendMessage(args);
      return 'Unknown tool: ' + name;
    },
    serverName: 'qa-panda-control',
  });
  return _server;
}

async function stopQaPandaControlMcpServer() {
  if (_server) {
    await _server.close();
    _server = null;
    _registry = null;
  }
}

module.exports = { startQaPandaControlMcpServer, stopQaPandaControlMcpServer };
