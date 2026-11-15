'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const A = require('./lesson-applicability');
const L = require('./lessons');

const profile = (over = {}) => ({ id: 'meanabs', hazard: 'intermediate-overflow', input: 'number-array', kind: 'numeric-array-aggregate', problem: 'overflow of an intermediate value', features: A.FEATURES.slice(), ...over });
const lesson = (over = {}, code = 'function f(v){const s=v.reduce((m,x)=>Math.max(m,Math.abs(x)),0);return s}') => ({ key: 'k1', applicability: A.buildApplicability({ profile: profile({ id: 'average' }), code, family: 'average', wide: { inputs: 1500, mismatches: 0 } }), ...over });

test('applicability metadata is built by the host from the task profile and the validated code', () => {
  const a = A.buildApplicability({ profile: profile({ id: 'average' }), code: 'function f(v){return v.reduce((m,x)=>x>0?Math.max(m,Math.abs(x)):m,0)}', family: 'average', wide: { inputs: 1500, mismatches: 0 } });
  assert.deepEqual(a.requires.sort(), ['Math.abs', 'Math.max', 'comparison', 'conditional', 'reduce'].sort());
  assert.equal(a.level, 'independent-checks+codex-review+stress'); assert.match(a.limits[0], /validated on "average" only/); assert.deepEqual(A.applicabilityProblems(a), []);
  assert.equal(A.buildApplicability({ profile: null, code: '', family: 'x' }), null, 'no profile, no metadata');
  assert.ok(A.applicabilityProblems({ ...a, requires: ['eval'] }).includes('requires'));
  assert.ok(A.applicabilityProblems(null).length);
});

test('assess: hazard, input kind, task kind and syntax decide; words do not', () => {
  const l = lesson();
  assert.equal(A.assess(l, profile()).applicable, true);
  assert.match(A.assess(l, profile({ hazard: 'none' })).reasons[0], /different hazard/);
  assert.match(A.assess(l, profile({ input: 'integer' })).reasons[0], /different input kind/);
  assert.match(A.assess(l, profile({ kind: 'scalar-predicate' })).reasons[0], /different kind of task/);
  assert.match(A.assess(l, profile({ features: ['const', 'length'] })).reasons[0], /needs syntax this task profile does not allow: reduce/);
  assert.equal(A.assess(l, null).applicable, true, 'no profile: structural check skipped');
  assert.equal(A.assess({ key: 'old' }, profile()).applicable, null, 'legacy-format lessons are not decided structurally');
});

test('assess: usage is an association; it demotes or hides on a task, never deletes', () => {
  const l = lesson();
  assert.equal(A.assess(l, profile({ id: 'midrange' }), { uses: 2, usesSucceeded: 0, byTask: { midrange: { uses: 2, ok: 0 } } }).applicable, false);
  assert.equal(A.assess(l, profile({ id: 'meanabs' }), { uses: 2, usesSucceeded: 0, byTask: { midrange: { uses: 2, ok: 0 } } }).applicable, true, 'another task is unaffected');
  assert.equal(A.assess(l, profile({ id: 'midrange' }), { uses: 1, usesSucceeded: 0, byTask: { midrange: { uses: 1, ok: 0 } } }).applicable, true, 'one failure is not enough');
  const base = A.assess(l, profile()).score, low = A.assess(l, profile(), { uses: 8, usesSucceeded: 1, byTask: {} });
  assert.ok(low.score < base && /association, not causality/.test(low.reasons.join()));
  assert.ok(A.assess(l, profile({ id: 'average' })).score > base, 'a lesson validated on this very task ranks higher');
});

