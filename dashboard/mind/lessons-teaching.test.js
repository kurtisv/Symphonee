'use strict';
// OBSERVATION -> TEACHING -> VALIDATED lifecycle of lessons (teacher-assisted learning).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const L = require('./lessons');

const CV = 'pure-subset.test0001';
const DAY = 86400000;
const T0 = Date.UTC(2026, 10, 15);
const tmp = (t) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'sym-teach-')); t.after(() => fs.rmSync(d, { recursive: true, force: true })); return d; };
const teaching = (over = {}) => ({ cause: 'The sum is computed first, so the intermediate total exceeds the double range before the division.', strategy: '1. Find the largest absolute value with a reduce. 2. Divide each element by it before adding. 3. Multiply back at the end.',
  pitfalls: ['Do not index fixed positions of the array'], verify: 'Try three huge equal numbers and confirm the result is finite.', source: 'claude', model: 'sonnet', tokens: 1200, errorClass: 'result:non-finite', family: 'average', ...over });
const evidence = (key, over = {}) => ({ runId: 'a'.repeat(32), family: 'average', checkerVersion: CV, independent: { passed: true, executed: 7, expected: 7 },
  codex: { decision: 'GO', taskId: 'task-1234', diffHash: 'd'.repeat(64), reviewer: { provider: 'codex', cleanup: 'verified-no-descendants', tools: ['functions.request_user_input'], version: 'codex-cli 0.169.0' } },
  codeHash: 'c'.repeat(64), assertionsHash: 'e'.repeat(64), shown: [key], blocked: { signature: 'checks:result-non-finite', failedAttempts: 2 }, afterTeaching: true, wideRequired: false, ...over });
function observe(root, scope, text = 'The sum overflows before the division on very large values', key = 'result:non-finite average') {
  return L.record(root, { scope, kind: 'blockage', text, key, source: 'independent checks', evidence: 'verified' }, T0).entry;
}
const taught = (root, scope, over = {}) => { const e = observe(root, scope); return L.attachTeaching(root, scope, e.key, teaching(over), T0 + 1); };

test('a verified observation becomes TEACHING, never VALIDATED, by being taught', t => {
  const root = tmp(t), scope = L.scopeOf('p', 'fixture:x'), e = observe(root, scope);
  assert.equal(L.statusOf(e), 'observation');
  const x = L.attachTeaching(root, scope, e.key, teaching(), T0 + 1);
  assert.equal(x.status, 'teaching'); assert.equal(x.errorClass, 'result:non-finite'); assert.equal(x.teaching.source, 'claude');
  assert.equal(L.isCurrent(x, CV, T0 + 2), false, 'a teaching is not current knowledge');
});

test('teaching is refused when malformed, and a validated or unknown lesson cannot be re-taught', t => {
  const root = tmp(t), scope = L.scopeOf('p', 'fixture:x'), e = observe(root, scope);
  for (const bad of [{ cause: 'short' }, { strategy: '' }, { pitfalls: 'x' }, { pitfalls: ['ok trap', 'x'] }, { source: 'chatgpt' }, { tokens: -1 }, { errorClass: 'Bad Class' }, { family: '' }, { verify: 1 }])
    assert.throws(() => L.attachTeaching(root, scope, e.key, teaching(bad)), /Invalid teaching/, JSON.stringify(bad));
  assert.throws(() => L.attachTeaching(root, scope, 'nope', teaching()), /Unknown lesson/);
  L.attachTeaching(root, scope, e.key, teaching(), T0);
  L.validate(root, scope, e.key, evidence(e.key), { checkerVersion: CV, now: T0 + 5 });
  assert.throws(() => L.attachTeaching(root, scope, e.key, teaching()), /validated lesson cannot be re-taught/);
});

