class SessionRegistry {
  constructor(options = {}) {
    this._entries = new Map();
    this._graceMs = Number.isFinite(options.graceMs) ? Math.max(0, options.graceMs) : 15_000;
  }

  attach(panelId, options = {}) {
    if (!panelId || typeof panelId !== 'string') {
      throw new Error('panelId is required');
    }
    const ws = options.ws || null;
    const createEntry = options.createEntry;

    let entry = this._entries.get(panelId);
    if (entry) {
      if (entry.disposeTimer) {
        clearTimeout(entry.disposeTimer);
        entry.disposeTimer = null;
      }
      entry.connection.ws = ws;
      return { entry, created: false };
    }

    if (typeof createEntry !== 'function') {
      throw new Error('createEntry callback is required for new sessions');
    }

    const connection = { ws };
    const createdEntry = createEntry(panelId, connection) || {};
    entry = {
      panelId,
      connection,
      disposeTimer: null,
      ...createdEntry,
    };
    this._entries.set(panelId, entry);
    return { entry, created: true };
  }

  rekey(fromPanelId, toPanelId) {
    if (!fromPanelId || !toPanelId || fromPanelId === toPanelId) return this.get(toPanelId) || this.get(fromPanelId);
    const entry = this._entries.get(fromPanelId);
    if (!entry) return this.get(toPanelId);
    const existing = this._entries.get(toPanelId);
    if (existing && existing !== entry) {
      if (existing.disposeTimer) {
        clearTimeout(existing.disposeTimer);
        existing.disposeTimer = null;
      }
      try { existing.session && existing.session.dispose && existing.session.dispose(); } catch {}
      this._entries.delete(toPanelId);
    }
    this._entries.delete(fromPanelId);
    entry.panelId = toPanelId;
    this._entries.set(toPanelId, entry);
    return entry;
  }

  get(panelId) {
    return this._entries.get(panelId) || null;
  }

  detach(panelId) {
    const entry = this._entries.get(panelId);
    if (!entry) return;
    entry.connection.ws = null;
    if (entry.disposeTimer) return;
    entry.disposeTimer = setTimeout(() => {
      entry.disposeTimer = null;
      if (this._entries.get(panelId) !== entry) return;
      try { entry.session && entry.session.dispose && entry.session.dispose(); } catch {}
      this._entries.delete(panelId);
    }, this._graceMs);
  }

  disposeAll() {
    for (const [panelId, entry] of this._entries.entries()) {
      if (entry.disposeTimer) {
        clearTimeout(entry.disposeTimer);
        entry.disposeTimer = null;
      }
      try { entry.session && entry.session.dispose && entry.session.dispose(); } catch {}
      this._entries.delete(panelId);
    }
  }
}

module.exports = { SessionRegistry };