test('select: never two methods for the same hazard, none when nothing applies, legacy only as a last resort', () => {
  const a = { id: 'a', lesson: lesson({ key: 'a' }), usage: {} }, b = { id: 'b', lesson: lesson({ key: 'b' }), usage: { uses: 5, usesSucceeded: 5, byTask: {} } };
  b.lesson.applicability.validatedOn = ['average', 'meanabs'];
  const s = A.select([a, b], profile());
  assert.equal(s.kept.length, 1, 'two methods for one hazard would contradict each other'); assert.equal(s.kept[0].id, 'b');
  assert.equal(s.decisions.find((d) => d.id === 'a').shown, false); assert.match(s.decisions.find((d) => d.id === 'a').reasons.join(), /another applicable method/);
  assert.equal(A.select([a, b], profile({ hazard: 'none' })).kept.length, 0);
  const legacy = { id: 'o', lesson: { key: 'o' }, usage: {} };
  assert.deepEqual(A.select([legacy], profile(), { legacyWordRelevant: () => true }).kept.map((x) => x.id), ['o'], 'legacy-format: the historical word rule, when nothing structured applies');
  assert.deepEqual(A.select([legacy, a], profile(), { legacyWordRelevant: () => true }).kept.map((x) => x.id), ['a'], 'a structured lesson beats a legacy one');
  assert.equal(A.select([legacy], profile(), { legacyWordRelevant: () => false }).kept.length, 0);
});

test('local lessons: selectForTask applies the same gate when a profile is given and is unchanged without one', () => {
  const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sym-applic-')); try {
    const CV = 'pure-subset.test0001', T0 = Date.UTC(2026, 10, 15), scope = L.scopeOf('p', 'fixture:x');
    const e = L.record(root, { scope, kind: 'blockage', text: 'The sum overflows before the division on very large values', key: 'result:non-finite average', source: 'independent checks', evidence: 'verified' }, T0).entry;
    L.attachTeaching(root, scope, e.key, { cause: 'The sum is computed first, so the intermediate total exceeds the double range before the division.', strategy: '1. Find the largest absolute value with a reduce. 2. Divide each element by it before adding. 3. Multiply back.',
      pitfalls: ['Do not index fixed positions of the array'], verify: 'Try three huge equal numbers and confirm the result is finite.', source: 'claude', model: 'sonnet', tokens: 1200, errorClass: 'result:non-finite', family: 'average' }, T0);
    L.validate(root, scope, e.key, { runId: 'a'.repeat(32), family: 'average', checkerVersion: CV, independent: { passed: true, executed: 7, expected: 7 }, applicability: lesson().applicability, wideRequired: true, wide: { inputs: 1500, mismatches: 0 },
      codex: { decision: 'GO', taskId: 'task-1234', diffHash: 'd'.repeat(64), reviewer: { provider: 'codex', cleanup: 'verified-no-descendants', tools: ['functions.request_user_input'], version: 'codex-cli 0.169.0' } },
      codeHash: 'c'.repeat(64), assertionsHash: 'e'.repeat(64), shown: [e.key], blocked: { signature: 'x:y', failedAttempts: 2 }, afterTeaching: true }, { checkerVersion: CV, now: T0 + 5 });
    const q = 'average of very large numbers must not overflow: the intermediate total exceeds the double range';
    assert.equal(L.selectForTask(root, scope, { checkerVersion: CV, question: q, now: T0 + 6, profile: profile() }).methods.length, 1);
    const none = L.selectForTask(root, scope, { checkerVersion: CV, question: q, now: T0 + 6, profile: profile({ hazard: 'none' }) });
    assert.equal(none.methods.length, 0); assert.match(none.decisions[0].reasons.join(), /different hazard/);
    assert.equal(L.selectForTask(root, scope, { checkerVersion: CV, question: q, now: T0 + 6 }).methods.length, 1, 'without a profile: the historical rule');
    assert.match(L.methodsText(L.selectForTask(root, scope, { checkerVersion: CV, question: q, now: T0 + 6, profile: profile() })), /Problem it solves: overflow of an intermediate value\./);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('invalid applicability metadata is refused at validation', () => {
  const ev = { applicability: { version: 1, problem: 'p' } };
  assert.match(L.validationProblems({ ...ev }, 'v', 'k').join(), /applicability invalid/);
});