test('only a taught lesson can be validated, and only with every proof', t => {
  const root = tmp(t), scope = L.scopeOf('p', 'fixture:x'), plain = observe(root, scope);
  assert.throws(() => L.validate(root, scope, plain.key, evidence(plain.key), { checkerVersion: CV }), /Only a taught lesson can be validated \(status: observation\)/, 'a Claude explanation is needed first, and an observation alone is never promoted');
  const key = L.attachTeaching(root, scope, plain.key, teaching(), T0).key;
  const reviewer = (over) => ({ provider: 'codex', cleanup: 'verified-no-descendants', tools: ['functions.request_user_input'], version: 'codex-cli 0.169.0', ...over });
  const cases = [
    [{ independent: { passed: false, executed: 6, expected: 7 } }, /independent checks did not all pass/],
    [{ independent: { passed: true, executed: 6, expected: 7 } }, /independent checks did not all pass/],
    [{ independent: { passed: true, executed: 0, expected: 0 } }, /independent checks did not all pass/],
    [{ codex: { ...evidence(key).codex, decision: 'NO-GO' } }, /no real Codex GO/],
    [{ codex: { ...evidence(key).codex, diffHash: 'nothex' } }, /no real Codex GO/],
    [{ codex: { ...evidence(key).codex, reviewer: reviewer({ cleanup: 'unverified' }) } }, /reviewer not proven tool-free/],
    [{ codex: { ...evidence(key).codex, reviewer: reviewer({ tools: ['functions.request_user_input', 'functions.exec'] }) } }, /reviewer not proven tool-free/],
    [{ codex: { ...evidence(key).codex, reviewer: reviewer({ provider: 'simulated' }) } }, /reviewer not proven tool-free/],
    [{ checkerVersion: 'pure-subset.other' }, /checker version mismatch/],
    [{ shown: [] }, /was not shown to the developer/],
    [{ shown: ['another:key'] }, /was not shown to the developer/],
    [{ blocked: { signature: 'checks:x', failedAttempts: 1 } }, /no repeated blockage/],
    [{ blocked: undefined }, /no repeated blockage/],
    [{ afterTeaching: false }, /did not come after the teaching/],
    [{ codeHash: 'short' }, /code or assertions identity missing/],
    [{ assertionsHash: undefined }, /code or assertions identity missing/],
    [{ runId: 'x' }, /run identity missing/],
    [{ family: '' }, /family missing/],
  ];
  for (const [over, re] of cases) assert.throws(() => L.validate(root, scope, key, evidence(key, over), { checkerVersion: CV }), re, JSON.stringify(over).slice(0, 80));
  assert.equal(L.statusOf(L.all(root).find((x) => x.key === key)), 'teaching', 'every refusal leaves it TEACHING');
  const ok = L.validate(root, scope, key, evidence(key), { checkerVersion: CV, now: T0 + 9 });
  assert.equal(ok.entry.status, 'validated'); assert.equal(ok.entry.validation.evidenceCount, 1); assert.equal(ok.entry.validation.checkerVersion, CV);
  assert.equal(ok.entry.validation.reviewTaskId, 'task-1234'); assert.equal(ok.entry.validation.codeHash, 'c'.repeat(64)); assert.ok(ok.entry.confidence >= 0.7);
  assert.equal(L.isCurrent(ok.entry, CV, T0 + 10), true);
});

test('the same method again is one lesson with more independent evidence; one run counts once', t => {
  const root = tmp(t), scope = L.scopeOf('p', 'fixture:x');
  const a = taught(root, scope);
  L.validate(root, scope, a.key, evidence(a.key), { checkerVersion: CV, now: T0 + 10 });
  const b = L.record(root, { scope, kind: 'blockage', text: 'The total overflows before the division, again', key: 'result:non-finite average second', source: 'independent checks', evidence: 'verified' }, T0 + 20).entry;
  L.attachTeaching(root, scope, b.key, teaching(), T0 + 21);
  const r = L.validate(root, scope, b.key, evidence(b.key, { runId: 'b'.repeat(32) }), { checkerVersion: CV, now: T0 + 30 });
  assert.equal(r.merged, true); assert.equal(r.entry.key, a.key); assert.equal(r.entry.validation.evidenceCount, 2);
  const mine = L.all(root).filter((x) => x.scope === scope);
  assert.deepEqual(mine.map((x) => [x.key === b.key ? 'dup' : 'orig', L.statusOf(x)]).sort(), [['dup', 'obsolete'], ['orig', 'validated']], 'no duplicate stays active');
  const c = L.record(root, { scope, kind: 'blockage', text: 'Third sighting of the overflow before the division', key: 'result:non-finite average third', source: 'independent checks', evidence: 'verified' }, T0 + 40).entry;
  L.attachTeaching(root, scope, c.key, teaching(), T0 + 41);
  assert.equal(L.validate(root, scope, c.key, evidence(c.key, { runId: 'b'.repeat(32) }), { checkerVersion: CV, now: T0 + 50 }).entry.validation.evidenceCount, 2, 'the same run does not count twice');
});

