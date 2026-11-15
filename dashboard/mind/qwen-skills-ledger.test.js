'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { computeIndicators, CATEGORIES, MASTERY } = require('./qwen-skills-ledger');
const data = require('./QWEN_MEMORY_EXPERIMENT_RESULTS.json');

test('indicators on the published memory experiment: nothing mastered, 2 of 12 autonomous, honest cloud cost', () => {
  const r = computeIndicators(data);
  const i = r.indicators;
  assert.deepEqual([i['1_categoriesMastered'].mastered, i['1_categoriesMastered'].covered, i['1_categoriesMastered'].total], [0, 1, 10]);
  const alg = i['1_categoriesMastered'].detail.find((c) => c.id === 'algorithms');
  assert.deepEqual([alg.covered, alg.tasksMeasured, alg.runs, alg.approved, alg.mastered], [true, 3, 12, 2, false]);
  assert.match(alg.why, /3 tasks and 17%/);
  assert.deepEqual(i['2_unseenTasksSolvedAutonomously'].overall, { runs: 12, approved: 2, rate: 0.167 });
  assert.deepEqual([i['2_unseenTasksSolvedAutonomously'].withMemory.approved, i['2_unseenTasksSolvedAutonomously'].withoutMemory.approved], [2, 0]);
  assert.equal(i['3_tasksApprovedWithoutClaude'].count, 2); assert.equal(i['3_tasksApprovedWithoutClaude'].claudeTokensInComparison, 0);
  assert.equal(i['5_cloudTokensPerApprovedTask'].comparisonOnly, 6689); // 13,377 Codex tokens / 2 approved
  assert.equal(i['5_cloudTokensPerApprovedTask'].includingPreparation, 17952); // (15,931 Claude + 19,973 Codex) / 2
  assert.match(i['5_cloudTokensPerApprovedTask'].netSaving, /not established/);
  assert.equal(i['6_reliabilitySafetyQuality'].approvedWithStressZeroMismatch, 2);
  assert.match(r.scope, /not an authorisation/); assert.match(r.performance.note, /not a budget/);
});

test('transfer: one near transfer is reported as single, never as a general skill', () => {
  const t = computeIndicators(data).indicators['4_transferableSkillsInMind'];
  assert.equal(t.lessons, 1); assert.equal(t.withObservedNearTransfer, 1); assert.equal(t.withRepeatedTransferOnTwoOrMoreOtherTasks, 0);
  assert.equal(t.detail[0].transferStrength, 'single-near-transfer'); assert.deepEqual(t.detail[0].succeededOn, ['meanabs']);
});

test('the mastery rule is fixed in advance and needs several tasks, trials and a high autonomous rate with no unsafe run', () => {
  assert.deepEqual(MASTERY, { minUnseenTasks: 3, minTrialsPerTask: 2, minAutonomousApprovalRate: 0.7 });
  const run = (task, k, outcome, over = {}) => ({ task, arm: 'mem', outcome, attempts: 1, seconds: 1, qwenTokens: 1, codexTokens: 0, claudeTokens: 0, peakLlamaRamMB: 1, methodsShown: [], cleanup: { tempRemoved: true, dockerLeftovers: [] }, sourceUnchanged: true, wideCheck: { inputs: 1500, mismatches: 0 }, ...over });
  const good = ['meanabs', 'midrange', 'meanpos'].flatMap((t) => [run(t, 1, 'fixture-approved'), run(t, 2, 'fixture-approved')]);
  const find = (runs) => computeIndicators({ runs, prep: [], totals: {} }).indicators['1_categoriesMastered'].detail.find((c) => c.id === 'algorithms');
  assert.equal(find(good).mastered, true);
  assert.equal(find(good.slice(0, 4)).mastered, false, 'two tasks are not enough');
  assert.equal(find([...good.slice(0, 4), ...[1, 2, 3, 4].map((k) => run('meanpos', k, 'stalled'))]).mastered, false, 'too many failures');
  assert.equal(find(good.map((r, i) => (i === 0 ? { ...r, cleanup: { tempRemoved: false, dockerLeftovers: [] } } : r))).mastered, false, 'an unclean run blocks mastery');
  assert.equal(find(good.map((r, i) => (i === 0 ? { ...r, sourceUnchanged: false } : r))).mastered, false);
  assert.ok(CATEGORIES.length === 10 && CATEGORIES.filter((c) => c.tasks.length).length === 1, 'nine of the ten requested categories have no measurement yet');
});
