const vscode = require('vscode');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { WebviewRenderer } = require('./webview-renderer');
const { SessionManager } = require('./session-manager');
const { globalAgentsPath, projectAgentsPath, loadAgentsFile, saveAgentsFile, loadMergedAgents } = require('./agents-store');
const { listInstances, stopInstance, restartInstance, ensureDesktop, getLinkedInstance } = require('./src/remote-desktop');

const activePanels = new Set();

// ── MCP config file helpers ─────────────────────────────────────────
function globalMcpPath() {
  return path.join(os.homedir(), '.cc-manager', 'mcp.json');
}

function projectMcpPath(repoRoot) {
  return path.join(repoRoot, '.cc-manager', 'mcp.json');
}

function loadMcpFile(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return {};
  }
}

function saveMcpFile(filePath, data) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
}

/** Load and merge global + project MCP servers. Project overrides global by name. */
function loadMergedMcpServers(repoRoot) {
  const globalServers = loadMcpFile(globalMcpPath());
  const projectServers = loadMcpFile(projectMcpPath(repoRoot));
  return { global: globalServers, project: projectServers };
}

// ── Tasks file helpers ───────────────────────────────────────────────
function tasksFilePath(repoRoot) {
  return path.join(repoRoot, '.cc-manager', 'tasks.json');
}

function loadTasksFile(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return { nextId: 1, nextCommentId: 1, nextProgressId: 1, tasks: [] };
  }
}

function saveTasksFile(filePath, data) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
}

function nowIso() { return new Date().toISOString(); }

function handleTaskMessage(msg, repoRoot) {
  const fp = tasksFilePath(repoRoot);
  const data = loadTasksFile(fp);

  if (msg.type === 'tasksLoad') {
    return { type: 'tasksData', tasks: data.tasks };
  }

  if (msg.type === 'taskCreate') {
    const id = `task-${data.nextId++}`;
    const task = {
      id, title: msg.title || 'Untitled', description: msg.description || '',
      detail_text: msg.detail_text || '', status: msg.status || 'backlog',
      created_at: nowIso(), updated_at: nowIso(), comments: [], progress_updates: [],
    };
    data.tasks.push(task);
    saveTasksFile(fp, data);
    return { type: 'tasksData', tasks: data.tasks };
  }

  if (msg.type === 'taskUpdate') {
    const task = data.tasks.find(t => t.id === msg.task_id);
    if (task) {
      if (msg.title !== undefined) task.title = msg.title;
      if (msg.description !== undefined) task.description = msg.description;
      if (msg.detail_text !== undefined) task.detail_text = msg.detail_text;
      if (msg.status !== undefined) task.status = msg.status;
      task.updated_at = nowIso();
      saveTasksFile(fp, data);
    }
    return { type: 'tasksData', tasks: data.tasks };
  }

  if (msg.type === 'taskDelete') {
    data.tasks = data.tasks.filter(t => t.id !== msg.task_id);
    saveTasksFile(fp, data);
    return { type: 'tasksData', tasks: data.tasks };
  }

  if (msg.type === 'taskAddComment') {
    const task = data.tasks.find(t => t.id === msg.task_id);
    if (task) {
      if (!task.comments) task.comments = [];
      task.comments.push({ id: data.nextCommentId++, author: msg.author || 'user', text: msg.text, created_at: nowIso() });
      task.updated_at = nowIso();
      saveTasksFile(fp, data);
    }
    return { type: 'tasksData', tasks: data.tasks };
  }

  if (msg.type === 'taskDeleteComment') {
    const task = data.tasks.find(t => t.id === msg.task_id);
    if (task && task.comments) {
      task.comments = task.comments.filter(c => c.id !== msg.comment_id);
      task.updated_at = nowIso();
      saveTasksFile(fp, data);
    }
    return { type: 'tasksData', tasks: data.tasks };
  }

  if (msg.type === 'taskEditComment') {
    const task = data.tasks.find(t => t.id === msg.task_id);
    if (task && task.comments) {
      const comment = task.comments.find(c => c.id === msg.comment_id);
      if (comment) { comment.text = msg.text; task.updated_at = nowIso(); saveTasksFile(fp, data); }
    }
    return { type: 'tasksData', tasks: data.tasks };
  }

  if (msg.type === 'taskDeleteProgress') {
    const task = data.tasks.find(t => t.id === msg.task_id);
    if (task && task.progress_updates) {
      task.progress_updates = task.progress_updates.filter(p => p.id !== msg.progress_id);
      task.updated_at = nowIso();
      saveTasksFile(fp, data);
    }
    return { type: 'tasksData', tasks: data.tasks };
  }

  if (msg.type === 'taskEditProgress') {
    const task = data.tasks.find(t => t.id === msg.task_id);
    if (task && task.progress_updates) {
      const update = task.progress_updates.find(p => p.id === msg.progress_id);
      if (update) { update.text = msg.text; task.updated_at = nowIso(); saveTasksFile(fp, data); }
    }
    return { type: 'tasksData', tasks: data.tasks };
  }

  if (msg.type === 'taskAddProgress') {
    const task = data.tasks.find(t => t.id === msg.task_id);
    if (task) {
      if (!task.progress_updates) task.progress_updates = [];
      task.progress_updates.push({ id: data.nextProgressId++, author: msg.author || 'user', text: msg.text, created_at: nowIso() });
      task.updated_at = nowIso();
      saveTasksFile(fp, data);
    }
    return { type: 'tasksData', tasks: data.tasks };
  }

  return null;
}

