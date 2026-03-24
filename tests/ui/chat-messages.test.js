const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { createWebviewDom, sampleInitConfig } = require('../helpers/webview-dom');

let wv;

beforeEach(() => {
  wv = createWebviewDom({ savedState: { currentMode: 'quick-dev', runId: 'run-1' } });
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

  it('claude message renders with label', () => {
    wv.postMessage({ type: 'claude', text: 'Hi there!', label: 'Developer' });
    const msgs = wv.document.getElementById('messages');
    assert.ok(msgs.innerHTML.includes('Hi there!'), 'should contain claude message text');
    assert.ok(msgs.innerHTML.includes('Developer') || msgs.innerHTML.includes('DEVELOPER'), 'should have agent label');
  });

  it('controller message renders', () => {
    wv.postMessage({ type: 'controller', text: 'Thinking...', label: 'Controller (Codex)' });
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
    wv.postMessage({ type: 'stop', label: 'Controller (Codex)' });
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

  it('banner message renders', () => {
    wv.postMessage({ type: 'banner', text: 'Reattached to run abc' });
    const msgs = wv.document.getElementById('messages');
    assert.ok(msgs.innerHTML.includes('Reattached to run abc'));
  });
});
