function normalizeSearchText(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function tokenizeSearchText(value) {
  return Array.from(new Set(
    normalizeSearchText(value)
      .split(/\s+/)
      .filter(Boolean)
  ));
}

function rankSearchResults(items, query, buildFields, limit = 5) {
  const queryText = normalizeSearchText(query);
  const queryTokens = tokenizeSearchText(query);
  if (!queryText || queryTokens.length === 0) return [];

  const ranked = [];
  for (const item of items || []) {
    const fields = Array.isArray(buildFields(item)) ? buildFields(item) : [];
    let score = 0;
    const matchedTokens = new Set();
    const matchedLabels = new Set();

    for (const field of fields) {
      if (!field || field.value == null) continue;
      const weight = Number(field.weight) > 0 ? Number(field.weight) : 1;
      const fieldText = normalizeSearchText(field.value);
      if (!fieldText) continue;

      if (fieldText.includes(queryText)) {
        score += weight * Math.max(4, queryTokens.length * 2);
        matchedLabels.add(field.label || 'field');
      }

      const fieldTokens = new Set(tokenizeSearchText(field.value));
      let overlapCount = 0;
      for (const token of queryTokens) {
        if (!fieldTokens.has(token)) continue;
        overlapCount += 1;
        matchedTokens.add(token);
      }
      if (overlapCount > 0) {
        score += overlapCount * weight;
        matchedLabels.add(field.label || 'field');
      }
    }

    if (score <= 0) continue;
    const tokens = Array.from(matchedTokens).slice(0, 5);
    const labels = Array.from(matchedLabels).slice(0, 3);
    ranked.push({
      item,
      score,
      matchReason: `Matched ${labels.join(', ')} for: ${tokens.join(', ')}`,
    });
  }

  ranked.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    const aUpdated = Date.parse(a.item?.updated_at || a.item?.lastTestedAt || 0) || 0;
    const bUpdated = Date.parse(b.item?.updated_at || b.item?.lastTestedAt || 0) || 0;
    if (bUpdated !== aUpdated) return bUpdated - aUpdated;
    return String(a.item?.title || a.item?.id || '').localeCompare(String(b.item?.title || b.item?.id || ''));
  });

  return ranked.slice(0, limit);
}

module.exports = {
  normalizeSearchText,
  tokenizeSearchText,
  rankSearchResults,
};
