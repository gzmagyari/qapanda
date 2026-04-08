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
const { buildApiCatalogPayload } = require('../../src/model-catalog');

const EXTENSION_DIR = path.resolve(__dirname, '../../extension');

/**
 * Get the HTML body content from the shared webview-html.js template.
 */
function getWebviewBodyHtml() {
  const { getWebviewHtml } = require(path.join(EXTENSION_DIR, 'webview-html'));
  let html = getWebviewHtml({ styleHref: 'style.css', scriptSrc: 'main.js' });

  // Strip the stylesheet link (we'll inline it)
  html = html.replace(/<link rel="stylesheet"[^>]*>/, '');
  // Strip the external script tag (we'll inline it)
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
  const clipboardWrites = [];
  let savedState = options.savedState || null;

  const dom = new JSDOM(html, {
    url: options.url || 'https://webview.test/',
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    beforeParse(window) {
      // Skip onboarding animations in tests
      window._noOnboardAnimation = true;
      window.requestAnimationFrame = (cb) => window.setTimeout(() => cb(Date.now()), 0);
      window.cancelAnimationFrame = (id) => window.clearTimeout(id);
      if (window.HTMLCanvasElement && window.HTMLCanvasElement.prototype) {
        window.HTMLCanvasElement.prototype.getContext = () => ({
          clearRect() {},
          save() {},
          translate() {},
          rotate() {},
          fillRect() {},
          restore() {},
          globalAlpha: 1,
          fillStyle: '',
        });
      }
      // Mock acquireVsCodeApi — the only VSCode-specific global
      window.acquireVsCodeApi = () => ({
        postMessage: (msg) => messages.push(msg),
        getState: () => savedState,
        setState: (s) => { savedState = s; },
      });
      Object.defineProperty(window.navigator, 'clipboard', {
        configurable: true,
        value: {
          writeText: async (text) => {
            clipboardWrites.push(String(text));
          },
        },
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
    clipboardWrites,
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
    async flush() {
      await new Promise((resolve) => dom.window.setTimeout(resolve, 0));
    },
    confettiCount() {
      return dom.window.document.querySelectorAll('.confetti-canvas').length;
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
    apiCatalog: buildApiCatalogPayload(),
    featureFlags: { enableRemoteDesktop: true, enableClaudeCli: true },
    mcpServers: { global: {}, project: {} },
    agents: {
      system: {
        dev: { name: 'Developer', description: 'Software developer', system_prompt: 'You are a dev.', mcps: {}, cli: 'claude', enabled: true },
        reviewer: { name: 'Code Reviewer', description: 'Reviews code changes', system_prompt: 'You review code.', mcps: {}, cli: 'claude', enabled: true },
        QA: { name: 'QA Engineer (Computer)', description: 'QA tester', system_prompt: 'You are QA.', mcps: {}, cli: 'qa-remote-claude', enabled: true },
        'QA-Browser': { name: 'QA Engineer (Browser)', description: 'Browser QA', system_prompt: 'You are QA.', mcps: { 'chrome-devtools': { command: 'npx', args: ['mcp'] } }, cli: 'claude', enabled: true },
      },
      systemMeta: {
        dev: { hasUserOverride: false, removed: false },
        reviewer: { hasUserOverride: false, removed: false },
        QA: { hasUserOverride: false, removed: false },
        'QA-Browser': { hasUserOverride: false, removed: false },
      },
      global: {},
      project: {},
    },
    modes: {
      system: {
        'test': { name: 'Test', description: 'Manual testing', category: 'test', icon: '🔍', useController: false, defaultAgent: { browser: 'QA-Browser', computer: 'QA' }, requiresTestEnv: true, autoDefault: false, enabled: true },
        'dev': { name: 'Dev', description: 'Development', category: 'develop', icon: '💻', useController: false, defaultAgent: 'dev', requiresTestEnv: false, autoDefault: false, enabled: true },
        'dev-test': { name: 'Dev & Test', description: 'Develop and verify', category: 'develop', icon: '🚀', useController: false, defaultAgent: 'dev', requiresTestEnv: true, autoDefault: true, enabled: true },
        'test-fix': { name: 'Test & Fix', description: 'QA-driven testing and fixing', category: 'test', icon: '🔧', useController: false, defaultAgent: { browser: 'QA-Browser', computer: 'QA' }, requiresTestEnv: true, autoDefault: true, enabled: true },
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
