'use strict';
// 2026-11-22: two dropped LM Studio connections (16:31, 17:01) used up Qwen's last resumes and handed a task to
// Claude although Qwen had done nothing wrong. A machine outage now pauses Qwen without counting against it.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { MindAutopilot } = require('./autopilot');

function repo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sym-outage-'));
  const g = (...a) => execFileSync('git', a, { cwd: dir, encoding: 'utf8' }).trim();
  g('init', '-q');
  fs.writeFileSync(path.join(dir, 'a.js'), 'module.exports = 1;\n');
  g('add', '.'); g('-c', 'user.name=T', '-c', 'user.email=t@example.invalid', 'commit', '-qm', 'init');
  return { dir, base: g('rev-parse', 'HEAD'), cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}
function pilot(r, active) {
  const p = Object.create(MindAutopilot.prototype);
  p.def = { qwen: { enabled: true, maxFiles: 6, maxBytes: 48000, maxRepairs: 2, maxResumes: 12, maxCoaching: 1 }, protectedPaths: [], verify: [], linkDirs: [] };
  p.state = { active, repoPath: r.dir + '-main-checkout' };
  p.calls = []; p.logs = [];
  p.dispatch = (stage) => p.calls.push(stage);
  p.log = (kind, msg) => p.logs.push(kind + ': ' + msg);
  p.learn = () => {}; p.trace = () => {}; p.save = () => {}; p.noteQwenTask = () => {}; p.unlinkActive = () => {};
  return p;
}
const plan = { title: 'Fix x', objective: 'Fix x in a.js', evidence: ['a.js:1 returns 1'] };
const stop = (msg) => ({ cli: 'qwen3-4b-local', state: 'failed', error: 'QWEN_INTERRUPTED: ' + msg, execution: { notes: [], strategies: [] } });

test('an LM Studio outage pauses Qwen even with no resume left, and does not use a resume', () => {
  const r = repo();
  try {
    const a = { stage: 'implement', plan, implementer: 'qwen', worktree: { path: r.dir }, baseSha: r.base, qwenResumes: 12 };
    const p = pilot(r, a);
    const now = Date.now();
    for (const msg of ['Model call failed (fetch failed); progress saved', 'LM Studio unreachable; progress saved', 'qwen/qwen3.5-9b with 8192 context is not loaded']) {
      a.stage = 'implement';
      assert.equal(p.qwenStopped(a, stop(msg), now), true);
      assert.equal(a.stage, 'budget-wait', msg);
      assert.equal(a.waitingStage, 'implement');
    }
    assert.equal(a.qwenResumes, 12, 'resumes untouched');
    assert.equal(a.qwenFailed, undefined, 'not handed to Claude');
    assert.deepEqual(p.calls, [], 'no coach, no takeover');
    assert.match(p.logs.at(-1), /not counted against Qwen/);
  } finally { r.cleanup(); }
});

test('an outage longer than 6 hours finally counts as a block (coach first)', () => {
  const r = repo();
  try {
    const t0 = Date.now();
    const a = { stage: 'implement', plan, implementer: 'qwen', worktree: { path: r.dir }, baseSha: r.base };
    const p = pilot(r, a);
    for (let t = t0; t < t0 + 6 * 3600000; t += 10 * 60000) { a.stage = 'implement'; p.qwenStopped(a, stop('LM Studio unreachable; progress saved'), t); }
    a.stage = 'implement';
    p.qwenStopped(a, stop('LM Studio unreachable; progress saved'), t0 + 6 * 3600000 + 1);
    assert.deepEqual(p.calls, ['coach']);
  } finally { r.cleanup(); }
});

test('a continuous outage seen only in short daily windows still reaches the limit', () => {
  const r = repo();
  try {
    const t0 = Date.now();
    const a = { stage: 'implement', plan, implementer: 'qwen', worktree: { path: r.dir }, baseSha: r.base };
    const p = pilot(r, a);
    p.qwenStopped(a, stop('LM Studio unreachable; progress saved'), t0);
    a.stage = 'implement';
    p.qwenStopped(a, stop('LM Studio unreachable; progress saved'), t0 + 24 * 3600000); // next day's window
    assert.deepEqual(p.calls, ['coach'], 'idle hours do not reset a continuous outage');
  } finally { r.cleanup(); }
});

