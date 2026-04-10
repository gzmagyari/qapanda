const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createCloudBoundary } = require('../../src/cloud');
const {
  createCliTokenStore,
  listCliCloudWorkspaces,
  loginCliCloud,
  logoutCliCloud,
  resolveHostedCloudUrl,
  runCloudCommand,
  statusCliCloud,
  switchCliCloudWorkspace,
  whoamiCliCloud,
} = require('../../src/cloud/cli-auth');

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'qapanda-cloud-auth-'));
}

function makeSession(overrides = {}) {
  return {
    tokens: {
      accessToken: 'access-token',
      refreshToken: 'refresh-token',
      accessExpiresAt: '2026-04-05T00:00:00.000Z',
      refreshExpiresAt: '2026-05-05T00:00:00.000Z',
    },
    actorId: 'actor-1',
    workspaceId: 'workspace-1',
    email: 'dev@example.com',
    updatedAt: '2026-04-04T00:00:00.000Z',
    ...overrides,
  };
}

function makeCurrentActorResponse(overrides = {}) {
  return {
    actor: {
      id: 'actor-1',
      email: 'dev@example.com',
      displayName: 'Dev User',
      provider: 'github',
      providerSubject: '123',
      isDisabled: false,
    },
    session: {
      sessionId: 'session-1',
      deviceId: 'device-1',
      clientKind: 'cli',
      deviceName: 'Dev box',
      issuedAt: '2026-04-04T00:00:00.000Z',
      accessExpiresAt: '2026-04-05T00:00:00.000Z',
      refreshExpiresAt: '2026-05-05T00:00:00.000Z',
      lastSeenAt: '2026-04-04T00:00:00.000Z',
      currentWorkspaceId: 'workspace-1',
      revokedAt: null,
      ...(overrides.session || {}),
    },
    memberships: overrides.memberships || [
      {
        workspaceId: 'workspace-1',
        slug: 'demo-workspace',
        name: 'Demo Workspace',
        planTier: 'pro',
        roleKey: 'admin',
        isBillingAdmin: true,
        entitlements: [],
        entitlementMap: {},
      },
      {
        workspaceId: 'workspace-2',
        slug: 'qa-team',
        name: 'QA Team',
        planTier: 'enterprise',
        roleKey: 'member',
        isBillingAdmin: false,
        entitlements: [],
        entitlementMap: {},
      },
    ],
    currentWorkspace: {
      workspaceId: 'workspace-1',
      slug: 'demo-workspace',
      name: 'Demo Workspace',
      planTier: 'pro',
      roleKey: 'admin',
      isBillingAdmin: true,
      entitlements: [],
      entitlementMap: {},
      ...(overrides.currentWorkspace || {}),
    },
    ...(overrides.extra || {}),
  };
}

function makeWriter() {
  let text = '';
  return {
    write(chunk) {
      text += String(chunk);
    },
    toString() {
      return text;
    },
  };
}

describe('createCliTokenStore', () => {
  it('persists the CLI cloud session with an encrypted file envelope', async () => {
    const tmpDir = makeTempDir();
    const sessionFile = path.join(tmpDir, 'session.json');
    const boundary = createCloudBoundary({ target: 'cli', env: {} });
    const env = {
      QAPANDA_CLOUD_SESSION_FILE: sessionFile,
      QAPANDA_CLOUD_SESSION_KEY: 'test-secret',
    };

    const first = await createCliTokenStore(boundary, { env });
    await first.tokenStore.save(makeSession());

    const second = await createCliTokenStore(boundary, { env });
    const loaded = await second.tokenStore.load();

    assert.equal(second.storageMode, 'encrypted');
    assert.equal(loaded.email, 'dev@example.com');
    assert.notEqual(fs.readFileSync(sessionFile, 'utf8').includes('access-token'), true);
  });
});

