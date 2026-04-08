const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { createWebviewDom, sampleInitConfig } = require('../helpers/webview-dom');

let wv;

function multiline(count, prefix = 'line') {
  return Array.from({ length: count }, (_, index) => `${prefix}-${index + 1}`).join('\n');
}

beforeEach(() => {
  wv = createWebviewDom({ savedState: { currentMode: 'dev', runId: 'run-1' } });
  wv.postMessage(sampleInitConfig({ runId: 'run-1' }));
});
afterEach(() => { wv.cleanup(); });

describe('Chat messages', () => {
  it('user message renders', () => {
    wv.postMessage({ type: 'user', text: 'Hello world' });
    const msgs = wv.document.getElementById('messages');
    assert.ok(msgs.innerHTML.includes('Hello world'), 'should contain user message text');
    assert.ok(msgs.innerHTML.includes('USER') || msgs.innerHTML.includes('User'), 'should have user label');
  });

  it('long user message renders collapsed with an expand toggle', () => {
    wv.postMessage({ type: 'user', text: multiline(60) });

    const msgs = wv.document.getElementById('messages');
    assert.ok(msgs.textContent.includes('line-50'));
    assert.ok(!msgs.textContent.includes('line-51'));

    const toggle = wv.document.querySelector('.user-message-toggle');
    assert.ok(toggle, 'should render expand toggle for long user messages');
    assert.equal(toggle.textContent.trim(), 'Expand');
    assert.equal(toggle.getAttribute('aria-expanded'), 'false');
  });

  it('long user message expands and collapses in place', async () => {
    wv.postMessage({ type: 'user', text: multiline(60) });

    let toggle = wv.document.querySelector('.user-message-toggle');
    assert.ok(toggle, 'should render expand toggle');
    toggle.click();
    await wv.flush();

    let msgs = wv.document.getElementById('messages');
    assert.ok(msgs.textContent.includes('line-60'));
    toggle = wv.document.querySelector('.user-message-toggle');
    assert.equal(toggle.textContent.trim(), 'Collapse');
    assert.equal(toggle.getAttribute('aria-expanded'), 'true');

    toggle.click();
    await wv.flush();

    msgs = wv.document.getElementById('messages');
    assert.ok(msgs.textContent.includes('line-50'));
    assert.ok(!msgs.textContent.includes('line-51'));
    toggle = wv.document.querySelector('.user-message-toggle');
    assert.equal(toggle.textContent.trim(), 'Expand');
    assert.equal(toggle.getAttribute('aria-expanded'), 'false');
  });

  it('copy uses the full raw text for collapsed long user messages', async () => {
    wv.postMessage({ type: 'user', text: multiline(60) });

    const copyBtn = wv.document.querySelector('.entry.role-user .entry-copy');
    assert.ok(copyBtn, 'should render user copy button');
    copyBtn.click();
    await wv.flush();

    assert.equal(wv.clipboardWrites.length, 1);
    assert.ok(wv.clipboardWrites[0].includes('line-60'));
  });

  it('claude message renders with label', () => {
    wv.postMessage({ type: 'claude', text: 'Hi there!', label: 'Developer' });
    const msgs = wv.document.getElementById('messages');
    assert.ok(msgs.innerHTML.includes('Hi there!'), 'should contain claude message text');
    assert.ok(msgs.innerHTML.includes('Developer') || msgs.innerHTML.includes('DEVELOPER'), 'should have agent label');
  });

  it('controller message renders', () => {
    wv.postMessage({ type: 'controller', text: 'Thinking...', label: 'Orchestrator (Codex)' });
    const msgs = wv.document.getElementById('messages');
    assert.ok(msgs.innerHTML.includes('Thinking...'), 'should contain controller text');
  });

  it('error message renders with error styling', () => {
    wv.postMessage({ type: 'error', text: 'Something went wrong' });
    const msgs = wv.document.getElementById('messages');
    assert.ok(msgs.innerHTML.includes('Something went wrong'));
    assert.ok(msgs.innerHTML.includes('role-error'), 'should have error class');
  });

  it('stop message renders', () => {
    wv.postMessage({ type: 'stop', label: 'Orchestrator (Codex)' });
    const msgs = wv.document.getElementById('messages');
    assert.ok(msgs.innerHTML.includes('STOP') || msgs.innerHTML.includes('stop') || msgs.innerHTML.includes('●'), 'should show stop indicator');
  });

  it('HTML entities in messages are escaped', () => {
    wv.postMessage({ type: 'user', text: '<script>alert("xss")</script>' });
    const msgs = wv.document.getElementById('messages');
    assert.ok(!msgs.innerHTML.includes('<script>alert'), 'should not contain unescaped script tag');
    assert.ok(msgs.innerHTML.includes('&lt;script&gt;') || msgs.innerHTML.includes('&lt;script'), 'should contain escaped tag');
  });

  it('transcriptHistory renders multiple messages', () => {
    wv.postMessage({
      type: 'transcriptHistory',
      messages: [
        { type: 'user', text: 'Fix the bug' },
        { type: 'claude', text: 'Fixed it!', label: 'Developer' },
        { type: 'user', text: 'Thanks' },
      ],
    });
    const msgs = wv.document.getElementById('messages');
    assert.ok(msgs.innerHTML.includes('Fix the bug'));
    assert.ok(msgs.innerHTML.includes('Fixed it!'));
    assert.ok(msgs.innerHTML.includes('Thanks'));
  });

  it('transcriptHistory collapses long replayed user messages', () => {
    wv.postMessage({
      type: 'transcriptHistory',
      messages: [
        { type: 'user', text: multiline(60) },
        { type: 'claude', text: 'Acknowledged', label: 'Developer' },
      ],
    });

    const msgs = wv.document.getElementById('messages');
    assert.ok(msgs.textContent.includes('line-50'));
    assert.ok(!msgs.textContent.includes('line-51'));
    assert.ok(msgs.textContent.includes('Acknowledged'));
    assert.ok(wv.document.querySelector('.user-message-toggle'));
  });

  it('does not collapse long non-user messages', () => {
    wv.postMessage({ type: 'claude', text: multiline(60), label: 'Developer' });

    const msgs = wv.document.getElementById('messages');
    assert.ok(msgs.textContent.includes('line-60'));
    assert.equal(wv.document.querySelector('.user-message-toggle'), null);
  });

  it('transcriptHistory keeps screenshots in order within the active section', () => {
    wv.postMessage({
      type: 'transcriptHistory',
      messages: [
        { type: 'claude', text: 'First observation', label: 'QA Engineer (Browser)' },
        { type: 'chatScreenshot', data: 'data:image/png;base64,ZmFrZQ==', alt: 'Tool screenshot' },
        { type: 'claude', text: 'Second observation', label: 'QA Engineer (Browser)' },
      ],
    });

    const section = wv.document.querySelector('.section');
    assert.ok(section, 'should render a section for the worker');

    const img = section.querySelector('.chat-screenshot');
    assert.ok(img, 'should render screenshot inside the active section');

    const entries = section.querySelectorAll('.entry');
    assert.equal(entries.length, 2);
    assert.ok(entries[0].textContent.includes('First observation'));
    assert.ok(entries[1].textContent.includes('Second observation'));

    const childClasses = Array.from(section.children).map((node) => node.className || node.tagName);
    const firstEntryIndex = childClasses.findIndex((name) => String(name).includes('entry'));
    const imageIndex = childClasses.findIndex((name) => String(name).includes('chat-screenshot'));
    const secondEntryIndex = childClasses.findIndex((name, index) => index > firstEntryIndex && String(name).includes('entry'));
    assert.ok(firstEntryIndex >= 0 && imageIndex > firstEntryIndex, 'screenshot should follow the first message');
    assert.ok(secondEntryIndex > imageIndex, 'second message should remain after the screenshot');
  });

  it('banner message renders', () => {
    wv.postMessage({ type: 'banner', text: 'Reattached to run abc' });
    const msgs = wv.document.getElementById('messages');
    assert.ok(msgs.innerHTML.includes('Reattached to run abc'));
  });

  it('keeps only the latest visible history tail in the live webview', async () => {
    for (let index = 0; index < 80; index += 1) {
      wv.postMessage({ type: 'user', text: `entry-${index} ` + 'x'.repeat(900) });
    }
    await wv.flush();

    const msgs = wv.document.getElementById('messages');
    assert.ok(msgs.textContent.includes('Showing only the latest chat tail for this run.'));
    assert.ok(msgs.textContent.includes('entry-79'));
    assert.ok(!msgs.textContent.includes('entry-0 '));
  });

  it('live visible history trimming sizes long user messages from the collapsed preview', async () => {
    const longUserText = Array.from({ length: 60 }, (_, index) => `block-${index + 1} ` + 'y'.repeat(340)).join('\n');
    wv.postMessage({ type: 'user', text: longUserText });

    for (let index = 0; index < 32; index += 1) {
      wv.postMessage({ type: 'user', text: `entry-${index} ` + 'x'.repeat(940) });
    }
    await wv.flush();

    const msgs = wv.document.getElementById('messages');
    assert.ok(!msgs.textContent.includes('Showing only the latest chat tail for this run.'));
    assert.ok(msgs.textContent.includes('entry-0'));
  });
});
