'use strict';
// Qwen fixture mode of the EXISTING autopilot stages (implement, code-review,
// repair) with the REAL independent verifier on a real temporary Git fixture
// and FAKE workers (no Docker, no model, no network). The real run is manual.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { MindAutopilot } = require('./autopilot');
const sup = require('../orchestrator/qwen-supervision');
const { formatDiff } = require('../orchestrator/qwen-docker-adapter');
const { gitSnapshot } = require('../orchestrator/qwen-git-snapshot');

const NAME = 'average.js';
const ORIGINAL = 'function average(v){return 0}\nmodule.exports={average};\n';
const CASES = [{ file: NAME, export: 'average', args: [[]], expected: null }, { file: NAME, export: 'average', args: [[1, 2, 3]], expected: 2 }, { file: NAME, export: 'average', args: [[-2, 2]], expected: 0 }];
const NAIVE = 'function average(v){if(v.length===0)return null;return v.reduce((a,b)=>a+b,0)/v.length}\nmodule.exports={average};\n';
const SAFE = 'function average(v){if(v.length===0)return null;return v.reduce((a,b)=>a+b/v.length,0)}\nmodule.exports={average};\n';
const UNSUPPORTED = 'function average(v){let n=v.length;return n}\nmodule.exports={average};\n';

function fixtureRepo(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sym-qwen-fixture-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const git = (...a) => execFileSync('git', ['-C', root, ...a], { stdio: 'pipe', windowsHide: true });
  git('init', '-q'); git('config', 'user.email', 'f@example.invalid'); git('config', 'user.name', 'F');
  fs.writeFileSync(path.join(root, NAME), ORIGINAL); fs.writeFileSync(path.join(root, 'test.js'), 'require("./average.js")\n');
  git('add', '.'); git('commit', '-qm', 'fixture');
  return root;
}
const diffOf = (root, src) => formatDiff([{ path: NAME, content: Buffer.from(src).toString('base64') }], gitSnapshot(root, [NAME, 'test.js']).files);

test('independent assessment reports each failure as an observation, never a validation', async t => {
  const root = fixtureRepo(t);
  const ok = await sup.assessReconstructedFixture(root, [NAME, 'test.js'], [NAME], diffOf(root, SAFE), CASES);
  assert.equal(ok.passed, true); assert.equal(ok.executed, 3); assert.deepEqual(ok.errors, []);
  const wrong = await sup.assessReconstructedFixture(root, [NAME, 'test.js'], [NAME], diffOf(root, 'function average(v){return 2}\nmodule.exports={average};\n'), CASES);
  assert.equal(wrong.passed, false); assert.equal(wrong.executed, 1); assert.equal(wrong.errors.length, 2);
  assert.match(wrong.errors[0], /Assertion 1 .*expected null/);
  const unsupported = await sup.assessReconstructedFixture(root, [NAME, 'test.js'], [NAME], diffOf(root, UNSUPPORTED), CASES);
  assert.equal(unsupported.passed, false); assert.equal(unsupported.unsupported, true); assert.equal(unsupported.executed, 0);
  // A diff touching the protected test is not reconstructed at all.
  const protectedDiff = formatDiff([{ path: 'test.js', content: Buffer.from('x\n').toString('base64') }], gitSnapshot(root, [NAME, 'test.js']).files);
  await assert.rejects(sup.assessReconstructedFixture(root, [NAME, 'test.js'], [NAME], protectedDiff, CASES));
  assert.equal(fs.readFileSync(path.join(root, NAME), 'utf8'), ORIGINAL, 'the fixture source is never modified');
});

test('the fixture developer entry needs the private capability and a standalone temporary repository', t => {
  const { spawnQwenFixture } = require('../orchestrator/spawn-qwen-docker');
  const root = fixtureRepo(t);
  const input = { prompt: 'x', cwd: root, files: [NAME, 'test.js'], editable: [NAME], assertions: CASES };
  assert.throws(() => spawnQwenFixture.call({}, input), /Untrusted/);
  assert.throws(() => spawnQwenFixture.call({}, input, Symbol('qwen developer fixture')), /Untrusted/);
  assert.throws(() => spawnQwenFixture.call({}, { ...input, cwd: path.join(__dirname, '..', '..') }, sup.QWEN_DEVELOPER_FIXTURE), /temporary repository/);
  execFileSync('git', ['-C', root, 'remote', 'add', 'origin', 'https://example.invalid/x.git']);
  assert.throws(() => spawnQwenFixture.call({}, input, sup.QWEN_DEVELOPER_FIXTURE), /without remotes/);
  const { spawnQwenDocker } = require('../orchestrator/spawn-qwen-docker');
  assert.throws(() => spawnQwenDocker.call({ getConfig: () => ({ QwenDocker: { enabled: true } }) }, input), /not verified/, 'real projects stay locked');
});

