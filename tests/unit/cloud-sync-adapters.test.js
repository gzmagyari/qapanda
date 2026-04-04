const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createCloudBoundary } = require('../../src/cloud');
const {
  issueFromPayload,
  projectAgentsFilePath,
  projectMcpFilePath,
  projectModesFilePath,
  projectPromptsDir,
  projectWorkflowsDir,
  PROJECT_SYNC_SETTING_KEYS,
  tasksFilePath,
  testsFilePath,
} = require('../../src/cloud/sync-adapters');
const { appInfoPath, memoryPath, projectConfigPath } = require('../../src/project-context');

function makeTempRepoRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'qapanda-cloud-adapters-'));
}

function writeJson(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
}

function writeWorkflow(repoRoot, dirName, content) {
  const filePath = path.join(projectWorkflowsDir(repoRoot), dirName, 'WORKFLOW.md');
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, 'utf8');
  return filePath;
}

async function createAdapters(repoRoot) {
  const boundary = createCloudBoundary({ target: 'cli', repoRoot, env: {} });
  return boundary.createRepositorySyncAdapters({
    identityOptions: {
      git: {
        localPath: repoRoot,
        remoteUrl: 'https://github.com/QA-Panda/cc-manager.git',
        branchName: 'main',
      },
    },
  });
}

