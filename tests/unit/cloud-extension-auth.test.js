const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { createCloudBoundary } = require('../../src/cloud');
const {
  createExtensionTokenStore,
  loginExtensionCloud,
  logoutExtensionCloud,
  openExtensionCloudTarget,
  resolveExtensionCloudState,
  switchExtensionCloudWorkspace,
} = require('../../src/cloud/extension-auth');

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
      ...(overrides.actor || {}),
    },
    currentWorkspace: {
      workspaceId: 'workspace-1',
      slug: 'demo-workspace',
      name: 'Demo Workspace',
      planTier: 'pro',
      roleKey: 'owner',
      isBillingAdmin: true,
      entitlements: [],
      entitlementMap: {},
      ...(overrides.currentWorkspace || {}),
    },
    memberships: overrides.memberships || [
      {
        workspaceId: 'workspace-1',
        slug: 'demo-workspace',
        name: 'Demo Workspace',
        planTier: 'pro',
        roleKey: 'owner',
        isBillingAdmin: true,
        entitlements: [],
        entitlementMap: {},
      },
      {
        workspaceId: 'workspace-2',
        slug: 'qa-team',
        name: 'QA Team',
        planTier: 'enterprise',
        roleKey: 'admin',
        isBillingAdmin: false,
        entitlements: [],
        entitlementMap: {},
      },
    ],
  };
}

function makeSecretStorage() {
  const values = new Map();
  return {
    values,
    async get(key) {
      return values.get(key);
    },
    async store(key, value) {
      values.set(key, value);
    },
    async delete(key) {
      values.delete(key);
    },
  };
}

describe('createExtensionTokenStore', () => {
  it('persists the cloud session in a SecretStorage-backed token store', async () => {
    const boundary = createCloudBoundary({ target: 'extension', env: {} });
    const secretStorage = makeSecretStorage();

    const first = await createExtensionTokenStore(boundary, { secretStorage });
    await first.tokenStore.save(makeSession());

    const second = await createExtensionTokenStore(boundary, { secretStorage });
    const loaded = await second.tokenStore.load();

    assert.equal(first.storageMode, 'vscode-secret-storage');
    assert.equal(loaded.email, 'dev@example.com');
    assert.ok(secretStorage.values.has('qapanda.cloud.session'));
  });
});

