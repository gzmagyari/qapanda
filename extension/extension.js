const vscode = require('vscode');
const path = require('node:path');
const { WebviewRenderer } = require('./webview-renderer');
const { SessionManager } = require('./session-manager');

let panelCount = 0;

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
    <div id="messages"></div>
    <div id="input-area">
      <textarea id="user-input" rows="1" placeholder="Type a message or /help for commands..."></textarea>
      <button id="btn-send">Send</button>
      <button id="btn-stop">Stop</button>
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
    panelCount++;
    const panel = vscode.window.createWebviewPanel(
      'ccManagerPanel',
      `CC Manager${panelCount > 1 ? ` (${panelCount})` : ''}`,
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

    const session = new SessionManager(renderer, {
      repoRoot,
      postMessage: (msg) => {
        try {
          panel.webview.postMessage(msg);
        } catch {
          // Panel disposed
        }
      },
    });

    panel.webview.onDidReceiveMessage(
      (msg) => session.handleMessage(msg),
      undefined,
      context.subscriptions
    );

    panel.onDidDispose(
      () => {
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
    async deserializeWebviewPanel(panel, _state) {
      panel.webview.html = getWebviewHtml(panel, context.extensionUri);

      const renderer = new WebviewRenderer(panel);
      const repoRoot = getRepoRoot(context.extensionUri);

      const session = new SessionManager(renderer, {
        repoRoot,
        postMessage: (msg) => {
          try {
            panel.webview.postMessage(msg);
          } catch {}
        },
      });

      panel.webview.onDidReceiveMessage(
        (msg) => session.handleMessage(msg),
        undefined,
        context.subscriptions
      );

      panel.onDidDispose(
        () => session.dispose(),
        null,
        context.subscriptions
      );

      renderer.banner('cc-manager session restored');
      renderer.banner(`Repo root: ${repoRoot}`);
      renderer.banner('Type /help for commands, or type a message to start.');
    },
  });
}

function deactivate() {}

module.exports = { activate, deactivate };
