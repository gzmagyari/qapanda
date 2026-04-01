const { safeJsonParse } = require('./utils');

function parseCanonicalToolResult(result) {
  if (!result || typeof result !== 'object' || !Array.isArray(result.content)) {
    return null;
  }
  if (result.content.length !== 1) return null;
  const only = result.content[0];
  if (!only || only.type !== 'text' || typeof only.text !== 'string') {
    return null;
  }
  return safeJsonParse(only.text);
}

function normalizeToolResultOutput(result) {
  return parseCanonicalToolResult(result) || result || {};
}

module.exports = {
  normalizeToolResultOutput,
  parseCanonicalToolResult,
};
