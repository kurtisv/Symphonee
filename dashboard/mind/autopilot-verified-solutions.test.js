'use strict';
// Decision of 2026-11-24: when Qwen fails even with Claude's coaching and an independent solution already verified on this same code exists,
// Symphonee hands it to Qwen as guidance (Qwen applies it itself); Claude's takeover stays the last resort; nothing here certifies new code.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { MindAutopilot } = require('./autopilot');
const vs = require('./verified-solutions');

function repo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sym-vs-'));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sym-vs-root-'));
  const g = (...a) => execFileSync('git', a, { cwd: dir, encoding: 'utf8' }).trim();
  g('init', '-q');
  fs.writeFileSync(path.join(dir, 'a.js'), 'module.exports = 1;\n');
  g('add', '.'); g('-c', 'user.name=T', '-c', 'user.email=t@example.invalid', 'commit', '-qm', 'init');
  return { dir, root, g, base: g('rev-parse', 'HEAD'), blob: g('rev-parse', 'HEAD:a.js'),
    cleanup: () => { fs.rmSync(dir, { recursive: true, force: true }); fs.rmSync(root, { recursive: true, force: true }); } };
}
const plan = { title: 'flushEvents drops events tracked during the send', objective: 'Fix flushEvents in a.js', evidence: ['a.js:1'] };
const solution = (r, extra = {}) => ({ id: 'flush-race', scope: 'gas-saver', title: 'flushEvents race', files: ['a.js'], keywords: ['flushevents', 'events'], minKeywords: 2,
  fileBlobs: { 'a.js': r.blob }, conditions: 'same a.js', guidance: '1. ROOT CAUSE: identity\n3. FIX: use a Set of the batch objects', evidence: { proof: ['hidden test 6/6', 'independent review PASS'] }, createdBy: 'test', ...extra });

function pilot(r, active, qwen = { enabled: true, maxFiles: 6, maxBytes: 48000, maxRepairs: 2, maxResumes: 12, maxCoaching: 1 }) {
  const p = Object.create(MindAutopilot.prototype);
  p.def = { qwen, protectedPaths: [], verify: [], linkDirs: [], behavior: { required: true } };
  p.state = { active, repoPath: r.dir };
  p.repoRoot = r.root; p.lessonScope = () => 'gas-saver';
  p.calls = []; p.logs = []; p.lessons = []; p.traces = [];
  p.dispatch = (stage) => { p.calls.push({ stage, implementer: active.implementer }); };
  p.log = (kind, msg) => p.logs.push(kind + ': ' + msg);
  p.learn = (kind, text) => p.lessons.push({ kind, text });
  p.trace = (kind, d) => p.traces.push({ kind, ...d }); p.save = () => {}; p.noteQwenTask = () => {}; p.unlinkActive = () => {};
  return p;
}
const blocked = { cli: 'qwen3-4b-local', state: 'failed', error: 'QWEN_BLOCKED: the type has no id', execution: { notes: ['x'], strategies: ['y'] } };
const active = (r, over = {}) => ({ stage: 'repair', plan, implementer: 'qwen', worktree: { path: r.dir }, baseSha: r.base, qwenFiles: ['a.js'], ...over });

test('the store refuses a solution without proof, without files, or with an unsafe id', () => {
  const r = repo();
  try {
    assert.throws(() => vs.add(r.root, solution(r, { evidence: { proof: [] } })), /proof/);
    assert.throws(() => vs.add(r.root, solution(r, { files: [] })), /file/);
    assert.throws(() => vs.add(r.root, solution(r, { id: '../x' })), /id/);
    assert.throws(() => vs.add(r.root, solution(r, { guidance: 'x'.repeat(9001) })), /longer/);
    assert.deepEqual(vs.read(r.root).solutions, []);
  } finally { r.cleanup(); }
});

