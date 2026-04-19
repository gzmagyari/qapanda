function _normalizeUrl(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function extractChromeTextBlocks(value, out = []) {
  if (value == null) return out;
  if (typeof value === 'string') {
    if (value.trim()) out.push(value);
    return out;
  }
  if (Array.isArray(value)) {
    for (const item of value) extractChromeTextBlocks(item, out);
    return out;
  }
  if (typeof value !== 'object') return out;
  if (typeof value.text === 'string' && value.text.trim()) {
    out.push(value.text);
  }
  if (Array.isArray(value.content)) {
    extractChromeTextBlocks(value.content, out);
  }
  if (Array.isArray(value.result)) {
    extractChromeTextBlocks(value.result, out);
  }
  if (value.result && typeof value.result === 'object') {
    extractChromeTextBlocks(value.result, out);
  }
  if (value.output && typeof value.output === 'object') {
    extractChromeTextBlocks(value.output, out);
  }
  if (value.Ok && typeof value.Ok === 'object') {
    extractChromeTextBlocks(value.Ok, out);
  }
  return out;
}

function parseChromePagesText(text) {
  if (typeof text !== 'string' || !text.includes('## Pages')) return null;
  const lines = String(text).replace(/\r/g, '').split('\n');
  const pages = [];
  for (const rawLine of lines) {
    const line = rawLine.trim();
    const match = line.match(/^(\d+):\s*(.+?)(\s+\[selected\])?$/);
    if (!match) continue;
    pages.push({
      pageNumber: Number(match[1]),
      url: match[2].trim(),
      selected: Boolean(match[3]),
    });
  }
  if (!pages.length) return null;
  const selected = pages.find((page) => page.selected) || null;
  return {
    pages,
    selectedPageNumber: selected ? selected.pageNumber : null,
    selectedPageUrl: selected ? selected.url : null,
  };
}

function parseChromePagesToolResult(result) {
  const texts = extractChromeTextBlocks(result);
  for (const text of texts) {
    const parsed = parseChromePagesText(text);
    if (parsed) return parsed;
  }
  return null;
}

function filterChromePageTargets(targets) {
  return (Array.isArray(targets) ? targets : []).filter((target) =>
    target &&
    target.type === 'page' &&
    typeof target.webSocketDebuggerUrl === 'string' &&
    target.webSocketDebuggerUrl
  );
}

function resolveChromeTargetByBinding(targets, binding = {}, fallbackCurrentTargetId = null) {
  const pages = filterChromePageTargets(targets);
  if (!pages.length) return { target: null, reason: 'no-pages' };

  const boundTargetId = binding && typeof binding.targetId === 'string' ? binding.targetId.trim() : '';
  const boundTargetUrl = _normalizeUrl(binding && binding.url);
  const currentTargetId = typeof fallbackCurrentTargetId === 'string' ? fallbackCurrentTargetId.trim() : '';

  if (boundTargetId) {
    const byId = pages.find((page) => page.id === boundTargetId) || null;
    if (byId) return { target: byId, reason: 'bound-id' };
  }

  if (boundTargetUrl) {
    const byUrl = pages.filter((page) => _normalizeUrl(page.url) === boundTargetUrl);
    if (byUrl.length === 1) return { target: byUrl[0], reason: 'bound-url' };
    if (byUrl.length > 1) return { target: null, reason: 'ambiguous-bound-url' };
  }

  if (currentTargetId) {
    const byCurrentId = pages.find((page) => page.id === currentTargetId) || null;
    if (byCurrentId) return { target: byCurrentId, reason: 'current-id' };
  }

  return { target: null, reason: 'unbound' };
}

function resolveChromeTargetFromSelection(targets, selection = {}, fallbackCurrentTargetId = null) {
  const pages = filterChromePageTargets(targets);
  if (!pages.length) return { target: null, reason: 'no-pages' };

  const pageNumber = Number(selection && selection.pageNumber);
  const expectedUrl = _normalizeUrl(selection && selection.expectedUrl);
  const currentTargetId = typeof fallbackCurrentTargetId === 'string' ? fallbackCurrentTargetId.trim() : '';
  const orderedTarget = Number.isFinite(pageNumber) && pageNumber > 0 ? (pages[pageNumber - 1] || null) : null;
  const exactUrlMatches = expectedUrl
    ? pages.filter((page) => _normalizeUrl(page.url) === expectedUrl)
    : [];
  const uniqueUrlTarget = exactUrlMatches.length === 1 ? exactUrlMatches[0] : null;

  if (orderedTarget && expectedUrl && _normalizeUrl(orderedTarget.url) === expectedUrl) {
    return { target: orderedTarget, reason: 'slot+url' };
  }

  if (orderedTarget && !expectedUrl) {
    return { target: orderedTarget, reason: 'slot-only' };
  }

  if (orderedTarget && expectedUrl && !uniqueUrlTarget) {
    return { target: orderedTarget, reason: 'slot-fallback' };
  }

  if (uniqueUrlTarget) {
    return { target: uniqueUrlTarget, reason: orderedTarget ? 'url-over-slot' : 'url-only' };
  }

  if (exactUrlMatches.length > 1) {
    return { target: null, reason: 'ambiguous-url' };
  }

  if (orderedTarget) {
    return { target: orderedTarget, reason: 'slot-only' };
  }

  if (currentTargetId) {
    const currentTarget = pages.find((page) => page.id === currentTargetId) || null;
    if (currentTarget) return { target: currentTarget, reason: 'current-id-fallback' };
  }

  return { target: null, reason: expectedUrl ? 'not-found' : 'no-selection' };
}

module.exports = {
  extractChromeTextBlocks,
  filterChromePageTargets,
  parseChromePagesText,
  parseChromePagesToolResult,
  resolveChromeTargetByBinding,
  resolveChromeTargetFromSelection,
};