describe('loginCliCloud', () => {
  it('defaults login to PKCE and stores the returned session securely', async () => {
    const tmpDir = makeTempDir();
    const sessionFile = path.join(tmpDir, 'session.json');
    const env = {
      QAPANDA_CLOUD_SESSION_FILE: sessionFile,
      QAPANDA_CLOUD_SESSION_KEY: 'test-secret',
    };
    const baseBoundary = createCloudBoundary({ target: 'cli', env: {} });
    const packages = await baseBoundary.loadPackages();
    const boundary = {
      config: { ...baseBoundary.config, authMode: 'disabled' },
      async loadPackages() {
        return {
          ...packages,
          clientCloud: {
            ...packages.clientCloud,
            async startBrowserPkceLogin(input) {
              await input.tokenStore.save(makeSession());
              return { session: makeSession(), callbackUrl: 'http://127.0.0.1:43111/qapanda-cloud-callback' };
            },
          },
        };
      },
      async createApiClient() {
        return { sdk: {} };
      },
    };

    const result = await loginCliCloud(boundary, {
      env,
      openExternal: async () => {},
      stdout: makeWriter(),
    });

    assert.equal(result.method, 'pkce');
    assert.equal(result.storageMode, 'encrypted');
    const stored = await (await createCliTokenStore(baseBoundary, { env })).tokenStore.load();
    assert.equal(stored.email, 'dev@example.com');
  });

  it('falls back to device approval when browser login is unavailable', async () => {
    const tmpDir = makeTempDir();
    const sessionFile = path.join(tmpDir, 'session.json');
    const env = {
      QAPANDA_CLOUD_SESSION_FILE: sessionFile,
      QAPANDA_CLOUD_SESSION_KEY: 'test-secret',
    };
    const baseBoundary = createCloudBoundary({ target: 'cli', env: {} });
    const packages = await baseBoundary.loadPackages();
    const stdout = makeWriter();
    const boundary = {
      config: { ...baseBoundary.config, authMode: 'disabled' },
      async loadPackages() {
        return {
          ...packages,
          clientCloud: {
            ...packages.clientCloud,
            async startBrowserPkceLogin() {
              throw new Error('browser unavailable');
            },
            async startDeviceCodeLogin(input) {
              input.onPending?.({
                status: 'pending',
                intervalSeconds: 1,
                verificationUri: 'https://app.qapanda.localhost/device',
                userCode: 'ABCD-EFGH',
              });
              await input.tokenStore.save(makeSession());
              return {
                session: makeSession(),
                verificationUri: 'https://app.qapanda.localhost/device',
                userCode: 'ABCD-EFGH',
              };
            },
          },
        };
      },
      async createApiClient() {
        return { sdk: {} };
      },
    };

    const result = await loginCliCloud(boundary, {
      env,
      openExternal: async () => {},
      stdout,
    });

    assert.equal(result.method, 'device_code');
    assert.equal(result.fallbackFrom, 'pkce');
    assert.match(stdout.toString(), /Falling back to device approval/);
    assert.match(stdout.toString(), /ABCD-EFGH/);
  });
});

describe('whoamiCliCloud', () => {
  it('loads the stored session and returns the current actor payload', async () => {
    const tmpDir = makeTempDir();
    const sessionFile = path.join(tmpDir, 'session.json');
    const env = {
      QAPANDA_CLOUD_SESSION_FILE: sessionFile,
      QAPANDA_CLOUD_SESSION_KEY: 'test-secret',
    };
    const boundary = createCloudBoundary({ target: 'cli', env: {} });
    const { tokenStore } = await createCliTokenStore(boundary, { env });
    await tokenStore.save(makeSession());

    const result = await whoamiCliCloud({
      ...boundary,
      async createApiClient() {
        return {
          sdk: {
            withHeaders() {
              return {
                async getCurrentActor() {
                  return makeCurrentActorResponse();
                },
              };
            },
          },
        };
      },
    }, { env });

    assert.equal(result.currentActor.actor.email, 'dev@example.com');
    assert.equal(result.currentActor.currentWorkspace.slug, 'demo-workspace');
    assert.equal(result.storageMode, 'encrypted');
  });

  it('refreshes and clears the stored session when the existing session is expired', async () => {
    const tmpDir = makeTempDir();
    const sessionFile = path.join(tmpDir, 'session.json');
    const env = {
      QAPANDA_CLOUD_SESSION_FILE: sessionFile,
      QAPANDA_CLOUD_SESSION_KEY: 'test-secret',
    };
    const baseBoundary = createCloudBoundary({ target: 'cli', env: {} });
    const packages = await baseBoundary.loadPackages();
    const { tokenStore } = await createCliTokenStore(baseBoundary, { env });
    await tokenStore.save(makeSession());

    await assert.rejects(() => whoamiCliCloud({
      ...baseBoundary,
      async loadPackages() {
        return {
          ...packages,
          clientCloud: {
            ...packages.clientCloud,
            async refreshCloudSession() {
              throw new Error('refresh revoked');
            },
          },
        };
      },
      async createApiClient() {
        return {
          sdk: {
            withHeaders() {
              return {
                async getCurrentActor() {
                  throw new Error('expired');
                },
              };
            },
          },
        };
      },
    }, { env }), /Stored QA Panda Cloud session expired/);

    assert.equal(await tokenStore.load(), null);
  });
});

