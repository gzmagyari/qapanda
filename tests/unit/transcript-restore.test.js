const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { controllerLabelFor, workerLabelFor } = require('../../src/render');

// Simulate the sendTranscript mapping logic from session-manager.js
function mapTranscriptEntries(entries, { workerLabel, controllerCli }) {
  const messages = [];
  for (const entry of entries) {
    if (entry.role === 'user') {
      messages.push({ type: 'user', text: entry.text || '' });
    } else if (entry.role === 'controller') {
      const cli = entry.controllerCli || controllerCli || 'codex';
      const label = controllerLabelFor(cli);
      if (entry.text === '[STOP]') {
        messages.push({ type: 'stop', label });
      } else {
        messages.push({ type: 'controller', text: entry.text || '', label });
      }
    } else if (entry.role === 'claude') {
      messages.push({ type: 'claude', text: (entry.text || '').trim(), label: workerLabel || 'Worker' });
    }
  }
  return messages;
}

describe('transcript entry mapping', () => {
  it('maps user entries', () => {
    const entries = [{ role: 'user', text: 'Hello' }];
    const messages = mapTranscriptEntries(entries, {});
    assert.equal(messages.length, 1);
    assert.equal(messages[0].type, 'user');
    assert.equal(messages[0].text, 'Hello');
  });

  it('maps controller entries with correct label', () => {
    const entries = [{ role: 'controller', text: 'Thinking...' }];
    const messages = mapTranscriptEntries(entries, { controllerCli: 'codex' });
    assert.equal(messages[0].type, 'controller');
    assert.equal(messages[0].label, 'Controller (Codex)');
  });

  it('maps controller STOP entries', () => {
    const entries = [{ role: 'controller', text: '[STOP]' }];
    const messages = mapTranscriptEntries(entries, { controllerCli: 'codex' });
    assert.equal(messages[0].type, 'stop');
  });

  it('maps worker entries with agent label', () => {
    const entries = [{ role: 'claude', text: '\n\nHi! How can I help?' }];
    const messages = mapTranscriptEntries(entries, { workerLabel: 'Developer' });
    assert.equal(messages[0].type, 'claude');
    assert.equal(messages[0].label, 'Developer');
    assert.equal(messages[0].text, 'Hi! How can I help?'); // trimmed
  });

  it('trims leading/trailing whitespace from worker text', () => {
    const entries = [{ role: 'claude', text: '\n\n  Hello world  \n\n' }];
    const messages = mapTranscriptEntries(entries, { workerLabel: 'Worker' });
    assert.equal(messages[0].text, 'Hello world');
  });

  it('falls back to Worker label when no workerLabel provided', () => {
    const entries = [{ role: 'claude', text: 'Hi' }];
    const messages = mapTranscriptEntries(entries, {});
    assert.equal(messages[0].label, 'Worker');
  });

  it('handles empty transcript', () => {
    const messages = mapTranscriptEntries([], {});
    assert.equal(messages.length, 0);
  });

  it('handles empty text fields', () => {
    const entries = [
      { role: 'user', text: '' },
      { role: 'claude', text: '' },
    ];
    const messages = mapTranscriptEntries(entries, { workerLabel: 'Dev' });
    assert.equal(messages[0].text, '');
    assert.equal(messages[1].text, '');
  });

  it('handles missing text fields', () => {
    const entries = [
      { role: 'user' },
      { role: 'claude' },
    ];
    const messages = mapTranscriptEntries(entries, { workerLabel: 'Dev' });
    assert.equal(messages[0].text, '');
    assert.equal(messages[1].text, '');
  });

  it('uses entry-level controllerCli when present', () => {
    const entries = [{ role: 'controller', text: 'Hi', controllerCli: 'claude' }];
    const messages = mapTranscriptEntries(entries, { controllerCli: 'codex' });
    assert.equal(messages[0].label, 'Controller (Claude)');
  });

  it('maps a complete conversation', () => {
    const entries = [
      { role: 'user', text: 'Fix the bug' },
      { role: 'controller', text: 'I\'ll delegate to the dev agent' },
      { role: 'claude', text: '\n\nI\'ve fixed the bug in file.js' },
      { role: 'controller', text: '[STOP]' },
    ];
    const messages = mapTranscriptEntries(entries, {
      workerLabel: 'Developer',
      controllerCli: 'codex',
    });
    assert.equal(messages.length, 4);
    assert.equal(messages[0].type, 'user');
    assert.equal(messages[1].type, 'controller');
    assert.equal(messages[1].label, 'Controller (Codex)');
    assert.equal(messages[2].type, 'claude');
    assert.equal(messages[2].label, 'Developer');
    assert.equal(messages[2].text, 'I\'ve fixed the bug in file.js');
    assert.equal(messages[3].type, 'stop');
  });
});

describe('workerLabel reconstruction from manifest', () => {
  it('resolves agent name from agentSessions + agents', () => {
    const manifest = {
      worker: {
        cli: 'claude',
        agentSessions: {
          dev: { sessionId: 'sess-1', hasStarted: true },
        },
      },
      agents: {
        dev: { name: 'Developer', cli: 'claude' },
        QA: { name: 'QA Engineer', cli: 'qa-remote-claude' },
      },
    };

    let agentName = null;
    const sessions = manifest.worker.agentSessions;
    if (sessions) {
      const agentId = Object.keys(sessions).find(id => sessions[id] && sessions[id].hasStarted);
      if (agentId && manifest.agents && manifest.agents[agentId]) {
        agentName = manifest.agents[agentId].name;
      }
    }
    const label = workerLabelFor(manifest.worker.cli, agentName);
    assert.equal(label, 'Developer');
  });

  it('falls back to CLI label when no agent started', () => {
    const manifest = {
      worker: { cli: 'claude', agentSessions: {} },
      agents: { dev: { name: 'Developer' } },
    };
    let agentName = null;
    const sessions = manifest.worker.agentSessions;
    if (sessions) {
      const agentId = Object.keys(sessions).find(id => sessions[id] && sessions[id].hasStarted);
      if (agentId && manifest.agents && manifest.agents[agentId]) {
        agentName = manifest.agents[agentId].name;
      }
    }
    const label = workerLabelFor(manifest.worker.cli, agentName);
    assert.equal(label, 'Worker (Claude)');
  });

  it('falls back to CLI label when no agentSessions', () => {
    const manifest = {
      worker: { cli: 'codex' },
      agents: {},
    };
    const label = workerLabelFor(manifest.worker.cli, null);
    assert.equal(label, 'Worker (Codex)');
  });
});
