'use strict';
// Teacher module (Claude as teacher) and the durable validated-lesson store in Mind.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const tq = require('./qwen-teaching');
const L = require('./lessons');
const { makeFixtureController } = require('./qwen-learning-fixture');

const CV = 'pure-subset.test0001';
const T0 = Date.UTC(2026, 10, 15);
function mindFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sym-mind-teach-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const space = 'fixture_' + crypto.randomBytes(8).toString('hex');
  return { root, space, queueDir: path.join(root, 'queue'), open: () => makeFixtureController({ repoRoot: root, space, queueDir: path.join(root, 'queue') }) };
}
const teaching = (over = {}) => ({ cause: 'The sum is computed first, so the intermediate total exceeds the double range before the division.', strategy: '1. Find the largest absolute value with a reduce. 2. Divide each element by it before adding. 3. Multiply back at the end.',
  pitfalls: ['Do not index fixed positions of the array'], verify: 'Try three huge equal numbers and confirm the result is finite.', source: 'claude', model: 'sonnet', tokens: 1200, errorClass: 'result:non-finite', family: 'average', ...over });
const evidence = (key, over = {}) => ({ runId: 'a'.repeat(32), family: 'average', checkerVersion: CV, independent: { passed: true, executed: 7, expected: 7 },
  codex: { decision: 'GO', taskId: 'task-1234', diffHash: 'd'.repeat(64), reviewer: { provider: 'codex', cleanup: 'verified-no-descendants', tools: ['functions.request_user_input'], version: 'codex-cli 0.169.0' } },
  codeHash: 'c'.repeat(64), assertionsHash: 'e'.repeat(64), shown: [key], blocked: { signature: 'checks:result-non-finite', failedAttempts: 2 }, afterTeaching: true, wideRequired: false, ...over });
const lesson = (key = 'blockage:result non finite average', over = {}, evOver = {}, cv = CV) => ({ key, checkerVersion: cv, teaching: teaching(over), evidence: evidence(key, { checkerVersion: cv, ...evOver }) });
const Q = 'meanAbs(v) average of absolute values must never overflow: the intermediate sum of very large values exceeds the double range';

// ── Teacher module ────────────────────────────────────────────────────────────
test('the teacher prompt carries the evidence and forbids handing over the solution', () => {
  const p = tq.buildTeacherPrompt({ fn: 'average', requirements: 'average(v) must not overflow', subset: 'if/return/const only',
    attempts: [{ attempt: 1, outcome: 'refused by the independent checker', code: 'function average(v){return 1}' }, { attempt: 2, outcome: 'Codex NO-GO', code: 'function average(v){return 2}' }],
    failures: ['average([]) returned 1, but it must return null.'], counterexamples: ['average(1e308,1e308) must return 1e308'] });
  for (const piece of ['TASK: average(v) must not overflow', 'ALLOWED SYNTAX', 'attempt 1 (refused by the independent checker)', 'attempt 2 (Codex NO-GO)', 'average([]) returned 1', 'INPUTS ADDED BY THE REVIEWER', 'do not write the complete function', 'exactly the keys cause'])
    assert.ok(p.includes(piece), piece);
  assert.ok(p.length < 9001);
  assert.equal(tq.codeOf('--- a/x\n+++ b/x\n@@\n-old\n+function f(){}\n+module.exports={f};'), 'function f(){}\nmodule.exports={f};');
});