test('only a model answer ends an outage: the next failure starts a new clock', () => {
  const r = repo();
  try {
    const t0 = Date.now();
    const a = { stage: 'implement', plan, implementer: 'qwen', worktree: { path: r.dir }, baseSha: r.base };
    const p = pilot(r, a);
    p.qwenStopped(a, stop('Model call failed (fetch failed)'), t0);
    // A later Qwen run that got answers from the model (real noteQwenTask, not the stub).
    MindAutopilot.prototype.noteQwenTask.call(p, a, { cli: 'qwen3-4b-local', state: 'completed', execution: { turns: 3, agentUsage: { calls: 3 } } });
    assert.equal(a.qwenOutageSince, null);
    a.stage = 'implement';
    p.qwenStopped(a, stop('Model call failed (fetch failed)'), t0 + 7 * 3600000);
    assert.equal(a.stage, 'budget-wait');
    assert.equal(a.qwenOutageSince, t0 + 7 * 3600000);
    assert.deepEqual(p.calls, []);
  } finally { r.cleanup(); }
});

test('agentUsage.calls is cumulative per session: an outage retry with no new answer does not reset the clock', () => {
  const r = repo();
  try {
    const t0 = Date.now();
    const a = { stage: 'implement', plan, implementer: 'qwen', worktree: { path: r.dir }, baseSha: r.base, qwenSessionId: 's1' };
    const p = pilot(r, a);
    const note = (calls) => MindAutopilot.prototype.noteQwenTask.call(p, a, { cli: 'qwen3-4b-local', state: 'failed', execution: { agentUsage: { calls } } });
    note(5); // earlier run: 5 answers
    a.qwenOutageSince = t0; // outage started
    note(5); // outage retry: same cumulative count, no new answer
    assert.equal(a.qwenOutageSince, t0, 'clock keeps running');
    note(6); // one new answer
    assert.equal(a.qwenOutageSince, null, 'outage over');
    a.qwenOutageSince = t0; a.qwenSessionId = 's2';
    note(1); // a new session counts from 0
    assert.equal(a.qwenOutageSince, null);
  } finally { r.cleanup(); }
});

test('the coach gives exactly one more repair attempt, not two', () => {
  const r = repo();
  try {
    const a = { stage: 'repair', plan, implementer: 'qwen', worktree: { path: r.dir }, baseSha: r.base, qwenRepairs: 2 };
    const p = pilot(r, a);
    p.orch = { spawnQwenInWorktree: () => {}, isQwenRepoEnabled: () => true };
    a.qwenCoachGrant = true; // what coachSettled sets
    assert.equal(p.qwenRepoCandidate('repair').ok, true);
    a.qwenCoachGrant = false; // consumed by the repair dispatch
    assert.equal(p.qwenRepoCandidate('repair').ok, false, 'counter untouched: no second attempt');
    assert.equal(a.qwenRepairs, 2);
  } finally { r.cleanup(); }
});

test('an outage during a repair gives the repair attempt back (or the coach grant it used)', () => {
  const r = repo();
  try {
    const a = { stage: 'repair', plan, implementer: 'qwen', worktree: { path: r.dir }, baseSha: r.base, qwenRepairs: 1, qwenRepairPaid: true };
    const p = pilot(r, a);
    p.qwenStopped(a, stop('LM Studio unreachable; progress saved'), Date.now());
    assert.equal(a.qwenRepairs, 0, 'paid attempt refunded');
    assert.equal(a.waitingStage, 'repair');
    const b = { stage: 'repair', plan, implementer: 'qwen', worktree: { path: r.dir }, baseSha: r.base, qwenRepairs: 2, qwenRepairPaid: false };
    pilot(r, b).qwenStopped(b, stop('Model call failed (fetch failed)'), Date.now());
    assert.equal(b.qwenRepairs, 2);
    assert.equal(b.qwenCoachGrant, true, 'the coach grant comes back');
  } finally { r.cleanup(); }
});

