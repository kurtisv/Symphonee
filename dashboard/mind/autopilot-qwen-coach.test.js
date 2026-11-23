'use strict';
// Decision of 2026-11-22: Qwen writes the code; Claude guides it (read-only) before taking a correction over.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { MindAutopilot, STAGES } = require('./autopilot');

function repo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sym-coach-'));
  const g = (...a) => execFileSync('git', a, { cwd: dir, encoding: 'utf8' }).trim();
  g('init', '-q');
  fs.writeFileSync(path.join(dir, 'a.js'), 'module.exports = 1;\n');
  g('add', '.'); g('-c', 'user.name=T', '-c', 'user.email=t@example.invalid', 'commit', '-qm', 'init');
  return { dir, base: g('rev-parse', 'HEAD'), cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

// A pilot with only the parts the routing uses; dispatch is recorded instead of spawning anything.
function pilot(r, active, qwen = { enabled: true, maxFiles: 6, maxBytes: 48000, maxRepairs: 2, maxResumes: 12, maxCoaching: 1 }) {
  const p = Object.create(MindAutopilot.prototype);
  p.def = { qwen, protectedPaths: [], verify: [], linkDirs: [] };
  p.state = { active, repoPath: r.dir + '-main-checkout' }; // the worktree under test is never the main checkout
  p.calls = []; p.logs = []; p.lessons = [];
  p.dispatch = (stage) => { p.calls.push({ stage, implementer: active.implementer, review: active.review }); };
  p.log = (kind, msg) => p.logs.push(kind + ': ' + msg);
  p.learn = (kind, text) => p.lessons.push({ kind, text });
  p.trace = () => {}; p.save = () => {}; p.noteQwenTask = () => {}; p.unlinkActive = () => {};
  return p;
}
const plan = { title: 'Fix x', objective: 'Fix x in a.js', evidence: ['a.js:1 returns 1'] };
const blocked = { cli: 'qwen3-4b-local', state: 'failed', error: 'QWEN_BLOCKED: SEARCH block malformed', execution: { notes: ['edit failed'], strategies: ['edit'] } };

test('coach is a real stage', () => { assert.ok(STAGES.includes('coach')); });

test('a blocked Qwen gets Claude guidance first, not a takeover', () => {
  const r = repo();
  try {
    const a = { stage: 'implement', plan, implementer: 'qwen', worktree: { path: r.dir }, baseSha: r.base };
    const p = pilot(r, a);
    assert.equal(p.qwenStopped(a, blocked, Date.now()), true);
    assert.deepEqual(p.calls.map(c => c.stage), ['coach']);
    assert.equal(a.qwenFailed, undefined, 'Qwen is not handed back yet');
    assert.match(a.coachFindings, /SEARCH block malformed/);
  } finally { r.cleanup(); }
});

test('after the guidance Qwen tries again, with the guidance, and the lesson is kept', () => {
  const r = repo();
  try {
    const a = { stage: 'coach', plan, implementer: 'qwen', worktree: { path: r.dir }, baseSha: r.base, qwenRepairs: 2, coachFindings: 'edit failed' };
    const p = pilot(r, a);
    a.coachCwd = r.dir; a.coachFingerprint = require('./autopilot').worktreeFingerprint(r.dir);
    p.coachSettled('1. ROOT CAUSE: a.js:1\n2. FIX: return 2\n3. TEST: node a.js\n4. LESSON: read the file before writing a SEARCH block');
    // No change in the worktree yet: Qwen implements again (not Claude).
    assert.deepEqual(p.calls.map(c => c.stage), ['implement']);
    assert.equal(p.calls[0].implementer, 'qwen');
    assert.equal(a.qwenCoached, 1);
    assert.equal(a.qwenCoachGrant, true, 'one more Qwen attempt is granted, explicitly (the counter is not lowered)');
    assert.match(a.coachGuidance, /ROOT CAUSE/);
    assert.ok(p.lessons.some(l => l.kind === 'aide-claude' && /read the file before writing a SEARCH block/.test(l.text)));
    // With work in the worktree, Qwen repairs it.
    fs.writeFileSync(path.join(r.dir, 'a.js'), 'module.exports = 2;\n');
    const b = { stage: 'coach', plan, implementer: 'qwen', worktree: { path: r.dir }, baseSha: r.base, coachFindings: 'x' };
    const p2 = pilot(r, b);
    b.coachCwd = r.dir; b.coachFingerprint = require('./autopilot').worktreeFingerprint(r.dir);
    p2.coachSettled('FIX: y');
    assert.deepEqual(p2.calls.map(c => c.stage), ['repair']);
    assert.match(b.review, /GUIDANCE FROM CLAUDE/);
  } finally { r.cleanup(); }
});

test('Qwen still stuck after the guidance: Claude takes the correction over', () => {
  const r = repo();
  try {
    fs.writeFileSync(path.join(r.dir, 'a.js'), 'module.exports = 3;\n');
    const a = { stage: 'repair', plan, implementer: 'qwen', worktree: { path: r.dir }, baseSha: r.base, qwenCoached: 1 };
    const p = pilot(r, a);
    p.qwenStopped(a, blocked, Date.now());
    assert.deepEqual(p.calls.map(c => c.stage), ['repair']);
    assert.equal(a.qwenFailed, true);
    assert.equal(a.implementer, 'claude-after-qwen');
  } finally { r.cleanup(); }
});

test('guidance that changed files is refused', () => {
  const r = repo();
  try {
    const a = { stage: 'coach', plan, implementer: 'qwen', worktree: { path: r.dir }, baseSha: r.base };
    const p = pilot(r, a);
    a.coachCwd = r.dir; a.coachFingerprint = require('./autopilot').worktreeFingerprint(r.dir);
    fs.writeFileSync(path.join(r.dir, 'a.js'), 'changed by the coach\n');
    assert.throws(() => p.coachSettled('FIX: z'), /read-only guidance/);
  } finally { r.cleanup(); }
});

test('coaching can be turned off per pilot (maxCoaching 0): direct takeover as before', () => {
  const r = repo();
  try {
    const a = { stage: 'implement', plan, implementer: 'qwen', worktree: { path: r.dir }, baseSha: r.base };
    const p = pilot(r, a, { enabled: true, maxFiles: 6, maxBytes: 48000, maxRepairs: 2, maxResumes: 12, maxCoaching: 0 });
    p.qwenStopped(a, blocked, Date.now());
    assert.equal(a.qwenFailed, true);
    assert.notEqual(p.calls[0].stage, 'coach');
  } finally { r.cleanup(); }
});