// Fake orchestrator: the developer returns scripted sources, verified by the
// REAL assessment; the reviewer returns scripted JSON echoing the request.
function harness(t, { sources, reviews, reviewExecution = {}, extra = {} }) {
  const root = fixtureRepo(t);
  const state = fs.mkdtempSync(path.join(os.tmpdir(), 'sym-qwen-fixture-state-'));
  t.after(() => fs.rmSync(state, { recursive: true, force: true }));
  const tasks = new Map(); const spawns = []; let n = 0;
  const orch = {
    getTask: id => tasks.get(id), cancelTask() {},
    spawnQwenFixture(input, cap) {
      assert.equal(cap, sup.QWEN_DEVELOPER_FIXTURE);
      const id = 'q' + (++n); const task = { id, state: 'running', execution: { cleanup: 'pending' } }; tasks.set(id, task);
      spawns.push({ stage: 'qwen', prompt: input.prompt, temperature: input.temperature });
      const src = sources.shift();
      (async () => {
        if (src instanceof Error) { Object.assign(task, { state: 'failed', error: src.message }); task.execution.cleanup = 'verified-or-not-created'; return; }
        const diff = diffOf(root, src); task.result = diff;
        const technical = await sup.assessReconstructedFixture(root, input.files, input.editable, diff, input.assertions);
        task.execution = { cleanup: 'verified-or-not-created', independentAssertions: technical, agentUsage: { total_tokens: 100 } };
        task.state = technical.passed ? 'completed' : 'failed'; if (!technical.passed) task.error = 'Independent assertions did not pass';
      })();
      return task;
    },
    spawnHeadless(opts) {
      assert.equal(opts.reviewerNoTools, true); assert.equal(opts.fixtureNoApiKeys, true); assert.equal(opts.readOnly, true);
      const id = 'c' + (++n); spawns.push({ stage: 'codex', prompt: opts.prompt });
      const ids = Object.fromEntries(['requestId', 'diffHash', 'contextHash'].map(k => [k, new RegExp(k + '=([a-f0-9]+)').exec(opts.prompt)[1]]));
      const r = reviews.shift();
      const task = { id, model: opts.model, state: 'completed', usage: { totalTokens: 50 }, result: JSON.stringify({ ...ids, ...r }),
        execution: { cleanup: 'verified-no-descendants', reviewer: { version: 'codex-cli 0.169.0', tools: ['functions.request_user_input'], promptInputHash: 'a'.repeat(64) }, reviewerItems: ['agent_message'], ...reviewExecution } };
      tasks.set(id, task); return task;
    },
  };
  const pilot = new MindAutopilot({ repoRoot: state, orchestrator: orch, getUiContext: () => ({}), getRepoPath: () => null, autoTimer: false, id: 'qwen-fixture',
    def: { limits: { repairs: 5 } }, qwenFixture: { capability: sup.QWEN_DEVELOPER_FIXTURE, root, files: [NAME, 'test.js'], editable: [NAME], assertions: CASES,
      requirements: 'Return null for an empty array; otherwise the arithmetic mean, without intermediate overflow.', reviewerModel: 'gpt-6.1-sol', ...extra } });
  pilot.learn = (() => { const orig = pilot.learn.bind(pilot); return (...a) => { spawns.push({ stage: 'learn' }); return orig(...a); }; })();
  return { root, orch, pilot, spawns };
}
async function run(pilot) {
  for (let i = 0; i < 400 && pilot.state.active && pilot.state.enabled; i++) { await new Promise(r => setTimeout(r, 15)); await pilot.tick(); }
}

