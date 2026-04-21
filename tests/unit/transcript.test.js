const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  buildDisplayMessageTail,
  buildTranscriptDisplayTail,
  buildMergedRunView,
  buildSessionReplay,
  buildTranscriptDisplayMessages,
  countDisplayMessageChars,
  createTranscriptRecord,
  providerMessagesForToolResult,
  readTranscriptEntries,
  readTranscriptTailEntries,
  TRANSCRIPT_TAIL_TRUNCATION_BANNER,
  visibleTextForDisplayMessage,
} = require('../../src/transcript');

function manifestStub() {
  return {
    controller: { cli: 'codex' },
    worker: { cli: 'api' },
    agents: {
      dev: { name: 'Developer', cli: 'api' },
    },
  };
}

describe('transcript helpers', () => {
  it('filters replay by session key and preserves screenshot tool results', () => {
    const entries = [
      createTranscriptRecord({
        kind: 'user_message',
        sessionKey: 'worker:default',
        backend: 'user',
        requestId: 'r1',
        loopIndex: 1,
        text: 'take a screenshot',
        payload: { role: 'user', content: 'take a screenshot' },
      }),
      createTranscriptRecord({
        kind: 'assistant_message',
        sessionKey: 'worker:default',
        backend: 'worker:api',
        requestId: 'r1',
        loopIndex: 1,
        payload: {
          role: 'assistant',
          content: '',
          tool_calls: [{
            id: 'call_1',
            type: 'function',
            function: { name: 'chrome_devtools__take_screenshot', arguments: '{}' },
          }],
        },
      }),
      createTranscriptRecord({
        kind: 'tool_result',
        sessionKey: 'worker:default',
        backend: 'worker:api',
        requestId: 'r1',
        loopIndex: 1,
        toolCallId: 'call_1',
        toolName: 'chrome_devtools__take_screenshot',
        result: {
          content: [{ type: 'image', mimeType: 'image/png', data: 'ZmFrZQ==' }],
        },
      }),
      createTranscriptRecord({
        kind: 'assistant_message',
        sessionKey: 'worker:agent:dev',
        backend: 'worker:api',
        requestId: 'r2',
        loopIndex: 1,
        agentId: 'dev',
        payload: { role: 'assistant', content: 'other agent output' },
      }),
    ];

    const replay = buildSessionReplay(entries, 'worker:default');
    assert.equal(replay.length, 4);
    assert.equal(replay[0].role, 'user');
    assert.equal(replay[1].role, 'assistant');
    assert.equal(replay[2].role, 'tool');
    assert.equal(replay[3].role, 'user');
    assert.ok(
      Array.isArray(replay[3].content) &&
      replay[3].content.some((part) => part.type === 'image_url'),
      'replay should include the screenshot as an image message'
    );
  });

  it('builds restore/display messages from v2 tool records', () => {
    const entries = [
      createTranscriptRecord({
        kind: 'controller_message',
        sessionKey: 'controller:main',
        backend: 'controller:codex',
        requestId: 'r1',
        loopIndex: 1,
        text: 'Delegating to the browser agent',
      }),
      createTranscriptRecord({
        kind: 'tool_call',
        sessionKey: 'worker:agent:dev',
        backend: 'worker:api',
        requestId: 'r1',
        loopIndex: 1,
        agentId: 'dev',
        toolCallId: 'shot-1',
        toolName: 'chrome_devtools__take_screenshot',
        input: {},
        payload: {
          id: 'shot-1',
          type: 'function',
          function: { name: 'chrome_devtools__take_screenshot', arguments: '{}' },
        },
      }),
      createTranscriptRecord({
        kind: 'tool_result',
        sessionKey: 'worker:agent:dev',
        backend: 'worker:api',
        requestId: 'r1',
        loopIndex: 1,
        agentId: 'dev',
        toolCallId: 'shot-1',
        toolName: 'chrome_devtools__take_screenshot',
        result: {
          content: [{ type: 'image', mimeType: 'image/png', data: 'ZmFrZQ==' }],
        },
      }),
      createTranscriptRecord({
        kind: 'assistant_message',
        sessionKey: 'worker:agent:dev',
        backend: 'worker:api',
        requestId: 'r1',
        loopIndex: 1,
        agentId: 'dev',
        text: 'The page shows a consent modal.',
        payload: { role: 'assistant', content: 'The page shows a consent modal.' },
      }),
    ];

    const messages = buildTranscriptDisplayMessages(entries, manifestStub());
    assert.equal(messages[0].type, 'controller');
    assert.ok(messages.some((msg) => msg.type === 'mcpCardComplete' || msg.type === 'toolCall'));
    assert.ok(messages.some((msg) => msg.type === 'chatScreenshot'));
    assert.ok(messages.some((msg) => msg.type === 'claude' && msg.label === 'Developer'));
  });

  it('restores browser screenshots alongside tool screenshots from the same session', () => {
    const entries = [
      createTranscriptRecord({
        kind: 'tool_call',
        sessionKey: 'worker:agent:dev',
        backend: 'worker:api',
        requestId: 'r1',
        loopIndex: 1,
        agentId: 'dev',
        toolCallId: 'shot-1',
        toolName: 'chrome_devtools__take_screenshot',
        input: {},
        payload: {
          id: 'shot-1',
          type: 'function',
          function: { name: 'chrome_devtools__take_screenshot', arguments: '{}' },
        },
      }),
      createTranscriptRecord({
        kind: 'tool_result',
        sessionKey: 'worker:agent:dev',
        backend: 'worker:api',
        requestId: 'r1',
        loopIndex: 1,
        agentId: 'dev',
        toolCallId: 'shot-1',
        toolName: 'chrome_devtools__take_screenshot',
        result: {
          content: [{ type: 'image', mimeType: 'image/png', data: 'ZmFrZQ==' }],
        },
      }),
      createTranscriptRecord({
        kind: 'ui_message',
        sessionKey: 'worker:agent:dev',
        backend: 'worker:api',
        requestId: 'r1',
        loopIndex: 1,
        agentId: 'dev',
        payload: {
          type: 'chatScreenshot',
          data: 'data:image/jpeg;base64,anBlZw==',
          alt: 'Browser screenshot',
        },
      }),
    ];

    const messages = buildTranscriptDisplayMessages(entries, manifestStub());
    assert.equal(messages.filter((msg) => msg.type === 'mcpCardStart').length, 1);
    assert.equal(messages.filter((msg) => msg.type === 'mcpCardComplete').length, 1);
    const screenshots = messages.filter((msg) => msg.type === 'chatScreenshot');
    assert.equal(screenshots.length, 2);
    assert.deepEqual(
      screenshots.map((msg) => msg.alt),
      ['Tool screenshot', 'Browser screenshot']
    );
  });

  it('replays Claude chrome tool results from raw tool_result events', () => {
    const messages = buildTranscriptDisplayMessages([
      createTranscriptRecord({
        kind: 'backend_event',
        sessionKey: 'worker:agent:dev',
        backend: 'worker:claude',
        requestId: 'r1',
        loopIndex: 1,
        agentId: 'dev',
        payload: {
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
        },
      }),
      createTranscriptRecord({
        kind: 'backend_event',
        sessionKey: 'worker:agent:dev',
        backend: 'worker:claude',
        requestId: 'r1',
        loopIndex: 1,
        agentId: 'dev',
        payload: {
          type: 'stream_event',
          event: { type: 'content_block_stop', index: 0 },
        },
      }),
      createTranscriptRecord({
        kind: 'backend_event',
        sessionKey: 'worker:agent:dev',
        backend: 'worker:claude',
        requestId: 'r1',
        loopIndex: 1,
        agentId: 'dev',
        payload: {
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
        },
      }),
    ], {
      controller: { cli: 'codex' },
      worker: { cli: 'claude' },
      agents: {
        dev: { name: 'ClaudeDev', cli: 'claude' },
      },
    });

    assert.equal(messages.filter((msg) => msg.type === 'mcpCardStart').length, 1);
    assert.equal(messages.filter((msg) => msg.type === 'mcpCardComplete').length, 1);
    const screenshots = messages.filter((msg) => msg.type === 'chatScreenshot');
    assert.equal(screenshots.length, 1);
    assert.equal(screenshots[0].alt, 'Tool screenshot');
    assert.equal(screenshots[0].data, 'data:image/png;base64,ZmFrZQ==');
  });

  it('dedupes persisted tool screenshots mirrored from tool results by exact payload', () => {
    const entries = [
      createTranscriptRecord({
        kind: 'tool_call',
        sessionKey: 'worker:agent:dev',
        backend: 'worker:api',
        requestId: 'r1',
        loopIndex: 1,
        agentId: 'dev',
        toolCallId: 'shot-1',
        toolName: 'chrome_devtools__take_screenshot',
        input: {},
        payload: {
          id: 'shot-1',
          type: 'function',
          function: { name: 'chrome_devtools__take_screenshot', arguments: '{}' },
        },
      }),
      createTranscriptRecord({
        kind: 'tool_result',
        sessionKey: 'worker:agent:dev',
        backend: 'worker:api',
        requestId: 'r1',
        loopIndex: 1,
        agentId: 'dev',
        toolCallId: 'shot-1',
        toolName: 'chrome_devtools__take_screenshot',
        result: {
          content: [{ type: 'image', mimeType: 'image/png', data: 'ZmFrZQ==' }],
        },
      }),
      createTranscriptRecord({
        kind: 'ui_message',
        sessionKey: 'worker:agent:dev',
        backend: 'worker:api',
        requestId: 'r1',
        loopIndex: 1,
        agentId: 'dev',
        payload: {
          type: 'chatScreenshot',
          data: 'data:image/png;base64,ZmFrZQ==',
          alt: 'Tool screenshot',
        },
      }),
    ];

    const messages = buildTranscriptDisplayMessages(entries, manifestStub());
    const screenshots = messages.filter((msg) => msg.type === 'chatScreenshot');
    assert.equal(screenshots.length, 1);
    assert.equal(screenshots[0].data, 'data:image/png;base64,ZmFrZQ==');
    assert.equal(screenshots[0].alt, 'Tool screenshot');
  });

  it('replays repeated persisted tool screenshots even when their image payloads are identical', () => {
    const screenshotPayload = {
      content: [{ type: 'image', mimeType: 'image/png', data: 'ZmFrZQ==' }],
    };
    const entries = [
      createTranscriptRecord({
        kind: 'backend_event',
        sessionKey: 'worker:agent:dev',
        backend: 'worker:codex',
        requestId: 'r1',
        loopIndex: 1,
        agentId: 'dev',
        payload: {
          type: 'item.completed',
          item: {
            type: 'mcp_tool_call',
            id: 'shot-1',
            server: 'chrome-devtools',
            tool: 'take_screenshot',
            arguments: {},
            output: screenshotPayload,
          },
        },
      }),
      createTranscriptRecord({
        kind: 'ui_message',
        sessionKey: 'worker:agent:dev',
        backend: 'worker:codex',
        requestId: 'r1',
        loopIndex: 1,
        agentId: 'dev',
        payload: {
          type: 'chatScreenshot',
          data: 'data:image/png;base64,ZmFrZQ==',
          alt: 'Tool screenshot',
        },
      }),
      createTranscriptRecord({
        kind: 'backend_event',
        sessionKey: 'worker:agent:dev',
        backend: 'worker:codex',
        requestId: 'r1',
        loopIndex: 1,
        agentId: 'dev',
        payload: {
          type: 'item.completed',
          item: {
            type: 'mcp_tool_call',
            id: 'shot-2',
            server: 'chrome-devtools',
            tool: 'take_screenshot',
            arguments: {},
            output: screenshotPayload,
          },
        },
      }),
      createTranscriptRecord({
        kind: 'ui_message',
        sessionKey: 'worker:agent:dev',
        backend: 'worker:codex',
        requestId: 'r1',
        loopIndex: 1,
        agentId: 'dev',
        payload: {
          type: 'chatScreenshot',
          data: 'data:image/png;base64,ZmFrZQ==',
          alt: 'Tool screenshot',
        },
      }),
    ];

    const messages = buildTranscriptDisplayMessages(entries, manifestStub());
    const screenshots = messages.filter((msg) => msg.type === 'chatScreenshot');
    assert.equal(screenshots.length, 2);
    assert.equal(screenshots[0].data, 'data:image/png;base64,ZmFrZQ==');
    assert.equal(screenshots[1].data, 'data:image/png;base64,ZmFrZQ==');
  });

  it('builds merged controller view while skipping replay-only entries', () => {
    const entries = [
      createTranscriptRecord({
        kind: 'user_message',
        sessionKey: 'controller:main',
        backend: 'user',
        requestId: 'r1',
        text: '[AUTO-CONTINUE] Decide the next step',
        payload: { role: 'user', content: '[AUTO-CONTINUE] Decide the next step' },
      }),
      createTranscriptRecord({
        kind: 'launch',
        sessionKey: 'controller:main',
        backend: 'controller:codex',
        requestId: 'r1',
        loopIndex: 1,
        text: 'Launching Developer with: "Fix the bug"',
      }),
      createTranscriptRecord({
        kind: 'user_message',
        sessionKey: 'worker:agent:dev',
        backend: 'user',
        requestId: 'r1',
        loopIndex: 1,
        agentId: 'dev',
        text: 'Fix the bug',
        payload: { role: 'user', content: 'Fix the bug' },
        display: false,
      }),
      createTranscriptRecord({
        kind: 'assistant_message',
        sessionKey: 'worker:agent:dev',
        backend: 'worker:api',
        requestId: 'r1',
        loopIndex: 1,
        agentId: 'dev',
        text: 'Bug fixed.',
        payload: { role: 'assistant', content: 'Bug fixed.' },
      }),
    ];

    const view = buildMergedRunView(entries, manifestStub());
    assert.deepEqual(view, [
      'Orchestrator (Codex): Launching Developer with: "Fix the bug"',
      'Developer: Bug fixed.',
    ]);
  });

  it('replays image-bearing tool results as text-only tool provenance plus a neutral image history message', () => {
    const entry = createTranscriptRecord({
      kind: 'tool_result',
      sessionKey: 'worker:default',
      backend: 'worker:api',
      requestId: 'r1',
      loopIndex: 1,
      toolCallId: 'call_123',
      toolName: 'chrome_devtools__take_screenshot',
      result: {
        content: [
          { type: 'text', text: 'Took a screenshot of the current page.' },
          { type: 'image', mimeType: 'image/png', data: 'ZmFrZQ==' },
        ],
      },
    });

    const replayMessages = providerMessagesForToolResult(entry);
    assert.equal(replayMessages.length, 2);
    assert.equal(replayMessages[0].role, 'tool');
    assert.match(replayMessages[0].content, /asset_id=asset_call_123/);
    assert.doesNotMatch(replayMessages[0].content, /Image returned by tool/);
    assert.equal(replayMessages[1].role, 'user');
    assert.equal(replayMessages[1].content[0].type, 'text');
    assert.match(replayMessages[1].content[0].text, /Here is the screenshot captured earlier in this conversation\./);
    assert.match(replayMessages[1].content[0].text, /asset_id=asset_call_123/);
    assert.equal(replayMessages[1].content[1].type, 'image_url');
    assert.equal(replayMessages[1].content[1].image_url.format, 'image/png');
  });

  it('can replay screenshot tool results as text-only provenance without inline images', () => {
    const entry = createTranscriptRecord({
      kind: 'tool_result',
      sessionKey: 'worker:default',
      backend: 'worker:api',
      requestId: 'r1',
      loopIndex: 1,
      toolCallId: 'call_123',
      toolName: 'chrome_devtools__take_screenshot',
      result: {
        content: [
          { type: 'text', text: 'Took a screenshot of the current page.' },
          { type: 'image', mimeType: 'image/png', data: 'ZmFrZQ==' },
        ],
      },
    });

    const replayMessages = providerMessagesForToolResult(entry, { includeInlineImages: false });
    assert.equal(replayMessages.length, 1);
    assert.equal(replayMessages[0].role, 'tool');
    assert.match(replayMessages[0].content, /Took a screenshot of the current page\./);
    assert.match(replayMessages[0].content, /asset_id=asset_call_123/);
  });

  it('uses the stored compact tool summary for provider replay text', () => {
    const entry = createTranscriptRecord({
      kind: 'tool_result',
      sessionKey: 'worker:default',
      backend: 'worker:api',
      requestId: 'r1',
      toolCallId: 'call_search',
      toolName: 'cc_tests__search_tests',
      text: 'Found 2 tests: test-1 "Login"; test-2 "Forgot password"',
      result: {
        content: [{
          type: 'text',
          text: JSON.stringify([
            { id: 'test-1', title: 'Login validation flow', status: 'partial', match_score: 91 },
            { id: 'test-2', title: 'Forgot password flow', status: 'untested', match_score: 77 },
          ]),
        }],
      },
    });

    const replayMessages = providerMessagesForToolResult(entry, { includeInlineImages: false });
    assert.equal(replayMessages.length, 1);
    assert.equal(replayMessages[0].role, 'tool');
    assert.match(replayMessages[0].content, /Found 2 tests/);
    assert.doesNotMatch(replayMessages[0].content, /Login validation flow/);
  });

  it('only replays inline screenshot images for trailing fresh tool results in tail-only mode', () => {
    const entries = [
      Object.assign(createTranscriptRecord({
        kind: 'assistant_message',
        sessionKey: 'worker:default',
        backend: 'worker:api',
        requestId: 'r1',
        payload: {
          role: 'assistant',
          content: '',
          tool_calls: [{
            id: 'shot-1',
            type: 'function',
            function: { name: 'chrome_devtools__take_screenshot', arguments: '{}' },
          }],
        },
      }), { __lineNumber: 1 }),
      Object.assign(createTranscriptRecord({
        kind: 'tool_result',
        sessionKey: 'worker:default',
        backend: 'worker:api',
        requestId: 'r1',
        toolCallId: 'shot-1',
        toolName: 'chrome_devtools__take_screenshot',
        result: {
          content: [{ type: 'image', mimeType: 'image/png', data: 'ZmFrZQ==' }],
        },
      }), { __lineNumber: 2 }),
      Object.assign(createTranscriptRecord({
        kind: 'user_message',
        sessionKey: 'worker:default',
        backend: 'user',
        requestId: 'r2',
        text: 'next request',
        payload: { role: 'user', content: 'next request' },
      }), { __lineNumber: 3 }),
    ];

    const staleReplay = buildSessionReplay(entries, 'worker:default', { inlineImageReplayMode: 'tail-only' });
    assert.equal(
      staleReplay.some((msg) =>
        msg.role === 'user' &&
        Array.isArray(msg.content) &&
        msg.content.some((part) => part.type === 'image_url')
      ),
      false
    );

    const tailReplay = buildSessionReplay(entries.slice(0, 2), 'worker:default', { inlineImageReplayMode: 'tail-only' });
    assert.equal(
      tailReplay.some((msg) =>
        msg.role === 'user' &&
        Array.isArray(msg.content) &&
        msg.content.some((part) => part.type === 'image_url')
      ),
      true
    );
  });

  it('does not restore permanent test cards from test mutation tool results', () => {
    const entries = [
      Object.assign(createTranscriptRecord({
        kind: 'tool_call',
        sessionKey: 'worker:default',
        backend: 'worker:api',
        requestId: 'r1',
        loopIndex: 1,
        toolCallId: 'step-1',
        toolName: 'cc_tests__update_step_result',
        input: { test_id: 'test-1', run_id: 1, step_id: 1, status: 'pass' },
      }), { __lineNumber: 1 }),
      Object.assign(createTranscriptRecord({
        kind: 'tool_result',
        sessionKey: 'worker:default',
        backend: 'worker:api',
        requestId: 'r1',
        loopIndex: 1,
        toolCallId: 'step-1',
        toolName: 'cc_tests__update_step_result',
        result: {
          content: [{
            type: 'text',
            text: JSON.stringify({
              step_id: 1,
              status: 'pass',
              _testCard: {
                title: 'Consent dialog',
                test_id: 'test-1',
                passed: 1,
                failed: 0,
                skipped: 0,
                steps: [{ name: 'Open page', status: 'pass' }],
              },
            }),
          }],
        },
      }), { __lineNumber: 2 }),
    ];

    const messages = buildTranscriptDisplayMessages(entries, manifestStub());
    assert.equal(messages.filter((msg) => msg.type === 'testCard').length, 0);
    assert.equal(messages.filter((msg) => msg.type === 'mcpCardComplete').length, 1);
  });

  it('restores one permanent test card from display_test_summary after test mutations', () => {
    const entries = [
      Object.assign(createTranscriptRecord({
        kind: 'tool_call',
        sessionKey: 'worker:default',
        backend: 'worker:api',
        requestId: 'r1',
        loopIndex: 1,
        toolCallId: 'step-1',
        toolName: 'cc_tests__update_step_result',
        input: { test_id: 'test-1', run_id: 1, step_id: 1, status: 'pass' },
      }), { __lineNumber: 1 }),
      Object.assign(createTranscriptRecord({
        kind: 'tool_result',
        sessionKey: 'worker:default',
        backend: 'worker:api',
        requestId: 'r1',
        loopIndex: 1,
        toolCallId: 'step-1',
        toolName: 'cc_tests__update_step_result',
        result: {
          content: [{
            type: 'text',
            text: JSON.stringify({
              step_id: 1,
              status: 'pass',
              _testCard: {
                title: 'Consent dialog',
                test_id: 'test-1',
                passed: 1,
                failed: 0,
                skipped: 0,
                steps: [{ name: 'Open page', status: 'pass' }],
              },
            }),
          }],
        },
      }), { __lineNumber: 2 }),
      Object.assign(createTranscriptRecord({
        kind: 'tool_call',
        sessionKey: 'worker:default',
        backend: 'worker:api',
        requestId: 'r1',
        loopIndex: 1,
        toolCallId: 'finish-1',
        toolName: 'cc_tests__complete_test_run',
        input: { test_id: 'test-1', run_id: 1 },
      }), { __lineNumber: 3 }),
      Object.assign(createTranscriptRecord({
        kind: 'tool_result',
        sessionKey: 'worker:default',
        backend: 'worker:api',
        requestId: 'r1',
        loopIndex: 1,
        toolCallId: 'finish-1',
        toolName: 'cc_tests__complete_test_run',
        result: {
          content: [{
            type: 'text',
            text: JSON.stringify({
              test_id: 'test-1',
              run_id: 1,
              status: 'passing',
              _testCard: {
                title: 'Consent dialog',
                test_id: 'test-1',
                passed: 1,
                failed: 0,
                skipped: 0,
                steps: [{ name: 'Open page', status: 'pass' }],
              },
            }),
          }],
        },
      }), { __lineNumber: 4 }),
      Object.assign(createTranscriptRecord({
        kind: 'tool_call',
        sessionKey: 'worker:default',
        backend: 'worker:api',
        requestId: 'r1',
        loopIndex: 1,
        toolCallId: 'summary-1',
        toolName: 'cc_tests__display_test_summary',
        input: {
          title: 'Consent dialog',
          passed: 1,
          failed: 0,
          skipped: 0,
          steps: [{ name: 'Open page', status: 'pass' }],
        },
      }), { __lineNumber: 5 }),
      Object.assign(createTranscriptRecord({
        kind: 'tool_result',
        sessionKey: 'worker:default',
        backend: 'worker:api',
        requestId: 'r1',
        loopIndex: 1,
        toolCallId: 'summary-1',
        toolName: 'cc_tests__display_test_summary',
        result: {
          content: [{ type: 'text', text: 'Displayed test summary card.' }],
        },
      }), { __lineNumber: 6 }),
    ];

    const messages = buildTranscriptDisplayMessages(entries, manifestStub());
    assert.equal(messages.filter((msg) => msg.type === 'testCard').length, 1);
    assert.equal(messages.filter((msg) => msg.type === 'mcpCardComplete').length, 2);
  });

  it('uses the latest context compaction checkpoint for replay while preserving older image history', () => {
    const entries = [
      Object.assign(createTranscriptRecord({
        kind: 'user_message',
        sessionKey: 'worker:default',
        backend: 'user',
        requestId: 'r1',
        text: 'old prompt',
        payload: { role: 'user', content: 'old prompt' },
      }), { __lineNumber: 1 }),
      Object.assign(createTranscriptRecord({
        kind: 'assistant_message',
        sessionKey: 'worker:default',
        backend: 'worker:api',
        requestId: 'r1',
        payload: {
          role: 'assistant',
          content: '',
          tool_calls: [{
            id: 'shot-1',
            type: 'function',
            function: { name: 'chrome_devtools__take_screenshot', arguments: '{}' },
          }],
        },
      }), { __lineNumber: 2 }),
      Object.assign(createTranscriptRecord({
        kind: 'tool_result',
        sessionKey: 'worker:default',
        backend: 'worker:api',
        requestId: 'r1',
        toolCallId: 'shot-1',
        toolName: 'chrome_devtools__take_screenshot',
        result: {
          content: [{ type: 'image', mimeType: 'image/png', data: 'ZmFrZQ==' }],
        },
      }), { __lineNumber: 3 }),
      Object.assign(createTranscriptRecord({
        kind: 'context_compaction',
        sessionKey: 'worker:default',
        backend: 'worker:api',
        requestId: 'r2',
        text: 'Older work summary.',
        payload: {
          role: 'assistant',
          content: 'Conversation summary (generated by context compaction):\nOlder work summary.',
        },
        compaction: {
          compactedThroughLine: 2,
          preservedLines: [2, 3],
        },
        display: false,
      }), { __lineNumber: 4 }),
      Object.assign(createTranscriptRecord({
        kind: 'assistant_message',
        sessionKey: 'worker:default',
        backend: 'worker:api',
        requestId: 'r3',
        text: 'Newest reply.',
        payload: { role: 'assistant', content: 'Newest reply.' },
      }), { __lineNumber: 5 }),
    ];

    const replay = buildSessionReplay(entries, 'worker:default');
    assert.equal(replay[0].role, 'assistant');
    assert.ok(Array.isArray(replay[0].tool_calls));
    assert.ok(replay.some((msg) => msg.role === 'assistant' && /Older work summary/.test(msg.content)));
    assert.ok(replay.some((msg) => msg.role === 'tool' && msg.tool_call_id === 'shot-1'));
    assert.ok(replay.some((msg) => msg.role === 'assistant' && msg.content === 'Newest reply.'));
  });

  it('skips orphaned tool results when compaction removed the matching assistant tool call', () => {
    const entries = [
      Object.assign(createTranscriptRecord({
        kind: 'user_message',
        sessionKey: 'worker:default',
        backend: 'user',
        requestId: 'r1',
        text: 'Hi',
        payload: { role: 'user', content: 'Hi' },
      }), { __lineNumber: 1 }),
      Object.assign(createTranscriptRecord({
        kind: 'assistant_message',
        sessionKey: 'worker:default',
        backend: 'worker:api',
        requestId: 'r1',
        payload: {
          role: 'assistant',
          content: '',
          tool_calls: [{
            id: 'orphan-1',
            type: 'function',
            function: { name: 'cc_memory__get_memory', arguments: '{}' },
          }],
        },
      }), { __lineNumber: 2 }),
      Object.assign(createTranscriptRecord({
        kind: 'tool_result',
        sessionKey: 'worker:default',
        backend: 'worker:api',
        requestId: 'r1',
        toolCallId: 'orphan-1',
        toolName: 'cc_memory__get_memory',
        result: {
          content: [{ type: 'text', text: 'Memory contents' }],
        },
      }), { __lineNumber: 3 }),
      Object.assign(createTranscriptRecord({
        kind: 'context_compaction',
        sessionKey: 'worker:default',
        backend: 'worker:api',
        requestId: 'r2',
        text: 'Older work summary.',
        payload: {
          role: 'assistant',
          content: 'Conversation summary (generated by context compaction):\nOlder work summary.',
        },
        compaction: {
          compactedThroughLine: 2,
          preservedLines: [1],
        },
        display: false,
      }), { __lineNumber: 4 }),
      Object.assign(createTranscriptRecord({
        kind: 'assistant_message',
        sessionKey: 'worker:default',
        backend: 'worker:api',
        requestId: 'r3',
        text: 'Continue testing.',
        payload: { role: 'assistant', content: 'Continue testing.' },
      }), { __lineNumber: 5 }),
    ];

    const replay = buildSessionReplay(entries, 'worker:default');
    assert.equal(
      replay.some((msg) => msg.role === 'tool' && msg.tool_call_id === 'orphan-1'),
      false
    );
    assert.ok(replay.some((msg) => msg.role === 'assistant' && /Older work summary/.test(String(msg.content || ''))));
    assert.ok(replay.some((msg) => msg.role === 'assistant' && msg.content === 'Continue testing.'));
  });

  it('never inserts the compaction summary inside a preserved tool bundle', () => {
    const entries = [
      Object.assign(createTranscriptRecord({
        kind: 'assistant_message',
        sessionKey: 'worker:default',
        backend: 'worker:api',
        requestId: 'r1',
        payload: {
          role: 'assistant',
          content: '',
          tool_calls: [{
            id: 'bundle-1',
            type: 'function',
            function: { name: 'cc_memory__get_memory', arguments: '{}' },
          }],
        },
      }), { __lineNumber: 1 }),
      Object.assign(createTranscriptRecord({
        kind: 'tool_result',
        sessionKey: 'worker:default',
        backend: 'worker:api',
        requestId: 'r1',
        toolCallId: 'bundle-1',
        toolName: 'cc_memory__get_memory',
        result: {
          content: [{ type: 'text', text: 'Memory contents' }],
        },
      }), { __lineNumber: 2 }),
      Object.assign(createTranscriptRecord({
        kind: 'context_compaction',
        sessionKey: 'worker:default',
        backend: 'worker:api',
        requestId: 'r2',
        text: 'Older work summary.',
        payload: {
          role: 'assistant',
          content: 'Conversation summary (generated by context compaction):\nOlder work summary.',
        },
        compaction: {
          compactedThroughLine: 2,
          preservedLines: [1, 2],
        },
        display: false,
      }), { __lineNumber: 3 }),
      Object.assign(createTranscriptRecord({
        kind: 'user_message',
        sessionKey: 'worker:default',
        backend: 'user',
        requestId: 'r3',
        text: 'Next prompt',
        payload: { role: 'user', content: 'Next prompt' },
      }), { __lineNumber: 4 }),
    ];

    const replay = buildSessionReplay(entries, 'worker:default');
    const assistantIndex = replay.findIndex((msg) => Array.isArray(msg.tool_calls));
    const toolIndex = replay.findIndex((msg) => msg.role === 'tool' && msg.tool_call_id === 'bundle-1');
    const summaryIndex = replay.findIndex((msg) => msg.role === 'assistant' && /Older work summary/.test(String(msg.content || '')));

    assert.ok(assistantIndex >= 0);
    assert.ok(toolIndex > assistantIndex);
    assert.ok(summaryIndex > toolIndex);
  });

  it('replays semantic tool bundles through interleaved backend events and tool-call rows', () => {
    const entries = [
      Object.assign(createTranscriptRecord({
        kind: 'user_message',
        sessionKey: 'worker:default',
        backend: 'user',
        requestId: 'r1',
        text: 'Test login page',
        payload: { role: 'user', content: 'Test login page' },
      }), { __lineNumber: 1 }),
      Object.assign(createTranscriptRecord({
        kind: 'assistant_message',
        sessionKey: 'worker:default',
        backend: 'worker:api',
        requestId: 'r1',
        text: 'Checking memory.',
        payload: {
          role: 'assistant',
          content: 'Checking memory.',
          tool_calls: [{
            id: 'mem-1',
            type: 'function',
            function: { name: 'cc_memory__get_memory', arguments: '{}' },
          }],
        },
      }), { __lineNumber: 2 }),
      Object.assign(createTranscriptRecord({
        kind: 'tool_call',
        sessionKey: 'worker:default',
        backend: 'worker:api',
        requestId: 'r1',
        toolCallId: 'mem-1',
        toolName: 'cc_memory__get_memory',
        input: {},
      }), { __lineNumber: 3 }),
      Object.assign(createTranscriptRecord({
        kind: 'backend_event',
        sessionKey: 'worker:default',
        backend: 'worker:api',
        requestId: 'r1',
        text: 'Checking memory.',
        payload: { source: 'worker-api', type: 'assistant_message', text: 'Checking memory.' },
      }), { __lineNumber: 4 }),
      Object.assign(createTranscriptRecord({
        kind: 'tool_result',
        sessionKey: 'worker:default',
        backend: 'worker:api',
        requestId: 'r1',
        toolCallId: 'mem-1',
        toolName: 'cc_memory__get_memory',
        result: { content: [{ type: 'text', text: 'Known login URL is /login' }] },
      }), { __lineNumber: 5 }),
      Object.assign(createTranscriptRecord({
        kind: 'assistant_message',
        sessionKey: 'worker:default',
        backend: 'worker:api',
        requestId: 'r1',
        text: 'Checking current page.',
        payload: {
          role: 'assistant',
          content: 'Checking current page.',
          tool_calls: [{
            id: 'pages-1',
            type: 'function',
            function: { name: 'chrome_devtools__list_pages', arguments: '{}' },
          }],
        },
      }), { __lineNumber: 6 }),
      Object.assign(createTranscriptRecord({
        kind: 'tool_call',
        sessionKey: 'worker:default',
        backend: 'worker:api',
        requestId: 'r1',
        toolCallId: 'pages-1',
        toolName: 'chrome_devtools__list_pages',
        input: {},
      }), { __lineNumber: 7 }),
      Object.assign(createTranscriptRecord({
        kind: 'backend_event',
        sessionKey: 'worker:default',
        backend: 'worker:api',
        requestId: 'r1',
        text: '',
        payload: { source: 'worker-api', type: 'tool_call', name: 'chrome_devtools__list_pages' },
      }), { __lineNumber: 8 }),
      Object.assign(createTranscriptRecord({
        kind: 'tool_result',
        sessionKey: 'worker:default',
        backend: 'worker:api',
        requestId: 'r1',
        toolCallId: 'pages-1',
        toolName: 'chrome_devtools__list_pages',
        result: { content: [{ type: 'text', text: '## Pages\n1: https://www.google.com/ [selected]' }] },
      }), { __lineNumber: 9 }),
      Object.assign(createTranscriptRecord({
        kind: 'assistant_message',
        sessionKey: 'worker:default',
        backend: 'worker:api',
        requestId: 'r1',
        text: 'First: discover',
        payload: { role: 'assistant', content: 'First: discover' },
      }), { __lineNumber: 10 }),
    ];

    const replay = buildSessionReplay(entries, 'worker:default', {
      inlineImageReplayMode: 'tail-only',
    });

    assert.ok(replay.length > 2, 'replay should not collapse to only prompt + final assistant');
    assert.ok(replay.some((msg) => Array.isArray(msg.tool_calls) && msg.tool_calls.some((toolCall) => toolCall.id === 'mem-1')));
    assert.ok(replay.some((msg) => msg.role === 'tool' && msg.tool_call_id === 'mem-1'));
    assert.ok(replay.some((msg) => msg.role === 'tool' && msg.tool_call_id === 'pages-1'));
    assert.equal(
      replay.some((msg) => msg && msg.role === undefined && msg.type === 'assistant_message'),
      false,
      'backend_event rows must not become provider replay messages'
    );
  });

  it('reads only complete transcript JSONL records from the tail window', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccm-transcript-tail-'));
    const transcriptPath = path.join(tmpDir, 'transcript.jsonl');
    const records = [
      createTranscriptRecord({
        kind: 'assistant_message',
        sessionKey: 'worker:default',
        backend: 'worker:api',
        text: 'older-1',
        payload: { role: 'assistant', content: 'older-1' },
      }),
      createTranscriptRecord({
        kind: 'assistant_message',
        sessionKey: 'worker:default',
        backend: 'worker:api',
        text: 'older-2',
        payload: { role: 'assistant', content: 'older-2' },
      }),
      createTranscriptRecord({
        kind: 'assistant_message',
        sessionKey: 'worker:default',
        backend: 'worker:api',
        text: 'newer-3',
        payload: { role: 'assistant', content: 'newer-3' },
      }),
      createTranscriptRecord({
        kind: 'assistant_message',
        sessionKey: 'worker:default',
        backend: 'worker:api',
        text: 'newer-4',
        payload: { role: 'assistant', content: 'newer-4' },
      }),
    ];
    const raw = records.map((entry) => JSON.stringify(entry)).join('\n') + '\n';
    fs.writeFileSync(transcriptPath, raw, 'utf8');

    try {
      const lastTwoRaw = `${JSON.stringify(records[2])}\n${JSON.stringify(records[3])}\n`;
      const result = await readTranscriptTailEntries(transcriptPath, {
        bytes: Buffer.byteLength(lastTwoRaw, 'utf8') + 5,
      });
      assert.deepEqual(result.entries.map((entry) => entry.text), ['newer-3', 'newer-4']);
      assert.ok(result.startOffset > 0);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('streams session-scoped transcript entries without readFile and prunes compacted history', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccm-transcript-session-stream-'));
    const transcriptPath = path.join(tmpDir, 'transcript.jsonl');
    const records = [
      createTranscriptRecord({
        kind: 'user_message',
        sessionKey: 'worker:agent:dev',
        backend: 'user',
        requestId: 'r1',
        text: 'old prompt',
        payload: { role: 'user', content: 'old prompt' },
      }),
      createTranscriptRecord({
        kind: 'assistant_message',
        sessionKey: 'worker:agent:dev',
        backend: 'worker:api',
        requestId: 'r1',
        payload: {
          role: 'assistant',
          content: '',
          tool_calls: [{
            id: 'old-tool',
            type: 'function',
            function: { name: 'cc_memory__get_memory', arguments: '{}' },
          }],
        },
      }),
      createTranscriptRecord({
        kind: 'tool_result',
        sessionKey: 'worker:agent:dev',
        backend: 'worker:api',
        requestId: 'r1',
        toolCallId: 'old-tool',
        toolName: 'cc_memory__get_memory',
        result: { content: [{ type: 'text', text: 'old memory' }] },
      }),
      createTranscriptRecord({
        kind: 'context_compaction',
        sessionKey: 'worker:agent:dev',
        backend: 'worker:api',
        requestId: 'r2',
        text: 'summary',
        payload: {
          role: 'assistant',
          content: 'Conversation summary (generated by context compaction):\nsummary',
        },
        compaction: {
          compactedThroughLine: 2,
          preservedLines: [1],
        },
        display: false,
      }),
      createTranscriptRecord({
        kind: 'assistant_message',
        sessionKey: 'worker:agent:dev',
        backend: 'worker:api',
        requestId: 'r3',
        text: 'new reply',
        payload: { role: 'assistant', content: 'new reply' },
      }),
      createTranscriptRecord({
        kind: 'assistant_message',
        sessionKey: 'worker:agent:qa',
        backend: 'worker:api',
        requestId: 'r4',
        text: 'other session',
        payload: { role: 'assistant', content: 'other session' },
      }),
    ];
    fs.writeFileSync(transcriptPath, records.map((entry) => JSON.stringify(entry)).join('\n') + '\n', 'utf8');

    const fsPromises = require('node:fs/promises');
    const originalReadFile = fsPromises.readFile;
    fsPromises.readFile = async () => {
      throw new Error('session-scoped transcript read should not use readFile');
    };

    try {
      const entries = await readTranscriptEntries(transcriptPath, { sessionKey: 'worker:agent:dev' });
      assert.deepEqual(
        entries.map((entry) => [entry.kind, entry.__lineNumber]),
        [
          ['user_message', 1],
          ['tool_result', 3],
          ['context_compaction', 4],
          ['assistant_message', 5],
        ]
      );
      assert.equal(entries.some((entry) => entry.sessionKey === 'worker:agent:qa'), false);
    } finally {
      fsPromises.readFile = originalReadFile;
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('counts visible display text instead of raw screenshot payload size', () => {
    const screenshotMessage = {
      type: 'chatScreenshot',
      data: 'data:image/png;base64,' + 'a'.repeat(20_000),
      alt: 'Tool screenshot',
    };
    assert.equal(visibleTextForDisplayMessage(screenshotMessage), '[Screenshot]');
    assert.equal(countDisplayMessageChars([screenshotMessage]), '[Screenshot]'.length);
  });

  it('builds a truncated display-message tail with a banner', () => {
    const messages = [
      { type: 'controller', text: 'z'.repeat(30_000), label: 'Orchestrator (Codex)' },
      { type: 'user', text: 'a'.repeat(30_000) },
      { type: 'chatScreenshot', data: 'data:image/png;base64,' + 'b'.repeat(10_000), alt: 'shot' },
      { type: 'claude', text: 'c'.repeat(30_000), label: 'Developer' },
    ];
    const tail = buildDisplayMessageTail(messages, {
      maxChars: 50_000,
      truncationBannerText: TRANSCRIPT_TAIL_TRUNCATION_BANNER,
    });
    assert.equal(tail.truncated, true);
    assert.equal(tail.messages[0].type, 'banner');
    assert.equal(tail.messages[0].text, TRANSCRIPT_TAIL_TRUNCATION_BANNER);
    assert.ok(tail.messages.some((message) => message.type === 'chatScreenshot'));
    assert.ok(tail.messages.some((message) => message.type === 'claude'));
    assert.ok(tail.messages.some((message) => message.type === 'user'));
    assert.ok(!tail.messages.some((message) => message.type === 'controller' && message.text === messages[0].text));
  });

  it('collapses replayed local browser screenshot clusters to the latest screenshot and closes the turn', () => {
    const messages = buildTranscriptDisplayMessages([
      createTranscriptRecord({
        kind: 'assistant_message',
        sessionKey: 'worker:agent:dev',
        backend: 'worker:api',
        agentId: 'dev',
        text: 'first turn',
        payload: { role: 'assistant', content: 'first turn' },
      }),
      createTranscriptRecord({
        kind: 'tool_call',
        sessionKey: 'worker:agent:dev',
        backend: 'worker:api',
        agentId: 'dev',
        toolCallId: 'call-cluster',
        toolName: 'mcp__chrome-devtools__navigate_page',
        input: { url: 'https://example.com' },
      }),
      createTranscriptRecord({
        kind: 'ui_message',
        sessionKey: 'worker:agent:dev',
        backend: 'worker:api',
        payload: { type: 'chatScreenshot', data: 'data:image/png;base64,first', alt: 'Browser screenshot' },
      }),
      createTranscriptRecord({
        kind: 'ui_message',
        sessionKey: 'worker:agent:dev',
        backend: 'worker:api',
        payload: { type: 'banner', text: 'Waiting for headless Chrome…' },
      }),
      createTranscriptRecord({
        kind: 'ui_message',
        sessionKey: 'worker:agent:dev',
        backend: 'worker:api',
        payload: { type: 'chatScreenshot', data: 'data:image/png;base64,second', alt: 'Browser screenshot' },
      }),
      createTranscriptRecord({
        kind: 'assistant_message',
        sessionKey: 'worker:agent:dev',
        backend: 'worker:api',
        agentId: 'dev',
        text: 'second turn',
        payload: { role: 'assistant', content: 'second turn' },
      }),
    ], manifestStub());

    const screenshots = messages.filter((message) => message.type === 'chatScreenshot');
    assert.equal(screenshots.length, 1);
    assert.equal(screenshots[0].data, 'data:image/png;base64,second');
    assert.equal(screenshots[0].closeAfter, true);
    assert.ok(messages.some((message) => message.type === 'banner' && message.text === 'Waiting for headless Chrome…'));
    assert.ok(messages.some((message) => message.type === 'claude' && message.text === 'first turn'));
    assert.ok(messages.some((message) => message.type === 'claude' && message.text === 'second turn'));
  });

  it('drops replayed local browser screenshots once a user message has started the next turn', () => {
    const messages = buildTranscriptDisplayMessages([
      createTranscriptRecord({
        kind: 'assistant_message',
        sessionKey: 'worker:agent:dev',
        backend: 'worker:api',
        agentId: 'dev',
        text: 'browser turn',
        payload: { role: 'assistant', content: 'browser turn' },
      }),
      createTranscriptRecord({
        kind: 'tool_call',
        sessionKey: 'worker:agent:dev',
        backend: 'worker:api',
        agentId: 'dev',
        toolCallId: 'call-1',
        toolName: 'mcp__chrome-devtools__navigate_page',
        input: { url: 'https://example.com' },
      }),
      createTranscriptRecord({
        kind: 'ui_message',
        sessionKey: 'worker:agent:dev',
        backend: 'worker:api',
        payload: { type: 'chatScreenshot', data: 'data:image/png;base64,valid', alt: 'Browser screenshot' },
      }),
      createTranscriptRecord({
        kind: 'user_message',
        sessionKey: 'worker:agent:dev',
        backend: 'worker:api',
        agentId: 'dev',
        text: 'next prompt',
        payload: { role: 'user', content: 'next prompt' },
      }),
      createTranscriptRecord({
        kind: 'ui_message',
        sessionKey: 'worker:agent:dev',
        backend: 'worker:api',
        payload: { type: 'chatScreenshot', data: 'data:image/png;base64,stale', alt: 'Browser screenshot' },
      }),
    ], manifestStub());

    const screenshots = messages.filter((message) => message.type === 'chatScreenshot');
    assert.equal(screenshots.length, 1);
    assert.equal(screenshots[0].data, 'data:image/png;base64,valid');
    assert.ok(messages.some((message) => message.type === 'user' && message.text === 'next prompt'));
  });

  it('builds a transcript display tail from the end of a large transcript file', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccm-transcript-display-tail-'));
    const transcriptPath = path.join(tmpDir, 'transcript.jsonl');
    const entries = [];
    for (let index = 0; index < 120; index += 1) {
      entries.push(createTranscriptRecord({
        kind: 'assistant_message',
        sessionKey: 'worker:agent:dev',
        backend: 'worker:api',
        agentId: 'dev',
        text: `entry-${index} ` + 'x'.repeat(700),
        payload: { role: 'assistant', content: `entry-${index} ` + 'x'.repeat(700) },
      }));
    }
    fs.writeFileSync(transcriptPath, entries.map((entry) => JSON.stringify(entry)).join('\n') + '\n', 'utf8');

    try {
      const result = await buildTranscriptDisplayTail(transcriptPath, manifestStub(), {
        maxChars: 50_000,
        initialBytes: 256,
        maxBytes: 1024 * 1024,
      });
      assert.equal(result.messages[0].type, 'banner');
      assert.equal(result.messages[0].text, TRANSCRIPT_TAIL_TRUNCATION_BANNER);
      assert.ok(result.messages.some((message) => message.type === 'claude' && message.text.includes('entry-119')));
      assert.ok(!result.messages.some((message) => message.type === 'claude' && message.text.includes('entry-0 ')));
      assert.ok(result.startOffset > 0);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('falls back to a reverse scan when malformed trailing lines hide the latest visible transcript messages', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccm-transcript-display-tail-fallback-'));
    const transcriptPath = path.join(tmpDir, 'transcript.jsonl');
    const goodEntries = [
      createTranscriptRecord({
        kind: 'user_message',
        sessionKey: 'worker:agent:dev',
        backend: 'worker:api',
        agentId: 'dev',
        text: 'latest valid user prompt',
        payload: { role: 'user', content: 'latest valid user prompt' },
      }),
      createTranscriptRecord({
        kind: 'assistant_message',
        sessionKey: 'worker:agent:dev',
        backend: 'worker:api',
        agentId: 'dev',
        text: 'latest valid assistant reply',
        payload: { role: 'assistant', content: 'latest valid assistant reply' },
      }),
    ];
    const malformedTail = [
      'x'.repeat(2200),
      'y'.repeat(2200),
      'z'.repeat(2200),
    ].join('\n') + '\n';
    fs.writeFileSync(
      transcriptPath,
      goodEntries.map((entry) => JSON.stringify(entry)).join('\n') + '\n' + malformedTail,
      'utf8'
    );

    try {
      const result = await buildTranscriptDisplayTail(transcriptPath, manifestStub(), {
        maxChars: 50_000,
        initialBytes: 256,
        maxBytes: 1024,
      });
      assert.ok(result.messages.some((message) => message.type === 'user' && message.text === 'latest valid user prompt'));
      assert.ok(result.messages.some((message) => message.type === 'claude' && message.text === 'latest valid assistant reply'));
      assert.ok(result.bytesRead > 1024);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