describe('createRepositorySyncAdapters', () => {
  it('queues cloud mutations for local issues, tests, and recipes', async () => {
    const repoRoot = makeTempRepoRoot();
    writeJson(tasksFilePath(repoRoot), {
      nextId: 2,
      nextCommentId: 2,
      nextProgressId: 2,
      tasks: [{
        id: 'task-1',
        title: 'Investigate login bug',
        description: 'Look at the redirect loop',
        detail_text: 'User gets stuck on callback page.',
        status: 'todo',
        created_at: '2026-04-04T10:00:00.000Z',
        updated_at: '2026-04-04T11:00:00.000Z',
        comments: [{ id: 1, author: 'alex', text: 'Needs triage', created_at: '2026-04-04T10:30:00.000Z' }],
        progress_updates: [{ id: 1, author: 'alex', text: 'Captured logs', created_at: '2026-04-04T10:45:00.000Z' }],
      }],
    });
    writeJson(testsFilePath(repoRoot), {
      nextId: 2,
      nextStepId: 3,
      nextRunId: 1,
      tests: [{
        id: 'test-1',
        title: 'Login flow',
        description: 'Browser smoke test',
        environment: 'browser',
        status: 'untested',
        steps: [
          { id: 1, description: 'Open login page', expectedResult: 'Login form appears', status: 'untested', actualResult: null },
          { id: 2, description: 'Submit valid credentials', expectedResult: 'User lands on dashboard', status: 'untested', actualResult: null },
        ],
        linkedTaskIds: ['task-1'],
        tags: ['smoke'],
        lastTestedAt: null,
        lastTestedBy: null,
        created_at: '2026-04-04T09:00:00.000Z',
        updated_at: '2026-04-04T09:15:00.000Z',
        runs: [],
      }],
    });
    writeWorkflow(repoRoot, 'release-checklist', `---
name: Release Checklist
description: Validate release readiness
---

# Release Checklist

Ship it.`);

    const adapters = await createAdapters(repoRoot);
    try {
      const issue = issueFromPayload({
        id: 'task-1',
        title: 'Investigate login bug',
        description: 'Look at the redirect loop',
        detailText: 'User gets stuck on callback page.',
        status: 'todo',
        createdAt: '2026-04-04T10:00:00.000Z',
        updatedAt: '2026-04-04T11:00:00.000Z',
        comments: [{ id: 1, author: 'alex', text: 'Needs triage', created_at: '2026-04-04T10:30:00.000Z' }],
        progressUpdates: [{ id: 1, author: 'alex', text: 'Captured logs', created_at: '2026-04-04T10:45:00.000Z' }],
      }, 'task-1');
      const localTest = JSON.parse(fs.readFileSync(testsFilePath(repoRoot), 'utf8')).tests[0];
      const localRecipe = adapters.recipes.listLocal()[0];

      adapters.issues.queueUpsert(issue);
      adapters.tests.queueUpsert(localTest);
      adapters.recipes.queueUpsert(localRecipe);

      const pending = adapters.store.listPendingMutations();
      assert.equal(pending.length, 3);
      assert.deepEqual(pending.map((item) => item.objectType).sort(), ['issue', 'recipe', 'test']);
      assert.equal(pending.find((item) => item.objectType === 'recipe').payload.name, 'Release Checklist');
    } finally {
      adapters.close();
    }
  });

  it('creates tombstone mutations for local deletes', async () => {
    const repoRoot = makeTempRepoRoot();
    const adapters = await createAdapters(repoRoot);
    try {
      adapters.issues.queueDelete('task-7', { id: 'task-7', title: 'Old issue' });
      adapters.tests.queueDelete('test-9', { id: 'test-9', title: 'Old test' });
      adapters.recipes.queueDelete('legacy-recipe', { id: 'legacy-recipe', title: 'Legacy Recipe' });

      const pending = adapters.store.listPendingMutations();
      assert.equal(pending.length, 3);
      assert.ok(pending.every((item) => item.action === 'delete'));
      assert.ok(adapters.store.listObjects().every((item) => item.deletedAt));
    } finally {
      adapters.close();
    }
  });

  it('hydrates remote changes back into local tests, issues, and recipes', async () => {
    const repoRoot = makeTempRepoRoot();
    const adapters = await createAdapters(repoRoot);
    try {
      adapters.applyRemoteEntries([
        {
          sequenceNo: 10,
          objectType: 'issue',
          objectId: 'task-2',
          action: 'upsert',
          createdAt: '2026-04-04T12:00:00.000Z',
          payload: {
            id: 'task-2',
            title: 'Remote issue',
            description: 'Synced from cloud',
            detailText: 'Needs follow-up',
            status: 'in_progress',
            createdAt: '2026-04-04T12:00:00.000Z',
            updatedAt: '2026-04-04T12:05:00.000Z',
            comments: [],
            progressUpdates: [],
          },
        },
        {
          sequenceNo: 11,
          objectType: 'test',
          objectId: 'test-2',
          action: 'upsert',
          createdAt: '2026-04-04T12:01:00.000Z',
          payload: {
            id: 'test-2',
            title: 'Remote test',
            description: 'Hydrated from sync store',
            environment: 'browser',
            status: 'passed',
            steps: [{ id: 1, description: 'Run smoke', expectedResult: 'Pass', status: 'pass', actualResult: 'Pass' }],
            linkedTaskIds: ['task-2'],
            tags: ['remote'],
            lastTestedAt: '2026-04-04T12:03:00.000Z',
            lastTestedBy: 'cloud',
            createdAt: '2026-04-04T12:01:00.000Z',
            updatedAt: '2026-04-04T12:04:00.000Z',
            runs: [],
          },
        },
        {
          sequenceNo: 12,
          objectType: 'recipe',
          objectId: 'triage-playbook',
          action: 'upsert',
          createdAt: '2026-04-04T12:02:00.000Z',
          payload: {
            id: 'triage-playbook',
            title: 'Triage Playbook',
            name: 'Triage Playbook',
            description: 'Remote workflow',
            directoryName: 'triage-playbook',
            content: `---\nname: Triage Playbook\ndescription: Remote workflow\n---\n\n# Triage`,
          },
        },
      ]);

      const tasksData = JSON.parse(fs.readFileSync(tasksFilePath(repoRoot), 'utf8'));
      const testsData = JSON.parse(fs.readFileSync(testsFilePath(repoRoot), 'utf8'));
      const workflowPath = path.join(projectWorkflowsDir(repoRoot), 'triage-playbook', 'WORKFLOW.md');

      assert.equal(tasksData.tasks.length, 1);
      assert.equal(tasksData.tasks[0].title, 'Remote issue');
      assert.equal(testsData.tests.length, 1);
      assert.equal(testsData.tests[0].title, 'Remote test');
      assert.equal(fs.existsSync(workflowPath), true);
      assert.match(fs.readFileSync(workflowPath, 'utf8'), /Triage Playbook/);
    } finally {
      adapters.close();
    }
  });

  it('surfaces sync conflicts instead of hiding them', async () => {
    const repoRoot = makeTempRepoRoot();
    const adapters = await createAdapters(repoRoot);
    try {
      adapters.setConflicts([
        {
          conflictId: 'conflict-1',
          objectType: 'test',
          objectId: 'test-1',
          status: 'open',
          createdAt: '2026-04-04T12:00:00.000Z',
          updatedAt: '2026-04-04T12:00:00.000Z',
        },
      ]);

      assert.equal(adapters.listConflicts().length, 1);
      assert.equal(adapters.tests.listConflicts().length, 1);
      assert.equal(adapters.issues.listConflicts().length, 0);

      adapters.resolveConflict('conflict-1');
      assert.equal(adapters.listConflicts()[0].status, 'resolved');
    } finally {
      adapters.close();
    }
  });

  it('syncs project agents, project MCP, project modes, prompt templates, app info, memory, and repo settings', async () => {
    const repoRoot = makeTempRepoRoot();
    writeJson(projectAgentsFilePath(repoRoot), {
      reviewer: {
        name: 'Reviewer',
        description: 'Reviews changes',
        system_prompt: 'Review code carefully.',
        enabled: true,
        cli: 'codex',
        mcps: {},
      },
    });
    writeJson(projectMcpFilePath(repoRoot), {
      docs: {
        command: 'node',
        args: ['docs-mcp.js'],
        target: 'both',
      },
    });
    writeJson(projectModesFilePath(repoRoot), {
      'repo-review': {
        name: 'Repo Review',
        description: 'Review changes in this repo',
        category: 'develop',
        useController: true,
        availableAgents: ['reviewer'],
        enabled: true,
      },
    });
    fs.mkdirSync(projectPromptsDir(repoRoot), { recursive: true });
    fs.writeFileSync(path.join(projectPromptsDir(repoRoot), 'triage.md'), 'Local triage prompt\n', 'utf8');
    fs.mkdirSync(path.dirname(appInfoPath(repoRoot)), { recursive: true });
    fs.writeFileSync(appInfoPath(repoRoot), 'App URL: http://localhost:3000\n', 'utf8');
    fs.writeFileSync(memoryPath(repoRoot), 'Remember the seeded demo user.\n', 'utf8');
    writeJson(projectConfigPath(repoRoot), {
      appInfoEnabled: true,
      memoryEnabled: true,
      cloudContextMode: 'branch',
      cloudContextLabel: 'main branch',
    });

    const adapters = await createAdapters(repoRoot);
    try {
      adapters.importAllLocal();

      const pending = adapters.store.listPendingMutations();
      assert.deepEqual(
        pending.map((item) => item.objectType).sort(),
        ['agent', 'app_info', 'mcp_server', 'mode', 'project_memory', 'project_setting', 'project_setting', 'prompt_template']
      );

      adapters.applyRemoteEntries([
        {
          sequenceNo: 21,
          objectType: 'agent',
          objectId: 'qa-remote',
          action: 'upsert',
          createdAt: '2026-04-04T12:10:00.000Z',
          payload: {
            id: 'qa-remote',
            name: 'Remote QA',
            description: 'Remote QA agent',
            systemPrompt: 'Run regression checks.',
            cli: 'claude',
            enabled: true,
            mcps: {},
          },
        },
        {
          sequenceNo: 22,
          objectType: 'mcp_server',
          objectId: 'remote-api',
          action: 'upsert',
          createdAt: '2026-04-04T12:11:00.000Z',
          payload: {
            id: 'remote-api',
            type: 'http',
            url: 'http://127.0.0.1:4010/mcp',
            target: 'worker',
          },
        },
        {
          sequenceNo: 23,
          objectType: 'mode',
          objectId: 'remote-mode',
          action: 'upsert',
          createdAt: '2026-04-04T12:11:30.000Z',
          payload: {
            id: 'remote-mode',
            name: 'Remote Mode',
            description: 'Remote synced mode',
            category: 'test',
            useController: false,
            availableAgents: ['qa-remote'],
            requiresTestEnv: true,
            enabled: true,
          },
        },
        {
          sequenceNo: 24,
          objectType: 'prompt_template',
          objectId: 'release',
          action: 'upsert',
          createdAt: '2026-04-04T12:11:45.000Z',
          payload: {
            id: 'release',
            fileName: 'release.md',
            title: 'release',
            content: 'Remote release prompt',
          },
        },
        {
          sequenceNo: 25,
          objectType: 'app_info',
          objectId: 'project-app-info',
          action: 'upsert',
          createdAt: '2026-04-04T12:12:00.000Z',
          payload: {
            id: 'project-app-info',
            content: 'Remote app info',
            enabled: false,
          },
        },
        {
          sequenceNo: 26,
          objectType: 'project_memory',
          objectId: 'project-memory',
          action: 'upsert',
          createdAt: '2026-04-04T12:13:00.000Z',
          payload: {
            id: 'project-memory',
            content: 'Remote memory',
            enabled: true,
          },
        },
        {
          sequenceNo: 27,
          objectType: 'project_setting',
          objectId: 'cloudContextMode',
          action: 'upsert',
          createdAt: '2026-04-04T12:14:00.000Z',
          payload: {
            id: 'cloudContextMode',
            key: 'cloudContextMode',
            value: 'custom',
          },
        },
        {
          sequenceNo: 28,
          objectType: 'project_setting',
          objectId: 'cloudContextKey',
          action: 'upsert',
          createdAt: '2026-04-04T12:14:30.000Z',
          payload: {
            id: 'cloudContextKey',
            key: 'cloudContextKey',
            value: 'release-train',
          },
        },
      ]);

      const projectAgents = JSON.parse(fs.readFileSync(projectAgentsFilePath(repoRoot), 'utf8'));
      const projectMcp = JSON.parse(fs.readFileSync(projectMcpFilePath(repoRoot), 'utf8'));
      const projectModes = JSON.parse(fs.readFileSync(projectModesFilePath(repoRoot), 'utf8'));
      const projectConfig = JSON.parse(fs.readFileSync(projectConfigPath(repoRoot), 'utf8'));

      assert.equal(projectAgents['qa-remote'].name, 'Remote QA');
      assert.equal(projectMcp['remote-api'].url, 'http://127.0.0.1:4010/mcp');
      assert.equal(projectModes['remote-mode'].name, 'Remote Mode');
      assert.equal(fs.readFileSync(path.join(projectPromptsDir(repoRoot), 'release.md'), 'utf8'), 'Remote release prompt');
      assert.equal(fs.readFileSync(appInfoPath(repoRoot), 'utf8'), 'Remote app info');
      assert.equal(fs.readFileSync(memoryPath(repoRoot), 'utf8'), 'Remote memory');
      assert.equal(projectConfig.appInfoEnabled, false);
      assert.equal(projectConfig.cloudContextMode, 'custom');
      assert.equal(projectConfig.cloudContextKey, 'release-train');
      assert.ok(PROJECT_SYNC_SETTING_KEYS.includes('cloudContextMode'));
    } finally {
      adapters.close();
    }
  });
});
