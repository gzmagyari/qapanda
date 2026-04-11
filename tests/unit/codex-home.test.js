const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createTempDir } = require('../helpers/test-utils');
const { buildIsolatedCodexEnv, relativeCodexImportPath } = require('../../src/codex-home');

function writeText(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, 'utf8');
}

test('buildIsolatedCodexEnv copies imported Codex session state without copying config.toml', async () => {
  const tmp = createTempDir();
  const originalHome = os.homedir;
  const fakeHome = path.join(tmp.root, 'user-home');
  const codexHome = path.join(fakeHome, '.codex');
  const importFile = path.join(codexHome, 'sessions', '2026', '04', '07', 'rollout-2026-04-07T14-46-38-session-1.jsonl');
  const tempHome = path.join(os.tmpdir(), 'cc-codex-home-test');

  try {
    writeText(path.join(codexHome, 'auth.json'), '{"ok":true}');
    writeText(path.join(codexHome, 'cap_sid'), 'cap');
    writeText(path.join(codexHome, 'config.toml'), 'mcp_servers.should_not_copy=true');
    writeText(path.join(codexHome, 'session_index.jsonl'), '{"id":"session-1"}\n');
    writeText(path.join(codexHome, 'version.json'), '{"version":"1"}\n');
    writeText(path.join(codexHome, 'state_5.sqlite'), 'sqlite-main');
    writeText(path.join(codexHome, 'state_5.sqlite-wal'), 'sqlite-wal');
    writeText(path.join(codexHome, 'state_5.sqlite-shm'), 'sqlite-shm');
    writeText(importFile, '{"timestamp":"2026-04-07T13:47:05.127Z"}\n');

    os.homedir = () => fakeHome;
    fs.rmSync(tempHome, { recursive: true, force: true });

    const env = buildIsolatedCodexEnv({
      importSource: {
        provider: 'codex',
        sessionId: 'session-1',
        filePath: importFile,
      },
    }, 'cc-codex-home-test');

    assert.equal(env.CODEX_HOME, tempHome);
    assert.equal(fs.existsSync(path.join(tempHome, 'auth.json')), true);
    assert.equal(fs.existsSync(path.join(tempHome, 'cap_sid')), true);
    assert.equal(fs.existsSync(path.join(tempHome, 'session_index.jsonl')), true);
    assert.equal(fs.existsSync(path.join(tempHome, 'version.json')), true);
    assert.equal(fs.existsSync(path.join(tempHome, 'state_5.sqlite')), true);
    assert.equal(fs.existsSync(path.join(tempHome, 'state_5.sqlite-wal')), true);
    assert.equal(fs.existsSync(path.join(tempHome, 'state_5.sqlite-shm')), false);
    assert.equal(fs.existsSync(path.join(tempHome, 'config.toml')), false);

    const relativeImport = relativeCodexImportPath(importFile, codexHome);
    assert.equal(relativeImport, path.join('sessions', '2026', '04', '07', 'rollout-2026-04-07T14-46-38-session-1.jsonl'));
    assert.equal(fs.existsSync(path.join(tempHome, relativeImport)), true);
  } finally {
    os.homedir = originalHome;
    fs.rmSync(tempHome, { recursive: true, force: true });
    tmp.cleanup();
  }
});
