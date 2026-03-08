const vscode = require('vscode');
const path = require('node:path');
const { WebviewRenderer } = require('./webview-renderer');
const { SessionManager } = require('./session-manager');

const activePanels = new Set();

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
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${panel.webview.cspSource}; script-src 'nonce-${nonce}';">
  <link rel="stylesheet" href="${styleUri}">
  <title>CC Manager</title>
</head>
<body>
  <div id="app">
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
          <option value="claude">Claude Code</option>
        </select>
      </div>
      <div class="config-group">
        <label>Controller CLI</label>
        <select id="cfg-controller-cli">
          <option value="codex">Codex</option>
          <option value="claude">Claude</option>
        </select>
      </div>
      <div class="config-group">
        <label>Controller</label>
        <select id="cfg-controller-model">
          <option value="">Model: default</option>
          <option value="gpt-5.4">GPT-5.4</option>
          <option value="gpt-5.3-codex">GPT-5.3 Codex</option>
          <option value="gpt-5.3-codex-spark">GPT-5.3 Spark</option>
          <option value="gpt-5.2-codex">GPT-5.2 Codex</option>
        </select>
        <select id="cfg-controller-thinking">
          <option value="">Thinking: default</option>
          <option value="minimal">Minimal</option>
          <option value="low">Low</option>
          <option value="medium">Medium</option>
          <option value="high">High</option>
          <option value="xhigh">Extra High</option>
        </select>
      </div>
      <div class="config-group">
        <label>Worker</label>
        <select id="cfg-worker-model">
          <option value="">Model: default</option>
          <option value="sonnet">Sonnet</option>
          <option value="opus">Opus</option>
          <option value="haiku">Haiku</option>
        </select>
        <select id="cfg-worker-thinking">
          <option value="">Thinking: default</option>
          <option value="low">Low</option>
          <option value="medium">Medium</option>
          <option value="high">High</option>
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
    });

    panel.webview.onDidReceiveMessage(
      (msg) => {
        if (msg.type === 'configChanged') {
          session.applyConfig(msg.config);
          Object.assign(panelConfig, msg.config);
          return;
        }
        if (msg.type === 'ready') {
          panel.webview.postMessage({ type: 'initConfig', config: panelConfig });
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
      });

      panel.webview.onDidReceiveMessage(
        async (msg) => {
          if (msg.type === 'configChanged') {
            session.applyConfig(msg.config);
            Object.assign(panelConfig, msg.config);
            return;
          }
          if (msg.type === 'ready') {
            panel.webview.postMessage({ type: 'initConfig', config: panelConfig });
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
