const { loadStoredCloudSession } = require('./cli-auth');
const { loadStoredExtensionSession } = require('./extension-auth');
const { buildDeviceMetadata } = require('./repository-sync');

const MIN_HEARTBEAT_INTERVAL_MS = 30000;
const DEFAULT_HEARTBEAT_MULTIPLIER = 3;

function isPositiveNumber(value) {
  return Number.isFinite(value) && value > 0;
}

function resolveClientKind(target) {
  if (target === 'extension') return 'extension';
  if (target === 'cli') return 'cli';
  return null;
}

function isUnauthorizedError(error) {
  return Boolean(error && typeof error === 'object' && Number(error.status) === 401);
}

function resolveHeartbeatIntervalMs(boundary, options = {}) {
  if (isPositiveNumber(options.heartbeatIntervalMs)) return Number(options.heartbeatIntervalMs);
  const syncIntervalMs = isPositiveNumber(options.syncIntervalMs)
    ? Number(options.syncIntervalMs)
    : Number(boundary.config.syncIntervalMs || 15000);
  return Math.max(syncIntervalMs * DEFAULT_HEARTBEAT_MULTIPLIER, MIN_HEARTBEAT_INTERVAL_MS);
}

function hasStateEntries(value, options = {}) {
  const ignoredKeys = new Set(Array.isArray(options.ignoredKeys) ? options.ignoredKeys : []);
  if (!value || typeof value !== 'object') return false;
  return Object.entries(value).some(([key, entry]) => {
    if (ignoredKeys.has(key)) return false;
    if (!entry || typeof entry !== 'object') return false;
    return Object.keys(entry).length > 0;
  });
}

function summarizeRuntime(boundary, state) {
  const binding = state.adapters ? state.adapters.store.getBinding() : {};
  const snapshot = state.adapters ? state.adapters.store.snapshot() : null;
  const conflicts = state.adapters ? state.adapters.listConflicts() : [];
  const objects = snapshot && Array.isArray(snapshot.objects) ? snapshot.objects : [];
  const objectCounts = { tests: 0, issues: 0, recipes: 0 };
  const recentObjects = [];
  for (const object of objects) {
    if (!object || object.deletedAt) continue;
    if (object.objectType === 'test') objectCounts.tests += 1;
    if (object.objectType === 'issue') objectCounts.issues += 1;
    if (object.objectType === 'recipe') objectCounts.recipes += 1;
    if (
      recentObjects.length < 5
      && (object.objectType === 'test' || object.objectType === 'issue' || object.objectType === 'recipe')
    ) {
      recentObjects.push({
        objectType: object.objectType,
        objectId: object.objectId,
        title: object.title || object.objectId,
        updatedAt: object.updatedAt || null,
        deletedAt: object.deletedAt || null,
      });
    }
  }
  const indicator = state.adapters
    ? state.adapters.syncClient.getIndicator()
    : {
        status: 'disabled',
        label: 'Disconnected',
        detail: 'Repository sync has not started.',
        tone: 'neutral',
      };
  return {
    started: Boolean(state.started),
    enabled: Boolean(state.started),
    repoRoot: boundary.repoRoot,
    dbPath: state.adapters ? state.adapters.dbPath : boundary.getCloudSyncDbPath(),
    syncIntervalMs: state.syncIntervalMs,
    heartbeatIntervalMs: state.heartbeatIntervalMs,
    indicator,
    binding,
    repository: state.adapters ? state.adapters.repository : null,
    loggedIn: Boolean(state.sessionInfo && state.sessionInfo.session),
    storageMode: state.sessionInfo ? state.sessionInfo.storageMode || null : null,
    sessionPath: state.sessionInfo ? state.sessionInfo.filePath || null : null,
    secretKey: state.sessionInfo ? state.sessionInfo.secretKey || null : null,
    openConflictCount: conflicts.filter((conflict) => conflict.status === 'open').length,
    conflicts,
    lastError: snapshot ? snapshot.lastError : null,
    lastSyncedAt: snapshot ? snapshot.lastSyncedAt : null,
    pendingMutationCount: snapshot ? snapshot.pendingMutations.length : 0,
    objectCounts,
    recentObjects,
    registered: Boolean(binding.repositoryContextId && binding.checkoutId),
    notificationSummary: state.notificationSummary || null,
    unreadNotifications: Array.isArray(state.notificationUnreadItems) ? state.notificationUnreadItems.slice() : [],
    hasUnreadNotifications: Boolean(state.notificationSummary && state.notificationSummary.unreadCount > 0),
    unreadNotificationCount: state.notificationSummary ? Number(state.notificationSummary.unreadCount || 0) : 0,
    notificationError: state.notificationError || null,
  };
}

