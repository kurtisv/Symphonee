'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { estimateTokens, capContext, requestFingerprint, summarizeTasks } = require('./token-economy');

test('caps context and estimates tokens without exceeding the budget', () => {
  const value = 'a'.repeat(1000);
  const capped = capContext(value, 200);
  assert.ok(capped.length <= 200);
  assert.match(capped, /context truncated/);
  assert.equal(estimateTokens('a'.repeat(8)), 2);
});

test('request fingerprints normalize whitespace but preserve routing inputs', () => {
  assert.equal(requestFingerprint({ cli: 'auto', prompt: 'do   work' }), requestFingerprint({ cli: 'auto', prompt: 'do work' }));
  assert.notEqual(requestFingerprint({ cli: 'auto', prompt: 'do work' }), requestFingerprint({ cli: 'claude', prompt: 'do work' }));
});

test('summarizes measured usage, context overhead and avoided duplicates', () => {
  const tasks = new Map([['1', { cli: 'gemini-api', prompt: 'x', usage: { inputTokens: 10, outputTokens: 4, cachedTokens: 2 }, promptMetrics: { finalEstimatedTokens: 8, contextEstimatedTokens: 3 }, duplicateHits: 2 }]]);
  const s = summarizeTasks(tasks);
  assert.equal(s.measuredTasks, 1); assert.equal(s.inputTokens, 10); assert.equal(s.duplicateSpawnsAvoided, 2); assert.equal(s.measurementCoverage, 100);
});