function handleAgentMessage(msg, repoRoot) {
  if (msg.type === 'agentsLoad') {
    return { type: 'agentsData', agents: loadMergedAgents(repoRoot) };
  }
  if (msg.type === 'agentSave') {
    const scope = msg.scope; // 'global' or 'project'
    const filePath = scope === 'global' ? globalAgentsPath() : projectAgentsPath(repoRoot);
    saveAgentsFile(filePath, msg.agents);
    return { type: 'agentsData', agents: loadMergedAgents(repoRoot) };
  }
  return null;
}

async function handleInstanceMessage(msg, repoRoot, panelId) {
  if (msg.type === 'instancesLoad') {
    const instances = await listInstances(panelId);
    return { type: 'instancesData', instances, panelId };
  }
  if (msg.type === 'instanceStart') {
    await ensureDesktop(repoRoot, panelId);
    const linked = getLinkedInstance(panelId);
    const instances = await listInstances(panelId);
    return { type: 'instancesData', instances, panelId, novncPort: linked ? linked.novncPort : null };
  }
  if (msg.type === 'instanceStop') {
    await stopInstance(msg.name);
    const instances = await listInstances(panelId);
    return { type: 'instancesData', instances, panelId };
  }
  if (msg.type === 'instanceRestart') {
    await restartInstance(msg.name, repoRoot, panelId);
    const instances = await listInstances(panelId);
    return { type: 'instancesData', instances, panelId };
  }
  if (msg.type === 'instanceStopAll') {
    const current = await listInstances(panelId);
    for (const inst of current) {
      await stopInstance(inst.name);
    }
    return { type: 'instancesData', instances: [], panelId };
  }
  if (msg.type === 'instanceRestartAll') {
    const current = await listInstances(panelId);
    for (const inst of current) {
      await restartInstance(inst.name, repoRoot, panelId);
    }
    const instances = await listInstances(panelId);
    return { type: 'instancesData', instances, panelId };
  }
  if (msg.type === 'instanceOpenVnc') {
    const port = msg.novncPort;
    if (port) {
      vscode.env.openExternal(vscode.Uri.parse(`http://localhost:${port}/vnc.html?autoconnect=true&resize=scale`));
    }
    return null;
  }
  return null;
}

