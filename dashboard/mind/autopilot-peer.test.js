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
