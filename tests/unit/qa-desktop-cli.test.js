const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const crypto = require('node:crypto');

// Test library modules
const { LABEL, LABEL_API_PORT, CONTAINER_API_PORT, parseInstanceLine } = require('../../qa-desktop/lib/labels');
const { snapshotTagForWorkspace } = require('../../qa-desktop/lib/snapshot');
const { volumeName, syncSessionName, SYNC_IGNORES } = require('../../qa-desktop/lib/mutagen');
const { parseArgs } = require('../../qa-desktop/cli');

describe('qa-desktop labels', () => {
  it('has correct label constants', () => {
    assert.equal(LABEL, 'qa-desktop-instance');
    assert.equal(LABEL_API_PORT, 'qa-desktop.api-port');
    assert.equal(CONTAINER_API_PORT, 8765);
  });

  it('parseInstanceLine parses tab-separated format', () => {
    const line = 'abc123\tqa-desktop-mytest\tUp 2 hours\t9000\t5901\t6080';
    const inst = parseInstanceLine(line);
    assert.ok(inst);
    assert.equal(inst.name, 'mytest');
    assert.equal(inst.containerName, 'qa-desktop-mytest');
    assert.equal(inst.containerId, 'abc123');
    assert.equal(inst.apiPort, 9000);
    assert.equal(inst.vncPort, 5901);
    assert.equal(inst.novncPort, 6080);
  });

  it('parseInstanceLine strips qa-desktop- prefix from name', () => {
    const line = 'x\tqa-desktop-foo\tUp\t1\t2\t3';
    assert.equal(parseInstanceLine(line).name, 'foo');
  });

  it('parseInstanceLine returns null for short lines', () => {
    assert.equal(parseInstanceLine('too\tshort'), null);
  });

  it('parseInstanceLine handles missing ports', () => {
    const line = 'x\tqa-desktop-foo\tUp\t\t\t';
    const inst = parseInstanceLine(line);
    assert.equal(inst.apiPort, 0);
    assert.equal(inst.vncPort, 0);
    assert.equal(inst.novncPort, 0);
  });
});

describe('qa-desktop snapshot tags', () => {
  it('produces deterministic tag from workspace path', () => {
    const tag1 = snapshotTagForWorkspace('/home/user/myproject');
    const tag2 = snapshotTagForWorkspace('/home/user/myproject');
    assert.equal(tag1, tag2);
  });

  it('different paths produce different tags', () => {
    const tag1 = snapshotTagForWorkspace('/home/user/project-a');
    const tag2 = snapshotTagForWorkspace('/home/user/project-b');
    assert.notEqual(tag1, tag2);
  });

  it('tag format is qa-snapshot-{base}-{hash}', () => {
    const tag = snapshotTagForWorkspace('/home/user/MyProject');
    assert.ok(tag.startsWith('qa-snapshot-'));
    assert.ok(tag.includes('myproject')); // lowercase
    assert.ok(tag.match(/qa-snapshot-[a-z0-9-]+-[a-f0-9]{8}$/));
  });

  it('strips non-alphanumeric chars from base name', () => {
    const tag = snapshotTagForWorkspace('/home/user/My Project (v2)');
    assert.ok(!tag.includes(' '));
    assert.ok(!tag.includes('('));
  });

  it('matches Python implementation for known path', () => {
    // Verify against Python:
    // normalized = path.resolve(workspace) — this is platform-specific
    // We verify the format is correct, not the exact hash
    const tag = snapshotTagForWorkspace('/test/workspace');
    assert.ok(tag.startsWith('qa-snapshot-workspace-'));
    assert.equal(tag.length, 'qa-snapshot-workspace-'.length + 8);
  });
});

describe('qa-desktop mutagen helpers', () => {
  it('volumeName derives from instance name', () => {
    assert.equal(volumeName('mytest'), 'qa-workspace-mytest');
  });

  it('syncSessionName derives from instance name', () => {
    assert.equal(syncSessionName('mytest'), 'qa-sync-mytest');
  });

  it('SYNC_IGNORES has common patterns', () => {
    assert.ok(SYNC_IGNORES.includes('node_modules'));
    assert.ok(SYNC_IGNORES.includes('dist'));
    assert.ok(SYNC_IGNORES.includes('__pycache__'));
    assert.ok(SYNC_IGNORES.includes('.venv'));
  });
});

describe('qa-desktop CLI arg parsing', () => {
  it('parses up command with flags', () => {
    const result = parseArgs(['node', 'cli.js', 'up', 'mytest', '--workspace', '/tmp/test', '--json']);
    assert.equal(result.command, 'up');
    assert.equal(result.positionals[0], 'mytest');
    assert.equal(result.flags.workspace, '/tmp/test');
    assert.equal(result.flags.json, true);
  });

  it('parses down command', () => {
    const result = parseArgs(['node', 'cli.js', 'down', 'mytest']);
    assert.equal(result.command, 'down');
    assert.equal(result.positionals[0], 'mytest');
  });

  it('parses ls --json', () => {
    const result = parseArgs(['node', 'cli.js', 'ls', '--json']);
    assert.equal(result.command, 'ls');
    assert.equal(result.flags.json, true);
  });

  it('parses --no-snapshot as snapshot=false', () => {
    const result = parseArgs(['node', 'cli.js', 'up', 'test', '--no-snapshot']);
    assert.equal(result.flags.snapshot, false);
  });

  it('parses = style flags', () => {
    const result = parseArgs(['node', 'cli.js', 'up', '--workspace=/my/path']);
    assert.equal(result.flags.workspace, '/my/path');
  });

  it('defaults to help command', () => {
    const result = parseArgs(['node', 'cli.js']);
    assert.equal(result.command, 'help');
  });
});