function getWebviewHtml(panel, extensionUri) {
  const webviewDir = vscode.Uri.joinPath(extensionUri, 'webview');
  const styleUri = panel.webview.asWebviewUri(vscode.Uri.joinPath(webviewDir, 'style.css'));
  const scriptUri = panel.webview.asWebviewUri(vscode.Uri.joinPath(webviewDir, 'main.js'));

  const nonce = getNonce();

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${panel.webview.cspSource}; script-src 'nonce-${nonce}'; frame-src http://localhost:*;">
  <link rel="stylesheet" href="${styleUri}">
  <title>CC Manager</title>
</head>
<body>
  <div id="app">
    <div id="tab-bar">
      <button class="tab-btn active" data-tab="agent">Agent</button>
      <button class="tab-btn" data-tab="tasks">Tasks</button>
      <button class="tab-btn" data-tab="agents">Agents</button>
      <button class="tab-btn" data-tab="mcp">MCP Servers</button>
      <button class="tab-btn" data-tab="instances">Instances</button>
      <button class="tab-btn" data-tab="computer">Computer</button>
    </div>

    <div id="tab-agent">
      <div id="progress-bubble" class="progress-bubble hidden">
        <div class="progress-header">Progress</div>
        <div class="progress-body"></div>
      </div>
      <div id="messages"></div>
      <div id="suggestions"></div>
      <div id="input-area">
        <textarea id="user-input" rows="1" placeholder="Type a message or /help for commands..."></textarea>
        <button id="btn-send">Send</button>
        <button id="btn-stop">Stop</button>
      </div>
      <div id="config-bar">
      <div class="config-group">
        <label>Target</label>
        <select id="cfg-chat-target">
          <option value="controller">Controller</option>
          <option value="claude">Worker (Default)</option>
        </select>
      </div>
      <div class="config-group cfg-controller-only">
        <label>Controller CLI</label>
        <select id="cfg-controller-cli">
          <option value="codex">Codex</option>
          <option value="claude">Claude</option>
        </select>
      </div>
      <div class="config-group cfg-controller-only">
        <label>Controller</label>
        <select id="cfg-controller-model">
          <option value="">Model: default</option>
        </select>
        <select id="cfg-controller-thinking">
          <option value="">Thinking: default</option>
        </select>
      </div>
      <div class="config-group cfg-worker-only">
        <label>Worker CLI</label>
        <select id="cfg-worker-cli">
          <option value="claude">Claude</option>
          <option value="codex">Codex</option>
        </select>
      </div>
      <div class="config-group cfg-worker-only">
        <label>Worker</label>
        <select id="cfg-worker-model">
          <option value="">Model: default</option>
        </select>
        <select id="cfg-worker-thinking">
          <option value="">Thinking: default</option>
        </select>
      </div>
      <div class="config-group">
        <label>Wait</label>
        <select id="cfg-wait-delay">
          <option value="">None</option>
          <option value="1m">1 min</option>
          <option value="2m">2 min</option>
          <option value="3m">3 min</option>
          <option value="5m">5 min</option>
          <option value="10m">10 min</option>
          <option value="15m">15 min</option>
          <option value="30m">30 min</option>
          <option value="1h">1 hour</option>
          <option value="2h">2 hours</option>
          <option value="3h">3 hours</option>
          <option value="5h">5 hours</option>
          <option value="6h">6 hours</option>
          <option value="12h">12 hours</option>
          <option value="1d">1 day</option>
          <option value="2d">2 days</option>
          <option value="3d">3 days</option>
          <option value="4d">4 days</option>
          <option value="5d">5 days</option>
          <option value="6d">6 days</option>
          <option value="7d">7 days</option>
        </select>
      </div>
    </div>
    </div><!-- /tab-agent -->

    <div id="tab-tasks" class="tab-hidden">
      <div id="kanban-board" class="kanban-board"></div>
      <div id="task-detail" class="task-detail" style="display:none"></div>
    </div><!-- /tab-tasks -->

    <div id="tab-agents" class="tab-hidden">
      <div class="mcp-container">
        <div class="mcp-section">
          <div class="mcp-section-header">
            <h3>Global Agents</h3>
            <span class="mcp-section-path">~/.cc-manager/agents.json</span>
            <button class="agent-add-btn" data-scope="global">+ Add</button>
          </div>
          <div id="agent-list-global" class="mcp-list"></div>
        </div>
        <div class="mcp-section">
          <div class="mcp-section-header">
            <h3>Project Agents</h3>
            <span class="mcp-section-path">.cc-manager/agents.json</span>
            <button class="agent-add-btn" data-scope="project">+ Add</button>
          </div>
          <div id="agent-list-project" class="mcp-list"></div>
        </div>
      </div>
    </div><!-- /tab-agents -->

    <div id="tab-mcp" class="tab-hidden">
      <div class="mcp-container">
        <div class="mcp-section">
          <div class="mcp-section-header">
            <h3>Global Servers</h3>
            <span class="mcp-section-path">~/.cc-manager/mcp.json</span>
            <button class="mcp-add-btn" data-scope="global">+ Add</button>
          </div>
          <div id="mcp-list-global" class="mcp-list"></div>
        </div>
        <div class="mcp-section">
          <div class="mcp-section-header">
            <h3>Project Servers</h3>
            <span class="mcp-section-path">.cc-manager/mcp.json</span>
            <button class="mcp-add-btn" data-scope="project">+ Add</button>
          </div>
          <div id="mcp-list-project" class="mcp-list"></div>
        </div>
      </div>
    </div><!-- /tab-mcp -->

    <div id="tab-instances" class="tab-hidden">
      <div class="mcp-container">
        <div class="mcp-section">
          <div class="mcp-section-header">
            <h3>Docker Instances</h3>
            <span class="mcp-section-path">qa-desktop containers</span>
            <div style="flex:1"></div>
            <button class="instance-action-btn" data-action="start">Start for this session</button>
            <button class="instance-action-btn instance-btn-secondary" data-action="restartAll">Restart All</button>
            <button class="instance-action-btn instance-btn-secondary" data-action="stopAll">Stop All</button>
          </div>
          <div id="instance-list" class="mcp-list"></div>
        </div>
      </div>
    </div><!-- /tab-instances -->

    <div id="tab-computer" class="tab-hidden">
      <div id="computer-placeholder" class="computer-placeholder">
        <p>No desktop instance linked to this session.</p>
        <p><small>Start a remote agent or launch an instance from the Instances tab.</small></p>
      </div>
      <iframe id="computer-vnc-frame" class="computer-vnc-frame" style="display:none;" sandbox="allow-scripts allow-same-origin allow-forms allow-popups"></iframe>
    </div><!-- /tab-computer -->
  </div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
}

