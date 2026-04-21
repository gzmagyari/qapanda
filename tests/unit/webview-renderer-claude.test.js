const test = require('node:test');
const assert = require('node:assert/strict');
const { WebviewRenderer } = require('../../extension/webview-renderer');

function createRenderer() {
  const output = [];
  const panel = {
    webview: {
      postMessage(message) {
        output.push(message);
        return true;
      },
    },
  };
  const renderer = new WebviewRenderer(panel);
  renderer.workerLabel = 'ClaudeDev';
  return { renderer, output };
}

test('Claude browser tool results emit browser cards and forward completion payloads', async () => {
  const { renderer, output } = createRenderer();
  const completions = [];
  renderer.handleMcpToolCompletion = async (payload) => {
    completions.push(payload);
  };

  renderer.claudeEvent({
    type: 'stream_event',
    event: {
      type: 'content_block_start',
      index: 0,
      content_block: {
        type: 'tool_use',
        id: 'tool-1',
        name: 'mcp__chrome-devtools__take_screenshot',
        input: {},
      },
    },
  });
  renderer.claudeEvent({
    type: 'stream_event',
    event: {
      type: 'content_block_stop',
      index: 0,
    },
  });
  renderer.claudeEvent({
    type: 'user',
    message: {
      role: 'user',
      content: [{
        type: 'tool_result',
        tool_use_id: 'tool-1',
        content: [
          { type: 'text', text: 'Captured the page.' },
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'ZmFrZQ==' } },
        ],
      }],
    },
    tool_use_result: [
      { type: 'text', text: 'Captured the page.' },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'ZmFrZQ==' } },
    ],
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.ok(output.some((msg) => msg.type === 'mcpCardStart' && msg.isChromeDevtools), 'should emit a Chrome start card');
  assert.ok(output.some((msg) => msg.type === 'mcpCardComplete' && msg.isChromeDevtools), 'should emit a Chrome completion card');
  assert.equal(completions.length, 1);
  assert.equal(completions[0].toolName, 'mcp__chrome-devtools__take_screenshot');
  assert.deepEqual(completions[0].output, [
    { type: 'text', text: 'Captured the page.' },
    { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'ZmFrZQ==' } },
  ]);
});