async function loadSyncSession(boundary, packages, options = {}) {
  if (typeof options.sessionLoader === 'function') {
    return options.sessionLoader({ boundary, packages });
  }
  if (boundary.target === 'extension') {
    return loadStoredExtensionSession(boundary, { ...options, packages });
  }
  if (boundary.target === 'cli') {
    return loadStoredCloudSession(boundary, { ...options, packages });
  }
  return {
    tokenStore: null,
    session: null,
    storageMode: null,
    filePath: null,
    secretKey: null,
  };
}

async function createAuthenticatedSyncApi(boundary, packages, options = {}) {
  const baseApi = options.baseApi || options.api || await boundary.createApiClient();
  let sessionInfo = options.sessionInfo || await loadSyncSession(boundary, packages, options);

  async function ensureSession({ forceRefresh = false } = {}) {
    if (!sessionInfo) {
      sessionInfo = await loadSyncSession(boundary, packages, options);
    }
    if (!sessionInfo || !sessionInfo.session) return null;
    if (!forceRefresh) return sessionInfo.session;
    if (!sessionInfo.tokenStore || !sessionInfo.session.tokens || !sessionInfo.session.tokens.refreshToken) {
      return sessionInfo.session;
    }
    const refreshed = await packages.clientCloud.refreshCloudSession({ tokenStore: sessionInfo.tokenStore });
    sessionInfo = { ...sessionInfo, session: refreshed };
    return refreshed;
  }

  async function invoke(methodName, args) {
    let session = await ensureSession();
    if (!session || !session.tokens || !session.tokens.accessToken) {
      throw new Error('cloud_session_required');
    }

    let sdk = baseApi.sdk.withHeaders({
      authorization: `Bearer ${session.tokens.accessToken}`,
    });

    try {
      return await sdk[methodName](...args);
    } catch (error) {
      if (!isUnauthorizedError(error)) throw error;
      session = await ensureSession({ forceRefresh: true });
      if (!session || !session.tokens || !session.tokens.accessToken) throw error;
      sdk = baseApi.sdk.withHeaders({
        authorization: `Bearer ${session.tokens.accessToken}`,
      });
      return sdk[methodName](...args);
    }
  }

  const sdk = {
    registerRepositoryCheckout(...args) {
      return invoke('registerRepositoryCheckout', args);
    },
    exchangeRepositorySync(...args) {
      return invoke('exchangeRepositorySync', args);
    },
    heartbeatRepositoryCheckout(...args) {
      return invoke('heartbeatRepositoryCheckout', args);
    },
    getNotificationSummary(...args) {
      return invoke('getNotificationSummary', args);
    },
    getNotifications(...args) {
      return invoke('getNotifications', args);
    },
    getSyncConflicts(...args) {
      return invoke('getSyncConflicts', args);
    },
    resolveSyncConflict(...args) {
      return invoke('resolveSyncConflict', args);
    },
  };

  return {
    api: { sdk },
    async getSessionInfo() {
      if (!sessionInfo || !sessionInfo.session) {
        sessionInfo = await loadSyncSession(boundary, packages, options);
      }
      return sessionInfo;
    },
  };
}

function buildCheckoutRegistrationInput(boundary, repository, device) {
  const clientKind = resolveClientKind(boundary.target);
  if (!clientKind) {
    throw new Error(`persistent sync is not supported for target "${boundary.target}"`);
  }
  return {
    ...(repository.git.remoteUrl ? { remoteUrl: repository.git.remoteUrl } : {}),
    ...(repository.git.localPath ? { localPath: repository.git.localPath } : {}),
    ...(repository.git.branchName ? { branchName: repository.git.branchName } : {}),
    contextMode: repository.projectConfig.contextMode,
    ...(repository.projectConfig.explicitContextKey ? { explicitContextKey: repository.projectConfig.explicitContextKey } : {}),
    ...(repository.projectConfig.contextLabel ? { contextLabel: repository.projectConfig.contextLabel } : {}),
    clientKind,
    deviceName: device.deviceName,
    machineFingerprint: device.machineFingerprint,
    platformLabel: device.platformLabel,
    hostLabel: device.hostLabel,
    localPathHash: repository.localPathHash,
  };
}

