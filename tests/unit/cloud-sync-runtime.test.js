const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createCloudBoundary } = require('../../src/cloud');
const { projectModesFilePath, projectPromptsDir, projectWorkflowsDir, tasksFilePath, testsFilePath } = require('../../src/cloud/sync-adapters');
const { projectConfigPath } = require('../../src/project-context');

function makeTempRepoRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'qapanda-cloud-runtime-'));
}

function writeJson(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
}

function writeWorkflow(repoRoot, dirName, content) {
  const filePath = path.join(projectWorkflowsDir(repoRoot), dirName, 'WORKFLOW.md');
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, 'utf8');
}

async function createRuntimeHarness(options = {}) {
  const repoRoot = options.repoRoot || makeTempRepoRoot();
  const boundary = createCloudBoundary({ target: options.target || 'cli', repoRoot, env: {} });
  const git = {
    localPath: repoRoot,
    remoteUrl: 'https://github.com/QA-Panda/cc-manager.git',
    branchName: 'main',
  };
  const repository = await boundary.getRepositoryIdentity({ git });
  const calls = {
    register: [],
    sync: [],
    heartbeat: [],
    notifications: [],
    getNotifications: [],
    getConflicts: [],
    resolve: [],
  };
  const timers = [];
  const fakeApi = {
    sdk: {
      withHeaders() {
        return this;
      },
      async registerRepositoryCheckout(input) {
        calls.register.push(input);
        return {
          repository: { id: 'repo-1' },
          identity: repository.identity,
          repositoryContext: { id: 'context-1' },
          checkout: { checkoutId: 'checkout-1' },
          nextCursorSequence: 0,
        };
      },
      async exchangeRepositorySync(input) {
        calls.sync.push(input);
        if (typeof options.onExchange === 'function') {
          return options.onExchange(input);
        }
        return {
          repositoryContext: { id: 'context-1' },
          checkout: { checkoutId: 'checkout-1' },
          acceptedMutationIds: input.mutations.map((mutation) => mutation.mutationId),
          rejectedMutations: [],
          remoteEntries: [
            {
              sequenceNo: 7,
              objectType: 'issue',
              objectId: 'task-remote',
              action: 'upsert',
              createdAt: '2026-04-04T12:30:00.000Z',
              payload: {
                id: 'task-remote',
                title: 'Remote issue',
                description: 'Synced from cloud',
                detailText: 'Server copy',
                status: 'in_progress',
                createdAt: '2026-04-04T12:30:00.000Z',
                updatedAt: '2026-04-04T12:30:30.000Z',
                comments: [],
                progressUpdates: [],
              },
            },
          ],
          nextCursorSequenceNo: 7,
          conflicts: [
            {
              conflictId: 'conflict-1',
              workspaceId: 'repo-1',
              repositoryId: 'repo-1',
              repositoryContextId: 'context-1',
              objectType: 'issue',
              objectId: 'task-remote',
              conflictCode: 'client_remote_conflict',
              status: 'open',
              clientMutationId: input.mutations[0] ? input.mutations[0].mutationId : 'mutation-1',
              checkoutId: 'checkout-1',
              localPayload: { title: 'Local issue' },
              remotePayload: { title: 'Remote issue' },
              resolution: null,
              createdAt: '2026-04-04T12:31:00.000Z',
              updatedAt: '2026-04-04T12:31:00.000Z',
              resolvedAt: null,
            },
          ],
          syncStatus: 'conflict',
        };
      },
      async heartbeatRepositoryCheckout(checkoutId, input) {
        calls.heartbeat.push({ checkoutId, input });
        return { ok: true, checkout: { checkoutId } };
      },
      async getNotificationSummary() {
        calls.notifications.push({ unreadCount: 2 });
        return {
          unreadCount: 2,
          latest: [
            {
              notificationId: 'notification-1',
              eventKey: 'run.failed',
              title: 'Sync needs attention',
              body: 'A synced run needs attention.',
              unread: true,
            },
          ],
        };
      },
      async getNotifications(state) {
        calls.getNotifications.push(state);
        if (typeof options.getNotifications === 'function') {
          return options.getNotifications(state);
        }
        return {
          unreadCount: 2,
          items: [
            {
              notificationId: 'notification-1',
              eventKey: 'run.failed',
              title: 'Sync needs attention',
              body: 'A synced run needs attention.',
              unread: true,
              actionUrl: 'https://app.qapanda.localhost/app/runs/run-1',
            },
          ],
        };
      },
      async getSyncConflicts(repositoryContextId) {
        calls.getConflicts.push(repositoryContextId);
        return {
          conflicts: [
            {
              conflictId: 'conflict-1',
              workspaceId: 'repo-1',
              repositoryId: 'repo-1',
              repositoryContextId,
              objectType: 'issue',
              objectId: 'task-remote',
              conflictCode: 'client_remote_conflict',
              status: 'open',
              clientMutationId: 'mutation-1',
              checkoutId: 'checkout-1',
              localPayload: { title: 'Local issue' },
              remotePayload: { title: 'Remote issue' },
              resolution: null,
              createdAt: '2026-04-04T12:31:00.000Z',
              updatedAt: '2026-04-04T12:31:00.000Z',
              resolvedAt: null,
            },
          ],
        };
      },
      async resolveSyncConflict(conflictId, input) {
        calls.resolve.push({ conflictId, input });
        return {
          ok: true,
          conflict: {
            conflictId,
            status: 'resolved',
          },
          replayEntries: [
            {
              sequenceNo: 8,
              objectType: 'issue',
              objectId: 'task-remote',
              action: 'upsert',
              createdAt: '2026-04-04T12:35:00.000Z',
              payload: {
                id: 'task-remote',
                title: 'Remote issue resolved',
                description: 'Resolved remotely',
                detailText: 'Resolution replay',
                status: 'done',
                createdAt: '2026-04-04T12:30:00.000Z',
                updatedAt: '2026-04-04T12:35:00.000Z',
                comments: [],
                progressUpdates: [],
              },
            },
          ],
        };
      },
    },
  };

  const runtime = await boundary.createRepositorySyncRuntime({
    api: fakeApi,
    identityOptions: { git },
    sessionLoader: options.sessionLoader || (async () => ({
      tokenStore: {
        async load() {
          return null;
        },
      },
      session: {
        email: 'demo@qapanda.local',
        workspaceId: 'workspace-1',
        tokens: {
          accessToken: 'access-token',
          refreshToken: 'refresh-token',
        },
      },
      storageMode: 'json-envelope',
      filePath: path.join(repoRoot, '.qpanda', 'cloud', 'session.json'),
    })),
    disableTimers: options.disableTimers,
    onNotifications: options.onNotifications,
    setIntervalImpl(callback, intervalMs) {
      const handle = { callback, intervalMs, cleared: false };
      timers.push(handle);
      return handle;
    },
    clearIntervalImpl(handle) {
      handle.cleared = true;
    },
  });

  return { repoRoot, boundary, repository, runtime, calls, timers };
}