test('a contradicting method for the same error class and family supersedes the older one', t => {
  const root = tmp(t), scope = L.scopeOf('p', 'fixture:x');
  const a = taught(root, scope);
  L.validate(root, scope, a.key, evidence(a.key), { checkerVersion: CV, now: T0 + 10 });
  const b = L.record(root, { scope, kind: 'blockage', text: 'Another way the overflow was fixed on the same task', key: 'result:non-finite average other', source: 'independent checks', evidence: 'verified' }, T0 + 20).entry;
  L.attachTeaching(root, scope, b.key, teaching({ strategy: '1. Halve every element first. 2. Add the halves with a bounded reduce. 3. Double the total after clamping it.', cause: 'Doubling happens too late, after the accumulated total already overflowed in the loop.' }), T0 + 21);
  const r = L.validate(root, scope, b.key, evidence(b.key, { runId: 'c'.repeat(32) }), { checkerVersion: CV, now: T0 + 30 });
  assert.equal(r.merged, false); assert.deepEqual(r.superseded, [a.key]);
  const old = L.all(root).find((x) => x.key === a.key);
  assert.equal(old.status, 'obsolete'); assert.equal(old.obsoleteReason, 'superseded'); assert.equal(old.supersededBy, b.key);
  const sel = L.selectForTask(root, scope, { checkerVersion: CV, question: 'overflow of the intermediate total in an average of huge values', now: T0 + 31 });
  assert.deepEqual(sel.methods.map((x) => x.key), [b.key], 'only the current method is transmitted');
});

test('a method of another family or error class is not touched by a contradiction', t => {
  const root = tmp(t), scope = L.scopeOf('p', 'fixture:x');
  const a = taught(root, scope);
  L.validate(root, scope, a.key, evidence(a.key), { checkerVersion: CV, now: T0 + 10 });
  const b = L.record(root, { scope, kind: 'blockage', text: 'A syntax blockage on another task', key: 'syntax:CallExpression leap', source: 'independent checks', evidence: 'verified' }, T0 + 20).entry;
  L.attachTeaching(root, scope, b.key, teaching({ errorClass: 'syntax:CallExpression', family: 'leap', strategy: '1. Only use reduce with two parameters. 2. Express the rule with comparisons and remainders only.' }), T0 + 21);
  const r = L.validate(root, scope, b.key, evidence(b.key, { runId: 'd'.repeat(32), family: 'leap' }), { checkerVersion: CV, now: T0 + 30 });
  assert.deepEqual(r.superseded, []); assert.equal(L.statusOf(L.all(root).find((x) => x.key === a.key)), 'validated');
});

test('a lesson validated under another checker version, or expired, is retired and no longer transmitted', t => {
  const root = tmp(t), scope = L.scopeOf('p', 'fixture:x'), q = 'overflow of the intermediate total in an average of huge values';
  const a = taught(root, scope);
  L.validate(root, scope, a.key, evidence(a.key), { checkerVersion: CV, now: T0 + 10 });
  assert.equal(L.selectForTask(root, scope, { checkerVersion: CV, question: q, now: T0 + 11 }).methods.length, 1);
  assert.equal(L.selectForTask(root, scope, { checkerVersion: 'pure-subset.changed', question: q, now: T0 + 11 }).methods.length, 0, 'the checker changed: not transmitted even before cleanup');
  assert.equal(L.selectForTask(root, scope, { checkerVersion: CV, question: q, now: T0 + 91 * DAY }).methods.length, 0, 'expired');
  assert.equal(L.expireStale(root, scope, 'pure-subset.changed', T0 + 12), 1);
  const old = L.all(root).find((x) => x.key === a.key);
  assert.deepEqual([old.status, old.obsoleteReason], ['obsolete', 'checker-changed']);
  assert.equal(L.expireStale(root, scope, 'pure-subset.changed', T0 + 13), 0, 'idempotent');
  const e2 = taught(root, L.scopeOf('p', 'fixture:y'));
  L.validate(root, L.scopeOf('p', 'fixture:y'), e2.key, evidence(e2.key), { checkerVersion: CV, now: T0 });
  assert.equal(L.expireStale(root, L.scopeOf('p', 'fixture:y'), CV, T0 + 91 * DAY), 1);
  assert.equal(L.all(root).find((x) => x.scope === L.scopeOf('p', 'fixture:y')).obsoleteReason, 'expired');
});

