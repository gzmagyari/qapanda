const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { createTempDir } = require('../helpers/test-utils');
const { runCcManager, stripAnsi } = require('../helpers/cli-runner');

function writeText(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, 'utf8');
}

describe('qapanda test CLI', () => {
  it('lists tracked Panda tests from the default source directory', async () => {
    const tmp = createTempDir();
    try {
      writeText(path.join(tmp.root, 'qapanda-tests', 'login.md'), `---\nid: login-smoke\ntitle: Login smoke\ntags: [smoke, login]\n---\n\nVerify login.\n`);

      const result = await runCcManager(['test', 'list', '--repo', tmp.root], { cwd: tmp.root });
      const stdout = stripAnsi(result.stdout);

      assert.equal(result.code, 0);
      assert.match(stdout, /Panda tests:/);
      assert.match(stdout, /login-smoke/);
      assert.match(stdout, /qapanda-tests\/login\.md/);
    } finally {
      tmp.cleanup();
    }
  });

  it('returns exit code 2 for an invalid Panda reporter', async () => {
    const tmp = createTempDir();
    try {
      writeText(path.join(tmp.root, 'qapanda-tests', 'login.md'), `---\nid: login-smoke\ntitle: Login smoke\n---\n\nVerify login.\n`);

      const result = await runCcManager(['test', 'run', '--repo', tmp.root, '--reporter', 'bogus'], { cwd: tmp.root });
      assert.equal(result.code, 2);
      assert.match(stripAnsi(result.stderr), /Unsupported Panda test reporter/);
    } finally {
      tmp.cleanup();
    }
  });
});