test('a solution applies only under its conditions: files named, the task looks like it, the file unchanged since it was verified', () => {
  const r = repo();
  try {
    vs.add(r.root, solution(r));
    const ok = vs.find(r.root, { scope: 'gas-saver', plan, namedFiles: ['a.js'], repoPath: r.dir, baseSha: r.base });
    assert.equal(ok.solution && ok.solution.id, 'flush-race');
    assert.equal(vs.find(r.root, { scope: 'default', plan, namedFiles: ['a.js'], repoPath: r.dir, baseSha: r.base }).solution, null, 'another pilot scope');
    assert.equal(vs.find(r.root, { scope: 'gas-saver', plan, namedFiles: ['b.js'], repoPath: r.dir, baseSha: r.base }).solution, null, 'file not named');
    assert.equal(vs.find(r.root, { scope: 'gas-saver', plan: { title: 'rename a label', objective: 'cosmetic', evidence: [] }, namedFiles: ['a.js'], repoPath: r.dir, baseSha: r.base }).solution, null, 'another kind of task');
    fs.writeFileSync(path.join(r.dir, 'a.js'), 'module.exports = 2;\n'); r.g('-c', 'user.name=T', '-c', 'user.email=t@example.invalid', 'commit', '-qam', 'change');
    const stale = vs.find(r.root, { scope: 'gas-saver', plan, namedFiles: ['a.js'], repoPath: r.dir, baseSha: r.g('rev-parse', 'HEAD') });
    assert.equal(stale.solution, null); assert.match(stale.reason, /changed since/);
  } finally { r.cleanup(); }
});

test('coach used up: the verified solution is handed to Qwen (not a takeover), once', () => {
  const r = repo();
  try {
    vs.add(r.root, solution(r));
    const a = active(r, { qwenCoached: 1 });
    const p = pilot(r, a);
    assert.equal(p.qwenStopped(a, blocked, Date.now()), true);
    assert.deepEqual(p.calls.map((c) => c.stage), ['implement'], 'no work yet: Qwen implements again');
    assert.equal(a.qwenFailed, undefined); assert.equal(a.implementer, 'qwen');
    assert.equal(a.relayedSolution, 'flush-race'); assert.equal(a.qwenCoachGrant, true);
    assert.match(a.coachGuidance, /Set of the batch objects/);
    assert.match(a.review, /VERIFIED SOLUTION RELAYED/);
    assert.ok(p.lessons.some((l) => l.kind === 'solution-relayee'));
    assert.equal(vs.read(r.root).solutions[0].uses, 1);
    // Qwen fails again with the relayed solution: Claude takes over (the last resort), the relay is not repeated.
    fs.writeFileSync(path.join(r.dir, 'a.js'), 'module.exports = 3;\n');
    p.qwenStopped(a, blocked, Date.now());
    assert.equal(a.qwenFailed, true); assert.equal(a.implementer, 'claude-after-qwen');
    assert.equal(p.calls.at(-1).stage, 'repair');
  } finally { r.cleanup(); }
});

test('the coach comes first: with coaching left, Claude coaches and the relay waits', () => {
  const r = repo();
  try {
    vs.add(r.root, solution(r));
    const a = active(r, { qwenCoached: 0 });
    const p = pilot(r, a);
    p.qwenStopped(a, blocked, Date.now());
    assert.deepEqual(p.calls.map((c) => c.stage), ['coach']);
    assert.equal(a.relayedSolution, undefined);
  } finally { r.cleanup(); }
});

test('no applicable solution: the takeover happens as before, and the reason is traced', () => {
  const r = repo();
  try {
    const a = active(r, { qwenCoached: 1 });
    const p = pilot(r, a);
    p.qwenStopped(a, blocked, Date.now());
    assert.equal(a.qwenFailed, true);
    assert.ok(p.traces.some((t) => t.kind === 'relay' && t.used === false));
  } finally { r.cleanup(); }
});

