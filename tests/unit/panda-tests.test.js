const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { createTempDir, readJson, writeJson } = require('../helpers/test-utils');
const {
  discoverPandaTests,
  filterPandaTests,
  loadPandaTestConfig,
  pandaTestConfigPath,
  pandaTestsFilePath,
  upsertManagedRuntimeTestRecord,
} = require('../../src/panda-tests');

function writeText(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, 'utf8');
}

describe('panda test discovery', () => {
  it('loads qapanda-tests/**/*.md by default', () => {
    const tmp = createTempDir();
    try {
      writeText(path.join(tmp.root, 'qapanda-tests', 'login.md'), `---\nid: login-smoke\ntitle: Login smoke\ntags: [smoke, login]\n---\n\nVerify login works.\n`);

      const config = loadPandaTestConfig(tmp.root);
      const tests = discoverPandaTests(tmp.root);

      assert.deepEqual(config.pandaTests.sources, ['qapanda-tests/**/*.md']);
      assert.equal(tests.length, 1);
      assert.equal(tests[0].id, 'login-smoke');
      assert.equal(tests[0].relativePath, 'qapanda-tests/login.md');
      assert.deepEqual(tests[0].tags, ['smoke', 'login']);
    } finally {
      tmp.cleanup();
    }
  });

  it('respects qapanda.config.json source overrides', () => {
    const tmp = createTempDir();
    try {
      writeJson(pandaTestConfigPath(tmp.root), {
        pandaTests: {
          sources: ['tests/panda/**/*.md'],
        },
      });
      writeText(path.join(tmp.root, 'tests', 'panda', 'checkout.md'), `---\nid: checkout\ntitle: Checkout\nagent: QA-Browser\nenvironment: browser\ntags: [smoke]\ntimeout: 10m\n---\n\nVerify checkout flow.\n`);

      const tests = discoverPandaTests(tmp.root);
      assert.equal(tests.length, 1);
      assert.equal(tests[0].id, 'checkout');
      assert.equal(tests[0].timeout, '10m');
      assert.equal(tests[0].relativePath, 'tests/panda/checkout.md');
    } finally {
      tmp.cleanup();
    }
  });

  it('filters discovered tests by id and tags', () => {
    const tmp = createTempDir();
    try {
      writeText(path.join(tmp.root, 'qapanda-tests', 'login.md'), `---\nid: login-smoke\ntitle: Login smoke\ntags: [smoke, login]\n---\n\nVerify login.\n`);
      writeText(path.join(tmp.root, 'qapanda-tests', 'billing.md'), `---\nid: billing-regression\ntitle: Billing regression\ntags: [billing, regression]\n---\n\nVerify billing.\n`);

      const tests = discoverPandaTests(tmp.root);
      assert.equal(filterPandaTests(tests, { tags: ['smoke'] }).length, 1);
      assert.equal(filterPandaTests(tests, { ids: ['billing-regression'] }).length, 1);
      assert.equal(filterPandaTests(tests, { ids: ['billing-regression'], tags: ['smoke'] }).length, 0);
    } finally {
      tmp.cleanup();
    }
  });

  it('fails on duplicate source ids', () => {
    const tmp = createTempDir();
    try {
      writeText(path.join(tmp.root, 'qapanda-tests', 'login.md'), `---\nid: shared\ntitle: First\n---\n\nOne.\n`);
      writeText(path.join(tmp.root, 'qapanda-tests', 'duplicate.md'), `---\nid: shared\ntitle: Second\n---\n\nTwo.\n`);

      assert.throws(() => discoverPandaTests(tmp.root), /Duplicate Panda test id "shared"/);
    } finally {
      tmp.cleanup();
    }
  });
});

describe('managed runtime Panda test records', () => {
  it('creates and updates a managed .qpanda/tests.json record with source metadata', () => {
    const tmp = createTempDir();
    try {
      writeText(path.join(tmp.root, 'qapanda-tests', 'login.md'), `---\nid: login-smoke\ntitle: Login smoke\ntags: [smoke, login]\n---\n\nVerify login works.\n`);
      const definition = discoverPandaTests(tmp.root)[0];

      const first = upsertManagedRuntimeTestRecord(tmp.root, definition);
      let stored = readJson(pandaTestsFilePath(tmp.root));
      assert.equal(first.runtimeTestId, 'test-1');
      assert.equal(stored.tests.length, 1);
      assert.equal(stored.tests[0].source.kind, 'panda-prompt');
      assert.equal(stored.tests[0].source.id, 'login-smoke');
      assert.equal(stored.tests[0].source.path, 'qapanda-tests/login.md');

      stored.tests[0].runs.push({ id: 7, status: 'passing' });
      writeJson(pandaTestsFilePath(tmp.root), stored);

      writeText(path.join(tmp.root, 'qapanda-tests', 'login.md'), `---\nid: login-smoke\ntitle: Login smoke updated\ntags: [smoke]\n---\n\nVerify login still works.\n`);
      const updatedDefinition = discoverPandaTests(tmp.root)[0];
      const second = upsertManagedRuntimeTestRecord(tmp.root, updatedDefinition);
      stored = readJson(pandaTestsFilePath(tmp.root));

      assert.equal(second.runtimeTestId, 'test-1');
      assert.equal(second.beforeLatestRunId, 7);
      assert.equal(stored.tests[0].title, 'Login smoke updated');
      assert.deepEqual(stored.tests[0].tags, ['smoke']);
    } finally {
      tmp.cleanup();
    }
  });

  it('fails loudly when the managed tests store is malformed', () => {
    const tmp = createTempDir();
    try {
      writeText(path.join(tmp.root, 'qapanda-tests', 'login.md'), `---\nid: login-smoke\ntitle: Login smoke\n---\n\nVerify login works.\n`);
      writeText(pandaTestsFilePath(tmp.root), '{not-json');
      const definition = discoverPandaTests(tmp.root)[0];

      assert.throws(() => upsertManagedRuntimeTestRecord(tmp.root, definition), SyntaxError);
    } finally {
      tmp.cleanup();
    }
  });
});