describe('workspace-aware CLI sessions', () => {
  it('lists memberships from the current actor payload', async () => {
    const tmpDir = makeTempDir();
    const sessionFile = path.join(tmpDir, 'session.json');
    const env = {
      QAPANDA_CLOUD_SESSION_FILE: sessionFile,
      QAPANDA_CLOUD_SESSION_KEY: 'test-secret',
    };
    const boundary = createCloudBoundary({ target: 'cli', env: {} });
    const { tokenStore } = await createCliTokenStore(boundary, { env });
    await tokenStore.save(makeSession());

    const result = await listCliCloudWorkspaces({
      ...boundary,
      async createApiClient() {
        return {
          sdk: {
            withHeaders() {
              return {
                async getCurrentActor() {
                  return makeCurrentActorResponse();
                },
              };
            },
          },
        };
      },
    }, { env });

    assert.equal(result.memberships.length, 2);
    assert.equal(result.memberships[1].slug, 'qa-team');
  });

  it('switches to a selected workspace by slug and persists the new workspace id', async () => {
    const tmpDir = makeTempDir();
    const sessionFile = path.join(tmpDir, 'session.json');
    const env = {
      QAPANDA_CLOUD_SESSION_FILE: sessionFile,
      QAPANDA_CLOUD_SESSION_KEY: 'test-secret',
    };
    const boundary = createCloudBoundary({ target: 'cli', env: {} });
    const { tokenStore } = await createCliTokenStore(boundary, { env });
    await tokenStore.save(makeSession());

    let switchedWorkspaceId = null;
    const result = await switchCliCloudWorkspace({
      ...boundary,
      async createApiClient() {
        return {
          sdk: {
            withHeaders() {
              return {
                async getCurrentActor() {
                  return makeCurrentActorResponse({
                    currentWorkspace: switchedWorkspaceId === 'workspace-2'
                      ? {
                          workspaceId: 'workspace-2',
                          slug: 'qa-team',
                          name: 'QA Team',
                          planTier: 'enterprise',
                          roleKey: 'member',
                          isBillingAdmin: false,
                          entitlements: [],
                          entitlementMap: {},
                        }
                      : undefined,
                  });
                },
                async switchWorkspace(workspaceId) {
                  switchedWorkspaceId = workspaceId;
                  return { actorId: 'actor-1', workspaceId };
                },
              };
            },
          },
        };
      },
    }, 'qa-team', { env });

    const stored = await tokenStore.load();
    assert.equal(switchedWorkspaceId, 'workspace-2');
    assert.equal(stored.workspaceId, 'workspace-2');
    assert.equal(result.currentActor.currentWorkspace.workspaceId, 'workspace-2');
  });

  it('refreshes the session before switching workspaces when the access token is stale', async () => {
    const tmpDir = makeTempDir();
    const sessionFile = path.join(tmpDir, 'session.json');
    const env = {
      QAPANDA_CLOUD_SESSION_FILE: sessionFile,
      QAPANDA_CLOUD_SESSION_KEY: 'test-secret',
    };
    const baseBoundary = createCloudBoundary({ target: 'cli', env: {} });
    const packages = await baseBoundary.loadPackages();
    const { tokenStore } = await createCliTokenStore(baseBoundary, { env });
    await tokenStore.save(makeSession());

    let authorizationHeaders = [];
    const refreshedSession = makeSession({
      tokens: {
        accessToken: 'fresh-access-token',
        refreshToken: 'fresh-refresh-token',
        accessExpiresAt: '2026-04-06T00:00:00.000Z',
        refreshExpiresAt: '2026-05-06T00:00:00.000Z',
      },
    });
    const result = await switchCliCloudWorkspace({
      ...baseBoundary,
      async loadPackages() {
        return {
          ...packages,
          clientCloud: {
            ...packages.clientCloud,
            async refreshCloudSession(input) {
              await input.tokenStore.save(refreshedSession);
              return refreshedSession;
            },
          },
        };
      },
      async createApiClient() {
        return {
          sdk: {
            withHeaders(headers) {
              authorizationHeaders.push(headers.authorization);
              if (headers.authorization === 'Bearer access-token') {
                return {
                  async getCurrentActor() {
                    return makeCurrentActorResponse();
                  },
                  async switchWorkspace() {
                    throw new Error('unauthorized');
                  },
                };
              }
              return {
                async getCurrentActor() {
                  return makeCurrentActorResponse({
                    currentWorkspace: {
                      workspaceId: 'workspace-2',
                      slug: 'qa-team',
                      name: 'QA Team',
                      planTier: 'enterprise',
                      roleKey: 'member',
                      isBillingAdmin: false,
                      entitlements: [],
                      entitlementMap: {},
                    },
                  });
                },
                async switchWorkspace(workspaceId) {
                  return { actorId: 'actor-1', workspaceId };
                },
              };
            },
          },
        };
      },
    }, 'qa-team', { env });

    const stored = await tokenStore.load();
    assert.deepEqual(authorizationHeaders, [
      'Bearer access-token',
      'Bearer access-token',
      'Bearer fresh-access-token',
      'Bearer fresh-access-token',
    ]);
    assert.equal(stored.workspaceId, 'workspace-2');
    assert.equal(stored.tokens.accessToken, 'fresh-access-token');
    assert.equal(result.currentActor.currentWorkspace.workspaceId, 'workspace-2');
  });

  it('clears the stored session when workspace switching fails after refresh', async () => {
    const tmpDir = makeTempDir();
    const sessionFile = path.join(tmpDir, 'session.json');
    const env = {
      QAPANDA_CLOUD_SESSION_FILE: sessionFile,
      QAPANDA_CLOUD_SESSION_KEY: 'test-secret',
    };
    const baseBoundary = createCloudBoundary({ target: 'cli', env: {} });
    const packages = await baseBoundary.loadPackages();
    const { tokenStore } = await createCliTokenStore(baseBoundary, { env });
    await tokenStore.save(makeSession());

    await assert.rejects(() => switchCliCloudWorkspace({
      ...baseBoundary,
      async loadPackages() {
        return {
          ...packages,
          clientCloud: {
            ...packages.clientCloud,
            async refreshCloudSession() {
              throw new Error('refresh revoked');
            },
          },
        };
      },
      async createApiClient() {
        return {
          sdk: {
            withHeaders() {
              return {
                async getCurrentActor() {
                  return makeCurrentActorResponse();
                },
                async switchWorkspace() {
                  throw new Error('unauthorized');
                },
              };
            },
          },
        };
      },
    }, 'qa-team', { env }), /Stored QA Panda Cloud session expired/);

    assert.equal(await tokenStore.load(), null);
  });
});

