'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { MindAutopilot } = require('./autopilot');
function peerBlocked(peer) {
  const pilot = Object.create(MindAutopilot.prototype);
  pilot.peers = () => [pilot, peer];
  return pilot.blockedByPeer();
}
test('a disabled pilot with unresolved handoff still owns the intensive slot', () => {
  for (const status of ['checking', 'ready', 'dispatched', 'blocked', 'unknown-future-status', undefined]) {
    const peer = { state: { enabled: false, active: { waitingStage: 'implement', handoff: { status } } } };
    assert.equal(peerBlocked(peer), peer, status);
  }
});
test('ordinary parked or idle pilots do not reserve the slot', () => {
  for (const peer of [{ state: { enabled: false, active: null } }, { state: { enabled: true, active: { waitingStage: 'budget-wait' } } }]) assert.equal(peerBlocked(peer), null);
});
test('acknowledging an unresolved handoff cannot discard its process ownership', () => {
  const pilot = Object.create(MindAutopilot.prototype);
  const active = { taskId: 'old', handoff: { status: 'blocked' }, worktree: { path: 'retained' } };
  pilot.state = { enabled: false, active, history: [] };
  pilot.orch = { getTask: () => ({ state: 'failed' }) };
  pilot.unlinkActive = () => {}; pilot.log = () => {}; pilot.save = () => {}; pilot.snapshot = () => ({});
  assert.throws(() => pilot.acknowledge(), /handoff/i);
  assert.equal(pilot.state.active, active);
});
test('a parked stage cannot resume while another pilot retains an unresolved handoff', async () => {
  for (const waitingStage of ['verify', 'implement']) {
    const pilot = Object.create(MindAutopilot.prototype);
    const active = { waitingStage, parkReason: 'quota' };
    pilot.state = { enabled: true, active, nextAt: 0 };
    pilot.def = {}; pilot.busy = false;
    pilot.windowCheckIn = () => {}; pilot.snapshot = () => ({}); pilot.save = () => {}; pilot.log = () => {};
    pilot.dispatch = () => { throw new Error('unexpected dispatch'); };
    pilot.startVerify = () => { throw new Error('unexpected verify'); };
    const peer = { state: { enabled: false, active: { handoff: { status: 'blocked' } } } };
    pilot.peers = () => [pilot, peer];
    await pilot.tick(Date.now());
    assert.equal(pilot.state.active, active);
    assert.equal(active.waitingStage, waitingStage);
    assert.equal(active.parkReason, 'quota');
    assert.equal(pilot.state.error, undefined);
  }
});

test('local verification resumes with exhausted daily model budget without launching a model', async () => {
  const pilot = Object.create(MindAutopilot.prototype);
  const now = Date.now();
  const active = { waitingStage: 'verify', stage: 'budget-wait', parkReason: 'restart' };
  pilot.state = { enabled: true, active, nextAt: now - 1, budgetCalls: [{ at: now, cli: 'claude', actualTokens: 4000000 }] };
  pilot.limits = { dailyCalls: 20, dailyTokenBudget: 3000000, reservedTokensPerCall: 150000 };
  pilot.def = {}; pilot.busy = false; pilot.peers = () => [pilot];
  pilot.windowCheckIn = () => {}; pilot.snapshot = () => ({}); pilot.save = () => {}; pilot.log = () => {};
  pilot.dispatch = () => { throw new Error('model launch forbidden'); };
  let verified = 0; pilot.startVerify = () => { verified++; };
  await pilot.tick(now);
  assert.equal(verified, 1);
  assert.equal(active.waitingStage, null);
});

test('restart and schedule waits are not reported as provider quota', () => {
  const pilot = Object.create(MindAutopilot.prototype);
  pilot.def = {};
  for (const parkReason of ['restart', 'window']) {
    pilot.state = { enabled: true, active: { waitingStage: 'verify', parkReason } };
    assert.equal(pilot.status(), 'waiting');
  }
  pilot.state.active.parkReason = 'credit';
  assert.equal(pilot.status(), 'quota');
});