test('the teacher answer is parsed strictly and a leaked solution is rejected', () => {
  const ok = teaching();
  const good = { cause: ok.cause, principle: 'Keep each intermediate value small by combining small pieces, so that no step leaves the range the machine can hold.', strategy: ok.strategy, pitfalls: ok.pitfalls, verify: ok.verify };
  assert.deepEqual(Object.keys(tq.parseTeaching('```json\n' + JSON.stringify(good) + '\n```', { fn: 'average' })).sort(), ['cause', 'pitfalls', 'principle', 'strategy', 'verify']);
  assert.throws(() => tq.parseTeaching('not json', { fn: 'average' }), /not valid JSON/);
  for (const bad of [{ ...good, extra: 1 }, { cause: good.cause }, { ...good, cause: 'short' }, { ...good, pitfalls: 'x' }, { ...good, pitfalls: Array(6).fill('a trap to avoid') }, { ...good, strategy: 'x'.repeat(1201) }])
    assert.throws(() => tq.parseTeaching(JSON.stringify(bad), { fn: 'average' }), /exactly|out of bounds/, JSON.stringify(bad).slice(0, 60));
  const leaks = [
    'Write function average(v){ return v.length } and export it in the end of the answer please',
    'Then add module.exports = { average } at the bottom of the file once the steps are done',
    'Use this: ```const s = 1``` when you start the first step of the strategy listed here',
    'Idioms: a => b, c => d, e => f, all three together make the whole solution',
    'Step: const a = 1; const b = 2; const c = 3; const d = 4; const e = 5; and then return the result',
    'Use `' + 'x'.repeat(130) + '` in the first step of the approach',
    'Use `v.reduce(f)`, `Math.max(a, b)` and `Math.abs(x)` together in the steps of the approach',
  ];
  for (const text of leaks) assert.throws(() => tq.parseTeaching(JSON.stringify({ ...good, strategy: text }), { fn: 'average' }), /contains the solution/, text.slice(0, 50));
  assert.doesNotThrow(() => tq.parseTeaching(JSON.stringify({ ...good, strategy: '1. Get the scale with `v.reduce((m, x) => Math.max(m, Math.abs(x)), 0)`. 2. Divide each element by the scale. 3. Multiply back at the end of the work.' }), { fn: 'average' }), 'one short idiom is allowed');
});