describe('loginExtensionCloud', () => {
  it('defaults extension login to PKCE, stores the session, and resolves hosted identity', async () => {
    const baseBoundary = createCloudBoundary({ target: 'extension', env: {} });
    const packages = await baseBoundary.loadPackages();
    const secretStorage = makeSecretStorage();
    let openedUrl = null;

    const boundary = {
      ...baseBoundary,
      config: { ...baseBoundary.config, authMode: 'disabled' },
      async loadPackages() {
        return {
          ...packages,
          clientCloud: {
            ...packages.clientCloud,
            async startBrowserPkceLogin(input) {
              await input.tokenStore.save(makeSession());
              await input.openExternal('https://app.qapanda.localhost/auth/start');
              return {
                session: makeSession(),
                callbackUrl: 'http://127.0.0.1:43111/qapanda-cloud-callback',
              };
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
    };

    const result = await loginExtensionCloud(boundary, {
      secretStorage,
      openExternal: async (url) => {
        openedUrl = url;
      },
      appName: 'VS Code',
      appVersion: '1.99.0',
    });

    assert.equal(result.method, 'pkce');
    assert.equal(openedUrl, 'https://app.qapanda.localhost/auth/start');
    assert.equal(result.state.loggedIn, true);
    assert.equal(result.state.workspace.slug, 'demo-workspace');
    assert.equal(result.state.memberships.length, 2);
  });
});

describe('resolveExtensionCloudState', () => {
  it('refreshes the stored session when the access token is stale', async () => {
    const baseBoundary = createCloudBoundary({ target: 'extension', env: {} });
    const packages = await baseBoundary.loadPackages();
    const secretStorage = makeSecretStorage();
    const { tokenStore } = await createExtensionTokenStore(baseBoundary, { secretStorage, packages });
    await tokenStore.save(makeSession({ updatedAt: '2026-04-03T00:00:00.000Z' }));

    let actorReads = 0;
    const refreshedSession = makeSession({
      tokens: {
        accessToken: 'fresh-access-token',
        refreshToken: 'fresh-refresh-token',
        accessExpiresAt: '2026-04-06T00:00:00.000Z',
        refreshExpiresAt: '2026-05-06T00:00:00.000Z',
      },
      updatedAt: '2026-04-04T12:00:00.000Z',
    });

    const boundary = {
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
            withHeaders() {
              actorReads += 1;
              if (actorReads === 1) {
                return {
                  async getCurrentActor() {
                    throw new Error('expired');
                  },
                };
              }
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

    const state = await resolveExtensionCloudState(boundary, { secretStorage });

    assert.equal(state.loggedIn, true);
    assert.equal(state.refreshed, true);
    assert.equal(state.session.accessExpiresAt, '2026-04-06T00:00:00.000Z');
    assert.equal(state.memberships[1].workspaceId, 'workspace-2');
  });
});

describe('switchExtensionCloudWorkspace', () => {
  it('updates the stored workspace and resolves the new hosted workspace state', async () => {
    const baseBoundary = createCloudBoundary({ target: 'extension', env: {} });
    const secretStorage = makeSecretStorage();
    const { tokenStore } = await createExtensionTokenStore(baseBoundary, { secretStorage });
    await tokenStore.save(makeSession());

    let switchedWorkspaceId = null;
    const boundary = {
      ...baseBoundary,
      async createApiClient() {
        return {
          sdk: {
            withHeaders() {
              return {
                async switchWorkspace(workspaceId) {
                  switchedWorkspaceId = workspaceId;
                  return {
                    actorId: 'actor-1',
                    workspaceId,
                  };
                },
                async getCurrentActor() {
                  return makeCurrentActorResponse({
                    currentWorkspace: {
                      workspaceId: 'workspace-2',
                      slug: 'qa-team',
                      name: 'QA Team',
                      planTier: 'enterprise',
                      roleKey: 'admin',
                      isBillingAdmin: false,
                      entitlements: [],
                      entitlementMap: {},
                    },
                  });
                },
              };
            },
          },
        };
      },
    };

    const state = await switchExtensionCloudWorkspace(boundary, 'workspace-2', { secretStorage });
    const stored = await tokenStore.load();

    assert.equal(switchedWorkspaceId, 'workspace-2');
    assert.equal(stored.workspaceId, 'workspace-2');
    assert.equal(state.workspace.workspaceId, 'workspace-2');
    assert.equal(state.memberships.length, 2);
  });

  it('refreshes the session before switching workspaces when the access token is stale', async () => {
    const baseBoundary = createCloudBoundary({ target: 'extension', env: {} });
    const packages = await baseBoundary.loadPackages();
    const secretStorage = makeSecretStorage();
    const { tokenStore } = await createExtensionTokenStore(baseBoundary, { secretStorage });
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
    const boundary = {
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
                  async switchWorkspace() {
                    throw new Error('unauthorized');
                  },
                };
              }
              return {
                async switchWorkspace() {
                  return { actorId: 'actor-1', workspaceId: 'workspace-2' };
                },
                async getCurrentActor() {
                  return makeCurrentActorResponse({
                    currentWorkspace: {
                      workspaceId: 'workspace-2',
                      slug: 'qa-team',
                      name: 'QA Team',
                      planTier: 'enterprise',
                      roleKey: 'admin',
                      isBillingAdmin: false,
                      entitlements: [],
                      entitlementMap: {},
                    },
                  });
                },
              };
            },
          },
        };
      },
    };

    const state = await switchExtensionCloudWorkspace(boundary, 'workspace-2', { secretStorage });
    const stored = await tokenStore.load();

    assert.deepEqual(authorizationHeaders, [
      'Bearer access-token',
      'Bearer fresh-access-token',
      'Bearer fresh-access-token',
    ]);
    assert.equal(stored.workspaceId, 'workspace-2');
    assert.equal(stored.tokens.accessToken, 'fresh-access-token');
    assert.equal(state.workspace.workspaceId, 'workspace-2');
  });

  it('clears the stored session when workspace switching fails after refresh', async () => {
    const baseBoundary = createCloudBoundary({ target: 'extension', env: {} });
    const packages = await baseBoundary.loadPackages();
    const secretStorage = makeSecretStorage();
    const { tokenStore } = await createExtensionTokenStore(baseBoundary, { secretStorage });
    await tokenStore.save(makeSession());

    const boundary = {
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
                async switchWorkspace() {
                  throw new Error('unauthorized');
                },
              };
            },
          },
        };
      },
    };

    await assert.rejects(
      () => switchExtensionCloudWorkspace(boundary, 'workspace-2', { secretStorage }),
      /Stored QA Panda Cloud session expired/
    );
    assert.equal(await tokenStore.load(), null);
  });
});

describe('logoutExtensionCloud', () => {
  it('clears the VS Code secret-backed session and revokes remotely when possible', async () => {
    const baseBoundary = createCloudBoundary({ target: 'extension', env: {} });
    const secretStorage = makeSecretStorage();
    const { tokenStore } = await createExtensionTokenStore(baseBoundary, { secretStorage });
    await tokenStore.save(makeSession());

    let revokedRefreshToken = null;
    const result = await logoutExtensionCloud({
      ...baseBoundary,
      async createApiClient() {
        return {
          sdk: {
            async logout(refreshToken) {
              revokedRefreshToken = refreshToken;
            },
          },
        };
      },
    }, { secretStorage });

    assert.equal(result.hadSession, true);
    assert.equal(result.revokedRemotely, true);
    assert.equal(revokedRefreshToken, 'refresh-token');
    assert.equal(await tokenStore.load(), null);
    assert.equal(result.state.loggedIn, false);
  });
});

describe('openExtensionCloudTarget', () => {
  it('opens the hosted notifications URL through the extension helper', async () => {
    const boundary = createCloudBoundary({
      target: 'extension',
      overrides: { appBaseUrl: 'https://app.qapanda.localhost' },
    });
    let opened = null;

    const result = await openExtensionCloudTarget(boundary, {
      target: 'notifications',
      openExternal: async (url) => {
        opened = url;
      },
    });

    assert.equal(opened, 'https://app.qapanda.localhost/app/notifications');
    assert.equal(result.url, opened);
  });
});
