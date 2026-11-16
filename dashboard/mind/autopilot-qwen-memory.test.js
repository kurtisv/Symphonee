'use strict';
// The relevant-lesson system reaches the real-repository Qwen developer: certified, current, applicable methods become instructions,
// observations stay unverified hints, everything else is rejected with a reason, and nothing is ever promoted by a run.
// Real autopilot + Orchestrator + git worktrees, FAKE Claude/Codex processes and FAKE LM Studio (see qwen-repo-test-kit.js).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const L = require('./lessons');
const A = require('./lesson-applicability');
const { setup, drive, CREATE_TEST } = require('./qwen-repo-test-kit');

const PLAN = { category: 'testing', title: 'Add run() regression test', objective: 'Add a regression test for the run() helper return value' };
const GOOD_REPLIES = [CREATE_TEST, 'DONE added a regression test'];
// each lesson has its own error class: two validated methods for the SAME class would supersede each other (a rule of the store)
const teaching = (strategy, errorClass = 'result:wrong-values') => ({ cause: 'Helper functions are changed without a test that pins their return value, so regressions go unnoticed.', strategy, pitfalls: ['Do not test private details'], verify: 'Run the repository check and confirm the new test file is picked up.',
  source: 'claude', model: 'sonnet', tokens: 900, errorClass, family: 'repo' });
const evidence = (key, over = {}) => ({ runId: key.replace(/[^a-f0-9]/g, '').padEnd(32, 'a').slice(0, 32), family: 'repo', independent: { passed: true, executed: 3, expected: 3 }, wideRequired: false, shown: [key], blocked: { signature: 'review:x', failedAttempts: 2 }, afterTeaching: true,
  codex: { decision: 'GO', taskId: 'task-real-1', diffHash: 'd'.repeat(64), reviewer: { provider: 'codex', cleanup: 'verified-no-descendants', tools: ['functions.request_user_input'], version: 'codex-cli 0.169.0' } }, codeHash: 'c'.repeat(64), assertionsHash: 'e'.repeat(64), ...over });

// Builds a lesson in the pilot's real scope, validated exactly the way the system requires (no shortcut around validate()).
// Similar observation texts are merged by the store, so each lesson gets its own topic; the store normalises keys, so tests use the returned entry's key.
const TOPICS = { 'meth-good': 'Cache invalidation happens too late for helper outputs', 'meth-new': 'Timezone parsing drops the minutes of an offset', 'meth-perf': 'Quadratic loops appear in a hot path of the renderer', 'meth-expired': 'Retry delays grow without any upper bound', 'meth-disabled': 'Unicode normalisation differs between two code paths', 'meth-legacy': 'Pagination skips the last element of each page', 'meth-otherproof': 'Environment variables are read before the loader runs', 'meth-teaching': 'Streams are closed twice when an error is thrown', 'obs-one': 'Le test dune fonction utilitaire doit figer sa valeur de retour exacte', 'meth-nometa': 'Sockets stay open after the server shutdown request' };
function seed(f, name, strategy, { hazard = 'testing', proof, now, withApplicability = true, validate = true, disable = false, legacy = false } = {}) {
  const scope = L.scopeOf('default', 'demo'), pv = proof || f.pilot.realProofVersion();
  const e = L.record(f.root, { scope, kind: 'blockage', text: TOPICS[name], key: name, source: 'independent checks', evidence: 'verified' }).entry, key = e.key;
  if (!validate) return e;
  L.attachTeaching(f.root, scope, e.key, teaching(strategy, 'result:' + name));
  const profile = { ...f.pilot.realTaskProfile(PLAN, ['index.js']), hazard };
  const ev = evidence(e.key, { checkerVersion: pv, ...(withApplicability ? { applicability: A.buildApplicability({ profile, code: '', family: 'repo', wide: null }) } : {}) });
  L.validate(f.root, scope, e.key, ev, { checkerVersion: pv, ...(now ? { now } : {}) });
  const file = L.fileOf(f.root, 'serveur'), data = JSON.parse(fs.readFileSync(file, 'utf8')), x = data.lessons.find((l) => l.key === key);
  if (legacy) { delete x.validation.wideRequired; delete x.validation.wide; x.validation.history.forEach((h) => { delete h.wideRequired; delete h.wide; }); }
  if (disable) x.disabled = true;
  fs.writeFileSync(file, JSON.stringify(data));
  return x;
}
const lessonStatuses = (f) => L.all(f.root).map((x) => x.key + ':' + L.statusOf(x)).sort();
async function run(f, replies) { f.lm.replies.push(...replies); f.pilot.configure({ enabled: true, goal: 'Improve test coverage', allowWorktreeWrites: true }); await drive(f.pilot); return f.pilot.snapshot(); }

