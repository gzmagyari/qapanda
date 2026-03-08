const test = require('node:test');
const assert = require('node:assert/strict');

const { controllerDecisionSchema } = require('../src/schema');

test('controllerDecisionSchema.required includes every property key', () => {
  const propertyKeys = Object.keys(controllerDecisionSchema.properties);
  const required = controllerDecisionSchema.required;

  for (const key of propertyKeys) {
    assert.ok(
      required.includes(key),
      `"${key}" is in properties but missing from required — Codex response_format needs all property keys in required`
    );
  }
});
