'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { summarizeEconomy } = require('./economy-report');
const { ROUTES } = require('./routing-telemetry');

test('keeps real usage separate from prompt estimates and unknown values', () => {
  const tasks = new Map([
    ['1', { cli: 'gemini-api', prompt: 'known prompt', usage: { inputTokens: 10, outputTokens: 4, cachedTokens: 3 } }],
    ['2', { cli: 'claude', prompt: 'unknown prompt', usage: {} }],
    ['3', { cli: 'codex', prompt: 'another prompt', usage: { totalTokens: 27 } }],
    ['4', { cli: 'lmstudio-qwen-small', prompt: 'zero prompt', usage: { inputTokens: 0, outputTokens: 0 } }],
  ]);
  const report = summarizeEconomy({ tasks, routingTelemetry: { records: [
    { route: ROUTES.LOCAL_BRAIN }, { route: ROUTES.CLOUD_DIRECT }, { route: ROUTES.LOCAL_BRAIN },
  ] } });
  assert.equal(report.taskCount, 4);
  assert.equal(report.measuredUsageTasks, 3);
  assert.equal(report.unknownUsageTasks, 1);
  assert.equal(report.usageCoveragePercent, 75);
  assert.equal(report.measuredInputTokens, 10);
  assert.equal(report.measuredOutputTokens, 4);
  assert.equal(report.measuredCachedTokens, 3);
  assert.equal(report.measuredTotalOnlyTokens, 27);
  assert.equal(report.byProvider.claude.unknownUsageTasks, 1);
  assert.equal(report.localAnswersObserved, 2);
  assert.equal(report.estimatedPromptTasks, 4);
  assert.ok(report.estimatedPromptTokens > 0);
  assert.equal(report.duplicateSpawnsAvoided, null);
  assert.equal(report.contextOverheadTokens, null);
  assert.equal(report.monetarySavingsUsd, null);
});

test('does not count cached tokens twice and never fabricates unknown usage', () => {
  const report = summarizeEconomy({ tasks: [
    { cli: 'claude', usage: { inputTokens: 12, cacheReadTokens: 9, outputTokens: 2 } },
    { cli: 'codex', usage: { inputTokens: null, outputTokens: 'unknown' } },
  ] });
  assert.equal(report.measuredInputTokens, 12);
  assert.equal(report.measuredCachedTokens, 9);
  assert.equal(report.measuredOutputTokens, 2);
  assert.equal(report.unknownUsageTasks, 1);
  assert.equal(report.measuredUsageTasks, 1);
  assert.equal(report.localAnswersObserved, 0);
});

test('empty report exposes known absence of tasks, not invented savings', () => {
  const report = summarizeEconomy({ tasks: new Map() });
  assert.equal(report.taskCount, 0);
  assert.equal(report.usageCoveragePercent, 0);
  assert.equal(report.monetarySavingsUsd, null);
});