test('repair attempts used with coaching used up: the relay happens at dispatch too', () => {
  const r = repo();
  try {
    vs.add(r.root, solution(r));
    fs.writeFileSync(path.join(r.dir, 'a.js'), 'module.exports = 2;\n');
    const a = active(r, { qwenCoached: 1, qwenRepairs: 2 });
    const p = pilot(r, a);
    p.qwenRepoCandidate = () => ({ ok: false, reason: 'Qwen repair attempts used (2)' });
    p.state.consent = { worktreeWrites: true };
    // Only the branch under test: the relay is decided before any budget or spawn logic.
    assert.equal(p.relayVerifiedSolution(a, Date.now(), 'findings'), true);
    assert.deepEqual(p.calls.map((c) => c.stage), ['repair'], 'Qwen already has work in the worktree: it repairs');
  } finally { r.cleanup(); }
});

test('a relayed solution that failed twice is retired; one that worked is confirmed', () => {
  const r = repo();
  try {
    vs.add(r.root, solution(r));
    vs.recordOutcome(r.root, 'flush-race', 'review-rejected'); assert.equal(vs.read(r.root).solutions[0].retired, false);
    vs.recordOutcome(r.root, 'flush-race', 'verify-failed'); assert.equal(vs.read(r.root).solutions[0].retired, true);
    assert.equal(vs.find(r.root, { scope: 'gas-saver', plan, namedFiles: ['a.js'], repoPath: r.dir, baseSha: r.base }).solution, null);
    vs.add(r.root, solution(r, { id: 'ok-one' })); vs.recordOutcome(r.root, 'ok-one', 'completed'); vs.recordOutcome(r.root, 'ok-one', 'review-rejected'); vs.recordOutcome(r.root, 'ok-one', 'review-rejected');
    assert.equal(vs.read(r.root).solutions.find((s) => s.id === 'ok-one').retired, false, 'it has already been confirmed');
  } finally { r.cleanup(); }
});

test('a correction Claude finished after Qwen, with every gate passed, is kept as a verified solution; one without a behaviour test is not', () => {
  const r = repo();
  try {
    fs.mkdirSync(path.join(r.dir, 'src', '__tests__'), { recursive: true });
    fs.writeFileSync(path.join(r.dir, 'a.js'), 'module.exports = 2;\n');
    fs.writeFileSync(path.join(r.dir, 'src', '__tests__', 'a.test.js'), "test('a', () => expect(require('../../a.js')).toBe(2))\n");
    r.g('add', '.'); r.g('-c', 'user.name=T', '-c', 'user.email=t@example.invalid', 'commit', '-qm', 'fix');
    const commit = r.g('rev-parse', 'HEAD');
    const a = active(r, { stage: 'code-review', implementer: 'claude-after-qwen', commit, verify: { ok: true, results: [{ name: 'jest' }] } });
    const p = pilot(r, a);
    p.settleSolutions(a, 'completed');
    const kept = vs.read(r.root).solutions;
    assert.equal(kept.length, 1); assert.deepEqual(kept[0].files, ['a.js']);
    assert.equal(kept[0].fileBlobs['a.js'], r.blob, 'bound to the content of the file before the fix');
    assert.ok(kept[0].evidence.proof.includes('independent review PASS'));
    assert.match(kept[0].guidance, /INDEPENDENT SOLUTION ALREADY VERIFIED/);
    // not completed / written by Qwen: nothing kept
    const r2 = pilot(r, active(r, { implementer: 'qwen', commit, verify: { ok: true, results: [{ name: 'jest' }] } }));
    r2.settleSolutions(r2.state.active, 'completed'); assert.equal(vs.read(r.root).solutions.length, 1);
    // a change without any test is refused
    fs.writeFileSync(path.join(r.dir, 'a.js'), 'module.exports = 5;\n'); r.g('-c', 'user.name=T', '-c', 'user.email=t@example.invalid', 'commit', '-qam', 'notest');
    const made = vs.fromCommit({ repoPath: r.dir, baseSha: commit, commit: r.g('rev-parse', 'HEAD'), plan, scope: 'gas-saver', proof: ['x'] });
    assert.equal(made.ok, false); assert.match(made.reason, /behaviour test/);
  } finally { r.cleanup(); }
});
