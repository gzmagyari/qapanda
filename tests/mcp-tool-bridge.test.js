const test = require('node:test');
const assert = require('node:assert/strict');
const {
  _isChromeDevtoolsServer,
  _isRecoverableStdioMcpError,
} = require('../src/mcp-tool-bridge');

test('chrome devtools MCP timeouts are treated as recoverable', () => {
  assert.equal(_isChromeDevtoolsServer('chrome-devtools', 'chrome_devtools__navigate_page'), true);
  assert.equal(
    _isRecoverableStdioMcpError(
      'chrome-devtools',
      'navigate_page',
      new Error('MCP error -32001: Request timed out'),
    ),
    true,
  );
});

test('non-chrome MCP tool failures are not treated as recoverable by default', () => {
  assert.equal(_isChromeDevtoolsServer('builtin-tools', 'builtin_tools__read_file'), false);
  assert.equal(
    _isRecoverableStdioMcpError(
      'builtin-tools',
      'read_file',
      new Error('MCP error -32001: Request timed out'),
    ),
    false,
  );
});
