const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { controllerLabelFor, workerLabelFor } = require('../../src/render');

describe('controllerLabelFor', () => {
  it('returns Orchestrator (Codex) for codex', () => {
    assert.equal(controllerLabelFor('codex'), 'Orchestrator (Codex)');
  });

  it('returns Orchestrator (Claude) for claude', () => {
    assert.equal(controllerLabelFor('claude'), 'Orchestrator (Claude)');
  });

  it('returns Orchestrator (Codex) for unknown CLI (default)', () => {
    assert.equal(controllerLabelFor('something-else'), 'Orchestrator (Codex)');
  });

  it('handles null/undefined', () => {
    // null/undefined are not 'claude', so should get Codex label
    assert.equal(controllerLabelFor(null), 'Orchestrator (Codex)');
    assert.equal(controllerLabelFor(undefined), 'Orchestrator (Codex)');
  });
});

describe('workerLabelFor', () => {
  it('returns Worker (Claude) for claude', () => {
    assert.equal(workerLabelFor('claude'), 'Worker (Claude)');
  });

  it('returns Worker (Claude) for null/undefined CLI', () => {
    assert.equal(workerLabelFor(null), 'Worker (Claude)');
    assert.equal(workerLabelFor(undefined), 'Worker (Claude)');
  });

  it('returns Worker (Codex) for codex', () => {
    assert.equal(workerLabelFor('codex'), 'Worker (Codex)');
  });

  it('returns agent name when provided (takes priority)', () => {
    assert.equal(workerLabelFor('claude', 'Developer'), 'Developer');
    assert.equal(workerLabelFor('codex', 'QA Engineer'), 'QA Engineer');
    assert.equal(workerLabelFor('qa-remote-claude', 'QA Engineer (Computer)'), 'QA Engineer (Computer)');
  });

  it('returns Worker (cli) for remote CLIs', () => {
    assert.equal(workerLabelFor('qa-remote-claude'), 'Worker (qa-remote-claude)');
    assert.equal(workerLabelFor('qa-remote-codex'), 'Worker (qa-remote-codex)');
  });

  it('returns Worker (cli) for unknown CLIs', () => {
    assert.equal(workerLabelFor('my-custom-cli'), 'Worker (my-custom-cli)');
  });
});