test('with maxRepairs 0 the coach grant still lets Qwen try the guidance once', () => {
  const r = repo();
  try {
    const a = { stage: 'repair', plan, implementer: 'qwen', worktree: { path: r.dir }, baseSha: r.base, qwenRepairs: 0 };
    const p = pilot(r, a);
    p.def.qwen.maxRepairs = 0;
    p.orch = { spawnQwenInWorktree: () => {}, isQwenRepoEnabled: () => true };
    assert.equal(p.qwenRepoCandidate('repair').ok, false, 'no grant: refused');
    a.qwenCoachGrant = true;
    assert.equal(p.qwenRepoCandidate('repair').ok, true, 'grant: allowed');
  } finally { r.cleanup(); }
});

test('a model HTTP 4xx (bad request) is not an outage; a 5xx or a dropped connection is', () => {
  const { isQwenOutage } = require('./autopilot');
  assert.equal(isQwenOutage('Model call failed (HTTP 400); progress saved'), false);
  assert.equal(isQwenOutage('Model call failed (HTTP 500); progress saved'), true);
  assert.equal(isQwenOutage('Model call failed (fetch failed); progress saved'), true);
  const r = repo();
  try {
    const a = { stage: 'implement', plan, implementer: 'qwen', worktree: { path: r.dir }, baseSha: r.base, qwenResumes: 0 };
    const p = pilot(r, a);
    p.qwenStopped(a, stop('Model call failed (HTTP 400); progress saved'), Date.now());
    assert.equal(a.qwenResumes, 1, 'counted like an ordinary interruption');
    assert.equal(a.qwenOutageSince, undefined);
  } finally { r.cleanup(); }
});

test('an ordinary interruption (work slot ended) still uses a resume', () => {
  const r = repo();
  try {
    const a = { stage: 'implement', plan, implementer: 'qwen', worktree: { path: r.dir }, baseSha: r.base, qwenResumes: 3 };
    const p = pilot(r, a);
    p.qwenStopped(a, stop('Work slot ended; progress saved, the task resumes in the next slot'), Date.now());
    assert.equal(a.qwenResumes, 4);
    assert.equal(a.stage, 'budget-wait');
  } finally { r.cleanup(); }
});

// A local time today at hh:mm (the window helpers use local time).
const at = (h, m) => { const d = new Date(); return new Date(d.getFullYear(), d.getMonth(), d.getDate(), h, m, 0, 0).getTime(); };
test('a step that ran out of time inside an open window resumes soon, not at the next window start', () => {
  const r = repo();
  try {
    const a = { stage: 'implement', plan, implementer: 'qwen', worktree: { path: r.dir }, baseSha: r.base, qwenResumes: 1 };
    const p = pilot(r, a);
    p.def.schedule = { start: '14:00', end: '19:00' };
    const now = at(16, 26);
    p.qwenStopped(a, stop('Work slot ended; progress saved, the task resumes in the next slot'), now);
    assert.equal(a.stage, 'budget-wait');
    assert.equal(a.waitingStage, 'implement');
    assert.equal(p.state.nextAt, now + 10 * 60000, 'resumes in the same window');
    assert.equal(a.qwenResumes, 2);
  } finally { r.cleanup(); }
});

test('a slot that ended with the window waits for the next window start', () => {
  const r = repo();
  try {
    const a = { stage: 'implement', plan, implementer: 'qwen', worktree: { path: r.dir }, baseSha: r.base };
    const p = pilot(r, a);
    p.def.schedule = { start: '14:00', end: '19:00' };
    const now = at(19, 0) + 30000;
    p.qwenStopped(a, stop('Work slot ended; progress saved, the task resumes in the next slot'), now);
    const next = new Date(p.state.nextAt);
    assert.ok(p.state.nextAt > now);
    assert.equal(next.getHours(), 14);
    assert.equal(next.getMinutes(), 0);
  } finally { r.cleanup(); }
});

test('a real block (not an outage) still goes to the coach', () => {
  const r = repo();
  try {
    const a = { stage: 'implement', plan, implementer: 'qwen', worktree: { path: r.dir }, baseSha: r.base };
    const p = pilot(r, a);
    p.qwenStopped(a, { cli: 'qwen3-4b-local', state: 'failed', error: 'QWEN_BLOCKED: The same failure persists after 3 changes of strategy', execution: {} }, Date.now());
    assert.deepEqual(p.calls, ['coach']);
  } finally { r.cleanup(); }
});