test('model stage due after restart or window reports exhausted internal budget', () => {
  const pilot = Object.create(MindAutopilot.prototype);
  pilot.def = {};
  const now = Date.now();
  pilot.limits = { dailyCalls: 20, dailyTokenBudget: 3000000, reservedTokensPerCall: 150000 };
  for (const parkReason of ['restart', 'window']) {
    pilot.state = { enabled: true, active: { waitingStage: 'implement', parkReason }, nextAt: now - 1,
      budgetCalls: [{ at: now, cli: 'claude', actualTokens: 4000000 }] };
    assert.equal(pilot.status(now), 'quota');
    pilot.state.nextAt = now + 1000;
    assert.equal(pilot.status(now), 'waiting');
    pilot.state.active.waitingStage = 'verify'; pilot.state.nextAt = now - 1;
    assert.equal(pilot.status(now), 'waiting');
  }
});

test('a held review and a stage outside its window are not reported as exhausted budget', () => {
  const pilot = Object.create(MindAutopilot.prototype);
  const now = Date.now();
  pilot.def = {};
  pilot.limits = { dailyCalls: 20, dailyTokenBudget: 3000000, reservedTokensPerCall: 150000 };
  pilot.state = { enabled: true, active: { waitingStage: 'code-review', parkReason: 'restart', reviewHold: 'held' }, nextAt: now - 1,
    budgetCalls: [{ at: now, cli: 'claude', actualTokens: 4000000 }, { ref: 'held', at: now, cli: 'codex', reservedTokens: 150000 }] };
  assert.equal(pilot.status(now), 'waiting');
  pilot.state.active.waitingStage = 'implement';
  pilot.def.schedule = { start: '14:00', end: '19:00' }; pilot.inWindow = () => false;
  assert.equal(pilot.status(now), 'waiting');
});

test('exhausted model budget still blocks parked implementation', async () => {
  const pilot = Object.create(MindAutopilot.prototype);
  const now = Date.now();
  const active = { waitingStage: 'implement', stage: 'budget-wait', parkReason: 'quota' };
  pilot.state = { enabled: true, active, nextAt: now - 1, budgetCalls: [{ at: now, cli: 'claude', actualTokens: 4000000 }] };
  pilot.limits = { dailyCalls: 20, dailyTokenBudget: 3000000, reservedTokensPerCall: 150000 };
  pilot.def = {}; pilot.busy = false; pilot.peers = () => [pilot];
  pilot.windowCheckIn = () => {}; pilot.snapshot = () => ({}); pilot.save = () => {}; pilot.log = () => {};
  pilot.dispatch = () => { throw new Error('model launch forbidden'); };
  await pilot.tick(now);
  assert.equal(active.waitingStage, 'implement');
});

test('local verification waits outside the configured work window', async () => {
  const pilot = Object.create(MindAutopilot.prototype);
  const now = Date.now();
  const active = { waitingStage: 'verify', stage: 'budget-wait', parkReason: 'restart' };
  pilot.state = { enabled: true, active, nextAt: now - 1, budgetCalls: [] };
  pilot.limits = { dailyCalls: 20, dailyTokenBudget: 3000000, reservedTokensPerCall: 150000 };
  pilot.def = { schedule: { start: '14:00', end: '19:00' } }; pilot.busy = false; pilot.peers = () => [pilot];
  pilot.windowCheckIn = () => {}; pilot.snapshot = () => ({}); pilot.save = () => {}; pilot.log = () => {};
  pilot.inWindow = () => false; let parked = 0;
  pilot.parkForWindow = stage => { assert.equal(stage, 'verify'); parked++; return {}; };
  pilot.startVerify = () => { throw new Error('verification outside schedule'); };
  await pilot.tick(now);
  assert.equal(parked, 1);
  assert.equal(active.waitingStage, 'verify');
});
