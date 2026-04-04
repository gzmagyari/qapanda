const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createCloudBoundary } = require('../../src/cloud');
const {
  createCliTokenStore,
  loginCliCloud,
  logoutCliCloud,
  resolveHostedCloudUrl,
  runCloudCommand,
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

function makeCurrentActorResponse() {
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
    },
    memberships: [],
    currentWorkspace: {
      workspaceId: 'workspace-1',
      slug: 'demo-workspace',
      name: 'Demo Workspace',
      planTier: 'pro',
      roleKey: 'admin',
      isBillingAdmin: true,
      entitlements: [],
      entitlementMap: {},
    },
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
                    conflicts: [{ conflictId: 'conflict-1', status: 'open' }],
                    pendingMutationCount: 0,
                    lastSyncedAt: '2026-04-04T12:00:00.000Z',
                    repository: {
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
    assert.match(stdout.toString(), /Notifications - 3 unread/);
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