describe('logoutCliCloud', () => {
  it('clears the stored session and revokes the refresh token remotely when possible', async () => {
    const tmpDir = makeTempDir();
    const sessionFile = path.join(tmpDir, 'session.json');
    const env = {
      QAPANDA_CLOUD_SESSION_FILE: sessionFile,
      QAPANDA_CLOUD_SESSION_KEY: 'test-secret',
    };
    const boundary = createCloudBoundary({ target: 'cli', env: {} });
    const { tokenStore } = await createCliTokenStore(boundary, { env });
    await tokenStore.save(makeSession());

    let revoked = null;
    const result = await logoutCliCloud({
      ...boundary,
      async createApiClient() {
        return {
          sdk: {
            async logout(refreshToken) {
              revoked = refreshToken;
            },
          },
        };
      },
    }, { env });

    assert.equal(result.hadSession, true);
    assert.equal(result.revokedRemotely, true);
    assert.equal(revoked, 'refresh-token');
    assert.equal(await tokenStore.load(), null);
  });
});

describe('runCloudCommand', () => {
  it('opens hosted deep links through the CLI cloud command flow', async () => {
    const stdout = makeWriter();
    let opened = null;
    await runCloudCommand(['open', 'notifications'], {
      stdout,
      openExternal: async (url) => {
        opened = url;
      },
      cloudModule: {
        createCloudBoundary() {
          return {
            config: {
              appBaseUrl: 'https://app.qapanda.localhost',
            },
          };
        },
      },
    });

    assert.equal(opened, 'https://app.qapanda.localhost/app/notifications');
    assert.match(stdout.toString(), /Opened https:\/\/app\.qapanda\.localhost\/app\/notifications/);
  });

  it('prints whoami details through the CLI command handler', async () => {
    const tmpDir = makeTempDir();
    const sessionFile = path.join(tmpDir, 'session.json');
    const env = {
      QAPANDA_CLOUD_SESSION_FILE: sessionFile,
      QAPANDA_CLOUD_SESSION_KEY: 'test-secret',
    };
    const boundary = createCloudBoundary({ target: 'cli', env: {} });
    const { tokenStore } = await createCliTokenStore(boundary, { env });
    await tokenStore.save(makeSession());

    const stdout = makeWriter();
    await runCloudCommand(['whoami'], {
      env,
      stdout,
      cloudModule: {
        createCloudBoundary() {
          return {
            ...boundary,
            async createApiClient() {
              return {
                sdk: {
                  withHeaders() {
                    return {
                      async getCurrentActor() {
                        return makeCurrentActorResponse();
                      },
                    };
                  },
                },
              };
            },
          };
        },
      },
    });

    assert.match(stdout.toString(), /Signed in as dev@example.com/);
    assert.match(stdout.toString(), /Workspace: Demo Workspace \(demo-workspace\)/);
  });

  it('prints sync status and unread notification presence through the CLI command handler', async () => {
    const stdout = makeWriter();
    await runCloudCommand(['status'], {
      stdout,
      cloudModule: {
        createCloudBoundary() {
          return {
            async loadPackages() {
              const tokenStore = {
                async load() {
                  return makeSession();
                },
                async save() {},
                async clear() {},
              };
              return {
                clientCloud: {
                  createPreferredTokenStore() {
                    return tokenStore;
                  },
                  async clearCloudSession() {},
                  inspectStoredTokenEnvelope() {
                    return 'encrypted';
                  },
                  renderCliSyncStatus(indicator, conflicts) {
                    assert.equal(indicator.label, 'Healthy');
                    assert.equal(conflicts.length, 1);
                    return 'Sync - Healthy\nAll changes are mirrored.';
                  },
                  renderCliNotificationSummary(summary) {
                    assert.equal(summary.unreadCount, 3);
                    return 'Notifications - 3 unread';
                  },
                },
              };
            },
            async createApiClient() {
              return {
                sdk: {
                  withHeaders() {
                    return {
                      async getCurrentActor() {
                        return makeCurrentActorResponse();
                      },
                    };
                  },
                },
              };
            },
            async createRepositorySyncRuntime() {
              return {
                async start() {
                  return {
                    started: true,
                    indicator: {
                      label: 'Healthy',
                      detail: 'All changes are mirrored.',
                      tone: 'positive',
                    },
                    conflicts: [{
                      conflictId: 'conflict-1',
                      status: 'open',
                      objectType: 'issue',
                      objectId: 'issue-7',
                      conflictCode: 'client_remote_conflict',
                    }],
                    objectCounts: {
                      tests: 2,
                      issues: 1,
                      recipes: 1,
                    },
                    recentObjects: [
                      {
                        objectType: 'issue',
                        objectId: 'issue-7',
                        title: 'Checkout fails on login',
                        updatedAt: '2026-04-08T19:55:00.000Z',
                      },
                      {
                        objectType: 'test',
                        objectId: 'test-4',
                        title: 'Verify login flow',
                        updatedAt: '2026-04-08T19:50:00.000Z',
                      },
                    ],
                    pendingMutationCount: 0,
                    lastSyncedAt: '2026-04-04T12:00:00.000Z',
                    repository: {
                      kind: 'remote',
                      displayName: 'cc-manager',
                      canonicalRemoteUrl: 'git:github.com/qa-panda/cc-manager',
                      repositoryKey: 'git:github.com/qa-panda/cc-manager',
                      contextKey: 'ctx:branch:feature-cloud-status',
                      instanceKey: 'git:github.com/qa-panda/cc-manager#ctx:branch:feature-cloud-status',
                      projectConfig: {
                        contextMode: 'branch',
                        contextLabel: 'feature/cloud-status',
                      },
                    },
                    notificationSummary: {
                      unreadCount: 3,
                      latest: [],
                    },
                  };
                },
                async stop() {},
              };
            },
          };
        },
      },
    });

    assert.match(stdout.toString(), /Sync - Healthy/);
    assert.match(stdout.toString(), /Context mode: branch/);
      assert.match(stdout.toString(), /Context label: feature\/cloud-status/);
    assert.match(stdout.toString(), /Connected project identity: cc-manager/);
      assert.match(stdout.toString(), /Canonical remote: git:github\.com\/qa-panda\/cc-manager/);
    assert.match(stdout.toString(), /Context key: ctx:branch:feature-cloud-status/);
    assert.match(stdout.toString(), /Synced objects: 2 tests, 1 issue, 1 recipe/);
    assert.match(stdout.toString(), /Recent synced objects:/);
    assert.match(stdout.toString(), /issue:issue-7 - Checkout fails on login/);
    assert.match(stdout.toString(), /test:test-4 - Verify login flow/);
    assert.match(stdout.toString(), /Open conflicts:/);
    assert.match(stdout.toString(), /issue:issue-7 - client_remote_conflict/);
    assert.match(stdout.toString(), /Notifications - 3 unread/);
  });

  it('prints actionable hosted notifications through the CLI command handler', async () => {
    const stdout = makeWriter();
    await runCloudCommand(['notifications'], {
      stdout,
      cloudModule: {
        createCloudBoundary() {
          return {
            config: {
              appBaseUrl: 'https://app.qapanda.localhost',
            },
            async loadPackages() {
              const tokenStore = {
                async load() {
                  return makeSession();
                },
                async save() {},
                async clear() {},
              };
              return {
                clientCloud: {
                  createPreferredTokenStore() {
                    return tokenStore;
                  },
                  async clearCloudSession() {},
                  inspectStoredTokenEnvelope() {
                    return 'encrypted';
                  },
                },
              };
            },
            async createApiClient() {
              return {
                sdk: {
                  withHeaders() {
                    return {
                      async getCurrentActor() {
                        return makeCurrentActorResponse();
                      },
                    };
                  },
                },
              };
            },
            async createRepositorySyncRuntime() {
              return {
                async start() {
                  return {
                    started: true,
                    indicator: {
                      label: 'Healthy',
                      detail: 'All changes are mirrored.',
                      tone: 'positive',
                    },
                    conflicts: [],
                    repository: null,
                    notificationSummary: {
                      unreadCount: 1,
                      latest: [],
                      inboxUrl: 'https://app.qapanda.localhost/app/notifications',
                    },
                  };
                },
                async stop() {},
              };
            },
            async readCurrentActorSessionInfo() {
              return {
                api: {
                  sdk: {
                    async getNotifications(state) {
                      assert.equal(state, 'unread');
                      return {
                        unreadCount: 1,
                        items: [
                          {
                            notificationId: 'notification-1',
                            eventKey: 'run.failed',
                            title: 'Checkout failed',
                            body: 'The latest hosted run needs attention.',
                            actionUrl: 'https://app.qapanda.localhost/app/runs/run-123',
                            unread: true,
                          },
                        ],
                      };
                    },
                  },
                },
              };
            },
          };
        },
      },
    });

    assert.match(stdout.toString(), /Cloud notifications: 1 unread \(unread notifications\)/);
    assert.match(stdout.toString(), /\[run\.failed\] Checkout failed/);
    assert.match(stdout.toString(), /The latest hosted run needs attention\./);
    assert.match(stdout.toString(), /Open: https:\/\/app\.qapanda\.localhost\/app\/runs\/run-123/);
    assert.match(stdout.toString(), /Inbox: https:\/\/app\.qapanda\.localhost\/app\/notifications/);
  });

  it('prints workspace memberships through the workspace list command', async () => {
    const tmpDir = makeTempDir();
    const sessionFile = path.join(tmpDir, 'session.json');
    const env = {
      QAPANDA_CLOUD_SESSION_FILE: sessionFile,
      QAPANDA_CLOUD_SESSION_KEY: 'test-secret',
    };
    const boundary = createCloudBoundary({ target: 'cli', env: {} });
    const { tokenStore } = await createCliTokenStore(boundary, { env });
    await tokenStore.save(makeSession());
    const stdout = makeWriter();

    await runCloudCommand(['workspace', 'list'], {
      env,
      stdout,
      cloudModule: {
        createCloudBoundary() {
          return {
            ...boundary,
            async createApiClient() {
              return {
                sdk: {
                  withHeaders() {
                    return {
                      async getCurrentActor() {
                        return makeCurrentActorResponse();
                      },
                    };
                  },
                },
              };
            },
          };
        },
      },
    });

    assert.match(stdout.toString(), /Current workspace: Demo Workspace/);
    assert.match(stdout.toString(), /\* Demo Workspace/);
    assert.match(stdout.toString(), /- QA Team/);
  });

  it('switches workspace through the CLI command handler', async () => {
    const tmpDir = makeTempDir();
    const sessionFile = path.join(tmpDir, 'session.json');
    const env = {
      QAPANDA_CLOUD_SESSION_FILE: sessionFile,
      QAPANDA_CLOUD_SESSION_KEY: 'test-secret',
    };
    const boundary = createCloudBoundary({ target: 'cli', env: {} });
    const { tokenStore } = await createCliTokenStore(boundary, { env });
    await tokenStore.save(makeSession());
    const stdout = makeWriter();
    let switchedWorkspaceId = null;

    await runCloudCommand(['workspace', 'use', 'qa-team'], {
      env,
      stdout,
      cloudModule: {
        createCloudBoundary() {
          return {
            ...boundary,
            async createApiClient() {
              return {
                sdk: {
                  withHeaders() {
                    return {
                      async getCurrentActor() {
                        return makeCurrentActorResponse({
                          currentWorkspace: switchedWorkspaceId === 'workspace-2'
                            ? {
                                workspaceId: 'workspace-2',
                                slug: 'qa-team',
                                name: 'QA Team',
                                planTier: 'enterprise',
                                roleKey: 'member',
                                isBillingAdmin: false,
                                entitlements: [],
                                entitlementMap: {},
                              }
                            : undefined,
                        });
                      },
                      async switchWorkspace(workspaceId) {
                        switchedWorkspaceId = workspaceId;
                        return { actorId: 'actor-1', workspaceId };
                      },
                    };
                  },
                },
              };
            },
          };
        },
      },
    });

    assert.equal(switchedWorkspaceId, 'workspace-2');
    assert.match(stdout.toString(), /Switched QA Panda Cloud workspace to QA Team/);
  });

  it('shows and saves connected-project context through the CLI command handler', async () => {
    const stdout = makeWriter();
    const savedUpdates = [];
    await runCloudCommand(['context', 'use', 'custom', 'release-worktree', '--label', 'Release worktree'], {
      stdout,
      cloudModule: {
        createCloudBoundary() {
          return {
            async saveCloudSyncProjectConfig(updates) {
              savedUpdates.push(updates);
              return {
                contextMode: updates.contextMode,
                explicitContextKey: updates.explicitContextKey,
                contextLabel: updates.contextLabel,
              };
            },
            async getRepositoryIdentity() {
              return {
                repoRoot: 'C:/repo',
                projectConfig: {
                  contextMode: 'custom',
                  explicitContextKey: 'release-worktree',
                  contextLabel: 'Release worktree',
                },
                git: {
                  branchName: 'release/1.2',
                },
                identity: {
                  displayName: 'cc-manager',
                  canonicalRemoteUrl: 'git:github.com/qa-panda/cc-manager',
                  repositoryKey: 'git:github.com/qa-panda/cc-manager',
                  contextKey: 'ctx:custom:release-worktree',
                  instanceKey: 'git:github.com/qa-panda/cc-manager#ctx:custom:release-worktree',
                },
              };
            },
          };
        },
      },
    });

    assert.deepEqual(savedUpdates[0], {
      contextMode: 'custom',
      explicitContextKey: 'release-worktree',
      contextLabel: 'Release worktree',
    });
    assert.match(stdout.toString(), /Saved connected-project context for this checkout/);
    assert.match(stdout.toString(), /Explicit context key: release-worktree/);
    assert.match(stdout.toString(), /Resolved context key: ctx:custom:release-worktree/);
  });

  it('opens the current hosted project context through the CLI command handler', async () => {
    const stdout = makeWriter();
    let opened = null;
    await runCloudCommand(['context', 'open'], {
      stdout,
      openExternal: async (url) => {
        opened = url;
      },
      cloudModule: {
        createCloudBoundary() {
          return {
            config: {
              appBaseUrl: 'https://app.qapanda.localhost',
            },
            async loadPackages() {
              const tokenStore = {
                async load() {
                  return makeSession();
                },
                async save() {},
                async clear() {},
              };
              return {
                clientCloud: {
                  createPreferredTokenStore() {
                    return tokenStore;
                  },
                  async clearCloudSession() {},
                  inspectStoredTokenEnvelope() {
                    return 'encrypted';
                  },
                },
              };
            },
            async createApiClient() {
              return {
                sdk: {
                  withHeaders() {
                    return {
                      async getCurrentActor() {
                        return makeCurrentActorResponse();
                      },
                    };
                  },
                },
              };
            },
            async createRepositorySyncRuntime() {
              return {
                async start() {
                  return {
                    started: true,
                    registered: true,
                    indicator: { label: 'Healthy', detail: 'ok', tone: 'positive' },
                    conflicts: [],
                    pendingMutationCount: 0,
                    binding: {
                      repositoryId: 'repo-1',
                      repositoryContextId: 'context-9',
                      checkoutId: 'checkout-4',
                    },
                    repository: {
                      displayName: 'cc-manager',
                      projectConfig: {
                        contextMode: 'shared',
                      },
                    },
                    notificationSummary: {
                      unreadCount: 0,
                      latest: [],
                    },
                  };
                },
                async stop() {},
              };
            },
          };
        },
      },
    });

    assert.equal(opened, 'https://app.qapanda.localhost/app/projects/repo-1?contextId=context-9');
    assert.match(stdout.toString(), /Opened https:\/\/app\.qapanda\.localhost\/app\/projects\/repo-1\?contextId=context-9/);
  });
});

describe('resolveHostedCloudUrl', () => {
  it('builds the expected hosted product URLs', () => {
    const boundary = { config: { appBaseUrl: 'https://app.qapanda.localhost/' } };
    assert.equal(resolveHostedCloudUrl(boundary, 'app'), 'https://app.qapanda.localhost/app');
    assert.equal(resolveHostedCloudUrl(boundary, 'runs'), 'https://app.qapanda.localhost/app/runs');
    assert.equal(resolveHostedCloudUrl(boundary, 'notifications'), 'https://app.qapanda.localhost/app/notifications');
    assert.equal(resolveHostedCloudUrl(boundary, 'run', 'run_123'), 'https://app.qapanda.localhost/app/runs/run_123');
  });
});
