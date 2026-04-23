class PanelRegistry {
  constructor() {
    this._entries = new Map();
  }

  add(panel, meta = {}) {
    if (!panel) {
      throw new Error('panel is required');
    }
    const entry = {
      panel,
      rootIdentity: meta.rootIdentity || null,
      runId: meta.runId || null,
      title: meta.title || '',
      lastFocusedAt: Number.isFinite(meta.lastFocusedAt) ? Number(meta.lastFocusedAt) : Date.now(),
      visible: meta.visible !== false,
    };
    this._entries.set(panel, entry);
    return entry;
  }

  get(panel) {
    return this._entries.get(panel) || null;
  }

  update(panel, patch = {}) {
    const entry = this._entries.get(panel);
    if (!entry) return null;
    if (Object.prototype.hasOwnProperty.call(patch, 'rootIdentity')) entry.rootIdentity = patch.rootIdentity || null;
    if (Object.prototype.hasOwnProperty.call(patch, 'runId')) entry.runId = patch.runId || null;
    if (Object.prototype.hasOwnProperty.call(patch, 'title')) entry.title = patch.title || '';
    if (Object.prototype.hasOwnProperty.call(patch, 'visible')) entry.visible = patch.visible !== false;
    if (Number.isFinite(patch.lastFocusedAt)) entry.lastFocusedAt = Number(patch.lastFocusedAt);
    return entry;
  }

  remove(panel) {
    const entry = this._entries.get(panel) || null;
    if (entry) this._entries.delete(panel);
    return entry;
  }

  markFocused(panel, timestamp = Date.now()) {
    return this.update(panel, { lastFocusedAt: timestamp, visible: true });
  }

  count() {
    return this._entries.size;
  }

  values() {
    return Array.from(this._entries.values());
  }

  hasOpenRun(rootIdentity, runId) {
    return !!this.findMostRecentByRun(rootIdentity, runId);
  }

  findMostRecentByRun(rootIdentity, runId) {
    if (!rootIdentity || !runId) return null;
    let best = null;
    for (const entry of this._entries.values()) {
      if (entry.rootIdentity !== rootIdentity) continue;
      if (entry.runId !== runId) continue;
      if (!best || Number(entry.lastFocusedAt || 0) > Number(best.lastFocusedAt || 0)) {
        best = entry;
      }
    }
    return best;
  }
}

module.exports = { PanelRegistry };