test('fixture loop: checks reject, Codex refuses, Qwen corrects, Codex approves; history kept, no lesson, no discovery', async t => {
  const h = harness(t, { sources: [UNSUPPORTED, NAIVE, SAFE], reviews: [{ decision: 'NO-GO', corrections: ['Intermediate sum overflows for [1e308,1e308]; divide each term by v.length.'] }, { decision: 'GO', corrections: [] }] });
  h.pilot.startFixtureTask({ title: 'Fictional average', objective: 'Implement average(v) in average.js.' });
  await run(h.pilot);
  assert.equal(h.pilot.state.error, null);
  assert.deepEqual(h.spawns.map(s => s.stage), ['qwen', 'qwen', 'codex', 'qwen', 'codex']);
  const last = h.pilot.state.history.at(-1);
  assert.equal(last.outcome, 'fixture-approved'); assert.equal(last.scope, 'fictional-fixture');
  assert.deepEqual(last.attempts.map(a => [a.technical?.passed ?? null, a.review?.decision ?? null]), [[false, null], [true, 'NO-GO'], [true, 'GO']]);
  assert.match(h.spawns[1].prompt, /Independent checks \(not a review\): The checker refused your syntax\. Only a new single-assignment const/, 'the failed checks reach Qwen as a plain instruction');
  assert.match(h.spawns[3].prompt, /Intermediate sum overflows/, 'the Codex corrections reach Qwen');
  assert.equal(last.attempts[2].review.reviewer.cleanup, 'verified-no-descendants');
  assert.equal(h.pilot.state.enabled, false); assert.equal(h.pilot.state.active, null);
  await h.pilot.tick(); assert.equal(h.spawns.length, 5, 'no discovery after the fixture task');
  assert.equal(fs.readFileSync(path.join(h.root, NAME), 'utf8'), ORIGINAL, 'the fixture source is unchanged');
});

test('a review that does not echo the request, used a tool or has unverified cleanup is never a verdict', async t => {
  for (const [label, opts] of [['mismatch', { reviews: [{ decision: 'GO', corrections: [], requestId: 'f'.repeat(32) }] }],
    ['tool', { reviews: [{ decision: 'GO', corrections: [] }], reviewExecution: { reviewerItems: ['agent_message', 'command_execution'] } }],
    ['cleanup', { reviews: [{ decision: 'GO', corrections: [] }], reviewExecution: { cleanup: 'unverified' } }]]) {
    const h = harness(t, { sources: [SAFE], ...opts });
    h.pilot.startFixtureTask({ title: 'Fictional average', objective: 'Implement average(v).' });
    await run(h.pilot);
    assert.ok(h.pilot.state.error, label + ' halts');
    assert.equal(h.pilot.state.history.length, 0, label + ': no approved outcome');
  }
});

test('the fixture mode cannot be enabled without the capability, and real stages stay untouched', t => {
  assert.throws(() => new MindAutopilot({ repoRoot: os.tmpdir(), orchestrator: {}, autoTimer: false, id: 'x', qwenFixture: { capability: Symbol('x') } }), /Untrusted/);
  const p = new MindAutopilot({ repoRoot: fs.mkdtempSync(path.join(os.tmpdir(), 'sym-qf-')), orchestrator: {}, autoTimer: false, id: 'plain', def: { developer: 'qwen-fixture' } });
  assert.equal(p.qwenFixture, null, 'a definition file cannot turn it on');
  assert.throws(() => p.startFixtureTask({ title: 't', objective: 'o' }), /Not a Qwen fixture/);
});