describe('createRepositorySyncRuntime', () => {
  it('summarizes synced tests, issues, and recipes in runtime status', async () => {
    const { runtime } = await createRuntimeHarness({
      onExchange() {
        return {
          repositoryContext: { id: 'context-1' },
          checkout: { checkoutId: 'checkout-1' },
          acceptedMutationIds: [],
          rejectedMutations: [],
          remoteEntries: [
            {
              sequenceNo: 1,
              objectType: 'issue',
              objectId: 'issue-7',
              action: 'upsert',
              createdAt: '2026-04-08T19:55:00.000Z',
              payload: { id: 'issue-7', title: 'Checkout fails on login' },
            },
            {
              sequenceNo: 2,
              objectType: 'test',
              objectId: 'test-4',
              action: 'upsert',
              createdAt: '2026-04-08T19:56:00.000Z',
              payload: { id: 'test-4', title: 'Verify login flow' },
            },
            {
              sequenceNo: 3,
              objectType: 'recipe',
              objectId: 'recipe-2',
              action: 'upsert',
              createdAt: '2026-04-08T19:57:00.000Z',
              payload: { id: 'recipe-2', title: 'Release smoke' },
            },
          ],
          nextCursorSequenceNo: 3,
          conflicts: [],
          syncStatus: 'synced',
        };
      },
    });
    try {
      const status = await runtime.start();
      assert.deepEqual(status.objectCounts, { tests: 1, issues: 1, recipes: 1 });
      assert.equal(status.recentObjects.length, 3);
      assert.deepEqual(
        status.recentObjects.map((item) => [item.objectType, item.objectId, item.title]),
        [
          ['recipe', 'recipe-2', 'Release smoke'],
          ['issue', 'issue-7', 'Checkout fails on login'],
          ['test', 'test-4', 'Verify login flow'],
        ],
      );
    } finally {
      await runtime.stop();
    }
  });

  it('registers the checkout, syncs local objects, and persists conflicts', async () => {
    const repoRoot = makeTempRepoRoot();
    writeJson(tasksFilePath(repoRoot), {
      nextId: 2,
      nextCommentId: 1,
      nextProgressId: 1,
      tasks: [
        {
          id: 'task-1',
          title: 'Local issue',
          description: 'From tasks.json',
          detail_text: 'Seeded locally',
          status: 'todo',
          created_at: '2026-04-04T10:00:00.000Z',
          updated_at: '2026-04-04T10:00:00.000Z',
          comments: [],
          progress_updates: [],
        },
      ],
    });
    writeJson(testsFilePath(repoRoot), {
      nextId: 2,
      nextStepId: 2,
      nextRunId: 1,
      tests: [
        {
          id: 'test-1',
          title: 'Local test',
          description: 'From tests.json',
          environment: 'browser',
          status: 'untested',
          steps: [{ id: 1, description: 'Open', expectedResult: 'Open', status: 'untested', actualResult: null }],
          linkedTaskIds: [],
          tags: [],
          lastTestedAt: null,
          lastTestedBy: null,
          created_at: '2026-04-04T10:00:00.000Z',
          updated_at: '2026-04-04T10:00:00.000Z',
          runs: [],
        },
      ],
    });
    writeWorkflow(repoRoot, 'triage-playbook', `---
name: Triage Playbook
description: Runtime fixture
---

# Triage`);

    const { runtime, calls } = await createRuntimeHarness({ repoRoot, disableTimers: true });
    try {
      const status = await runtime.start();

      assert.equal(status.started, true);
      assert.equal(status.registered, true);
      assert.equal(calls.register.length, 1);
      assert.equal(calls.register[0].clientKind, 'cli');
      assert.equal(calls.register[0].contextMode, 'shared');
      assert.equal(calls.sync.length, 1);
      assert.equal(calls.sync[0].mutations.length, 3);
      assert.equal(calls.heartbeat.length, 1);
      assert.equal(calls.notifications.length, 1);
      assert.equal(runtime.listConflicts().length, 1);
      assert.equal(runtime.getStatus().indicator.status, 'conflict');
      assert.equal(runtime.getStatus().notificationSummary.unreadCount, 2);

      const tasksData = JSON.parse(fs.readFileSync(tasksFilePath(repoRoot), 'utf8'));
      assert.equal(tasksData.tasks.some((task) => task.id === 'task-remote'), true);
    } finally {
      await runtime.stop();
    }
  });

  it('starts periodic sync and heartbeat timers and can heartbeat on demand', async () => {
    const { runtime, calls, timers } = await createRuntimeHarness();
    try {
      await runtime.start();

      assert.equal(timers.length, 2);
      assert.equal(timers[0].intervalMs, 15000);
      assert.equal(timers[1].intervalMs, 45000);

      await runtime.heartbeatNow();
      assert.equal(calls.heartbeat.length, 2);

      await runtime.stop();
      assert.equal(timers.every((timer) => timer.cleared), true);
    } finally {
      await runtime.stop();
    }
  });

  it('refreshes and resolves conflicts through the shared sync client', async () => {
    const { repoRoot, runtime, calls } = await createRuntimeHarness({ disableTimers: true });
    try {
      await runtime.start();

      const refreshed = await runtime.refreshConflicts();
      assert.equal(refreshed.length, 1);
      assert.equal(calls.getConflicts.length, 1);

      const resolved = await runtime.resolveConflict('conflict-1', 'take_remote');
      assert.equal(calls.resolve.length, 1);
      assert.equal(calls.resolve[0].input.resolution, 'take_remote');
      assert.equal(resolved[0].status, 'resolved');

      const tasksData = JSON.parse(fs.readFileSync(tasksFilePath(repoRoot), 'utf8'));
      assert.equal(tasksData.tasks.find((task) => task.id === 'task-remote').title, 'Remote issue resolved');
    } finally {
      await runtime.stop();
    }
  });

  it('does not start persistent sync without a stored session', async () => {
    const { runtime } = await createRuntimeHarness({
      disableTimers: true,
      sessionLoader: async () => ({
        tokenStore: null,
        session: null,
        storageMode: null,
        filePath: null,
      }),
    });

    const status = await runtime.start();
    assert.equal(status.started, false);
    assert.equal(status.reason, 'not_logged_in');
    assert.equal(status.registered, false);
  });

  it('re-imports repo-owned local files on later sync ticks', async () => {
    const repoRoot = makeTempRepoRoot();
    const { runtime, calls } = await createRuntimeHarness({ repoRoot, disableTimers: true });
    try {
      await runtime.start();
      assert.equal(calls.sync.length, 1);

      writeJson(projectModesFilePath(repoRoot), {
        'sync-review': {
          name: 'Sync Review',
          description: 'Review after login',
          category: 'develop',
          enabled: true,
        },
      });
      fs.mkdirSync(projectPromptsDir(repoRoot), { recursive: true });
      fs.writeFileSync(path.join(projectPromptsDir(repoRoot), 'followup.md'), 'Follow-up prompt', 'utf8');

      await runtime.tick();
      assert.equal(calls.sync.length, 2);
      assert.deepEqual(
        calls.sync[1].mutations.map((mutation) => mutation.objectType).sort(),
        ['mode', 'prompt_template']
      );
    } finally {
      await runtime.stop();
    }
  });

  it('hydrates remote repo-owned objects on a fresh empty checkout before treating local files as deletes', async () => {
    const repoRoot = makeTempRepoRoot();
    writeJson(projectConfigPath(repoRoot), {
      cloudContextMode: 'custom',
      cloudContextKey: 'fresh-empty-context',
      cloudContextLabel: 'Fresh Empty Context',
    });
    const { runtime, calls } = await createRuntimeHarness({
      repoRoot,
      disableTimers: true,
      onExchange(input) {
        return {
          repositoryContext: { id: 'context-1' },
          checkout: { checkoutId: 'checkout-1' },
          acceptedMutationIds: [],
          rejectedMutations: [],
          remoteEntries: input.cursorSequenceNo === 0
            ? [
                {
                  sequenceNo: 42,
                  objectType: 'agent',
                  objectId: 'agent-remote',
                  action: 'upsert',
                  createdAt: '2026-04-04T13:00:00.000Z',
                  payload: {
                    id: 'agent-remote',
                    title: 'Remote Agent',
                    name: 'Remote Agent',
                    prompt: 'Hydrated from cloud',
                    scope: 'project',
                  },
                },
              ]
            : [],
          nextCursorSequenceNo: input.cursorSequenceNo === 0 ? 42 : input.cursorSequenceNo,
          conflicts: [],
          syncStatus: 'healthy',
        };
      },
    });

    try {
      await runtime.start();

      assert.equal(calls.sync.length, 1);
      assert.equal(calls.sync[0].cursorSequenceNo, 0);
      assert.equal(calls.sync[0].mutations.length, 0);

      const agentsPath = path.join(repoRoot, '.qpanda', 'agents.json');
      const agentsData = JSON.parse(fs.readFileSync(agentsPath, 'utf8'));
      assert.equal(agentsData['agent-remote'].name, 'Remote Agent');
      assert.equal(runtime.getStatus().pendingMutationCount, 0);
    } finally {
      await runtime.stop();
    }
  });

  it('does not re-queue remotely hydrated objects as local mutations on the next tick', async () => {
    const repoRoot = makeTempRepoRoot();
    let exchangeCount = 0;
    const { runtime, calls } = await createRuntimeHarness({
      repoRoot,
      disableTimers: true,
      onExchange(input) {
        exchangeCount += 1;
        if (exchangeCount === 1) {
          return {
            repositoryContext: { id: 'context-1' },
            checkout: { checkoutId: 'checkout-1' },
            acceptedMutationIds: input.mutations.map((mutation) => mutation.mutationId),
            rejectedMutations: [],
            remoteEntries: [],
            nextCursorSequenceNo: 0,
            conflicts: [],
            syncStatus: 'healthy',
          };
        }
        if (exchangeCount === 2) {
          return {
            repositoryContext: { id: 'context-1' },
            checkout: { checkoutId: 'checkout-1' },
            acceptedMutationIds: [],
            rejectedMutations: [],
            remoteEntries: [
              {
                sequenceNo: 5,
                objectType: 'issue',
                objectId: 'task-remote-followup',
                action: 'upsert',
                createdAt: '2026-04-04T13:10:00.000Z',
                payload: {
                  id: 'task-remote-followup',
                  title: 'Remote follow-up',
                  description: 'Hydrated during tick',
                  detailText: 'Pulled from cloud',
                  status: 'todo',
                  createdAt: '2026-04-04T13:10:00.000Z',
                  updatedAt: '2026-04-04T13:10:00.000Z',
                  comments: [],
                  progressUpdates: [],
                },
              },
            ],
            nextCursorSequenceNo: 5,
            conflicts: [],
            syncStatus: 'healthy',
          };
        }
        return {
          repositoryContext: { id: 'context-1' },
          checkout: { checkoutId: 'checkout-1' },
          acceptedMutationIds: [],
          rejectedMutations: [],
          remoteEntries: [],
          nextCursorSequenceNo: input.cursorSequenceNo,
          conflicts: [],
          syncStatus: 'healthy',
        };
      },
    });

    try {
      await runtime.start();
      await runtime.tick();

      const tasksAfterPull = JSON.parse(fs.readFileSync(tasksFilePath(repoRoot), 'utf8'));
      assert.equal(tasksAfterPull.tasks.some((task) => task.id === 'task-remote-followup'), true);

      await runtime.tick();
      assert.equal(calls.sync.length, 3);
      assert.equal(calls.sync[2].mutations.length, 0);
    } finally {
      await runtime.stop();
    }
  });

  it('does not re-queue hydrated project agents, MCP servers, or modes on the next tick', async () => {
    const repoRoot = makeTempRepoRoot();
    let exchangeCount = 0;
    const { runtime, calls } = await createRuntimeHarness({
      repoRoot,
      disableTimers: true,
      onExchange(input) {
        exchangeCount += 1;
        if (exchangeCount === 1) {
          return {
            repositoryContext: { id: 'context-1' },
            checkout: { checkoutId: 'checkout-1' },
            acceptedMutationIds: [],
            rejectedMutations: [],
            remoteEntries: [
              {
                sequenceNo: 11,
                objectType: 'agent',
                objectId: 'agent-remote-followup',
                action: 'upsert',
                createdAt: '2026-04-04T13:20:00.000Z',
                payload: {
                  id: 'agent-remote-followup',
                  title: 'Remote Agent',
                  name: 'Remote Agent',
                  description: 'Hydrated from cloud',
                  systemPrompt: 'Keep the remote prompt',
                  enabled: true,
                  mcps: {},
                  cli: 'codex',
                  updatedAt: '2026-04-04T13:20:00.000Z',
                },
              },
              {
                sequenceNo: 12,
                objectType: 'mcp_server',
                objectId: 'mcp-remote-followup',
                action: 'upsert',
                createdAt: '2026-04-04T13:21:00.000Z',
                payload: {
                  id: 'mcp-remote-followup',
                  title: 'mcp-remote-followup',
                  command: 'node',
                  args: ['server.js'],
                  env: { MODE: 'remote' },
                  target: 'both',
                  updatedAt: '2026-04-04T13:21:00.000Z',
                },
              },
              {
                sequenceNo: 13,
                objectType: 'mode',
                objectId: 'mode-remote-followup',
                action: 'upsert',
                createdAt: '2026-04-04T13:22:00.000Z',
                payload: {
                  id: 'mode-remote-followup',
                  title: 'Remote Mode',
                  name: 'Remote Mode',
                  description: 'Hydrated mode',
                  category: 'develop',
                  useController: false,
                  availableAgents: ['agent-remote-followup'],
                  requiresTestEnv: false,
                  controllerPrompt: '',
                  enabled: true,
                  updatedAt: '2026-04-04T13:22:00.000Z',
                },
              },
            ],
            nextCursorSequenceNo: 13,
            conflicts: [],
            syncStatus: 'healthy',
          };
        }
        return {
          repositoryContext: { id: 'context-1' },
          checkout: { checkoutId: 'checkout-1' },
          acceptedMutationIds: [],
          rejectedMutations: [],
          remoteEntries: [],
          nextCursorSequenceNo: input.cursorSequenceNo,
          conflicts: [],
          syncStatus: 'healthy',
        };
      },
    });

    try {
      await runtime.start();

      const agents = JSON.parse(fs.readFileSync(path.join(repoRoot, '.qpanda', 'agents.json'), 'utf8'));
      const mcp = JSON.parse(fs.readFileSync(path.join(repoRoot, '.qpanda', 'mcp.json'), 'utf8'));
      const modes = JSON.parse(fs.readFileSync(path.join(repoRoot, '.qpanda', 'modes.json'), 'utf8'));
      assert.equal(agents['agent-remote-followup'].updatedAt, '2026-04-04T13:20:00.000Z');
      assert.equal(mcp['mcp-remote-followup'].updatedAt, '2026-04-04T13:21:00.000Z');
      assert.equal(modes['mode-remote-followup'].updatedAt, '2026-04-04T13:22:00.000Z');

      await runtime.tick();
      assert.equal(calls.sync.length, 2);
      assert.equal(calls.sync[1].mutations.length, 0);
    } finally {
      await runtime.stop();
    }
  });

  it('baselines existing unread notifications on start and emits only newly unread items on later ticks', async () => {
    const notificationBatches = [];
    let notificationPoll = 0;
    const { runtime, calls } = await createRuntimeHarness({
      disableTimers: true,
      onNotifications(batch) {
        notificationBatches.push(batch);
      },
      getNotifications(state) {
        assert.equal(state, 'unread');
        notificationPoll += 1;
        if (notificationPoll === 1) {
          return {
            unreadCount: 1,
            items: [
              {
                notificationId: 'notification-old',
                eventKey: 'run.failed',
                title: 'Existing failure',
                body: 'Existing unread item.',
                unread: true,
                actionUrl: 'https://app.qapanda.localhost/app/runs/run-old',
              },
            ],
          };
        }
        return {
          unreadCount: 2,
          items: [
            {
              notificationId: 'notification-old',
              eventKey: 'run.failed',
              title: 'Existing failure',
              body: 'Existing unread item.',
              unread: true,
              actionUrl: 'https://app.qapanda.localhost/app/runs/run-old',
            },
            {
              notificationId: 'notification-new',
              eventKey: 'schedule.attention',
              title: 'Schedule needs attention',
              body: 'A schedule missed its last run.',
              unread: true,
              actionUrl: 'https://app.qapanda.localhost/app/schedules/schedule-1',
            },
          ],
        };
      },
    });

    try {
      await runtime.start();
      assert.equal(notificationBatches.length, 0);

      await runtime.tick();

      assert.equal(calls.getNotifications.length >= 2, true);
      assert.equal(notificationBatches.length, 1);
      assert.deepEqual(
        notificationBatches[0].items.map((item) => item.notificationId),
        ['notification-new'],
      );
      assert.equal(notificationBatches[0].summary.unreadCount, 2);
    } finally {
      await runtime.stop();
    }
  });
});