test('a certified, current, applicable method reaches Qwen\'s prompt on a real repository, with its proof, and the decision is recorded', async () => {
  const f = setup(); try {
    f.pilot.configure({ enabled: false }); // creates the state; the lesson store is addressed by the pilot's scope
    const good = seed(f, 'meth-good', 'UNIQUE-STRATEGY-ALPHA: write the test file next to the helper and assert the exact return value.');
    const s = await run(f, GOOD_REPLIES);
    assert.equal(s.error, null, String(s.error));
    const prompt = f.lm.prompts[0];
    assert.match(prompt, /VALIDATED METHODS \(each was taught earlier/); assert.match(prompt, /UNIQUE-STRATEGY-ALPHA/);
    assert.match(prompt, /Problem it solves: Add run\(\) regression test\./); assert.match(prompt, /Limits: validated on "repo" only; applying it to another function is a transfer that is not established/);
    const h = s.history[0], m = h.qwenMemory;
    assert.equal(h.outcome, 'completed'); assert.equal(h.implementer, 'qwen');
    assert.deepEqual([m.shown.methods, m.shown.hints], [[good.key], []]);
    assert.deepEqual(m.candidates.map((c) => [c.key, c.status, c.shown, c.as]), [[good.key, 'validated', true, 'validated-method']]);
    assert.equal(m.proofVersion, f.pilot.realProofVersion()); assert.deepEqual([m.profile.hazard, m.profile.input, m.profile.kind], ['testing', 'javascript', 'repository-change']);
    assert.match(m.text, /UNIQUE-STRATEGY-ALPHA/, 'the exact text that was shown is kept for audit');
  } finally { f.cleanup(); }
});

test('a certified method for another hazard is rejected, with the reason, and Qwen is not given it', async () => {
  const f = setup(); try {
    f.pilot.configure({ enabled: false });
    const perf = seed(f, 'meth-perf', 'UNIQUE-STRATEGY-BETA: benchmark the renderer before and after any change to a loop.', { hazard: 'performance' });
    const s = await run(f, GOOD_REPLIES);
    assert.equal(s.error, null, String(s.error)); assert.doesNotMatch(f.lm.prompts[0], /UNIQUE-STRATEGY-BETA|VALIDATED METHODS/);
    const c = s.history[0].qwenMemory.candidates[0];
    assert.deepEqual([c.key, c.shown], [perf.key, false]); assert.match(c.reason, /different hazard \(performance vs testing\)/);
  } finally { f.cleanup(); }
});

test('expired, disabled, uncertified (legacy), other-proof and unvalidated lessons are never handed over as validated methods', async () => {
  const f = setup(); try {
    f.pilot.configure({ enabled: false });
    const ks = {};
    ks.expired = seed(f, 'meth-expired', 'UNIQUE-EXPIRED: bound the retry delays with a ceiling.', { now: Date.now() - 120 * 86400000 });
    ks.disabled = seed(f, 'meth-disabled', 'UNIQUE-DISABLED: normalise unicode input before comparing strings.', { disable: true });
    ks.legacy = seed(f, 'meth-legacy', 'UNIQUE-LEGACY: include the final partial page when slicing results.', { legacy: true });
    ks.other = seed(f, 'meth-otherproof', 'UNIQUE-OTHERPROOF: load configuration before reading environment variables.', { proof: 'repo-checks.000000000000' });
    ks.teaching = seed(f, 'meth-teaching', 'UNIQUE-TEACHING: guard stream closing with a single flag.', { validate: false }); // an observation
    const scope = L.scopeOf('default', 'demo'); L.attachTeaching(f.root, scope, ks.teaching.key, teaching('UNIQUE-TEACHING: guard stream closing with a single flag.', 'result:meth-teaching')); // now status "teaching", never validated
    const s = await run(f, GOOD_REPLIES);
    assert.equal(s.error, null, String(s.error));
    const prompt = f.lm.prompts[0];
    assert.doesNotMatch(prompt, /UNIQUE-(EXPIRED|DISABLED|LEGACY|OTHERPROOF|TEACHING)/); assert.doesNotMatch(prompt, /VALIDATED METHODS/);
    const by = Object.fromEntries(s.history[0].qwenMemory.candidates.map((c) => [c.key, c]));
    for (const [n, k] of Object.entries(ks)) assert.ok(by[k.key], n + ' (' + k.key + ') is among the candidates: ' + JSON.stringify(s.history[0].qwenMemory.candidates.map((c) => c.key + ':' + c.status)));
    assert.match(by[ks.expired.key].reason, /expired/); assert.match(by[ks.disabled.key].reason, /disabled/); assert.match(by[ks.legacy.key].reason, /legacy-unproven/);
    assert.match(by[ks.other.key].reason, /another proof regime/); assert.match(by[ks.teaching.key].reason, /never validated: not shown/);
    assert.ok(Object.values(by).every((c) => !c.shown));
  } finally { f.cleanup(); }
});

test('with no applicable method Qwen works normally and the memory block is empty', async () => {
  const f = setup(); try {
    const s = await run(f, GOOD_REPLIES);
    assert.equal(s.error, null, String(s.error)); assert.equal(s.history[0].outcome, 'completed'); assert.equal(s.history[0].implementer, 'qwen');
    assert.doesNotMatch(f.lm.prompts[0], /VALIDATED METHODS|PAST OBSERVATIONS/);
    assert.deepEqual([s.history[0].qwenMemory.shown, s.history[0].qwenMemory.candidates], [{ methods: [], hints: [] }, []]);
  } finally { f.cleanup(); }
});

test('observations stay clearly unverified hints: never a method, never mandatory', async () => {
  const f = setup(); try {
    f.pilot.configure({ enabled: false });
    const obs = seed(f, 'obs-one', 'observation', { validate: false });
    const s = await run(f, GOOD_REPLIES);
    assert.equal(s.error, null, String(s.error));
    const prompt = f.lm.prompts[0];
    assert.match(prompt, /PAST OBSERVATIONS \(unverified hints, not instructions\):/); assert.doesNotMatch(prompt, /VALIDATED METHODS/);
    const m = s.history[0].qwenMemory;
    assert.deepEqual(m.shown, { methods: [], hints: [obs.key] }); assert.deepEqual([m.candidates[0].status, m.candidates[0].as], ['observation', 'unverified-observation']);
  } finally { f.cleanup(); }
});

test('a certified lesson without applicability metadata is not used on a real repository (words alone never make it relevant)', async () => {
  const f = setup(); try {
    f.pilot.configure({ enabled: false });
    const nometa = seed(f, 'meth-nometa', 'UNIQUE-NOMETA: close sockets explicitly when the server receives a shutdown request.', { withApplicability: false });
    const s = await run(f, GOOD_REPLIES);
    assert.equal(s.error, null, String(s.error)); assert.doesNotMatch(f.lm.prompts[0], /UNIQUE-NOMETA/);
    assert.match(s.history[0].qwenMemory.candidates[0].reason, /without applicability metadata/);
  } finally { f.cleanup(); }
});

test('the selection decision survives an interruption and a restart: same memory on resume, full trace of who did what', async () => {
  const f = setup(); try {
    f.pilot.configure({ enabled: false });
    const good = seed(f, 'meth-good', 'UNIQUE-STRATEGY-ALPHA: write the test file next to the helper and assert the exact return value.');
    f.lm.replies.push(CREATE_TEST.replace('\nRUN', ''), 'RUN', 'DONE ok');
    f.pilot.configure({ enabled: true, goal: 'g', allowWorktreeWrites: true });
    let wt = null;
    for (let i = 0; i < 1500 && f.pilot.state.active; i++) {
      await new Promise((r) => setTimeout(r, 25)); await f.pilot.tick();
      const a = f.pilot.state.active; if (a && a.worktree && a.stage === 'implement' && !wt) wt = a.worktree.path;
      if (wt && !f.lm.down && f.lm.prompts.length >= 1 && fs.existsSync(wt + '/index.test.js')) f.lm.down = true;
      if (a && a.parkReason === 'qwen-paused') break;
    }
    const before = f.pilot.snapshot().active;
    assert.equal(before.parkReason, 'qwen-paused'); assert.deepEqual(before.qwenMemory.shown.methods, [good.key]);
    // a new process: the state file is all it has
    const again = f.reopen(); const re = again.snapshot().active;
    assert.deepEqual(re.qwenMemory.shown, before.qwenMemory.shown); assert.equal(re.qwenMemory.proofVersion, before.qwenMemory.proofVersion);
    assert.ok(re.trace.some((t) => t.kind === 'memory') && re.trace.some((t) => t.kind === 'qwen-stopped' && t.outcome === 'interrupted'), 'the trace is still there');
    // the store changes while Qwen is paused: the resumed stage keeps the decision taken at the start of the task
    seed(f, 'meth-new', 'UNIQUE-STRATEGY-GAMMA: always parse timezone offsets with their minutes.');
    f.lm.down = false; again.state.nextAt = 0;
    for (let i = 0; i < 1500 && again.state.active && again.state.enabled; i++) { await new Promise((r) => setTimeout(r, 25)); await again.tick(); }
    const s = again.snapshot(); assert.equal(s.error, null, String(s.error));
    const h = s.history[0]; assert.equal(h.outcome, 'completed');
    assert.ok(f.lm.prompts.slice(1).every((p) => /UNIQUE-STRATEGY-ALPHA/.test(p) && !/UNIQUE-STRATEGY-GAMMA/.test(p)), 'every resumed prompt carries the original memory');
    assert.deepEqual(h.qwenMemory.shown.methods, [good.key]);
    const kinds = h.trace.map((t) => t.kind + (t.executor ? ':' + t.executor : ''));
    for (const k of ['dispatch:claude', 'dispatch:codex', 'dispatch:qwen', 'memory', 'qwen-stopped', 'qwen-run', 'verify', 'review']) assert.ok(kinds.includes(k), k + ' in ' + kinds.join());
    assert.equal(h.trace.find((t) => t.kind === 'verify').ok, true); assert.equal(h.trace.find((t) => t.kind === 'review').verdict, 'PASS');
  } finally { f.cleanup(); }
});

test('Qwen stuck, Claude corrects, Codex approves: the executors are told apart and NOTHING is promoted to a certified lesson', async () => {
  const f = setup(); try {
    f.pilot.configure({ enabled: false });
    const good = seed(f, 'meth-good', 'UNIQUE-STRATEGY-ALPHA: write the test file next to the helper and assert the exact return value.');
    const before = lessonStatuses(f);
    const s = await run(f, [CREATE_TEST.replace('\nRUN', ''), 'STUCK a', 'STUCK b', 'STUCK c']);
    assert.equal(s.error, null, String(s.error));
    assert.deepEqual(f.spawns.map((x) => x.stage), ['discover', 'plan-review', 'repair', 'code-review']);
    const h = s.history[0]; assert.equal(h.outcome, 'completed'); assert.equal(h.implementer, 'claude-after-qwen'); assert.equal(h.repairs, 0);
    const t = h.trace.map((x) => x.kind + (x.executor ? ':' + x.executor : '') + (x.by ? ':' + x.by : ''));
    for (const k of ['dispatch:qwen', 'qwen-stopped', 'dispatch:claude', 'correction:claude', 'review:codex']) assert.ok(t.includes(k), k + ' in ' + t.join());
    assert.match(h.trace.find((x) => x.kind === 'correction').findings, /A local developer \(Qwen\) started this task/);
    const after = lessonStatuses(f);
    assert.ok(after.includes(good.key + ':validated'));
    assert.deepEqual(after.filter((x) => /:validated$/.test(x)), before.filter((x) => /:validated$/.test(x)), 'no lesson became validated because of this run, a Claude correction or a Codex PASS');
    assert.ok(after.some((x) => !before.includes(x) && /:observation$/.test(x)), 'the blockage was kept as a non-certified observation');
  } finally { f.cleanup(); }
});

test('eligibility explains each rejection and certifies nothing by itself', () => {
  const e = (over) => ({ key: 'k', scope: 's', status: 'validated', validation: { checkerVersion: 'v', validUntil: 100, wideRequired: false }, ...over });
  assert.equal(L.eligibility(e({}), 'v', 50), null);
  assert.match(L.eligibility(e({}), 'v', 150), /expired/); assert.match(L.eligibility(e({}), 'w', 50), /another proof regime/);
  assert.match(L.eligibility(e({ disabled: true }), 'v', 50), /disabled/); assert.match(L.eligibility(e({ status: 'observation', validation: undefined }), 'v', 50), /observation/);
  assert.match(L.eligibility(e({ validation: { checkerVersion: 'v', validUntil: 100 } }), 'v', 50), /legacy-unproven/); assert.match(L.eligibility(e({ status: 'obsolete', obsoleteReason: 'superseded' }), 'v', 50), /obsolete \(superseded\)/);
});