async function createRepositorySyncRuntime(boundary, options = {}) {
  const packages = options.packages || await boundary.loadPackages();
  const syncIntervalMs = isPositiveNumber(options.syncIntervalMs)
    ? Number(options.syncIntervalMs)
    : Number(boundary.config.syncIntervalMs || 15000);
  const heartbeatIntervalMs = resolveHeartbeatIntervalMs(boundary, options);
  const setIntervalImpl = options.setIntervalImpl || setInterval;
  const clearIntervalImpl = options.clearIntervalImpl || clearInterval;
  const state = {
    started: false,
    starting: null,
    adapters: null,
    localState: null,
    syncTimer: null,
    heartbeatTimer: null,
    auth: null,
    sessionInfo: null,
    syncIntervalMs,
    heartbeatIntervalMs,
    notificationSummary: null,
    notificationUnreadItems: [],
    notificationError: null,
    seenNotificationIds: new Set(),
  };

  function trace(event, detail = null) {
    if (typeof options.onTrace !== 'function') return;
    try {
      options.onTrace({
        event,
        ...(detail && typeof detail === 'object' ? detail : {}),
      });
    } catch {}
  }

  function emitStatus(status = summarizeRuntime(boundary, state)) {
    if (typeof options.onStatus === 'function') {
      try {
        options.onStatus(status);
      } catch {}
    }
    return status;
  }

  function emitNotifications(items, summary) {
    if (!Array.isArray(items) || items.length === 0) return;
    if (typeof options.onNotifications === 'function') {
      try {
        options.onNotifications({
          items,
          summary: summary || state.notificationSummary || null,
          unreadItems: Array.isArray(state.notificationUnreadItems) ? state.notificationUnreadItems.slice() : [],
        });
      } catch {}
    }
  }

  async function ensureAdapters() {
    if (state.adapters) return state.adapters;
    if (!state.auth) {
      state.auth = await createAuthenticatedSyncApi(boundary, packages, options);
    }
    const sessionInfo = await state.auth.getSessionInfo();
    state.sessionInfo = sessionInfo;
    if (!sessionInfo || !sessionInfo.session) return null;
    state.adapters = options.adapters || await boundary.createRepositorySyncAdapters({
      packages,
      api: state.auth.api,
      identityOptions: options.identityOptions,
      storeOptions: options.storeOptions,
    });
    return state.adapters;
  }

  async function registerCheckout() {
    const adapters = await ensureAdapters();
    trace('register_checkout.begin');
    if (!adapters) {
      trace('register_checkout.skipped', { reason: 'not_logged_in' });
      return {
        registered: false,
        reason: 'not_logged_in',
      };
    }
    const device = buildDeviceMetadata({
      target: boundary.target,
      appName: options.appName,
      appVersion: options.appVersion,
      deviceName: options.deviceName,
      machineFingerprint: options.machineFingerprint,
      platformLabel: options.platformLabel,
      hostLabel: options.hostLabel,
      username: options.username,
      platform: options.platform,
      release: options.release,
      arch: options.arch,
    });
    const registration = buildCheckoutRegistrationInput(boundary, adapters.repository, device);
    await adapters.syncClient.registerCheckout(registration);
    trace('register_checkout.done', {
      repositoryContextId: adapters.store.getBinding().repositoryContextId || null,
      checkoutId: adapters.store.getBinding().checkoutId || null,
    });
    return {
      registered: true,
      registration,
      binding: adapters.store.getBinding(),
    };
  }

  async function refreshNotifications(config = {}) {
    const notifyNew = config.notifyNew !== false;
    const adapters = await ensureAdapters();
    trace('refresh_notifications.begin');
    if (!adapters) {
      state.notificationSummary = null;
      state.notificationUnreadItems = [];
      state.notificationError = null;
      state.seenNotificationIds = new Set();
      trace('refresh_notifications.skipped', { reason: 'not_logged_in' });
      return null;
    }
    try {
      state.notificationSummary = await state.auth.api.sdk.getNotificationSummary();
      state.notificationUnreadItems = [];
      let newUnreadItems = [];
      if (state.notificationSummary && Number(state.notificationSummary.unreadCount || 0) > 0) {
        const unreadResponse = await state.auth.api.sdk.getNotifications('unread');
        state.notificationUnreadItems = Array.isArray(unreadResponse && unreadResponse.items)
          ? unreadResponse.items.filter((item) => item && item.notificationId)
          : [];
        if (notifyNew) {
          newUnreadItems = state.notificationUnreadItems.filter((item) => item.unread !== false && !state.seenNotificationIds.has(item.notificationId));
        }
        state.notificationUnreadItems.forEach((item) => {
          state.seenNotificationIds.add(item.notificationId);
        });
      }
      state.notificationError = null;
      trace('refresh_notifications.done', {
        unreadCount: Number(state.notificationSummary && state.notificationSummary.unreadCount || 0),
        fetchedUnreadItems: state.notificationUnreadItems.length,
        newUnreadItems: newUnreadItems.length,
      });
      emitNotifications(newUnreadItems, state.notificationSummary);
      return state.notificationSummary;
    } catch (error) {
      state.notificationError = error && error.message ? error.message : String(error);
      trace('refresh_notifications.error', { message: state.notificationError });
      return null;
    }
  }

  async function tick() {
    const adapters = await ensureAdapters();
    trace('tick.begin');
    if (!adapters) {
      trace('tick.skipped', { reason: 'not_logged_in' });
      return emitStatus();
    }
    adapters.queueLocalChanges(state.localState || {});
    trace('tick.local_changes_queued', {
      pendingMutationCount: adapters.store.snapshot().pendingMutations.length,
    });
    await adapters.syncClient.syncOnce();
    trace('tick.sync_once.done', {
      cursor: adapters.store.getLastSyncCursor(),
    });
    adapters.hydrateAllFromStore({ pruneRemoved: true });
    trace('tick.hydrate.done');
    await refreshNotifications({ notifyNew: true });
    state.localState = adapters.captureLocalState();
    trace('tick.done', {
      localDomains: Object.keys(state.localState || {}),
    });
    return emitStatus();
  }

  async function heartbeatNow() {
    const adapters = await ensureAdapters();
    if (!adapters) {
      return {
        sent: false,
        reason: 'not_logged_in',
      };
    }
    const binding = adapters.store.getBinding();
    if (!binding.repositoryContextId || !binding.checkoutId) {
      return {
        sent: false,
        reason: 'repository_checkout_not_registered',
      };
    }
    const snapshot = adapters.store.snapshot();
    const response = await state.auth.api.sdk.heartbeatRepositoryCheckout(binding.checkoutId, {
      repositoryContextId: binding.repositoryContextId,
      branchName: adapters.repository.git.branchName,
      pendingMutationCount: snapshot.pendingMutations.length,
      lastClientSequenceNo: adapters.store.getLastSyncCursor(),
      lastServerSequenceNo: adapters.store.getLastSyncCursor(),
    });
    return {
      sent: true,
      response,
      binding: adapters.store.getBinding(),
    };
  }

  async function refreshConflicts() {
    const adapters = await ensureAdapters();
    if (!adapters) return [];
    const binding = adapters.store.getBinding();
    if (!binding.repositoryContextId) return adapters.listConflicts();
    const response = await state.auth.api.sdk.getSyncConflicts(binding.repositoryContextId);
    const conflicts = adapters.setConflicts(response.conflicts);
    emitStatus();
    return conflicts;
  }

  async function resolveConflict(conflictId, resolution = 'take_remote') {
    const adapters = await ensureAdapters();
    if (!adapters) throw new Error('cloud_session_required');
    await packages.clientCloud.resolveRepositoryConflict({
      client: adapters.syncClient,
      api: state.auth.api,
      env: boundary.env,
      conflictId,
      resolution,
    });
    adapters.hydrateAllFromStore({ pruneRemoved: true });
    const conflicts = adapters.listConflicts();
    emitStatus();
    return conflicts;
  }

  function startTimers() {
    if (options.disableTimers) return;
    if (!state.syncTimer) {
      state.syncTimer = setIntervalImpl(() => {
        tick().catch((error) => {
          if (typeof options.onError === 'function') options.onError(error);
        });
      }, syncIntervalMs);
    }
    if (!state.heartbeatTimer) {
      state.heartbeatTimer = setIntervalImpl(() => {
        heartbeatNow().catch((error) => {
          if (typeof options.onError === 'function') options.onError(error);
        });
      }, heartbeatIntervalMs);
    }
  }

  function clearTimers() {
    if (state.syncTimer) {
      clearIntervalImpl(state.syncTimer);
      state.syncTimer = null;
    }
    if (state.heartbeatTimer) {
      clearIntervalImpl(state.heartbeatTimer);
      state.heartbeatTimer = null;
    }
  }

  async function start() {
    if (state.started) return summarizeRuntime(boundary, state);
    if (state.starting) return state.starting;
    state.starting = (async () => {
      trace('start.begin');
      const sessionInfo = await (state.auth
        ? state.auth.getSessionInfo()
        : loadSyncSession(boundary, packages, options));
      state.sessionInfo = sessionInfo;
      if (!sessionInfo || !sessionInfo.session) {
        trace('start.skipped', { reason: 'not_logged_in' });
        return emitStatus({
          ...summarizeRuntime(boundary, state),
          started: false,
          enabled: false,
          reason: 'not_logged_in',
        });
      }
      trace('start.ensure_adapters.begin');
      await ensureAdapters();
      trace('start.ensure_adapters.done');
      await registerCheckout();
      const storeSnapshot = state.adapters.store.snapshot();
      const capturedLocalState = state.adapters.captureLocalState();
      trace('start.local_state_captured', {
        objectCount: storeSnapshot.objects.length,
        pendingMutationCount: storeSnapshot.pendingMutations.length,
      });
      const shouldHydrateRemoteBaselineFirst =
        storeSnapshot.objects.length === 0 &&
        storeSnapshot.pendingMutations.length === 0 &&
        !hasStateEntries(capturedLocalState, { ignoredKeys: ['projectSettings'] });
      if (shouldHydrateRemoteBaselineFirst) {
        // A brand-new same-context checkout should replay the existing
        // remote baseline before empty local files are treated as deletes.
        state.adapters.store.setLastSyncCursor(0);
        state.localState = capturedLocalState;
        trace('start.mode', { type: 'hydrate_remote_baseline_first' });
      } else {
        // Startup can reopen a persisted sync DB that already contains the
        // same local objects. Use the diff-based local sync path here so
        // repeated starts do not enqueue duplicate stable mutation IDs.
        state.adapters.syncLocalToStore();
        state.localState = capturedLocalState;
        trace('start.mode', { type: 'sync_local_to_store' });
      }
      trace('start.sync_once.begin');
      await state.adapters.syncClient.syncOnce();
      trace('start.sync_once.done', {
        cursor: state.adapters.store.getLastSyncCursor(),
      });
      state.adapters.hydrateAllFromStore({ pruneRemoved: true });
      trace('start.hydrate.done');
      await refreshNotifications({ notifyNew: false });
      state.localState = state.adapters.captureLocalState();
      trace('start.local_state_recaptured');
      startTimers();
      state.started = true;
      trace('start.done');
      return emitStatus();
    })();
    try {
      return await state.starting;
    } finally {
      state.starting = null;
    }
  }

  async function stop() {
    clearTimers();
    state.started = false;
    if (state.adapters && typeof state.adapters.close === 'function') {
      state.adapters.close();
    }
    state.adapters = null;
    state.localState = null;
    state.notificationSummary = null;
    state.notificationUnreadItems = [];
    state.notificationError = null;
    state.seenNotificationIds = new Set();
    return emitStatus();
  }

  return {
    start,
    stop,
    close: stop,
    tick,
    heartbeatNow,
    registerCheckout,
    refreshConflicts,
    refreshNotifications,
    resolveConflict,
    listConflicts() {
      return state.adapters ? state.adapters.listConflicts() : [];
    },
    getStatus() {
      return summarizeRuntime(boundary, state);
    },
    getIndicator() {
      return state.adapters
        ? state.adapters.syncClient.getIndicator()
        : summarizeRuntime(boundary, state).indicator;
    },
  };
}

module.exports = {
  MIN_HEARTBEAT_INTERVAL_MS,
  createRepositorySyncRuntime,
  resolveHeartbeatIntervalMs,
};
