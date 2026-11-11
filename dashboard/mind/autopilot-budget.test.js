'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { LIMITS, dailyUsage, reserveCall, settleCall, tokensFromTask, canDispatch,
  startOfNextDay, dayOf } = require('./autopilot-budget');

test('two tasks per day stay possible within ten conservative call reservations', () => {
  assert.equal(LIMITS.dailyCompletions, 2);
  assert.equal(LIMITS.dailyDiscoveries, 2);
  assert.equal(LIMITS.repairs, 1);
  const state = { budgetCalls: [] };
  for (let i = 0; i < 10; i++) {
    assert.ok(reserveCall(state, { cli: i % 2 ? 'codex' : 'claude', stage: 'code-review',
      at: Date.now(), ref: String(i) }));
  }
  assert.equal(dailyUsage(state).calls, 10);
  assert.equal(dailyUsage(state).chargedTokens, LIMITS.dailyTokenBudget);
  assert.equal(dailyUsage(state).unmeteredCalls, 10);
  assert.equal(canDispatch(state), false);
  assert.equal(reserveCall(state, { cli: 'claude', stage: 'repair', ref: 'extra' }), null);
});
test('measured usage releases unused reservations without inventing a token count', () => {
  const state = { budgetCalls: [] };
  reserveCall(state, { cli: 'claude', stage: 'discover', ref: 'one' });
  reserveCall(state, { cli: 'codex', stage: 'plan-review', ref: 'two' });
  assert.equal(settleCall(state, 'one', { state: 'completed', usage: { inputTokens: 300, outputTokens: 200 } }), true);
  assert.equal(settleCall(state, 'one', { state: 'completed', usage: { totalTokens: 1 } }), false);
  assert.equal(settleCall(state, 'two', { state: 'failed' }), true);
  const usage = dailyUsage(state);
  assert.equal(usage.measuredTokens, 500);
  assert.equal(usage.reservedTokens, LIMITS.reservedTokensPerCall);
  assert.equal(usage.unmeteredCalls, 1);
  assert.equal(usage.tokenUsageExact, false);
  assert.equal(usage.byProvider.claude.measuredTokens, 500);
  assert.equal(usage.byProvider.codex.reservedTokens, LIMITS.reservedTokensPerCall);
});
test('reject unsupported token metadata rather than reporting a false exact count', () => {
  assert.equal(tokensFromTask({ usage: { inputTokens: 10 } }), null);
  assert.equal(tokensFromTask({ usage: { totalTokens: -10 } }), null);
  assert.equal(tokensFromTask({ usage: { input_tokens: 123, output_tokens: 44 } }), 167);
  assert.equal(tokensFromTask({ geminiUsage: { total_tokens: 45 } }), 45);
});
test('ledger enforces daily call count when reported tokens are low', () => {
  const state = { budgetCalls: [] };
  for (let i = 0; i < LIMITS.dailyCalls; i++) {
    reserveCall(state, { cli: 'claude', stage: 'discover', ref: String(i) });
    settleCall(state, String(i), { state: 'completed',
      usage: { inputTokens: 10, outputTokens: 10 } });
  }
  assert.equal(dailyUsage(state).calls, LIMITS.dailyCalls);
  assert.equal(canDispatch(state), false);
});
test('ledger resets on UTC day boundary without clearing historical entries', () => {
  const yesterday = Date.UTC(2026, 10, 10, 23, 59);
  const today = startOfNextDay(yesterday);
  const state = { budgetCalls: [] };
  reserveCall(state, { cli: 'claude', stage: 'discover', at: yesterday, ref: 'old' });
  assert.equal(dailyUsage(state, yesterday).calls, 1);
  assert.equal(dayOf(today), '2026-11-11');
  assert.equal(dailyUsage(state, today).calls, 0);
  assert.equal(canDispatch(state, today), true);
  assert.equal(state.budgetCalls.length, 1);
});