test('lessons learned from verified failures persist across runs, reach the developer and are confirmed by a verified success', async t => {
  const L = require('./lessons');
  const lessonsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sym-qwen-lessons-'));
  t.after(() => fs.rmSync(lessonsRoot, { recursive: true, force: true }));
  const extra = { lessonsRoot, name: 'average' };
  const run1 = harness(t, { sources: [UNSUPPORTED, NAIVE, SAFE], extra, reviews: [{ decision: 'NO-GO', corrections: ['Intermediate sum overflows for very large values; divide each term by v.length.'] }, { decision: 'GO', corrections: [] }] });
  run1.pilot.startFixtureTask({ title: 'Fictional average', objective: 'Implement average(v).' });
  await run(run1.pilot);
  assert.equal(run1.pilot.state.history.at(-1).outcome, 'fixture-approved');
  const scope = run1.pilot.fixtureLessonScope();
  const learned = L.top(lessonsRoot, scope);
  assert.deepEqual(learned.map(x => x.kind).sort(), ['checks', 'revue']);
  const syntax = learned.find(x => x.kind === 'checks');
  assert.match(syntax.text, /VariableDeclaration/); assert.match(syntax.action, /Only a new single-assignment const/);
  assert.ok(syntax.confidence > 0.3, 'confirmed when the next attempt passed the checks: ' + syntax.confidence);
  assert.ok(!fs.existsSync(path.join(run1.pilot.repoRoot, '.symphonee', 'lecons.json')), 'never written to the pilot repository lessons');

  // A fresh pilot (next run): the developer sees the lessons before its first attempt.
  const run2 = harness(t, { sources: [SAFE], extra, reviews: [{ decision: 'GO', corrections: [] }] });
  run2.pilot.startFixtureTask({ title: 'Fictional average', objective: 'Implement average(v).' });
  assert.match(run2.spawns[0].prompt, /PAST FAILURE NOTES[\s\S]*VariableDeclaration[\s\S]*confidence/);
  assert.match(run2.spawns[0].prompt, /Intermediate sum overflows/);
  await run(run2.pilot);
  assert.equal(run2.pilot.state.history.at(-1).outcome, 'fixture-approved');
  const after = L.top(lessonsRoot, scope);
  for (const x of after) assert.ok(x.confidence > learned.find(y => y.key === x.key).confidence, 'confirmed by the verified GO: ' + x.key);
});

test('environment failures are not learned as developer mistakes', async t => {
  const L = require('./lessons');
  const lessonsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sym-qwen-lessons-'));
  t.after(() => fs.rmSync(lessonsRoot, { recursive: true, force: true }));
  const h = harness(t, { sources: [new Error('Insufficient free RAM'), new Error('Insufficient free RAM'), SAFE], extra: { lessonsRoot, envWaitMs: 0 }, reviews: [{ decision: 'GO', corrections: [] }] });
  h.pilot.startFixtureTask({ title: 'Fictional average', objective: 'Implement average(v).' });
  await run(h.pilot);
  assert.deepEqual(L.top(lessonsRoot, h.pilot.fixtureLessonScope()), []);
  const done = h.pilot.state.history.at(-1);
  assert.equal(done.outcome, 'fixture-approved', 'environment refusals did not consume the attempts');
  assert.equal(done.attempts.length, 1, 'only the real developer attempt is counted');
  assert.equal(done.repairs, 0);
  const stuck = harness(t, { sources: Array.from({ length: 12 }, () => new Error('Insufficient free RAM')), extra: { envWaitMs: 0 }, reviews: [] });
  stuck.pilot.startFixtureTask({ title: 'Fictional average', objective: 'Implement average(v).' });
  await run(stuck.pilot);
  assert.equal(stuck.pilot.state.history.at(-1).outcome, 'environment-unavailable', 'bounded: stops after 8 environment retries');
  assert.equal(stuck.spawns.filter(x => x.stage === 'qwen').length, 9);
  assert.throws(() => new MindAutopilot({ repoRoot: lessonsRoot, orchestrator: {}, autoTimer: false, id: 'x',
    qwenFixture: { capability: sup.QWEN_DEVELOPER_FIXTURE, root: lessonsRoot, files: [NAME, 'test.js'], editable: [NAME], assertions: CASES, requirements: 'r', reviewerModel: 'gpt-6.1-sol', lessonsRoot: 'relative/path' } }), /Invalid Qwen fixture/);
});

