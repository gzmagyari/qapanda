/**
 * Shared HTML template for QA Panda webview.
 * Used by both the VSCode extension (with CSP/nonce) and the standalone web server (without).
 *
 * @param {object} opts
 * @param {string} opts.styleHref  - URL/path to style.css
 * @param {string} opts.scriptSrc  - URL/path to main.js
 * @param {string} [opts.nonce]    - CSP nonce (VSCode only)
 * @param {string} [opts.cspSource] - VSCode CSP source string
 */
function getWebviewHtml({ styleHref, scriptSrc, nonce, cspSource }) {
  const cspMeta = nonce
    ? `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${cspSource}; script-src 'nonce-${nonce}'; frame-src http://localhost:*; img-src data:;">`
    : '';
  const scriptAttr = nonce ? ` nonce="${nonce}"` : '';

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  ${cspMeta}
  <link rel="stylesheet" href="${styleHref}">
  <title>QA Panda</title>
</head>
<body>
  <div id="app">
    <div id="tab-bar">
      <button class="tab-btn active" data-tab="agent">Agent</button>
      <button class="tab-btn" data-tab="tasks">Issues</button>
      <button class="tab-btn" data-tab="tests">Tests</button>
      <button class="tab-btn" data-tab="appinfo">App Info</button>
      <button class="tab-btn" data-tab="memory">Memory</button>
      <button class="tab-btn" data-tab="agents">Agents</button>
      <button class="tab-btn" data-tab="mcp">MCP Servers</button>
      <button class="tab-btn" data-tab="instances">Instances</button>
      <button class="tab-btn" data-tab="computer">Computer</button>
      <button class="tab-btn" data-tab="browser">Browser</button>
      <button class="tab-btn" data-tab="settings">Settings</button>
    </div>

    <div id="confirm-modal" style="display:none;">
      <div class="confirm-modal-backdrop"></div>
      <div class="confirm-modal-box">
        <p id="confirm-modal-text"></p>
        <div class="confirm-modal-buttons">
          <button id="confirm-modal-yes">Yes, continue</button>
          <button id="confirm-modal-no">Cancel</button>
        </div>
      </div>
    </div>

    <div id="init-wizard" class="wizard-hidden">
      <!-- Onboarding steps (shown on first run only) -->
      <div id="wizard-step-onboard" class="wizard-step wizard-hidden">
        <div class="welcome-icon">&#x1F43C;</div>
        <h2>QA Panda</h2>
        <p class="wizard-subtitle">Let's check your environment and preferences.</p>
        <div id="onboard-status" class="onboard-status"></div>
        <div id="onboard-cli-preference" class="wizard-cards wizard-hidden"></div>
        <div class="wizard-nav">
          <button class="wizard-skip" id="onboard-skip">Skip Setup</button>
          <button class="wizard-secondary" id="onboard-recheck">Re-check</button>
          <button class="wizard-next" id="onboard-next" disabled>Continue</button>
        </div>
      </div>

      <div id="wizard-step-onboard-summary" class="wizard-step wizard-hidden">
        <h2>Setup Complete</h2>
        <div id="onboard-summary" class="onboard-status"></div>
        <div class="wizard-nav">
          <button class="wizard-back" id="onboard-summary-back">Back</button>
          <button class="wizard-next" id="onboard-complete">Get Started</button>
        </div>
      </div>

    </div>

    <div id="cloud-entry-screen" class="cloud-entry-screen" aria-live="polite">
      <div class="cloud-entry-card">
        <div class="cloud-entry-eyebrow">Optional Sign-In</div>
        <h2>Use QA Panda with or without an account</h2>
        <p class="cloud-entry-copy">
          Sign in to enable hosted sync, shared issues and tests, and cloud notifications for this repository. You can also continue locally as a guest exactly like today.
        </p>
        <div class="cloud-entry-actions">
          <button class="mcp-btn mcp-btn-primary" id="cloud-entry-login" type="button">Sign In</button>
          <button class="mcp-btn" id="cloud-entry-guest" type="button">Continue as Guest</button>
        </div>
        <div class="cloud-entry-footnote">
          Local files in <code>.qpanda/</code> still work without a hosted account.
        </div>
      </div>
    </div>

    <div id="tab-agent">
      <div id="progress-bubble" class="progress-bubble hidden">
        <div class="progress-header">Progress</div>
        <div class="progress-body"></div>
      </div>
      <div id="messages"></div>
      <div id="suggestions"></div>
      <div id="input-row">
        <div id="panda-buddy" class="panda-buddy panda-buddy--idle" title="Click me!"></div>
        <div id="input-box">
          <textarea id="user-input" rows="1" placeholder="Type a message or /help for commands..."></textarea>
          <div id="input-toolbar">
          <div id="input-toolbar-left">
            <span class="toolbar-label">TARGET</span>
            <select id="cfg-chat-target">
              <option value="controller">Orchestrator</option>
              <option value="agent-QA-Browser">QA Browser</option>
            </select>
          </div>
          <div id="input-toolbar-center">
            <span id="browser-status" class="status-indicator" style="display:none;" title="Headless Chrome status">
              <span class="status-dot"></span>
              <span class="status-label">Browser</span>
            </span>
          </div>
          <div id="input-toolbar-right">
            <button id="btn-send">Send</button>
            <button id="btn-continue" title="Send to controller with optional guidance">Continue ▶</button>
            <div id="review-split" class="split-action" style="display:none;">
              <button id="btn-review" title="Review current git changes">Review</button>
              <button id="btn-review-menu" class="split-action-toggle" title="Review options" aria-haspopup="true" aria-expanded="false">▼</button>
              <div id="review-menu" class="split-action-menu" style="display:none;">
                <button type="button" class="split-action-item" data-scope="unstaged">Review unstaged</button>
                <button type="button" class="split-action-item" data-scope="staged">Review staged</button>
                <button type="button" class="split-action-item" data-scope="both">Review both</button>
              </div>
            </div>
            <button id="btn-orchestrate" title="Full controller orchestration">Orchestrate ⚡</button>
            <button id="btn-stop">Stop ■</button>
            <div id="loop-objective-wrap" class="loop-objective-wrap" title="Optional objective for Continue loop mode">
              <span class="loop-objective-label">Loop Objective</span>
              <input type="text" id="loop-objective" class="loop-objective-input" placeholder="Optional stop goal for Continue loop" />
            </div>
            <div class="toggle-switch" title="Auto-continue loop">
              <input type="checkbox" id="loop-toggle" />
              <label for="loop-toggle"><span class="toggle-slider"></span></label>
            </div>
          </div>
        </div>
      </div>
      </div><!-- /input-row -->
      <div id="config-bar">
      <div class="config-group cfg-controller-only">
        <label>Orchestrator CLI</label>
        <select id="cfg-controller-cli">
          <option value="codex">Codex</option>
          <option value="claude">Claude</option>
          <option value="api">API (BYOK)</option>
        </select>
      </div>
      <div class="config-group cfg-controller-only cfg-codex-only">
        <label>Codex Mode</label>
        <select id="cfg-codex-mode">
          <option value="app-server">App Server (persistent)</option>
          <option value="cli">CLI (per turn)</option>
        </select>
      </div>
      <div class="config-group cfg-controller-only">
        <label>Orchestrator</label>
        <select id="cfg-controller-model">
          <option value="">Model: default</option>
        </select>
        <input type="text" id="cfg-controller-custom-model" class="config-input cfg-custom-model" placeholder="model name" />
        <select id="cfg-controller-thinking">
          <option value="">Thinking: default</option>
        </select>
      </div>
      <div class="config-group cfg-worker-only">
        <label>Default Worker CLI</label>
        <select id="cfg-worker-cli">
          <option value="codex">Codex</option>
          <option value="claude">Claude</option>
          <option value="api">API (BYOK)</option>
        </select>
      </div>
      <div class="config-group cfg-worker-only">
        <label>Default Worker</label>
        <select id="cfg-worker-model">
          <option value="">Model: default</option>
        </select>
        <input type="text" id="cfg-worker-custom-model" class="config-input cfg-custom-model" placeholder="model name" />
        <select id="cfg-worker-thinking">
          <option value="">Thinking: default</option>
        </select>
      </div>
      <div class="config-group cfg-api-only">
        <label>Provider</label>
        <select id="cfg-api-provider">
          <option value="openrouter">OpenRouter</option>
          <option value="openai">OpenAI</option>
          <option value="anthropic">Anthropic</option>
          <option value="gemini">Google Gemini</option>
          <option value="custom">Custom</option>
        </select>
      </div>
      <div class="config-group cfg-api-only">
        <label>Base URL</label>
        <input type="text" id="cfg-api-base-url" class="config-input" placeholder="https://example.com/v1" />
      </div>
      <div class="config-group cfg-api-only" id="cfg-api-key-warning-container">
        <span class="api-key-warning" id="cfg-api-key-warning"></span>
      </div>
      <div class="config-group cfg-controller-only">
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

    <div id="tab-tests" class="tab-hidden">
      <div id="test-board" class="test-board"></div>
      <div id="test-detail" class="test-detail"></div>
    </div><!-- /tab-tests -->

    <div id="tab-appinfo" class="tab-hidden">
      <div class="project-doc-panel">
        <div class="project-doc-header">
          <div>
            <h3>Project App Info</h3>
            <span class="project-doc-path">.qpanda/APPINFO.md</span>
          </div>
          <label class="project-doc-toggle">
            <input type="checkbox" id="app-info-enabled" checked />
            Inject into agent prompts
          </label>
        </div>
        <p class="project-doc-help">
          App Info is for user-provided facts about the app, such as URLs, credentials, environments, and other repo-local information you want every agent to know.
        </p>
        <textarea id="app-info-text" class="project-doc-textarea" rows="24" spellcheck="false" placeholder="App URL, credentials, API keys, environments, notes, and other repo-local information."></textarea>
        <div class="project-doc-actions">
          <button class="mcp-btn mcp-btn-primary" id="app-info-save">Save App Info</button>
          <span class="project-doc-status" id="app-info-status"></span>
        </div>
      </div>
    </div><!-- /tab-appinfo -->

    <div id="tab-memory" class="tab-hidden">
      <div class="project-doc-panel">
        <div class="project-doc-header">
          <div>
            <h3>Project Memory</h3>
            <span class="project-doc-path">.qpanda/MEMORY.md</span>
          </div>
          <label class="project-doc-toggle">
            <input type="checkbox" id="memory-enabled" checked />
            Inject prompts + enable memory MCP
          </label>
        </div>
        <p class="project-doc-help">
          Memory is automatically updated by agents as they learn how the app works and how to use or test it effectively. That learned context is reused in later sessions, and you can edit it manually too.
        </p>
        <textarea id="memory-text" class="project-doc-textarea" rows="24" spellcheck="false" placeholder="Agent-maintained project memory that can also be edited manually."></textarea>
        <div class="project-doc-actions">
          <button class="mcp-btn mcp-btn-primary" id="memory-save">Save Memory</button>
          <span class="project-doc-status" id="memory-status"></span>
        </div>
      </div>
    </div><!-- /tab-memory -->

    <div id="tab-agents" class="tab-hidden">
      <div class="mcp-container">
        <div class="mcp-section">
          <div class="mcp-section-header">
            <h3>System Agents</h3>
            <span class="mcp-section-path">Built-in agents shipped with the extension</span>
          </div>
          <div id="agent-list-system" class="mcp-list"></div>
        </div>
        <div class="mcp-section">
          <div class="mcp-section-header">
            <h3>Global Agents</h3>
            <span class="mcp-section-path">~/.qpanda/agents.json</span>
            <button class="agent-add-btn" data-scope="global">+ Add</button>
          </div>
          <div id="agent-list-global" class="mcp-list"></div>
        </div>
        <div class="mcp-section">
          <div class="mcp-section-header">
            <h3>Project Agents</h3>
            <span class="mcp-section-path">.qpanda/agents.json</span>
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
            <span class="mcp-section-path">~/.qpanda/mcp.json</span>
            <button class="mcp-add-btn" data-scope="global">+ Add</button>
          </div>
          <div id="mcp-list-global" class="mcp-list"></div>
        </div>
        <div class="mcp-section">
          <div class="mcp-section-header">
            <h3>Project Servers</h3>
            <span class="mcp-section-path">.qpanda/mcp.json</span>
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
            <label class="instance-snapshot-toggle"><input type="checkbox" id="use-snapshot-checkbox" checked> Use snapshot</label>
            <button class="instance-action-btn" data-action="start">Start for this session</button>
            <button class="instance-action-btn instance-btn-secondary" data-action="restartAll">Restart All</button>
            <button class="instance-action-btn instance-btn-secondary" data-action="stopAll">Stop All</button>
          </div>
          <div id="snapshot-info" style="display:flex;align-items:center;gap:8px;padding:4px 8px;min-height:24px;"></div>
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
    <div id="tab-browser" class="tab-hidden">
      <div id="browser-nav" class="browser-nav" style="display:none;">
        <button id="browser-back" class="browser-nav-btn" title="Back">\u2190</button>
        <button id="browser-forward" class="browser-nav-btn" title="Forward">\u2192</button>
        <button id="browser-reload" class="browser-nav-btn" title="Reload">\u21BB</button>
        <input id="browser-url" class="browser-url-input" type="text" placeholder="Enter URL..." spellcheck="false" />
        <button id="browser-go" class="browser-nav-btn" title="Go">Go</button>
      </div>
      <div id="browser-placeholder" class="computer-placeholder">
        <p>No Chrome instance linked to this session.</p>
        <p><small>Click this tab to start a headless Chrome instance.</small></p>
      </div>
      <img id="browser-chrome-frame" class="browser-chrome-frame" tabindex="0" style="display:none;" alt="Chrome Screencast" />
    </div><!-- /tab-browser -->

    <div id="tab-settings" class="tab-hidden">
      <div class="mcp-container">
        <div class="mcp-section" id="cloud-account-section">
          <div class="mcp-section-header">
            <h3>QA Panda Cloud</h3>
            <span class="mcp-section-path">Hosted account state for this VS Code extension. Session is stored in VS Code Secret Storage.</span>
          </div>
          <div class="settings-list">
            <div class="settings-item settings-item-stack">
              <div class="settings-item-info">
                <div class="settings-item-name" id="cloud-account-state">Signed out</div>
                <div class="settings-item-desc" id="cloud-account-desc">Sign in to QA Panda Cloud to use hosted sessions from the extension.</div>
              </div>
              <div class="cloud-account-meta" id="cloud-account-meta"></div>
            </div>
            <div class="settings-item settings-item-stack">
              <div class="settings-item-info">
                <div class="settings-item-name">Hosted Workspace</div>
                <div class="settings-item-desc" id="cloud-account-workspace">No hosted workspace is currently linked.</div>
              </div>
              <div class="cloud-account-links">
                <button class="mcp-btn mcp-btn-primary" id="cloud-account-login">Sign In</button>
                <button class="mcp-btn" id="cloud-account-refresh">Refresh</button>
                <button class="mcp-btn" id="cloud-account-open-app">Open App</button>
                <button class="mcp-btn" id="cloud-account-open-notifications">Notifications</button>
                <button class="mcp-btn" id="cloud-account-logout">Sign Out</button>
              </div>
            </div>
            <div class="settings-item settings-item-stack">
              <div class="settings-item-info">
                <div class="settings-item-name">Repository Sync</div>
                <div class="settings-item-desc" id="cloud-sync-state">Sync state will appear here after the extension loads cloud status.</div>
              </div>
              <div class="cloud-account-meta" id="cloud-sync-meta"></div>
            </div>
            <div class="settings-item settings-item-stack">
              <div class="settings-item-info">
                <div class="settings-item-name">Sync Conflicts</div>
                <div class="settings-item-desc" id="cloud-conflict-state">Per-object sync conflicts will appear here when local and cloud changes disagree.</div>
              </div>
              <div class="cloud-conflict-actions">
                <button class="mcp-btn" id="cloud-conflicts-refresh">Refresh Conflicts</button>
              </div>
            </div>
            <div class="cloud-conflict-list" id="cloud-conflict-list"></div>
            <div class="settings-item settings-item-stack">
              <div class="settings-item-info">
                <div class="settings-item-name">Notifications</div>
                <div class="settings-item-desc" id="cloud-notification-state">Unread hosted notifications will appear here after the extension loads cloud status.</div>
              </div>
              <div class="cloud-account-meta" id="cloud-notification-meta"></div>
            </div>
            <div class="settings-item settings-item-stack">
              <div class="settings-item-info">
                <div class="settings-item-name">Session Details</div>
                <div class="settings-item-desc" id="cloud-account-session">Auth state will appear here after the extension loads cloud status.</div>
              </div>
              <div class="cloud-account-status" id="cloud-account-status"></div>
            </div>
          </div>
        </div>
        <div class="mcp-section">
          <div class="mcp-section-header">
            <h3>API Keys</h3>
            <span class="mcp-section-path">For direct LLM access (API mode). Stored locally, only sent to the selected provider.</span>
          </div>
          <div class="settings-list">
            <div class="settings-item">
              <div class="settings-item-info"><div class="settings-item-name">OpenAI</div><div class="settings-item-desc">For GPT-4.1, GPT-5, o-series, and current direct chat models</div></div>
              <input type="password" class="settings-api-key-input" id="api-key-openai" placeholder="sk-proj-..." data-provider="openai" />
            </div>
            <div class="settings-item">
              <div class="settings-item-info"><div class="settings-item-name">Anthropic</div><div class="settings-item-desc">For Claude Sonnet, Opus, Haiku models</div></div>
              <input type="password" class="settings-api-key-input" id="api-key-anthropic" placeholder="sk-ant-..." data-provider="anthropic" />
            </div>
            <div class="settings-item">
              <div class="settings-item-info"><div class="settings-item-name">OpenRouter</div><div class="settings-item-desc">Access curated OpenAI, Anthropic, Gemini, Grok, Kimi, Qwen, DeepSeek, MiniMax, and Mistral models</div></div>
              <input type="password" class="settings-api-key-input" id="api-key-openrouter" placeholder="sk-or-..." data-provider="openrouter" />
            </div>
            <div class="settings-item">
              <div class="settings-item-info"><div class="settings-item-name">Google Gemini</div><div class="settings-item-desc">For Gemini 2.5 and 3.x Pro/Flash models</div></div>
              <input type="password" class="settings-api-key-input" id="api-key-gemini" placeholder="AI..." data-provider="gemini" />
            </div>
            <div class="settings-item">
              <div class="settings-item-info"><div class="settings-item-name">Custom</div><div class="settings-item-desc">For any OpenAI-compatible endpoint</div></div>
              <input type="password" class="settings-api-key-input" id="api-key-custom" placeholder="API key" data-provider="custom" />
            </div>
          </div>
        </div>
        <div class="mcp-section">
          <div class="mcp-section-header">
            <h3>Developer Settings</h3>
          </div>
          <div class="settings-list">
            <div class="settings-item">
              <div class="settings-item-info">
                <div class="settings-item-name">Self-Testing Mode</div>
                <div class="settings-item-desc">Enable self-testing prompts so agents can test the QA Panda UI itself via the web app (http://localhost:3000). Start with <code>npm run web</code>.</div>
              </div>
              <input type="checkbox" id="setting-self-testing" class="settings-checkbox" />
            </div>
          </div>
        </div>
        <div class="mcp-section settings-prompts-hidden" id="settings-prompts-section">
          <div class="settings-expander" id="settings-prompts-expander">Self-Testing Prompts</div>
          <span class="mcp-section-path settings-expander-desc">Injected into agent system prompts when self-testing is enabled</span>
          <div class="settings-expander-content" id="settings-prompts-content">
            <div class="settings-prompt-group">
              <label class="settings-prompt-label">QA-Browser Agent</label>
              <span class="settings-prompt-desc">Detailed testing instructions for the QA-Browser agent</span>
              <textarea id="setting-prompt-qa-browser" class="settings-prompt-textarea" rows="16" spellcheck="false"></textarea>
            </div>
            <div class="settings-prompt-group">
              <label class="settings-prompt-label">Controller (Orchestrate / Continue)</label>
              <span class="settings-prompt-desc">Short instructions for the controller that delegates to agents</span>
              <textarea id="setting-prompt-controller" class="settings-prompt-textarea" rows="8" spellcheck="false"></textarea>
            </div>
            <div class="settings-prompt-group">
              <label class="settings-prompt-label">Other Agents (Developer, QA, etc.)</label>
              <span class="settings-prompt-desc">Brief awareness prompt for all other agents</span>
              <textarea id="setting-prompt-agent" class="settings-prompt-textarea" rows="4" spellcheck="false"></textarea>
            </div>
            <div class="settings-prompt-actions">
              <button class="mcp-btn" id="settings-prompts-reset">Reset to Defaults</button>
              <button class="mcp-btn mcp-btn-primary" id="settings-prompts-save">Save Prompts</button>
            </div>
          </div>
        </div>
      </div>
    </div><!-- /tab-settings -->

    <div id="fatal-recovery" class="fatal-recovery" aria-live="assertive">
      <div class="fatal-recovery-card">
        <h2>QA Panda hit a webview error</h2>
        <p>The panel can usually recover by reloading. Your run data is still stored on disk.</p>
        <pre id="fatal-recovery-detail" class="fatal-recovery-detail"></pre>
        <div class="fatal-recovery-actions">
          <button id="fatal-recovery-reload" class="fatal-recovery-btn" type="button">Reload QA Panda</button>
        </div>
      </div>
    </div>
  </div>
  <script${scriptAttr} src="${scriptSrc}"></script>
</body>
</html>`;
}

module.exports = { getWebviewHtml };