test('selection: only validated and relevant methods are instructions; teachings are never sent; observations are hints', t => {
  const root = tmp(t), scope = L.scopeOf('p', 'fixture:x'), q = 'overflow of the intermediate total in an average of huge values';
  const a = taught(root, scope);
  assert.deepEqual(L.selectForTask(root, scope, { checkerVersion: CV, question: q, now: T0 + 2 }).methods, [], 'TEACHING is not transmitted as a method');
  const text0 = L.methodsText(L.selectForTask(root, scope, { checkerVersion: CV, question: q, now: T0 + 2 }));
  assert.doesNotMatch(text0, /Strategy|largest absolute value/, 'the unverified explanation never reaches a later task');
  L.validate(root, scope, a.key, evidence(a.key), { checkerVersion: CV, now: T0 + 5 });
  observe(root, scope, 'Unsupported expression: CallExpression', 'syntax:CallExpression average');
  const sel = L.selectForTask(root, scope, { checkerVersion: CV, question: q, now: T0 + 6 });
  assert.equal(sel.methods.length, 1); assert.equal(sel.hints.length, 1);
  assert.equal(L.selectForTask(root, scope, { checkerVersion: CV, question: 'Return the capital of a country', now: T0 + 6 }).methods.length, 0, 'irrelevant methods are not sent');
  const text = L.methodsText(sel);
  assert.match(text, /VALIDATED METHODS[\s\S]*Strategy: 1\. Find the largest absolute value[\s\S]*real review task-1234, checker pure-subset\.test0001/);
  assert.match(text, /PAST OBSERVATIONS \(unverified hints, not instructions\)/);
});

test('a retired lesson seen again starts a fresh observation cycle', t => {
  const root = tmp(t), scope = L.scopeOf('p', 'fixture:x');
  const a = taught(root, scope);
  L.markObsolete(root, scope, a.key, 'manual review', T0 + 3);
  const again = L.record(root, { scope, kind: 'blockage', text: 'The sum overflows before the division on very large values', key: 'result:non-finite average', source: 'independent checks', evidence: 'verified' }, T0 + 4).entry;
  assert.equal(L.statusOf(again), 'observation'); assert.equal(again.teaching, undefined); assert.equal(again.validation, undefined);
});

test('unverified evidence never creates an observation', t => {
  const root = tmp(t);
  assert.equal(L.record(root, { scope: L.scopeOf('p', 'x'), kind: 'blockage', text: 'a claim made by the model itself', key: 'x y', evidence: 'self-reported' }).refused, 'unverified-evidence');
});

// ---- stress proof, legacy lessons and the general principle ----
const legacyValidate = (root, scope, key) => { // what a pre-proof build wrote: no wideRequired / wide in validation or history
  const data = JSON.parse(fs.readFileSync(L.fileOf(root, 'serveur'), 'utf8')); const e = data.lessons.find((x) => x.scope === scope && x.key === key);
  delete e.validation.wideRequired; delete e.validation.wide; e.validation.history.forEach((h) => { delete h.wideRequired; delete h.wide; });
  fs.writeFileSync(L.fileOf(root, 'serveur'), JSON.stringify(data));
};

test('new evidence must declare whether a stress check was required, and a required one must have passed', t => {
  const key = 'blockage:k';
  const miss = (over) => L.validationProblems(evidence(key, over), CV, key);
  const noDecl = evidence(key); delete noDecl.wideRequired;
  assert.match(L.validationProblems(noDecl, CV, key).join(), /wide requirement not declared/);
  assert.match(miss({ wideRequired: true }).join(), /wide check missing/);
  assert.match(miss({ wideRequired: true, wide: { inputs: 50, mismatches: 0 } }).join(), /wide check not passed/);
  assert.match(miss({ wideRequired: true, wide: { inputs: 1500, mismatches: 2 } }).join(), /wide check not passed/);
  assert.deepEqual(miss({ wideRequired: true, wide: { inputs: 1500, mismatches: 0 } }), []);
  assert.deepEqual(miss({ wideRequired: false }), []);
});

