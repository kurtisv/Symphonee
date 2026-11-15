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
const crypto = require('crypto');
const lessonsMod = require('./lessons');
const { makeFixtureController } = require('./qwen-learning-fixture');
const { CHECKER_VERSION } = require('../orchestrator/qwen-pure-assertions');

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
function harness(t, { sources, reviews = [], reviewExecution = {}, extra = {}, teachings = [] }) {
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
      if (opts.cli === 'claude') { // the teacher: tool-free, read-only, no API key, measured usage
        assert.deepEqual([opts.readOnly, opts.fixtureNoApiKeys, opts.noFallback, opts.usageJson], [true, true, true, true]);
        const id = 't' + (++n); spawns.push({ stage: 'claude', prompt: opts.prompt }); const item = teachings.shift();
        const task = item instanceof Error ? { id, model: 'sonnet', state: 'failed', error: item.message, execution: {} }
          : { id, model: 'sonnet', state: 'completed', usage: { inputTokens: 1500, outputTokens: 200 }, result: typeof item === 'string' ? item : JSON.stringify(item), execution: {} };
        tasks.set(id, task); return task;
      }
      assert.equal(opts.reviewerNoTools, true); assert.equal(opts.fixtureNoApiKeys, true); assert.equal(opts.readOnly, true);
      const id = 'codex-task-' + (++n); spawns.push({ stage: 'codex', prompt: opts.prompt });
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

// ══ Teacher-assisted learning in the loop ═════════════════════════════════════
const wrongWith = (n, name = 'a') => `function average(v){const ${name}=${n};return ${name}}\nmodule.exports={average};\n`;
const safeVariant = (k) => `function average(v){if(v.length===0)return null;return v.reduce((a,b)=>a+b/v.length+0*${k},0)}\nmodule.exports={average};\n`;
const TEACH = { cause: 'The first versions return a constant, so every input gets the same answer instead of a computed mean.', strategy: '1. Return null at once for an empty array. 2. Divide each element by the length inside the reduce. 3. Start the reduce from zero.',
  pitfalls: ['Do not return a constant'], verify: 'Check that [1,2,3] gives 2 and [] gives null before answering.' };
function teachSetup(t, over = {}) {
  const lessonsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sym-qwen-lessons-')); t.after(() => fs.rmSync(lessonsRoot, { recursive: true, force: true }));
  const mroot = fs.mkdtempSync(path.join(os.tmpdir(), 'sym-qwen-mind-')); t.after(() => fs.rmSync(mroot, { recursive: true, force: true }));
  const space = 'fixture_' + crypto.randomBytes(8).toString('hex');
  const mind = makeFixtureController({ repoRoot: mroot, space, queueDir: path.join(mroot, 'queue') });
  return { lessonsRoot, mind, reopen: () => makeFixtureController({ repoRoot: mroot, space, queueDir: path.join(mroot, 'queue') }), extra: { lessonsRoot, family: 'average', name: 'average', teacher: { enabled: true }, mind, ...over } };
}
const start = (h, objective = 'Implement average(v) in average.js; it must not overflow on very large values.') => h.pilot.startFixtureTask({ title: 'Fictional average', objective });

test('teacher-assisted loop: repeated failure -> Claude teaches -> Qwen writes it -> checks + real review -> VALIDATED -> kept in Mind', async t => {
  const s = teachSetup(t);
  const h = harness(t, { sources: [wrongWith(0, 'a'), wrongWith(0, 'b'), SAFE], reviews: [{ decision: 'GO', corrections: [] }], teachings: [TEACH], extra: s.extra });
  start(h); await run(h.pilot);
  const done = h.pilot.state.history.at(-1);
  assert.equal(done.outcome, 'fixture-approved');
  assert.deepEqual(h.spawns.filter(x => x.stage !== 'learn').map(x => x.stage), ['qwen', 'qwen', 'claude', 'qwen', 'codex'], 'one teacher call, between the 2nd failure and the 3rd attempt');
  const qwen = h.spawns.filter(x => x.stage === 'qwen'), claude = h.spawns.find(x => x.stage === 'claude');
  assert.match(claude.prompt, /ITS LAST ATTEMPTS[\s\S]*attempt 1 \(refused by the independent checker\)[\s\S]*attempt 2[\s\S]*WHAT KEEPS FAILING[\s\S]*average\(\[\]\) returned 0, but it must return null/);
  assert.doesNotMatch(qwen[0].prompt + qwen[1].prompt, /TEACHER'S EXPLANATION/, 'nothing taught before the teacher is called');
  assert.match(qwen[2].prompt, /TEACHER'S EXPLANATION \(from Claude[\s\S]*NOT been verified yet; write the code yourself\)[\s\S]*Cause: The first versions return a constant/);
  assert.deepEqual([done.teachings, done.teacherTokens], [1, 1700], 'the teacher call and its measured tokens are accounted');
  // lifecycle in the lesson store
  const entry = lessonsMod.all(s.lessonsRoot).find(x => lessonsMod.statusOf(x) === 'validated');
  assert.ok(entry, 'validated; events: ' + h.pilot.state.events.map(e => e.kind + ': ' + e.msg).join(' || ')); assert.equal(entry.errorClass, 'result:wrong-values'); assert.equal(entry.teaching.source, 'claude');
  assert.equal(entry.validation.checkerVersion, CHECKER_VERSION); assert.equal(entry.validation.independent.executed, 3); assert.equal(entry.validation.blocked.failedAttempts, 2);
  assert.deepEqual(done.attempts[2].shown, [entry.key], 'the validating attempt was shown the lesson');
  assert.equal(done.attempts[2].review.decision, 'GO');
  // durable in Mind, recoverable by a new controller
  // a new controller on the same graph (a new session) sees it
  const stored = s.reopen().listLessons(); assert.equal(stored.length, 1); assert.equal(stored[0].status, 'validated'); assert.equal(stored[0].validation.reviewTaskId, done.attempts[2].review.taskId);
  const rec = s.reopen().recallLessons({ question: 'compute the mean of an array without returning a constant: divide each element by the length', checkerVersion: CHECKER_VERSION });
  assert.equal(rec.length, 1); assert.match(rec[0].teaching.strategy, /Divide each element by the length/);
});

test('teacher unavailable: the loop keeps its normal fallback and certifies nothing', async t => {
  const s = teachSetup(t);
  const h = harness(t, { sources: [wrongWith(0, 'a'), wrongWith(0, 'b'), SAFE], reviews: [{ decision: 'GO', corrections: [] }], teachings: [new Error('claude unavailable')], extra: s.extra });
  start(h); await run(h.pilot);
  assert.equal(h.pilot.state.history.at(-1).outcome, 'fixture-approved', 'the normal path still completes');
  assert.match(h.pilot.state.events.map(e => e.msg).join('\n'), /Teacher unavailable \(claude unavailable\): standard repair, nothing is certified/);
  assert.deepEqual(lessonsMod.all(s.lessonsRoot).map(x => lessonsMod.statusOf(x)), ['observation'], 'only the verified observation exists');
  assert.deepEqual(s.mind.listLessons(), []); assert.equal(h.spawns.filter(x => x.stage === 'claude').length, 1, 'not retried');
  assert.doesNotMatch(h.spawns.filter(x => x.stage === 'qwen')[2].prompt, /TEACHER'S EXPLANATION/);
});

test('a teacher answer that contains the solution, or is malformed, is refused', async t => {
  for (const bad of [{ ...TEACH, strategy: 'Write function average(v){ return v.length } and export it with module.exports at the end of the file.' }, 'not json at all', { ...TEACH, extra: 'x' }]) {
    const s = teachSetup(t);
    const h = harness(t, { sources: [wrongWith(0, 'a'), wrongWith(0, 'b'), SAFE], reviews: [{ decision: 'GO', corrections: [] }], teachings: [bad], extra: s.extra });
    start(h); await run(h.pilot);
    assert.match(h.pilot.state.events.map(e => e.msg).join('\n'), /Teaching refused/);
    const spent = h.pilot.state.history.at(-1);
    assert.equal(spent.teacherTokens, 1700, 'a refused answer still cost tokens: they are counted');
    assert.deepEqual([spent.teachingLog.length, spent.teachingLog[0].accepted, typeof spent.teachingLog[0].error], [1, false, 'string']); assert.ok(spent.teachingLog[0].rawChars > 0);
    assert.deepEqual(lessonsMod.all(s.lessonsRoot).map(x => lessonsMod.statusOf(x)), ['observation']);
    assert.deepEqual(s.mind.listLessons(), []);
    assert.doesNotMatch(h.spawns.filter(x => x.stage === 'qwen')[2].prompt, /TEACHER'S EXPLANATION/);
  }
});

test('teacher calls are bounded: one per blockage, two per task', async t => {
  const s = teachSetup(t);
  const other = { ...TEACH, cause: 'The second constant answer shows the same misunderstanding again in a new form here.', strategy: '1. Compute from the elements. 2. Never return a constant. 3. Use reduce over the array values.' };
  const h = harness(t, { sources: [wrongWith(1, 'a'), wrongWith(1, 'b'), wrongWith(2, 'a'), wrongWith(2, 'b'), wrongWith(3, 'a'), wrongWith(3, 'b')], teachings: [TEACH, other, TEACH], extra: s.extra });
  start(h); await run(h.pilot);
  assert.equal(h.spawns.filter(x => x.stage === 'claude').length, 2, 'the third blockage gets no third teacher call');
  assert.equal(h.pilot.state.history.at(-1).outcome, 'checks-failed');
  assert.equal(h.pilot.state.history.at(-1).teachings, 2);
});

test('after a teaching, the same blockage repeating does not call Claude again and ends as stalled', async t => {
  const s = teachSetup(t);
  const h = harness(t, { sources: [wrongWith(1, 'a'), wrongWith(1, 'b'), wrongWith(1, 'c'), wrongWith(1, 'd'), wrongWith(1, 'e'), wrongWith(1, 'f')], teachings: [TEACH, TEACH], extra: s.extra });
  start(h); await run(h.pilot);
  assert.equal(h.spawns.filter(x => x.stage === 'claude').length, 1);
  assert.equal(h.pilot.state.history.at(-1).outcome, 'stalled'); assert.equal(h.spawns.filter(x => x.stage === 'codex').length, 0, 'no review is paid for code that fails the checks');
  assert.equal(lessonsMod.all(s.lessonsRoot).filter(x => lessonsMod.statusOf(x) === 'validated').length, 0);
});

test('a taught lesson stays TEACHING when the real review refuses the code that followed', async t => {
  const s = teachSetup(t);
  const h = harness(t, { sources: [wrongWith(0, 'a'), wrongWith(0, 'b'), safeVariant(1), safeVariant(2), safeVariant(3), safeVariant(4)], teachings: [TEACH],
    reviews: ['Alpha problem with precision', 'Bravo issue about empty input handling', 'Charlie trouble regarding negative numbers', 'Delta defect in rounding behaviour'].map(c => ({ decision: 'NO-GO', corrections: [c] })), extra: s.extra });
  start(h); await run(h.pilot);
  assert.equal(h.pilot.state.history.at(-1).outcome, 'review-rejected');
  assert.deepEqual(lessonsMod.all(s.lessonsRoot).map(x => lessonsMod.statusOf(x)).filter(x => x !== 'observation'), ['teaching'], 'never promoted without a Codex GO');
  assert.deepEqual(s.mind.listLessons(), []);
});

test('a new session recalls validated methods from Mind, with provenance, and counts the use', async t => {
  const s = teachSetup(t, { teacher: { enabled: false } });
  const seed = { key: 'blockage:seed', checkerVersion: CHECKER_VERSION, teaching: { ...TEACH, source: 'claude', model: 'sonnet', tokens: 1700, errorClass: 'result:wrong-values', family: 'average',
      cause: 'The intermediate sum of very large values exceeds the double range before the final division happens.', strategy: '1. Divide each element by the length before adding. 2. Keep the running total bounded.' },
    evidence: { runId: 'f'.repeat(32), family: 'average', checkerVersion: CHECKER_VERSION, independent: { passed: true, executed: 7, expected: 7 }, shown: ['blockage:seed'], blocked: { signature: 'checks:x', failedAttempts: 2 }, afterTeaching: true,
      codex: { decision: 'GO', taskId: 'task-seed-1', diffHash: 'd'.repeat(64), reviewer: { provider: 'codex', cleanup: 'verified-no-descendants', tools: ['functions.request_user_input'], version: 'codex-cli 0.169.0' } }, codeHash: 'c'.repeat(64), assertionsHash: 'e'.repeat(64) } };
  const m = s.mind.upsertLesson(seed);
  const h = harness(t, { sources: [SAFE], reviews: [{ decision: 'GO', corrections: [] }], extra: { ...s.extra, teacher: { enabled: false } } });
  start(h); await run(h.pilot);
  const p = h.spawns.find(x => x.stage === 'qwen').prompt;
  assert.match(p, /VALIDATED METHODS \(each was taught earlier[\s\S]*\[result:wrong-values\] Cause: The intermediate sum of very large values[\s\S]*real review task-seed-1, checker pure-subset\./);
  assert.deepEqual(h.pilot.state.history.at(-1).shownMethods.map(x => [x.key, x.source, x.provenance.reviewTaskId]), [['blockage:seed', 'mind', 'task-seed-1']], 'the provenance of what was shown is kept');
  const prov = s.mind.recallLessons({ question: 'average very large values intermediate sum overflow', checkerVersion: CHECKER_VERSION })[0].provenance;
  assert.deepEqual([prov.uses, prov.usesSucceeded], [1, 1]);
  // without Mind, an obsolete checker version, or an unrelated task: nothing is sent
  const h2 = harness(t, { sources: [SAFE], reviews: [{ decision: 'GO', corrections: [] }], extra: { lessonsRoot: s.lessonsRoot, family: 'average', name: 'average', teacher: { enabled: false } } });
  start(h2); await run(h2.pilot);
  assert.doesNotMatch(h2.spawns.find(x => x.stage === 'qwen').prompt, /VALIDATED METHODS/, 'no memory, no methods');
  s.mind.retireStale('pure-subset.future');
  const h3 = harness(t, { sources: [SAFE], reviews: [{ decision: 'GO', corrections: [] }], extra: { ...s.extra, teacher: { enabled: false } } });
  start(h3); await run(h3.pilot);
  assert.doesNotMatch(h3.spawns.find(x => x.stage === 'qwen').prompt, /VALIDATED METHODS/, 'a lesson from another checker version is retired');
  const s2 = teachSetup(t, { teacher: { enabled: false } }); s2.mind.upsertLesson(seed);
  const h4 = harness(t, { sources: [SAFE], reviews: [{ decision: 'GO', corrections: [] }], extra: { ...s2.extra, requirements: 'Return the capital city of a country given its name as a string.' } });
  start(h4, 'Return the capital of a country given its name'); await run(h4.pilot);
  assert.doesNotMatch(h4.spawns.find(x => x.stage === 'qwen').prompt, /VALIDATED METHODS/, 'an unrelated task gets no method');
});

test('interruption between the teaching and its validation leaves a TEACHING that no later session receives', async t => {
  const s = teachSetup(t);
  const h = harness(t, { sources: [wrongWith(0, 'a'), wrongWith(0, 'b'), SAFE], reviews: [{ decision: 'GO', corrections: [] }], teachings: [TEACH], extra: s.extra });
  start(h);
  for (let i = 0; i < 400 && !(h.pilot.state.active && h.pilot.state.active.teaching); i++) { await new Promise(r => setTimeout(r, 15)); await h.pilot.tick(); }
  assert.ok(h.pilot.state.active.teaching, 'the teaching was received'); // ...and the process dies here
  assert.deepEqual(lessonsMod.all(s.lessonsRoot).map(x => lessonsMod.statusOf(x)), ['teaching']);
  const h2 = harness(t, { sources: [SAFE], reviews: [{ decision: 'GO', corrections: [] }], extra: { ...s.extra, teacher: { enabled: false } } });
  start(h2); await run(h2.pilot);
  const p = h2.spawns.find(x => x.stage === 'qwen').prompt;
  assert.doesNotMatch(p, /TEACHER'S EXPLANATION|VALIDATED METHODS|The first versions return a constant/, 'an unvalidated explanation is not transmitted to a later session');
  assert.deepEqual(lessonsMod.all(s.lessonsRoot).map(x => lessonsMod.statusOf(x)), ['teaching'], 'and it was not promoted by the later success');
  assert.deepEqual(s.mind.listLessons(), []);
});

test('the teacher mode needs a lessons store and a family; a Mind object must be complete', () => {
  const base = { capability: sup.QWEN_DEVELOPER_FIXTURE, root: os.tmpdir(), files: [NAME, 'test.js'], editable: [NAME], assertions: CASES, requirements: 'r', reviewerModel: 'gpt-6.1-sol' };
  const mk = (extra) => new MindAutopilot({ repoRoot: os.tmpdir(), orchestrator: {}, autoTimer: false, id: 'x', qwenFixture: { ...base, ...extra } });
  assert.throws(() => mk({ teacher: { enabled: true } }), /Invalid Qwen fixture teacher/);
  assert.throws(() => mk({ teacher: { enabled: true }, lessonsRoot: os.tmpdir() }), /Invalid Qwen fixture teacher/);
  assert.throws(() => mk({ teacher: { enabled: 'yes' } }), /Invalid Qwen fixture teacher/);
  assert.throws(() => mk({ mind: { recallLessons() {} } }), /Invalid Qwen fixture Mind/);
  assert.throws(() => mk({ family: 'Bad Family' }), /Invalid Qwen fixture family/);
  assert.doesNotThrow(() => mk({ teacher: { enabled: true }, lessonsRoot: os.tmpdir(), family: 'average' }));
});

test('the blockage class comes from the raw checker message, and a long but bounded teaching is accepted', async t => {
  const s = teachSetup(t);
  const long = { ...TEACH, cause: 'The code uses names that do not exist in the sandbox. ' + 'It also forgets that the allowed list is short. '.repeat(14), verify: 'Trace the three listed cases by hand. ' + 'Compare each step with the requirement. '.repeat(10) };
  assert.ok(long.cause.length > 600 && long.cause.length <= 800 && long.verify.length > 400 && long.verify.length <= 600);
  const unknown = (n) => `function average(v){const ${n}=Infinity;return ${n}}\nmodule.exports={average};\n`;
  const h = harness(t, { sources: [unknown('a'), unknown('b'), SAFE], reviews: [{ decision: 'GO', corrections: [] }], teachings: [long], extra: s.extra });
  start(h); await run(h.pilot);
  const lesson = lessonsMod.all(s.lessonsRoot).find(x => lessonsMod.statusOf(x) === 'validated');
  assert.ok(lesson, 'accepted and validated: ' + h.pilot.state.events.map(e => e.msg).join(' || ').slice(0, 800));
  assert.equal(lesson.errorClass, 'syntax:UnknownIdentifier');
});

test('a blockage with many failing cases (long failure text) is still validated: the evidence keeps a short digest', async t => {
  const s = teachSetup(t);
  const many = [[[], null], [[1, 2, 3], 2], [[-2, 2], 0], [[4, 6], 5], [[10], 10], [[0, 0], 0], [[2, 2, 2], 2], [[-1, -3], -2]].map(([args, expected]) => ({ file: NAME, export: 'average', args: [args], expected }));
  const h = harness(t, { sources: [wrongWith(7, 'a'), wrongWith(7, 'b'), SAFE], reviews: [{ decision: 'GO', corrections: [] }], teachings: [TEACH], extra: { ...s.extra, assertions: many } });
  start(h); await run(h.pilot);
  const pending = h.pilot.state.history.at(-1);
  assert.equal(pending.outcome, 'fixture-approved');
  assert.ok(pending.attempts[0].developerError.length > 600, 'the raw failure text is long, as in the real run');
  const lesson = lessonsMod.all(s.lessonsRoot).find(x => lessonsMod.statusOf(x) === 'validated');
  assert.ok(lesson, 'validated: ' + h.pilot.state.events.map(e => e.msg).join(' || ').slice(-500));
  assert.match(lesson.validation.blocked.signature, /^result:wrong-values:[a-f0-9]{16}$/); assert.equal(lesson.validation.independent.executed, 8);
  assert.equal(s.mind.listLessons().length, 1);
});

test('a lesson is promoted only if the wide check passes when the family defines one', async t => {
  for (const [mismatches, expected] of [[3, 'teaching'], [0, 'validated']]) {
    const s = teachSetup(t, { wideCheck: () => ({ inputs: 1500, mismatches }) });
    const h = harness(t, { sources: [wrongWith(0, 'a'), wrongWith(0, 'b'), SAFE], reviews: [{ decision: 'GO', corrections: [] }], teachings: [TEACH], extra: s.extra });
    start(h); await run(h.pilot);
    assert.equal(h.pilot.state.history.at(-1).outcome, 'fixture-approved');
    const states = lessonsMod.all(s.lessonsRoot).map(x => lessonsMod.statusOf(x));
    assert.ok(states.includes(expected), 'mismatches ' + mismatches + ' -> ' + states.join());
    assert.equal(states.includes('validated'), expected === 'validated');
    assert.equal(s.mind.listLessons().length, expected === 'validated' ? 1 : 0);
  }
});

test('a wide check that cannot run (no result) blocks the promotion', async t => {
  const s = teachSetup(t, { wideCheck: () => ({ inputs: 'container run failed', mismatches: 'container run failed' }) });
  const h = harness(t, { sources: [wrongWith(0, 'a'), wrongWith(0, 'b'), SAFE], reviews: [{ decision: 'GO', corrections: [] }], teachings: [TEACH], extra: s.extra });
  start(h); await run(h.pilot);
  assert.ok(!lessonsMod.all(s.lessonsRoot).some(x => lessonsMod.statusOf(x) === 'validated'));
  assert.equal(s.mind.listLessons().length, 0);
});

test('a Mind write that fails after local validation is pending, then synced once without duplicates', async t => {
  const s = teachSetup(t); let fail = true; const real = s.mind;
  const flaky = { ...real, recallLessons: real.recallLessons, recordLessonUse: real.recordLessonUse, upsertLesson: (x) => { if (fail) throw new Error('disk full'); return real.upsertLesson(x); } };
  const h = harness(t, { sources: [wrongWith(0, 'a'), wrongWith(0, 'b'), SAFE], reviews: [{ decision: 'GO', corrections: [] }], teachings: [TEACH], extra: { ...s.extra, mind: flaky } });
  start(h); await run(h.pilot);
  assert.ok(lessonsMod.all(s.lessonsRoot).some(x => lessonsMod.statusOf(x) === 'validated'), 'validated locally');
  const log = h.pilot.state.events.map(e => e.msg).join('\n');
  assert.match(log, /Mind write FAILED \(pending sync/); assert.doesNotMatch(log, /Not validated, stays TEACHING/);
  assert.equal(h.pilot.state.mindSyncPending.length, 1); assert.equal(real.listLessons().length, 0);
  fail = false;
  assert.equal(h.pilot.syncPendingMind(), 1); assert.equal(h.pilot.syncPendingMind(), 0);
  assert.equal(h.pilot.state.mindSyncPending.length, 0);
  assert.equal(real.listLessons().length, 1); assert.equal(real.listLessons()[0].validation.evidenceCount, 1);
});
