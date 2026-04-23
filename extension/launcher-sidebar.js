const vscode = require('vscode');
const { getSidebarHtml } = require('./sidebar-html');

class LauncherSidebarProvider {
  constructor(context, options = {}) {
    this._context = context;
    this._options = options;
    this._view = null;
  }

  resolveWebviewView(webviewView) {
    this._view = webviewView;
    const sidebarDir = vscode.Uri.joinPath(this._context.extensionUri, 'sidebar');
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [sidebarDir],
    };
    webviewView.webview.html = getSidebarHtml({
      styleHref: webviewView.webview.asWebviewUri(vscode.Uri.joinPath(sidebarDir, 'style.css')).toString(),
      scriptSrc: webviewView.webview.asWebviewUri(vscode.Uri.joinPath(sidebarDir, 'main.js')).toString(),
      nonce: this._options.getNonce ? this._options.getNonce() : '',
      cspSource: webviewView.webview.cspSource,
    });

    webviewView.webview.onDidReceiveMessage(async (msg) => {
      await this._handleMessage(msg);
    }, null, this._context.subscriptions);

    if (typeof webviewView.onDidChangeVisibility === 'function') {
      webviewView.onDidChangeVisibility(() => {
        if (webviewView.visible) {
          void this.refresh();
        }
      }, null, this._context.subscriptions);
    }
  }

  async _handleMessage(msg) {
    if (!msg || typeof msg !== 'object') return;
    if (msg.type === 'launcherReady' || msg.type === 'launcherRefresh') {
      await this.refresh();
      return;
    }
    if (msg.type === 'launcherNewSession') {
      if (typeof this._options.openNewSession === 'function') {
        await this._options.openNewSession();
      }
      return;
    }
    if (msg.type === 'launcherResumeLatest') {
      if (typeof this._options.resumeLatest === 'function') {
        await this._options.resumeLatest();
      }
      return;
    }
    if (msg.type === 'launcherOpenRun') {
      if (typeof this._options.openRun === 'function') {
        await this._options.openRun(msg.runId || '');
      }
      return;
    }
    if (msg.type === 'launcherOpenWorkspace') {
      if (typeof this._options.openWorkspace === 'function') {
        await this._options.openWorkspace();
      }
    }
  }

  async refresh() {
    if (!this._view) return;
    const data = typeof this._options.getData === 'function'
      ? await this._options.getData()
      : { runs: [], namedWorkspacesEnabled: false };
    try {
      this._view.webview.postMessage({
        type: 'launcherData',
        runs: Array.isArray(data.runs) ? data.runs : [],
        namedWorkspacesEnabled: !!data.namedWorkspacesEnabled,
      });
    } catch {}
  }
}

module.exports = { LauncherSidebarProvider };