test('the stress proof is recorded with the validation and with each history item', t => {
  const root = tmp(t), scope = L.scopeOf('p', 'fixture:x'), e = observe(root, scope);
  L.attachTeaching(root, scope, e.key, teaching(), T0);
  const r = L.validate(root, scope, e.key, evidence(e.key, { wideRequired: true, wide: { inputs: 1500, mismatches: 0 } }), { checkerVersion: CV, now: T0 + 5 });
  assert.deepEqual(r.entry.validation.wide, { inputs: 1500, mismatches: 0 }); assert.equal(r.entry.validation.wideRequired, true);
  assert.deepEqual(r.entry.validation.history[0].wide, { inputs: 1500, mismatches: 0 });
  assert.equal(L.isCurrent(r.entry, CV, T0 + 6), true);
});

test('a legacy lesson without the stress proof is kept with its history but never recalled as a certified method; a proven run upgrades it', t => {
  const root = tmp(t), scope = L.scopeOf('p', 'fixture:x'), e = observe(root, scope);
  L.attachTeaching(root, scope, e.key, teaching(), T0);
  L.validate(root, scope, e.key, evidence(e.key), { checkerVersion: CV, now: T0 + 5 });
  legacyValidate(root, scope, e.key);
  const legacy = L.all(root).find((x) => x.key === e.key);
  assert.equal(L.statusOf(legacy), 'validated', 'status and history are untouched'); assert.equal(legacy.validation.history.length, 1);
  assert.equal(L.isCurrent(legacy, CV, T0 + 6), false, 'not certified');
  assert.equal(L.isFresh(legacy, CV, T0 + 6), true);
  const q = 'average of very large numbers must not overflow: the intermediate total exceeds the double range';
  assert.equal(L.selectForTask(root, scope, { checkerVersion: CV, question: q, now: T0 + 6 }).methods.length, 0, 'not offered as a method');
  assert.equal(L.expireStale(root, scope, CV, T0 + 7), 0, 'not retired either: nothing is lost');
  // the same method confirmed by a run that carries the proof upgrades it, with a second piece of evidence
  const b = observe(root, scope, 'Another run hit a non finite result again with huge inputs', 'blockage:again'); L.attachTeaching(root, scope, b.key, teaching(), T0 + 10);
  const up = L.validate(root, scope, b.key, evidence(b.key, { runId: 'b'.repeat(32), wideRequired: true, wide: { inputs: 1500, mismatches: 0 } }), { checkerVersion: CV, now: T0 + 11 });
  assert.equal(up.merged, true); assert.equal(up.entry.validation.evidenceCount, 2); assert.equal(up.entry.validation.certifiedBy, 'b'.repeat(32));
  assert.equal(L.selectForTask(root, scope, { checkerVersion: CV, question: q, now: T0 + 12 }).methods.length, 1, 'certified now');
});

test('the general principle is optional (old lessons), bounded, kept, and shown as principle plus application', t => {
  const root = tmp(t), scope = L.scopeOf('p', 'fixture:x');
  const e = observe(root, scope);
  assert.throws(() => L.attachTeaching(root, scope, e.key, teaching({ principle: 'short' })), /Invalid teaching: principle/);
  assert.throws(() => L.attachTeaching(root, scope, e.key, teaching({ principle: 'x'.repeat(501) })), /Invalid teaching: principle/);
  L.attachTeaching(root, scope, e.key, teaching({ principle: 'Keep every intermediate value small by combining small pieces instead of one big total.' }), T0);
  L.validate(root, scope, e.key, evidence(e.key), { checkerVersion: CV, now: T0 + 5 });
  const m = L.selectForTask(root, scope, { checkerVersion: CV, question: 'average of very large numbers must not overflow: the intermediate total exceeds the double range', now: T0 + 6 });
  const txt = L.methodsText(m);
  assert.match(txt, /General principle \(applies to other problems too\): Keep every intermediate value small/); assert.match(txt, /Application to the problem it was taught on \(adapt it, do not copy it\)/);
  // a lesson without principle keeps the old wording
  const root2 = tmp(t), e2 = observe(root2, scope); L.attachTeaching(root2, scope, e2.key, teaching(), T0); L.validate(root2, scope, e2.key, evidence(e2.key), { checkerVersion: CV, now: T0 + 5 });
  const old = L.methodsText(L.selectForTask(root2, scope, { checkerVersion: CV, question: 'average of very large numbers must not overflow: the intermediate total exceeds the double range', now: T0 + 6 }));
  assert.match(old, /Strategy: /); assert.doesNotMatch(old, /General principle/);
});
