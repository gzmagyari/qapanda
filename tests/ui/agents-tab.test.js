const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { createWebviewDom, sampleInitConfig } = require('../helpers/webview-dom');

let wv;

beforeEach(() => {
  wv = createWebviewDom({ savedState: { currentMode: 'dev', runId: 'run-1' } });
  wv.postMessage(sampleInitConfig({ runId: 'run-1' }));
  wv.click('[data-tab="agents"]');
});
afterEach(() => { wv.cleanup(); });

describe('Agents tab', () => {
  it('system agents are listed', () => {
    const systemList = wv.document.getElementById('agent-list-system');
    assert.ok(systemList, 'system agent list should exist');
    assert.ok(systemList.innerHTML.includes('Developer'), 'should show Developer agent');
    assert.ok(systemList.innerHTML.includes('QA Engineer'), 'should show QA agent');
  });

  it('agent cards show name and CLI', () => {
    const systemList = wv.document.getElementById('agent-list-system');
    assert.ok(systemList.innerHTML.includes('claude') || systemList.innerHTML.includes('codex'), 'should show CLI info');
  });

  it('agent cards have toggle checkbox', () => {
    const toggles = wv.document.querySelectorAll('#agent-list-system .mcp-toggle');
    assert.ok(toggles.length > 0, 'should have toggle checkboxes');
  });

  it('agent cards have Edit button', () => {
    const editBtns = wv.document.querySelectorAll('#agent-list-system .mcp-btn');
    const hasEdit = Array.from(editBtns).some(btn => btn.textContent === 'Edit');
    assert.ok(hasEdit, 'should have Edit button');
  });

  it('agentsData message refreshes the list', () => {
    wv.postMessage({
      type: 'agentsData',
      agents: {
        system: {
          'custom-agent': { name: 'Custom Agent', description: 'A custom one', cli: 'claude', enabled: true },
        },
        systemMeta: { 'custom-agent': { hasUserOverride: false, removed: false } },
        global: {},
        project: {},
      },
    });
    const systemList = wv.document.getElementById('agent-list-system');
    assert.ok(systemList.innerHTML.includes('Custom Agent'), 'should show new agent');
  });

  it('saving a new project agent does not read a stale system edit form', async () => {
    const systemEditBtn = Array.from(wv.document.querySelectorAll('#agent-list-system .mcp-btn'))
      .find((btn) => btn.textContent.trim() === 'Edit');
    assert.ok(systemEditBtn, 'system edit button should exist');
    systemEditBtn.click();
    await wv.flush();

    wv.click('.agent-add-btn[data-scope="project"]');
    await wv.flush();

    const idInputs = wv.document.querySelectorAll('#agent-f-id');
    assert.equal(idInputs.length, 1, 'only one agent form should be mounted at a time');

    wv.document.getElementById('agent-f-id').value = 'ClaudeDev';
    wv.document.getElementById('agent-f-name').value = 'ClaudeDev';
    wv.document.getElementById('agent-f-prompt').value = 'custom project prompt';
    wv.document.getElementById('agent-f-save').click();
    await wv.flush();

    const saveMsg = wv.messages.filter((msg) => msg.type === 'agentSave' && msg.scope === 'project').pop();
    assert.ok(saveMsg, 'project save should be posted');
    assert.ok(saveMsg.agents.ClaudeDev, 'custom agent should be saved under its own id');
    assert.equal(saveMsg.agents.ClaudeDev.name, 'ClaudeDev');
    assert.equal(Object.prototype.hasOwnProperty.call(saveMsg.agents, 'dev'), false, 'should not overwrite the built-in dev agent in project config');
  });

  it('project agent editor allows renaming the id', async () => {
    wv.postMessage({
      type: 'agentsData',
      agents: {
        system: sampleInitConfig().agents.system,
        systemMeta: sampleInitConfig().agents.systemMeta,
        global: {},
        project: {
          ClaudeDev: {
            name: 'ClaudeDev',
            description: 'Custom developer',
            system_prompt: 'prompt',
            mcps: {},
            enabled: true,
            cli: 'codex',
          },
        },
      },
    });
    await wv.flush();

    const editBtn = Array.from(wv.document.querySelectorAll('#agent-list-project .mcp-btn'))
      .find((btn) => btn.textContent.trim() === 'Edit');
    assert.ok(editBtn, 'project edit button should exist');
    editBtn.click();
    await wv.flush();

    const idInput = wv.document.getElementById('agent-f-id');
    assert.ok(idInput, 'project agent id input should exist');
    assert.equal(idInput.disabled, false, 'project agent id should be editable');

    idInput.value = 'claude-dev';
    wv.document.getElementById('agent-f-save').click();
    await wv.flush();

    const saveMsg = wv.messages.filter((msg) => msg.type === 'agentSave' && msg.scope === 'project').pop();
    assert.ok(saveMsg, 'renamed project agent should be saved');
    assert.ok(saveMsg.agents['claude-dev'], 'renamed id should be present');
    assert.equal(Object.prototype.hasOwnProperty.call(saveMsg.agents, 'ClaudeDev'), false, 'old id should be removed after rename');
  });

  it('project agent editor includes a delete button', async () => {
    wv.postMessage({
      type: 'agentsData',
      agents: {
        system: sampleInitConfig().agents.system,
        systemMeta: sampleInitConfig().agents.systemMeta,
        global: {},
        project: {
          ClaudeDev: {
            name: 'ClaudeDev',
            description: 'Custom developer',
            system_prompt: 'prompt',
            mcps: {},
            enabled: true,
            cli: 'codex',
          },
        },
      },
    });
    await wv.flush();

    const editBtn = Array.from(wv.document.querySelectorAll('#agent-list-project .mcp-btn'))
      .find((btn) => btn.textContent.trim() === 'Edit');
    assert.ok(editBtn, 'project edit button should exist');
    editBtn.click();
    await wv.flush();

    const deleteBtn = wv.document.getElementById('agent-f-delete');
    assert.ok(deleteBtn, 'project edit form should expose a delete button');
    deleteBtn.click();
    await wv.flush();

    const saveMsg = wv.messages.filter((msg) => msg.type === 'agentSave' && msg.scope === 'project').pop();
    assert.ok(saveMsg, 'project delete should post a save');
    assert.equal(Object.keys(saveMsg.agents).length, 0, 'deleted project agent should be removed from saved config');
  });
});