test('the teacher runs tool-free, read-only, without API keys, with measured usage', () => {
  const o = tq.teacherSpawnOptions({ prompt: 'p', cwd: '/x', space: 's' });
  assert.deepEqual([o.cli, o.readOnly, o.fixtureNoApiKeys, o.noRetry, o.noFallback, o.compactContext, o.usageJson], ['claude', true, true, true, true, true, true]);
  assert.ok(o.cloudTimeoutMs > 0 && o.timeout > 0);
  assert.equal(tq.teacherTokens({ inputTokens: 1696, outputTokens: 14 }), 1710); assert.equal(tq.teacherTokens(null), null); assert.equal(tq.teacherTokens({ inputTokens: 1 }), null);
  assert.match(tq.teachingText({ ...teaching() }), /^TEACHER'S EXPLANATION[\s\S]*NOT been verified yet; write the code yourself[\s\S]*Cause:[\s\S]*Strategy:[\s\S]*Avoid:[\s\S]*Check:/);
});

test('blockage classes are decided by the host', () => {
  assert.equal(tq.errorClassFor('checks', ['x: verification refused: Unsupported expression: CallExpression']), 'syntax:CallExpression');
  assert.equal(tq.errorClassFor('checks', ['verification refused: Unsupported statement: VariableDeclaration']), 'syntax:VariableDeclaration');
  assert.equal(tq.errorClassFor('checks', ['verification refused: Unknown identifier']), 'syntax:UnknownIdentifier');
  assert.equal(tq.errorClassFor('checks', ['verification refused: Unsupported result']), 'result:non-finite');
  assert.equal(tq.errorClassFor('checks', ['maxOf([]) returned 0, but it must return null.']), 'result:wrong-values');
  assert.equal(tq.errorClassFor('checks', ['something else']), 'result:other');
  const a = tq.errorClassFor('review', ['The sum can overflow before division']), b = tq.errorClassFor('review', ['  the SUM can overflow before division. ']);
  assert.equal(a, b); assert.match(a, /^review:[a-f0-9]{8}$/);
});

// ── Durable store in Mind ─────────────────────────────────────────────────────
test('Mind keeps a validated lesson across sessions, with its provenance', t => {
  const m = mindFixture(t), c1 = m.open();
  const r = c1.upsertLesson(lesson(), T0);
  assert.match(r.id, /^qwen_lesson_[a-f0-9]{64}$/); assert.equal(r.merged, false);
  const c2 = m.open(); // a new session: nothing in memory but the graph
  const got = c2.recallLessons({ question: Q, checkerVersion: CV, now: T0 + 1000 });
  assert.equal(got.length, 1); assert.equal(got[0].errorClass, 'result:non-finite'); assert.match(got[0].teaching.strategy, /largest absolute value/);
  assert.deepEqual([got[0].provenance.reviewTaskId, got[0].provenance.checkerVersion, got[0].provenance.evidenceCount, got[0].provenance.proofLevel],
    ['task-1234', CV, 1, 'real-codex-review-fictional-fixture']);
  assert.equal(got[0].provenance.diffHash, 'd'.repeat(64)); assert.equal(got[0].provenance.codeHash, 'c'.repeat(64));
  assert.deepEqual(c2.verifiedLessons(), [], 'nothing is promoted to a real project');
});

test('Mind refuses an unvalidated lesson, whatever the teaching says', t => {
  const m = mindFixture(t), c = m.open(), k = 'blockage:x';
  const bad = [
    lesson(k, {}, { codex: { ...evidence(k).codex, decision: 'NO-GO' } }), lesson(k, {}, { independent: { passed: true, executed: 3, expected: 7 } }),
    lesson(k, {}, { shown: [] }), lesson(k, {}, { afterTeaching: false }), lesson(k, {}, { blocked: { signature: 'x', failedAttempts: 1 } }),
    lesson(k, {}, { codex: { ...evidence(k).codex, reviewer: { ...evidence(k).codex.reviewer, tools: ['functions.exec'] } } }), { ...lesson(k), evidence: undefined },
    lesson(k, { source: 'chatgpt' }), lesson(k, { strategy: '' }), { ...lesson(k), checkerVersion: 'pure-subset.other' },
  ];
  for (const b of bad) assert.throws(() => c.upsertLesson(b, T0), /Invalid lesson|not validated/, JSON.stringify(b).slice(0, 80));
  assert.deepEqual(c.listLessons(), []);
  assert.deepEqual(c.recallLessons({ question: Q, checkerVersion: CV, now: T0 }), []);
});

test('Mind recall returns only current, relevant, enabled lessons', t => {
  const m = mindFixture(t), c = m.open();
  const a = c.upsertLesson(lesson('blockage:a', {}, { runId: '1'.repeat(32) }), T0);
  assert.equal(c.recallLessons({ question: 'Return the capital of a country', checkerVersion: CV, now: T0 + 1 }).length, 0, 'irrelevant');
  assert.equal(c.recallLessons({ question: Q, checkerVersion: 'pure-subset.changed', now: T0 + 1 }).length, 0, 'another checker version');
  assert.equal(c.recallLessons({ question: Q, checkerVersion: CV, now: T0 + 91 * 86400000 }).length, 0, 'expired');
  assert.throws(() => c.recallLessons({ question: Q, now: T0 }), /checkerVersion required/);
  assert.equal(c.retireStale('pure-subset.changed', T0 + 2), 1);
  assert.equal(c.listLessons()[0].obsoleteReason, 'checker-changed'); assert.equal(c.recallLessons({ question: Q, checkerVersion: CV, now: T0 + 3 }).length, 0, 'retired lessons stay retired');
  c.retireLesson(a.id, 'manual');
  assert.equal(c.listLessons()[0].status, 'obsolete');
});

test('Mind merges the same method, supersedes a contradicting one, and counts uses', t => {
  const m = mindFixture(t), c = m.open();
  const a = c.upsertLesson(lesson('blockage:a', {}, { runId: '1'.repeat(32) }), T0);
  const again = c.upsertLesson(lesson('blockage:b', {}, { runId: '2'.repeat(32) }), T0 + 10);
  assert.deepEqual([again.merged, again.id, again.evidenceCount], [true, a.id, 2]);
  assert.equal(c.upsertLesson(lesson('blockage:c', {}, { runId: '2'.repeat(32) }), T0 + 20).evidenceCount, 2, 'the same run counts once');
  assert.equal(c.listLessons().filter((x) => x.status === 'validated').length, 1);
  const other = c.upsertLesson(lesson('blockage:d', { strategy: '1. Halve every element first. 2. Add the halves with a bounded reduce. 3. Double the total after clamping it.', cause: 'Doubling happens too late, after the accumulated total already overflowed in the loop.' }, { runId: '3'.repeat(32) }), T0 + 30);
  assert.deepEqual(other.superseded, [a.id]);
  const all = c.listLessons(); assert.deepEqual(all.map((x) => x.status).sort(), ['obsolete', 'validated']);
  assert.equal(all.find((x) => x.id === a.id).supersededBy, other.id);
  const rec = c.recallLessons({ question: Q, checkerVersion: CV, now: T0 + 40 });
  assert.deepEqual(rec.map((x) => x.id), [other.id], 'only the current method comes back');
  c.recordLessonUse(other.id, true); c.recordLessonUse(other.id, false);
  const after = c.recallLessons({ question: Q, checkerVersion: CV, now: T0 + 41 })[0].provenance;
  assert.deepEqual([after.uses, after.usesSucceeded], [2, 1]);
  assert.throws(() => c.recordLessonUse('bad', true), /Invalid lesson use/); assert.throws(() => c.recordLessonUse(other.id, 'yes'), /Invalid lesson use/);
});

test('a corrupted lesson node is ignored, not trusted', t => {
  const m = mindFixture(t), c = m.open(), store = require('./store');
  c.upsertLesson(lesson(), T0);
  const g = store.loadGraph(m.root, m.space); g.nodes.find((n) => n.source?.type === 'qwen-fixture-lesson').content = g.nodes.find((n) => n.source?.type === 'qwen-fixture-lesson').content.replace('largest', 'tampered');
  store.saveGraph(m.root, m.space, g);
  assert.deepEqual(c.recallLessons({ question: Q, checkerVersion: CV, now: T0 + 1 }), []);
  assert.equal(c.listLessons()[0].status, 'corrupt');
});

// ── Generalisation through the existing skill reflection ─────────────────────
test('skills are proposed only from several independent validated runs, and never applied', () => {
  assert.deepEqual(tq.skillProposals([]).candidates, []);
  const mk = (key, runId) => ({ key, status: 'validated', errorClass: 'result:non-finite', teaching: teaching(), validation: { history: [{ runId, at: T0 }] } });
  assert.match(tq.skillProposals([mk('a', '1'.repeat(32))]).reason, /fewer than two/);
  const r = tq.skillProposals([mk('a', '1'.repeat(32)), mk('b', '2'.repeat(32))]);
  assert.equal(r.applied, false);
  for (const c of r.candidates) assert.ok(c.sessions >= 2 && c.steps.length >= 2);
  const obsolete = { ...mk('c', '3'.repeat(32)), status: 'obsolete' };
  assert.match(tq.skillProposals([mk('a', '1'.repeat(32)), obsolete]).reason, /fewer than two/, 'retired lessons are no evidence');
});

// ---- stress proof in Mind, legacy lessons, general principle ----
const store = require('./store');
const legacyize = (m, id) => { // rewrite a stored lesson the way a pre-proof build wrote it
  const g = store.loadGraph(m.root, m.space), n = g.nodes.find((x) => x.id === id), c = JSON.parse(n.content);
  delete c.validation.wideRequired; delete c.validation.wide; c.validation.history.forEach((h) => { delete h.wideRequired; delete h.wide; });
  n.content = JSON.stringify(c); n.observationDigest = crypto.createHash('sha256').update(n.content).digest('hex'); store.saveGraph(m.root, m.space, g);
};

test('Mind: a legacy lesson stays stored with its history but is not recalled as certified; retireStale keeps it; a proven run upgrades it', t => {
  const m = mindFixture(t), c = m.open();
  const a = c.upsertLesson(lesson('blockage:a', {}, { runId: '1'.repeat(32) }), T0);
  assert.equal(c.recallLessons({ question: Q, checkerVersion: CV, now: T0 + 1 }).length, 1, 'with the proof declared it is recalled');
  legacyize(m, a.id);
  const c2 = m.open();
  assert.equal(c2.recallLessons({ question: Q, checkerVersion: CV, now: T0 + 2 }).length, 0, 'legacy: not recalled as a certified method');
  const row = c2.listLessons()[0];
  assert.equal(row.status, 'validated'); assert.equal(row.certified, false); assert.equal(row.validation.history.length, 1, 'history kept');
  assert.equal(c2.retireStale(CV, T0 + 3), 0, 'unproven is not stale: nothing is retired or lost');
  const up = c2.upsertLesson(lesson('blockage:b', {}, { runId: '2'.repeat(32), wideRequired: true, wide: { inputs: 1500, mismatches: 0 } }), T0 + 10);
  assert.equal(up.merged, true); assert.equal(up.id, a.id);
  const back = c2.listLessons()[0]; assert.equal(back.certified, true); assert.equal(back.validation.evidenceCount, 2); assert.equal(back.validation.certifiedBy, '2'.repeat(32));
  assert.equal(c2.recallLessons({ question: Q, checkerVersion: CV, now: T0 + 11 }).length, 1);
});

test('Mind refuses to store a lesson whose required stress proof is missing, failed or too small', t => {
  const c = mindFixture(t).open();
  for (const [over, re] of [[{ wideRequired: true }, /wide check missing/], [{ wideRequired: true, wide: { inputs: 10, mismatches: 0 } }, /wide check not passed/], [{ wideRequired: true, wide: { inputs: 1500, mismatches: 1 } }, /wide check not passed/]])
    assert.throws(() => c.upsertLesson(lesson('blockage:x', {}, over), T0), re);
  assert.equal(c.listLessons().length, 0);
});

test('the stress proof is stored with the Mind lesson and its history', t => {
  const c = mindFixture(t).open();
  c.upsertLesson(lesson('blockage:a', {}, { wideRequired: true, wide: { inputs: 1500, mismatches: 0 } }), T0);
  const l = c.listLessons()[0]; assert.deepEqual(l.validation.wide, { inputs: 1500, mismatches: 0 }); assert.equal(l.validation.history[0].wideRequired, true);
});

test('the general principle travels with the lesson into recall, and parseTeaching demands one that does not name the function', () => {
  const m = { principle: 'Keep each intermediate value small by combining small pieces, so that no step leaves the range the machine can hold.' };
  const ok = teaching(), good = { cause: ok.cause, principle: m.principle, strategy: ok.strategy, pitfalls: ok.pitfalls, verify: ok.verify };
  assert.equal(tq.parseTeaching(JSON.stringify(good), { fn: 'average' }).principle, m.principle);
  const { principle, ...noPrinciple } = good;
  assert.throws(() => tq.parseTeaching(JSON.stringify(noPrinciple), { fn: 'average' }), /exactly/, 'a new teaching must carry a principle');
  assert.throws(() => tq.parseTeaching(JSON.stringify({ ...good, principle: 'To compute average safely, divide every element by the length first and add them.' }), { fn: 'average' }), /names the current function/);
  assert.throws(() => tq.parseTeaching(JSON.stringify({ ...good, principle: 'short' }), { fn: 'average' }), /out of bounds/);
  assert.match(tq.teachingText({ ...ok, principle: m.principle }), /General principle: Keep each intermediate[\s\S]*Application to this problem: 1\./);
  assert.match(tq.teachingText(ok), /Strategy: 1\./);
});

test('Mind recall carries the principle and an old lesson without one still works', t => {
  const mf = mindFixture(t), c = mf.open();
  c.upsertLesson(lesson('blockage:p', { principle: 'Keep each intermediate value small by combining small pieces, so no step leaves the range.' }, { wideRequired: false }), T0);
  const r = c.recallLessons({ question: Q, checkerVersion: CV, now: T0 + 1 });
  assert.equal(r.length, 1); assert.match(r[0].teaching.principle, /Keep each intermediate value small/);
  const mf2 = mindFixture(t), c2 = mf2.open(); c2.upsertLesson(lesson('blockage:q', {}), T0);
  assert.equal(c2.recallLessons({ question: Q, checkerVersion: CV, now: T0 + 1 })[0].teaching.principle, undefined);
});
