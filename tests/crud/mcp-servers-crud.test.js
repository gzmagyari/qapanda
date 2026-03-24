const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createTempDir, writeJson, readJson } = require('../helpers/test-utils');

// MCP servers use the same loadFile/saveFile pattern as agents/modes
// The extension.js handles CRUD via message handlers; we test the file operations

function loadMcpFile(filePath) {
  try { return JSON.parse(fs.readFileSync(filePath, 'utf8')); }
  catch { return {}; }
}

function saveMcpFile(filePath, data) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
}

let tmp;

beforeEach(() => { tmp = createTempDir(); });
afterEach(() => { tmp.cleanup(); });

describe('MCP server config CRUD', () => {
  it('loads empty object for missing file', () => {
    const result = loadMcpFile(path.join(tmp.root, 'mcp.json'));
    assert.deepEqual(result, {});
  });

  it('saves and loads MCP server config', () => {
    const filePath = path.join(tmp.ccDir, 'mcp.json');
    const config = {
      'my-mcp': { command: 'node', args: ['server.js'], target: 'both' },
    };
    saveMcpFile(filePath, config);
    const loaded = loadMcpFile(filePath);
    assert.deepEqual(loaded, config);
  });

  it('adds a new MCP server', () => {
    const filePath = path.join(tmp.ccDir, 'mcp.json');
    saveMcpFile(filePath, {});
    const data = loadMcpFile(filePath);
    data['new-server'] = { command: 'npx', args: ['-y', 'my-mcp@latest'], target: 'both' };
    saveMcpFile(filePath, data);
    const loaded = loadMcpFile(filePath);
    assert.ok(loaded['new-server']);
    assert.equal(loaded['new-server'].command, 'npx');
  });

  it('edits an existing MCP server', () => {
    const filePath = path.join(tmp.ccDir, 'mcp.json');
    saveMcpFile(filePath, {
      'my-mcp': { command: 'node', args: ['old.js'], target: 'both' },
    });
    const data = loadMcpFile(filePath);
    data['my-mcp'].args = ['new.js'];
    data['my-mcp'].env = { DEBUG: 'true' };
    saveMcpFile(filePath, data);
    const loaded = loadMcpFile(filePath);
    assert.deepEqual(loaded['my-mcp'].args, ['new.js']);
    assert.equal(loaded['my-mcp'].env.DEBUG, 'true');
  });

  it('toggles MCP server target', () => {
    const filePath = path.join(tmp.ccDir, 'mcp.json');
    saveMcpFile(filePath, {
      'my-mcp': { command: 'node', args: ['s.js'], target: 'both' },
    });
    const data = loadMcpFile(filePath);
    data['my-mcp'].target = 'controller';
    saveMcpFile(filePath, data);
    assert.equal(loadMcpFile(filePath)['my-mcp'].target, 'controller');

    data['my-mcp'].target = 'worker';
    saveMcpFile(filePath, data);
    assert.equal(loadMcpFile(filePath)['my-mcp'].target, 'worker');

    data['my-mcp'].target = 'none';
    saveMcpFile(filePath, data);
    assert.equal(loadMcpFile(filePath)['my-mcp'].target, 'none');
  });

  it('deletes an MCP server', () => {
    const filePath = path.join(tmp.ccDir, 'mcp.json');
    saveMcpFile(filePath, {
      'keep': { command: 'a' },
      'remove': { command: 'b' },
    });
    const data = loadMcpFile(filePath);
    delete data['remove'];
    saveMcpFile(filePath, data);
    const loaded = loadMcpFile(filePath);
    assert.ok(loaded['keep']);
    assert.ok(!loaded['remove']);
  });

  it('merges global + project (project wins on collision)', () => {
    const globalPath = path.join(tmp.root, 'global', 'mcp.json');
    const projectPath = path.join(tmp.ccDir, 'mcp.json');

    saveMcpFile(globalPath, {
      'shared': { command: 'node', args: ['global.js'], target: 'both' },
      'global-only': { command: 'node', args: ['g.js'] },
    });
    saveMcpFile(projectPath, {
      'shared': { command: 'node', args: ['project.js'], target: 'worker' },
      'project-only': { command: 'node', args: ['p.js'] },
    });

    const global = loadMcpFile(globalPath);
    const project = loadMcpFile(projectPath);
    const merged = { ...global, ...project };

    assert.equal(merged['shared'].args[0], 'project.js', 'project should win');
    assert.equal(merged['shared'].target, 'worker');
    assert.ok(merged['global-only'], 'global-only should exist');
    assert.ok(merged['project-only'], 'project-only should exist');
  });

  it('HTTP MCP server config', () => {
    const filePath = path.join(tmp.ccDir, 'mcp.json');
    saveMcpFile(filePath, {
      'remote-api': { type: 'http', url: 'http://localhost:8080/mcp', target: 'both' },
    });
    const loaded = loadMcpFile(filePath);
    assert.equal(loaded['remote-api'].type, 'http');
    assert.equal(loaded['remote-api'].url, 'http://localhost:8080/mcp');
  });

  it('MCP server with env vars', () => {
    const filePath = path.join(tmp.ccDir, 'mcp.json');
    const config = {
      'my-mcp': {
        command: 'node',
        args: ['server.js'],
        env: { API_KEY: 'secret', DEBUG: '1' },
        target: 'worker',
      },
    };
    saveMcpFile(filePath, config);
    const loaded = loadMcpFile(filePath);
    assert.equal(loaded['my-mcp'].env.API_KEY, 'secret');
    assert.equal(loaded['my-mcp'].env.DEBUG, '1');
  });
});
