/**
 * JSDOM-based webview testing helper.
 *
 * Loads the REAL webview HTML, CSS, and JS from the extension directory,
 * mocks acquireVsCodeApi(), and provides helpers to simulate messages
 * and assert on DOM state.
 *
 * Usage:
 *   const { createWebviewDom } = require('./webview-dom');
 *   const wv = createWebviewDom();
 *   wv.postMessage({ type: 'initConfig', ... });
 *   assert(wv.document.getElementById('init-wizard'));
 *   wv.cleanup();
 */
const { JSDOM } = require('jsdom');
const fs = require('node:fs');
const path = require('node:path');

const EXTENSION_DIR = path.resolve(__dirname, '../../extension');

/**
 * Extract the HTML body content from extension.js getWebviewHtml().
 * We read the file and extract the template literal between the backticks.
 */
function getWebviewBodyHtml() {
  const extJs = fs.readFileSync(path.join(EXTENSION_DIR, 'extension.js'), 'utf8');

  // Find the template literal in getWebviewHtml — starts after "return `" and ends at "`;"
  const startMarker = "return `<!DOCTYPE html>";
  const endMarker = "</html>`;";
  const startIdx = extJs.indexOf(startMarker);
  const endIdx = extJs.indexOf(endMarker);

  if (startIdx === -1 || endIdx === -1) {
    throw new Error('Could not find HTML template in extension.js');
  }

  let html = extJs.slice(startIdx + 'return `'.length, endIdx + '</html>'.length);

  // Replace template expressions: ${styleUri}, ${scriptUri}, ${nonce}, ${panel.webview.cspSource}
  // Strip the CSP meta tag entirely (JSDOM doesn't enforce it)
  html = html.replace(/<meta http-equiv="Content-Security-Policy"[^>]*>/, '');
  // Remove the external stylesheet link (we'll inline it)
  html = html.replace(/<link rel="stylesheet"[^>]*>/, '');
  // Remove the external script tag (we'll inline it)
  html = html.replace(/<script[^>]*src="[^"]*"[^>]*><\/script>/, '');

  return html;
}

/**
 * Create a JSDOM instance with the real webview content.
 *
 * @param {object} [options]
 * @param {object} [options.savedState] - Initial vscode.getState() value
 * @returns {{ dom, window, document, messages, postMessage, getState, messagesOfType, cleanup }}
 */
function createWebviewDom(options = {}) {
  const mainJs = fs.readFileSync(path.join(EXTENSION_DIR, 'webview', 'main.js'), 'utf8');
  const styleCss = fs.readFileSync(path.join(EXTENSION_DIR, 'webview', 'style.css'), 'utf8');
  const bodyHtml = getWebviewBodyHtml();

  // Build full HTML with inlined CSS and JS
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <style>${styleCss}</style>
</head>
${bodyHtml.slice(bodyHtml.indexOf('<body>'))}
`;

  // Mock state
  const messages = [];
  let savedState = options.savedState || null;

  const dom = new JSDOM(html, {
    url: 'https://webview.test/',
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    beforeParse(window) {
      // Mock acquireVsCodeApi — the only VSCode-specific global
      window.acquireVsCodeApi = () => ({
        postMessage: (msg) => messages.push(msg),
        getState: () => savedState,
        setState: (s) => { savedState = s; },
      });

      // Suppress console.error from debug logging in main.js
      const origError = window.console.error;
      window.console.error = (...args) => {
        const str = args.join(' ');
        if (str.includes('[DEBUG') || str.includes('_dbg')) return;
        origError.apply(window.console, args);
      };
    },
  });

  // Inject the real main.js — execute it after DOM is ready
  const scriptEl = dom.window.document.createElement('script');
  scriptEl.textContent = mainJs;
  dom.window.document.body.appendChild(scriptEl);

  return {
    dom,
    window: dom.window,
    document: dom.window.document,
    /** All postMessage calls from webview → extension host */
    messages,
    /** Get messages of a specific type */
    messagesOfType: (type) => messages.filter(m => m.type === type),
    /** Current saved state */
    getState: () => savedState,
    /** Simulate extension host → webview message */
    postMessage(msg) {
      dom.window.dispatchEvent(
        new dom.window.MessageEvent('message', { data: msg })
      );
    },
    /** Click an element by selector */
    click(selector) {
      const el = dom.window.document.querySelector(selector);
      if (!el) throw new Error(`Element not found: ${selector}`);
      el.click();
    },
    /** Check if an element is visible (not hidden by wizard-hidden or tab-hidden class) */
    isVisible(selector) {
      const el = dom.window.document.querySelector(selector);
      if (!el) return false;
      return !el.classList.contains('wizard-hidden') && !el.classList.contains('tab-hidden');
    },
    /** Get text content of an element */
    text(selector) {
      const el = dom.window.document.querySelector(selector);
      return el ? el.textContent.trim() : '';
    },
    /** Clean up JSDOM */
    cleanup() {
      dom.window.close();
    },
  };
}

/**
 * Sample initConfig message with realistic data for testing.
 */
function sampleInitConfig(overrides = {}) {
  return {
    type: 'initConfig',
    config: {},
    mcpServers: { global: {}, project: {} },
    agents: {
      system: {
        dev: { name: 'Developer', description: 'Software developer', system_prompt: 'You are a dev.', mcps: {}, cli: 'claude', enabled: true },
        QA: { name: 'QA Engineer (Computer)', description: 'QA tester', system_prompt: 'You are QA.', mcps: {}, cli: 'qa-remote-claude', enabled: true },
        'QA-Browser': { name: 'QA Engineer (Browser)', description: 'Browser QA', system_prompt: 'You are QA.', mcps: { 'chrome-devtools': { command: 'npx', args: ['mcp'] } }, cli: 'claude', enabled: true },
      },
      systemMeta: {
        dev: { hasUserOverride: false, removed: false },
        QA: { hasUserOverride: false, removed: false },
        'QA-Browser': { hasUserOverride: false, removed: false },
      },
      global: {},
      project: {},
    },
    modes: {
      system: {
        'quick-test': { name: 'Quick Test', description: 'Test one thing', category: 'test', icon: '🔍', useController: false, defaultAgent: { browser: 'QA-Browser', computer: 'QA' }, requiresTestEnv: true, setupAgent: { browser: 'setup-browser', computer: 'setup-computer' }, enabled: true },
        'quick-dev': { name: 'Quick Dev', description: 'Quick code changes', category: 'develop', icon: '💻', useController: false, defaultAgent: 'dev', requiresTestEnv: false, enabled: true },
        'auto-test': { name: 'Auto Test', description: 'Autonomous testing', category: 'test', icon: '🔄', useController: true, requiresTestEnv: true, enabled: true },
        'auto-dev': { name: 'Auto Dev', description: 'Autonomous development', category: 'develop', icon: '⚡', useController: true, requiresTestEnv: false, enabled: true },
      },
      systemMeta: {},
      global: {},
      project: {},
    },
    panelId: 'test-panel-001',
    runId: null,
    onboarding: { complete: true, data: null },
    ...overrides,
  };
}

module.exports = { createWebviewDom, sampleInitConfig };
