'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { classify, profile, eligible } = require('./autopilot-fallback');
test('quota is distinct from rate, network, auth and task errors', () => {
  assert.equal(classify('usage limit reached'), 'quota');
  assert.equal(classify('insufficient_quota'), 'quota');
  for (const s of ['429 rate limit', '401 auth failed', 'context too large', 'ECONNRESET', 'tests failed', 'security violation']) assert.notEqual(classify(s), 'quota');
});
const { MindAutopilot } = require('./autopilot');
const { LIMITS } = require('./autopilot-budget');
test('handoff checkpoint bounds and redacts transferred diagnostics', () => {
  const c = require('./autopilot-fallback').checkpoint({ stage: 'repair', plan: { title: 'token=secretvalue' }, review: 'Bearer abcdef sk-example123 ' + 'x'.repeat(9000) }, Array(150).fill('src/app.js'));
  assert.equal(c.changedFiles.length, 100); assert.ok(c.findings.length <= 2000);
  assert.ok(!JSON.stringify(c).includes('secretvalue')); assert.ok(!c.findings.includes('abcdef'));
});
function simulated(proven = true) {
  const now = Date.now(), a = { stage: 'discover', currentProvider: 'claude', taskId: 'old' };
  const calls = [];
  const p = { id: 'default', def: { fallback: profile({ enabled: true, cloudConsent: true, worktreeWritesConsent: true, maxCalls: 2, tokenCeiling: 900000 }) },
    state: { enabled: true, active: a, budgetCalls: [] }, limits: LIMITS, save() {}, log() {}, blockedByPeer() { return null; },
    readUsage() { return { codex: { readAt: now, windows: [{ usedPct: 10, resetsAt: now + 3600000 }] } }; },
    orch: { providerHealth: { isAvailable() { return true; }, get() { return { lastSuccess: now }; } },
      canConfineProvider() { return true; }, getConfig() { return { OrchestrateCliList: ['qwen'] }; },
      async ensureTaskProcessTerminated() { calls.push('terminated'); return { proven, checkedAt: now }; } },
    dispatch(stage) { calls.push(stage); a.handoff.status = 'dispatched'; a.taskId = 'new'; } };
  return { p, a, now, calls };
}
test('handoff proves termination before dispatch and reserves Codex', async () => {
  const { p, a, now, calls } = simulated();
  assert.equal(await MindAutopilot.prototype.tryQwenHandoff.call(p, a, { id: 'old', cli: 'claude', error: 'usage limit reached' }, now), true);
  assert.deepEqual(calls, ['terminated', 'discover']);
  assert.equal(p.state.budgetCalls[0].cli, 'codex');
  assert.equal(p.state.budgetCalls[0].stage, 'review-hold');
  assert.equal(a.handoff.status, 'dispatched');
});
test('uncertain tree termination disables pilot without dispatch', async () => {
  const { p, a, now, calls } = simulated(false);
  await MindAutopilot.prototype.tryQwenHandoff.call(p, a, { id: 'old', cli: 'claude', error: 'usage limit reached' }, now);
  assert.deepEqual(calls, ['terminated']); assert.equal(p.state.enabled, false); assert.equal(a.handoff.status, 'blocked');
});
test('retained handoffs cannot bypass ownership checks through resume or configure', () => {
  const { p, a } = simulated(); a.handoff = { status: 'blocked' };
  assert.throws(() => MindAutopilot.prototype.resume.call(p), /ownership verification/);
  assert.throws(() => MindAutopilot.prototype.configure.call(p, { enabled: true }), /ownership verification/);
});
test('ready handoff revalidates consent at actual dispatch', () => {
  const { p, a, now, calls } = simulated();
  a.handoff = { stage: 'discover', status: 'ready' }; p.def.fallback.cloudConsent = false;
  assert.throws(() => MindAutopilot.prototype.dispatch.call(p, 'discover', now), /preflight changed/);
  assert.equal(a.handoff.status, 'blocked'); assert.deepEqual(calls, []);
});
test('same failed Claude task cannot dispatch a second Qwen worker', async () => {
  const { p, a, now, calls } = simulated(); const task = { id: 'old', cli: 'claude', error: 'usage limit reached' };
  await MindAutopilot.prototype.tryQwenHandoff.call(p, a, task, now);
  await MindAutopilot.prototype.tryQwenHandoff.call(p, a, task, now);
  assert.deepEqual(calls, ['terminated', 'discover']); assert.equal(p.state.budgetCalls.length, 1);
});
test('unsupported confinement and Codex quota never launch Qwen', async () => {
  for (const kind of ['confinement', 'reviewer']) {
    const { p, a, now, calls } = simulated();
    if (kind === 'confinement') p.orch.canConfineProvider = () => false;
    else p.readUsage = () => ({ codex: { readAt: now, windows: [{ usedPct: 100, resetsAt: now + 3600000 }] } });
    assert.equal(await MindAutopilot.prototype.tryQwenHandoff.call(p, a, { id: 'old', cli: 'claude', error: 'usage limit reached' }, now), false);
    assert.deepEqual(calls, []);
  }
});
test('fallback defaults off and requires separate consent and ceilings', () => {
  assert.equal(profile().enabled, false);
  assert.equal(eligible({}, {}).ok, false);
  const p = { enabled: true, cloudConsent: true, worktreeWritesConsent: true, maxCalls: 2, tokenCeiling: 400000 };
  const input = { pilot: 'default', stage: 'implement', error: 'usage limit reached', provider: 'claude', switches: 0, qwenReady: true, reviewerReady: true, executionAllowed: true, calls: 0, chargedTokens: 0, reservation: 100000 };
  assert.equal(eligible(p, input).ok, true);
  for (const key of ['qwenReady', 'reviewerReady', 'executionAllowed']) assert.equal(eligible(p, { ...input, [key]: false }).ok, false);
  assert.equal(eligible(p, { ...input, switches: 1 }).ok, false);
  assert.equal(eligible(p, { ...input, stage: 'code-review' }).ok, false);
  assert.equal(eligible(p, { ...input, pilot: 'pleinsens' }).ok, false);
  assert.equal(eligible(p, { ...input, chargedTokens: 350000 }).ok, false);
});