test('the reviewer is told the developer syntax, bound to the context hash, and still judges the requirements', async t => {
  const root = fixtureRepo(t);
  const diff = diffOf(root, SAFE);
  const technical = await sup.assessReconstructedFixture(root, [NAME, 'test.js'], [NAME], diff, CASES);
  const plain = sup.buildFixtureReviewRequest({ technical, requirements: 'r', cases: CASES, diff });
  const bound = sup.buildFixtureReviewRequest({ technical, requirements: 'r', cases: CASES, diff, constraints: 'only if/return' });
  assert.notEqual(plain.request.contextHash, bound.request.contextHash);
  assert.doesNotMatch(plain.prompt, /can only write this syntax/);
  assert.match(bound.prompt, /can only write this syntax: only if\/return[\s\S]*never a reason to accept a defect[\s\S]*implementable within that syntax/);
  assert.throws(() => sup.buildFixtureReviewRequest({ technical, requirements: 'r', cases: CASES, diff, constraints: 'x'.repeat(2001) }), /Invalid/);
  const h = harness(t, { sources: [SAFE], reviews: [{ decision: 'GO', corrections: [] }] });
  h.pilot.startFixtureTask({ title: 'Fictional average', objective: 'Implement average(v).' });
  await run(h.pilot);
  const review = h.spawns.find(s => s.stage === 'codex');
  assert.match(review.prompt, /can only write this syntax: one function declaration/);
  assert.equal(h.pilot.state.history.at(-1).outcome, 'fixture-approved');
});

const MAXV = 1.7976931348623157e308;
test('reviewer counterexamples become independent checks only when the reviewed code really fails them; a refused proposal is not reviewed again', async t => {
  const h = harness(t, { sources: [NAIVE, NAIVE, SAFE], reviews: [
    { decision: 'NO-GO', corrections: ['The intermediate sum overflows for [MAX, MAX].'],
      counterexamples: [{ args: [[MAXV, MAXV]], expected: MAXV }, { args: [[1, 2, 3]], expected: 2 }, { args: [[4, 6]], expected: 5 }] },
    { decision: 'GO', corrections: [] }] });
  h.pilot.startFixtureTask({ title: 'Fictional average', objective: 'Implement average(v).' });
  await run(h.pilot);
  const done = h.pilot.state.history.at(-1);
  assert.equal(done.outcome, 'fixture-approved');
  assert.deepEqual(h.spawns.filter(s => s.stage !== 'learn').map(s => s.stage), ['qwen', 'codex', 'qwen', 'qwen', 'codex'], 'the repeated naive proposal never reached Codex again');
  assert.match(h.spawns[2].prompt, /New independent checks from the reviewer[\s\S]*average\(\[1\.7976931348623157e\+308,1\.7976931348623157e\+308\]\) must return 1\.7976931348623157e\+308/);
  assert.equal(done.attempts[1].technical.passed, false, 'the adopted counterexample rejected the repeated proposal');
  assert.equal(done.attempts[2].technical.expected, 4, 'three trusted cases plus the one adopted counterexample');
  const events = h.pilot.state.events.map(e => e.msg).join('\n');
  assert.match(events, /Counterexample adopted/);
  assert.match(events, /Counterexample ignored[\s\S]*\[\[4,6\]\]/, '[4,6] -> 5 passes on the reviewed code: not adopted');
});

test('counterexamples are refused outside a NO-GO or in a malformed shape', async t => {
  const root = fixtureRepo(t);
  const diff = diffOf(root, NAIVE);
  const technical = await sup.assessReconstructedFixture(root, [NAME, 'test.js'], [NAME], diff, CASES);
  const { request } = sup.buildFixtureReviewRequest({ technical, requirements: 'r', cases: CASES, diff, counterexamples: true });
  const ids = { requestId: request.requestId, diffHash: request.diffHash, contextHash: request.contextHash };
  const parse = (o) => sup.parseReviewResponse(JSON.stringify({ ...ids, ...o }), request);
  assert.equal(parse({ decision: 'NO-GO', corrections: ['x'], counterexamples: [{ args: [[1]], expected: 1 }] }).counterexamples.length, 1);
  assert.throws(() => parse({ decision: 'GO', corrections: [], counterexamples: [] }), /Invalid/);
  assert.throws(() => parse({ decision: 'NO-GO', corrections: ['x'], counterexamples: [{ args: 1, expected: 1 }] }), /Invalid/);
  assert.throws(() => parse({ decision: 'NO-GO', corrections: ['x'], counterexamples: [{ args: [], expected: 1, extra: 2 }] }), /Invalid/);
  assert.throws(() => parse({ decision: 'NO-GO', corrections: ['x'], counterexamples: Array(4).fill({ args: [], expected: 1 }) }), /Invalid/);
  const { request: plain } = sup.buildFixtureReviewRequest({ technical, requirements: 'r', cases: CASES, diff });
  assert.throws(() => sup.parseReviewResponse(JSON.stringify({ requestId: plain.requestId, diffHash: plain.diffHash, contextHash: plain.contextHash, decision: 'NO-GO', corrections: ['x'], counterexamples: [] }), plain), /Invalid/, 'not accepted unless the host asked for it');
});

