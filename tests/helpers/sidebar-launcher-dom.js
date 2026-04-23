const { JSDOM } = require('jsdom');
const fs = require('node:fs');
const path = require('node:path');

const EXTENSION_DIR = path.resolve(__dirname, '../../extension');

function getSidebarBodyHtml() {
  const { getSidebarHtml } = require(path.join(EXTENSION_DIR, 'sidebar-html'));
  let html = getSidebarHtml({ styleHref: 'style.css', scriptSrc: 'main.js' });
  html = html.replace(/<link rel="stylesheet"[^>]*>/, '');
  html = html.replace(/<script[^>]*src="[^"]*"[^>]*><\/script>/, '');
  return html;
}

function createSidebarLauncherDom(options = {}) {
  const mainJs = fs.readFileSync(path.join(EXTENSION_DIR, 'sidebar', 'main.js'), 'utf8');
  const styleCss = fs.readFileSync(path.join(EXTENSION_DIR, 'sidebar', 'style.css'), 'utf8');
  const bodyHtml = getSidebarBodyHtml();
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <style>${styleCss}</style>
</head>
${bodyHtml.slice(bodyHtml.indexOf('<body>'))}`;

  const messages = [];
  const dom = new JSDOM(html, {
    url: options.url || 'https://sidebar.test/',
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    beforeParse(window) {
      window.acquireVsCodeApi = () => ({
        postMessage: (msg) => messages.push(msg),
        getState: () => null,
        setState: () => {},
      });
    },
  });

  const scriptEl = dom.window.document.createElement('script');
  scriptEl.textContent = mainJs;
  dom.window.document.body.appendChild(scriptEl);

  return {
    dom,
    window: dom.window,
    document: dom.window.document,
    messages,
    messagesOfType: (type) => messages.filter((msg) => msg.type === type),
    postMessage(msg) {
      dom.window.dispatchEvent(new dom.window.MessageEvent('message', { data: msg }));
    },
    click(selector) {
      const el = dom.window.document.querySelector(selector);
      if (!el) throw new Error(`Element not found: ${selector}`);
      el.click();
    },
    async flush() {
      await new Promise((resolve) => dom.window.setTimeout(resolve, 0));
    },
    cleanup() {
      dom.window.close();
    },
  };
}

module.exports = { createSidebarLauncherDom };