function getNonce() {
  let text = '';
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 32; i++) {
    text += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return text;
}

function getRepoRoot(extensionUri) {
  const folders = vscode.workspace.workspaceFolders;
  if (folders && folders.length > 0) {
    return folders[0].uri.fsPath;
  }
  // Fallback: extension lives in <project>/extension, so go up one level
  return path.dirname(extensionUri.fsPath);
}

function activate(context) {
  const openCommand = vscode.commands.registerCommand('ccManager.open', () => {
    const title = activePanels.size === 0 ? 'CC Manager' : `CC Manager (${activePanels.size + 1})`;
    const panel = vscode.window.createWebviewPanel(
      'ccManagerPanel',
      title,
      vscode.ViewColumn.One,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [
          vscode.Uri.joinPath(context.extensionUri, 'webview'),
        ],
      }
    );

    panel.iconPath = vscode.Uri.joinPath(context.extensionUri, 'resources', 'icon.svg');
    panel.webview.html = getWebviewHtml(panel, context.extensionUri);

    const renderer = new WebviewRenderer(panel);
    const repoRoot = getRepoRoot(context.extensionUri);

    // Per-panel mutable config (new panels start with defaults)
    const panelConfig = {};

    function postMessage(msg) {
      // Keep panelConfig in sync when SessionManager pushes config changes
      if (msg && msg.type === 'syncConfig' && msg.config) {
        Object.assign(panelConfig, msg.config);
      }
      try {
        panel.webview.postMessage(msg);
      } catch {
        // Panel disposed
      }
    }

    const session = new SessionManager(renderer, {
      repoRoot,
      postMessage,
      initialConfig: panelConfig,
      extensionPath: context.extensionUri.fsPath,
    });
    // Initialize MCP servers and agents from disk
    session.setMcpServers(loadMergedMcpServers(repoRoot));
    session.setAgents(loadMergedAgents(repoRoot));

    panel.webview.onDidReceiveMessage(
      async (msg) => {
        if (msg.type === 'configChanged') {
          session.applyConfig(msg.config);
          Object.assign(panelConfig, msg.config);
          return;
        }
        if (msg.type === 'setPanelTitle') {
          panel.title = msg.title;
          return;
        }
        if (msg.type === 'ready') {
          // Restore panelId from webview persisted state if available
          if (msg.panelId) session._panelId = msg.panelId;
          const mcpData = loadMergedMcpServers(repoRoot);
          const agentsData = loadMergedAgents(repoRoot);
          panel.webview.postMessage({ type: 'initConfig', config: panelConfig, mcpServers: mcpData, agents: agentsData, panelId: session.panelId });
          // Re-populate remote-desktop cache if a container is still running for this panel
          if (msg.panelId) {
            ensureDesktop(repoRoot, session.panelId).then(desktop => {
              if (desktop) {
                try { panel.webview.postMessage({ type: 'desktopReady', novncPort: desktop.novncPort }); } catch {}
              }
            }).catch(() => {});
          }
          return;
        }
        if (msg.type === 'mcpServersChanged') {
          const scope = msg.scope;
          const servers = msg.servers;
          const filePath = scope === 'global' ? globalMcpPath() : projectMcpPath(repoRoot);
          saveMcpFile(filePath, servers);
          const mcpData = loadMergedMcpServers(repoRoot);
          session.setMcpServers(mcpData);
          return;
        }
        // Task CRUD messages
        const taskReply = handleTaskMessage(msg, repoRoot);
        if (taskReply) { try { panel.webview.postMessage(taskReply); } catch {} return; }
        // Agent CRUD messages
        const agentReply = handleAgentMessage(msg, repoRoot);
        if (agentReply) {
          try { panel.webview.postMessage(agentReply); } catch {}
          session.setAgents(loadMergedAgents(repoRoot));
          return;
        }
        // Instance management messages (async)
        const instanceReply = await handleInstanceMessage(msg, repoRoot, session.panelId);
        if (instanceReply) {
          try { panel.webview.postMessage(instanceReply); } catch {}
          if (instanceReply.novncPort) {
            try { panel.webview.postMessage({ type: 'desktopReady', novncPort: instanceReply.novncPort }); } catch {}
          }
          return;
        }
        session.handleMessage(msg);
      },
      undefined,
      context.subscriptions
    );

    activePanels.add(panel);

    panel.onDidDispose(
      () => {
        activePanels.delete(panel);
        session.dispose();
      },
      null,
      context.subscriptions
    );

    renderer.banner('cc-manager interactive session');
    renderer.banner(`Repo root: ${repoRoot}`);
    renderer.banner('Type /help for commands, or type a message to start.');
  });

  context.subscriptions.push(openCommand);

  // Register serializer for panel restoration
  vscode.window.registerWebviewPanelSerializer('ccManagerPanel', {
    async deserializeWebviewPanel(panel, state) {
      panel.webview.html = getWebviewHtml(panel, context.extensionUri);

      const renderer = new WebviewRenderer(panel);
      const repoRoot = getRepoRoot(context.extensionUri);
      // Per-panel config restored from webview state (per-panel, not shared)
      const panelConfig = (state && state.config) || {};
      const savedRunId = (state && state.runId) || null;

      function postMessage(msg) {
        if (msg && msg.type === 'syncConfig' && msg.config) {
          Object.assign(panelConfig, msg.config);
        }
        try {
          panel.webview.postMessage(msg);
        } catch {}
      }

      const session = new SessionManager(renderer, {
        repoRoot,
        postMessage,
        initialConfig: panelConfig,
        extensionPath: context.extensionUri.fsPath,
      });
      session.setMcpServers(loadMergedMcpServers(repoRoot));
      session.setAgents(loadMergedAgents(repoRoot));

      panel.webview.onDidReceiveMessage(
        async (msg) => {
          if (msg.type === 'configChanged') {
            session.applyConfig(msg.config);
            Object.assign(panelConfig, msg.config);
            return;
          }
          if (msg.type === 'setPanelTitle') {
            panel.title = msg.title;
            return;
          }
          if (msg.type === 'mcpServersChanged') {
            const scope = msg.scope;
            const servers = msg.servers;
            const filePath = scope === 'global' ? globalMcpPath() : projectMcpPath(repoRoot);
            saveMcpFile(filePath, servers);
            const mcpData = loadMergedMcpServers(repoRoot);
            session.setMcpServers(mcpData);
            return;
          }
          // Task CRUD messages
          const taskReply = handleTaskMessage(msg, repoRoot);
          if (taskReply) { try { panel.webview.postMessage(taskReply); } catch {} return; }
          // Agent CRUD messages
          const agentReply = handleAgentMessage(msg, repoRoot);
          if (agentReply) {
            try { panel.webview.postMessage(agentReply); } catch {}
            session.setAgents(loadMergedAgents(repoRoot));
            return;
          }
          // Instance management messages (async)
          const instanceReply = await handleInstanceMessage(msg, repoRoot, session.panelId);
          if (instanceReply) {
            try { panel.webview.postMessage(instanceReply); } catch {}
            if (instanceReply.novncPort) {
              try { panel.webview.postMessage({ type: 'desktopReady', novncPort: instanceReply.novncPort }); } catch {}
            }
            return;
          }
          if (msg.type === 'ready') {
            // Restore panelId from webview persisted state if available
            if (msg.panelId) session._panelId = msg.panelId;
            const mcpData = loadMergedMcpServers(repoRoot);
            const agentsData = loadMergedAgents(repoRoot);
            panel.webview.postMessage({ type: 'initConfig', config: panelConfig, mcpServers: mcpData, agents: agentsData, panelId: session.panelId });
            // Re-populate remote-desktop cache if a container is still running for this panel
            if (msg.panelId) {
              ensureDesktop(repoRoot, session.panelId).then(desktop => {
                if (desktop) {
                  try { panel.webview.postMessage({ type: 'desktopReady', novncPort: desktop.novncPort }); } catch {}
                }
              }).catch(() => {});
            }
            // Reattach to saved run if the webview had one before reload
            const runId = msg.runId || savedRunId;
            if (runId) {
              const ok = await session.reattachRun(runId);
              if (ok) {
                await session.sendTranscript();
                renderer.banner(`Reattached to run ${session.getRunId()}`);
                await session.sendProgress();
                session._restoreWaitTimer();
              } else {
                renderer.banner(`Previous run ${runId} no longer exists. Starting fresh.`);
              }
            }
            return;
          }
          session.handleMessage(msg);
        },
        undefined,
        context.subscriptions
      );

      activePanels.add(panel);

      panel.onDidDispose(
        () => {
          activePanels.delete(panel);
          session.dispose();
        },
        null,
        context.subscriptions
      );
    },
  });
}

function deactivate() {}

module.exports = { activate, deactivate };
