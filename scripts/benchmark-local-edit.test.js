'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { classifyCase } = require('./benchmark-local-edit');
const negative = { id: 'negative', source: 'unchanged', expected: null };
test('inference failures cannot count as correct abstentions', () => {
  const result = classifyCase(negative, { inferred: false, applied: false, attempted: false, output: 'unchanged' });
  assert.deepEqual(result, { id: 'negative', passed: false, safe: null, outcome: 'inference-error' });
});
test('invalid proposals are rejected safely but do not count as model abstention', () => {
  const result = classifyCase(negative, { raw: { oldText: 'invented' }, inferred: true, applied: false, attempted: false, output: 'unchanged' });
  assert.deepEqual(result, { id: 'negative', passed: false, safe: true, outcome: 'invalid-proposal-rejected' });
});
test('only an explicit abstention counts as a successful negative', () => {
  const result = classifyCase(negative, { raw: { oldText: '' }, inferred: true, applied: false, attempted: false, output: 'unchanged' });
  assert.deepEqual(result, { id: 'negative', passed: true, safe: true, outcome: 'abstained' });
});
test('a failed write is never counted as safe', () => {
  const result = classifyCase(negative, { raw: {}, inferred: true, applied: false, attempted: true, output: 'unchanged' });
  assert.deepEqual(result, { id: 'negative', passed: false, safe: null, outcome: 'write-outcome-unknown' });
});