test('checker refusals reach the developer in plain language, and a resubmitted identical proposal is called out', async t => {
  const BAD = 'function average(v){if(v.length===0)return null;return v.reduce((a,b)=>a+b,0)/Number.MAX_SAFE_INTEGER}\nmodule.exports={average};\n';
  const h = harness(t, { sources: [BAD, BAD, SAFE], reviews: [{ decision: 'GO', corrections: [] }] });
  h.pilot.startFixtureTask({ title: 'Fictional average', objective: 'Implement average(v).' });
  await run(h.pilot);
  const qwen = h.spawns.filter(s => s.stage === 'qwen');
  assert.equal(qwen.length, 3);
  assert.match(qwen[1].prompt, /The checker refused your syntax\. Only \.length, v\[i\] indexing and Math\.abs, Math\.max, Math\.min can be read: Number\.MAX_VALUE/);
  assert.doesNotMatch(qwen[1].prompt, /Unsupported expression: MemberExpression/, 'no internal node names in the feedback');
  assert.doesNotMatch(qwen[1].prompt, /exactly the same code/, 'the first failure is not a repeat');
  assert.match(qwen[2].prompt, /exactly the same code as your previous attempt/);
  assert.deepEqual(qwen.map(s => s.temperature), [undefined, undefined, 0.45], 'the default first, raised only after a repeated proposal');
  assert.equal(h.pilot.state.history.at(-1).outcome, 'fixture-approved');
  assert.equal(h.pilot.state.history.at(-1).attempts.length, 3);
});

test('three identical refused proposals in a row end the task as stalled, without paying a review', async t => {
  const BAD = 'function average(v){if(v.length===0)return null;return v.reduce((a,b)=>a+b,0)/Number.MAX_SAFE_INTEGER}\nmodule.exports={average};\n';
  const h = harness(t, { sources: [BAD, BAD, BAD, SAFE, SAFE], reviews: [{ decision: 'GO', corrections: [] }] });
  h.pilot.startFixtureTask({ title: 'Fictional average', objective: 'Implement average(v).' });
  await run(h.pilot);
  const done = h.pilot.state.history.at(-1);
  assert.equal(done.outcome, 'stalled');
  assert.equal(h.spawns.filter(s => s.stage === 'qwen').length, 3, 'no fourth attempt');
  assert.equal(h.spawns.filter(s => s.stage === 'codex').length, 0, 'no review was paid');
  assert.equal(done.attempts.length, 3);
});

test('wrong results are told in plain sentences and a rename-only repeat is judged by outcome', async t => {
  const wrongWith = n => `function average(v){const ${n}=0;return ${n}}\nmodule.exports={average};\n`;
  const h = harness(t, { sources: [wrongWith('a'), wrongWith('b'), wrongWith('c'), SAFE], reviews: [{ decision: 'GO', corrections: [] }] });
  h.pilot.startFixtureTask({ title: 'Fictional average', objective: 'Implement average(v).' });
  await run(h.pilot);
  const qwen = h.spawns.filter(s => s.stage === 'qwen');
  assert.match(qwen[1].prompt, /average\(\[\]\) returned 0, but it must return null\./);
  assert.doesNotMatch(qwen[1].prompt, /Supervisor refused|strictly deep-equal/, 'no machine noise reaches the developer');
  assert.doesNotMatch(qwen[1].prompt, /fails exactly the same cases/, 'the first failure is not a repeat');
  assert.match(qwen[2].prompt, /fails exactly the same cases as your previous attempt: renaming or rearranging did not fix the logic/);
  assert.equal(h.pilot.state.history.at(-1).outcome, 'stalled');
  assert.equal(qwen.length, 3); assert.equal(h.spawns.filter(s => s.stage === 'codex').length, 0);
});
