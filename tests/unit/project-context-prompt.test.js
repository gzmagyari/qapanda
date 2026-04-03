const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  buildAgentWorkerSystemPrompt,
  buildControllerPrompt,
  buildCopilotBasePrompt,
} = require('../../src/prompts');
const { buildPromptsDirs } = require('../../src/prompt-tags');

function createRepo(files = {}, config = null) {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'qapanda-project-context-'));
  const qpandaDir = path.join(repoRoot, '.qpanda');
  fs.mkdirSync(qpandaDir, { recursive: true });
  for (const [relPath, content] of Object.entries(files)) {
    const filePath = path.join(repoRoot, relPath);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content, 'utf8');
  }
  if (config) {
    fs.writeFileSync(path.join(qpandaDir, 'config.json'), JSON.stringify(config, null, 2), 'utf8');
  }
  return repoRoot;
}

function createManifest(repoRoot) {
  return {
    repoRoot,
    runId: 'run-1',
    requests: [],
    stopReason: null,
    selfTesting: false,
    controllerSystemPrompt: null,
    controller: {
      sessionId: null,
      extraInstructions: '',
    },
    worker: {
      sessionId: null,
      hasStarted: false,
      cli: 'codex',
    },
    agents: {},
  };
}

describe('project context prompt injection', () => {
  it('injects app info and memory into worker, controller, and base controller prompts when enabled', () => {
    const repoRoot = createRepo({
      '.qpanda/APPINFO.md': 'App URL: http://localhost:8001',
      '.qpanda/MEMORY.md': 'Known fact: enterprise login works after backend restart.',
    });

    try {
      const promptsDirs = buildPromptsDirs(repoRoot);
      const workerPrompt = buildAgentWorkerSystemPrompt(
        { name: 'Developer', system_prompt: 'You are a dev.' },
        { repoRoot },
        promptsDirs
      );
      assert.match(workerPrompt, /Project App Info:\nApp URL: http:\/\/localhost:8001/);
      assert.match(workerPrompt, /Project Memory:\nKnown fact: enterprise login works after backend restart\./);
      assert.match(workerPrompt, /Project Memory guidance:/);

      const manifest = createManifest(repoRoot);
      const request = {
        id: 'req-1',
        userMessage: 'Fix the bug',
        startedAt: '2026-04-03T10:00:00.000Z',
        loops: [],
      };
      const controllerPrompt = buildControllerPrompt(manifest, request);
      assert.match(controllerPrompt, /Project App Info:\nApp URL: http:\/\/localhost:8001/);
      assert.match(controllerPrompt, /Project Memory:\nKnown fact: enterprise login works after backend restart\./);

      const basePrompt = buildCopilotBasePrompt({ repoRoot });
      assert.match(basePrompt, /Project App Info:\nApp URL: http:\/\/localhost:8001/);
      assert.match(basePrompt, /Project Memory:\nKnown fact: enterprise login works after backend restart\./);
      assert.match(basePrompt, /Project Memory guidance:/);
    } finally {
      fs.rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it('omits app info and memory sections when disabled in project config', () => {
    const repoRoot = createRepo(
      {
        '.qpanda/APPINFO.md': 'secret app info',
        '.qpanda/MEMORY.md': 'secret memory',
      },
      { appInfoEnabled: false, memoryEnabled: false }
    );

    try {
      const workerPrompt = buildAgentWorkerSystemPrompt(
        { name: 'Developer', system_prompt: 'You are a dev.' },
        { repoRoot },
        buildPromptsDirs(repoRoot)
      );
      assert.doesNotMatch(workerPrompt, /Project App Info:/);
      assert.doesNotMatch(workerPrompt, /Project Memory:/);
      assert.doesNotMatch(workerPrompt, /Project Memory guidance:/);

      const basePrompt = buildCopilotBasePrompt({ repoRoot });
      assert.doesNotMatch(basePrompt, /Project App Info:/);
      assert.doesNotMatch(basePrompt, /Project Memory:/);
    } finally {
      fs.rmSync(repoRoot, { recursive: true, force: true });
    }
  });
});
