const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  _prepareStdioMcpLaunch,
  _describeStdioMcpLaunch,
} = require('../../src/mcp-tool-bridge');

test('project stdio MCP launch resolves cwd to config dir and upgrades relative script args to absolute paths', () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'qapanda-mcp-launch-'));
  const configDir = path.join(tempRoot, '.qpanda');
  fs.mkdirSync(configDir, { recursive: true });
  const serverPath = path.join(configDir, 'server.js');
  fs.writeFileSync(serverPath, 'console.log("ok");', 'utf8');

  const launch = _prepareStdioMcpLaunch({
    command: 'node',
    args: ['server.js', '--flag'],
    __configDir: configDir,
  });

  assert.equal(launch.command, 'node');
  assert.equal(launch.cwd, configDir);
  assert.deepEqual(launch.args, [serverPath, '--flag']);
});

test('stdio MCP launch description includes command and cwd for diagnostics', () => {
  const launch = {
    command: 'node',
    args: ['/repo/.qpanda/server.js'],
    cwd: '/repo/.qpanda',
  };
  const description = _describeStdioMcpLaunch('demo-mcp', launch);
  assert.match(description, /server=demo-mcp/);
  assert.match(description, /command=node/);
  assert.match(description, /cwd=\/repo\/\.qpanda/);
});
