'use strict';
// Discovered tasks stay in memory: one discovery can return several tasks, they wait in a queue, and no new discovery
// happens while the queue has work. Pure parsing + queue bookkeeping (no model, no network).
const test = require('node:test');
const assert = require('node:assert/strict');
const { parsePlanList, taskKey } = require('./autopilot');
const kit = require('./qwen-repo-test-kit');

const task = (title, extra = {}) => ({ category: 'testing', title, objective: 'Add a focused regression test for ' + title + ' in the module.', evidence: ['module.js:3 has no test for ' + title], acceptance: ['node --test passes'], ...extra });

test('one discovery answer carries its first task and up to four more, all validated', () => {
  const raw = JSON.stringify({ ...task('First helper test'), decision: 'TASK', more: [task('Second helper test'), { title: 'x' }, task('Third helper test'), task('Fourth helper test'), task('Fifth helper test'), task('Sixth helper test')] });
  const plans = parsePlanList(raw);
  assert.deepEqual(plans.map(p => p.title), ['First helper test', 'Second helper test', 'Third helper test', 'Fourth helper test'], 'at most 5 in total, taken from the first four "more" entries; the invalid one is dropped');
  assert.ok(plans.every(p => p.decision === 'TASK'));
});

test('a plain single-task answer and NO_TASK keep their old meaning', () => {
  assert.equal(parsePlanList(JSON.stringify({ ...task('Only one helper test'), decision: 'TASK' })).length, 1);
  assert.deepEqual(parsePlanList(JSON.stringify({ decision: 'NO_TASK' })), [{ decision: 'NO_TASK' }]);
  assert.deepEqual(parsePlanList('not json at all'), []);
});

test('the queue keeps discovered tasks, refuses duplicates, and exposes them in the snapshot', () => {
  const f = kit.setup();
  try {
    const a = task('Queued helper test');
    assert.equal(f.pilot.enqueue([a, a, task('Other queued test')]), 2, 'a duplicate is not queued twice');
    assert.equal(f.pilot.enqueue([task('Queued helper test')]), 2, 'a task already queued is refused');
    const snap = f.pilot.snapshot();
    assert.deepEqual(snap.queue.map(x => x.title), ['Queued helper test', 'Other queued test']);
    assert.equal(snap.queue[0].key, taskKey(a));
  } finally { f.cleanup(); }
});

test('the queue is capped at ten, so a bad discovery cannot pile up work', () => {
  const f = kit.setup();
  try {
    const many = Array.from({ length: 14 }, (_, i) => task('Helper number ' + i + ' test'));
    assert.equal(f.pilot.enqueue(many), 10);
  } finally { f.cleanup(); }
});

test('queue order: priority FIRST (severity, then proof); the model is chosen afterwards; a Claude task is skipped only while no paid unit is left', () => {
  const f = kit.setup();
  try {
    f.pilot.state.repoPath = f.repo;
    const hard = task('Data loss in the protected file', { severity: 'data-loss', proof: 'reproduced', evidence: ['secrets/key.txt:1 holds a value the task must change'] });
    const easy = task('Cosmetic typo in the helper', { severity: 'other', proof: 'read-in-code', evidence: ['index.js:1 has a typo in a comment'] });
    const mid = task('Wrong price shown by the helper', { severity: 'wrong-price', proof: 'read-in-code', evidence: ['index.js:2 formats the price wrongly'] });
    f.pilot.enqueue([easy, hard, mid].map(p => ({ ...p, decision: 'TASK' })));
    assert.equal(f.pilot.qwenCanTake(easy), true); assert.equal(f.pilot.qwenCanTake(mid), true); assert.equal(f.pilot.qwenCanTake(hard), false, 'a protected file is never given to Qwen');
    const title = (i) => f.pilot.state.queue[i].plan.title;
    assert.equal(title(f.pilot.pickQueued(true)), hard.title, 'the most serious defect goes first even though only Claude can take it');
    assert.equal(title(f.pilot.pickQueued(false)), mid.title, 'no paid unit left: the best task Qwen can take, not the easiest one');
    f.pilot.state.queue = f.pilot.state.queue.filter(x => x.plan.title === hard.title);
    assert.equal(f.pilot.pickQueued(false), -1, 'only a Claude task left and no paid unit left: nothing starts');
    assert.equal(f.pilot.pickQueued(true), 0);
  } finally { f.cleanup(); }
});

test('priority score: severity dominates, then the strength of the proof, then the amount of evidence; unknown values never raise it', () => {
  const { priorityScore } = require('./autopilot');
  const p = (severity, proof, n = 1) => ({ severity, proof, evidence: Array(n).fill('e') });
  assert.ok(priorityScore(p('data-loss', 'inferred')) > priorityScore(p('crash', 'reproduced', 4)));
  assert.ok(priorityScore(p('wrong-price', 'reproduced')) > priorityScore(p('wrong-price', 'read-in-code')));
  assert.ok(priorityScore(p('wrong-price', 'read-in-code')) > priorityScore(p('measured-slowness', 'reproduced')));
  assert.equal(priorityScore(p('invented', 'trust-me')), priorityScore(p('other', 'inferred')));
  assert.equal(priorityScore(null), 0);
});

test('a task queued on an older base is revalidated by the plan review; a task older than three days is dropped', () => {
  const f = kit.setup();
  try {
    f.pilot.state.repoPath = f.repo;
    const p = task('Queued on an old base');
    f.pilot.enqueue([p]);
    assert.equal(f.pilot.state.queue[0].baseSha, f.pilot.currentBaseSha(), 'the base is recorded when the task is queued');
    f.pilot.state.queue[0].baseSha = '0000000000000000000000000000000000000000';
    f.pilot.state.active = { stage: 'discover', plan: null };
    // popQueued dispatches the plan review: stop before it, we only read what it prepared
    const real = f.pilot.dispatch; let seen = null; f.pilot.dispatch = (stage) => { seen = { stage, revalidate: f.pilot.state.active.revalidate }; };
    assert.equal(f.pilot.popQueued(Date.now(), true), true);
    assert.equal(seen.stage, 'plan-review'); assert.equal(seen.revalidate.from, '0000000000'); assert.match(seen.revalidate.to, /^[0-9a-f]{10}$/);
    assert.match(f.pilot.reviewPrompt('plan-review'), /REVALIDATION: this task was discovered on base 0000000000 and the base is now [0-9a-f]{10}\. Re-derive the claimed defect on the CURRENT code/);
    f.pilot.dispatch = real;
    // too old: dropped, never reviewed
    f.pilot.state.active = { stage: 'discover', plan: null };
    f.pilot.state.queue = [{ key: 'k', plan: task('Very old task'), score: 1, baseSha: null, discoveredAt: new Date(Date.now() - 4 * 86400000).toISOString() }];
    f.pilot.dispatch = () => { throw new Error('must not be dispatched'); };
    assert.equal(f.pilot.popQueued(Date.now(), true), false); assert.equal(f.pilot.state.queue.length, 0);
    f.pilot.dispatch = real;
  } finally { f.cleanup(); }
});

test('the discovery prompt carries the priority contract and what is already done, in flight or queued', () => {
  const f = kit.setup();
  try {
    f.pilot.state.repoPath = f.repo;
    f.pilot.state.history = [{ title: 'Already merged price fix', outcome: 'completed' }, { title: '(discovery)', outcome: 'no-task' }];
    f.pilot.enqueue([task('Queued stations task')]);
    f.pilot.state.active = { stage: 'discover', plan: null, localSignals: {} };
    const p = f.pilot.discoveryPrompt();
    assert.match(p, /PRIORITY \(decided before anyone implements it; the model is chosen afterwards/); assert.match(p, /"severity":"data-loss\|crash\|security\|wrong-price\|broken-flow\|measured-slowness\|other"/);
    assert.match(p, /ALREADY DONE, IN FLIGHT OR QUEUED/); assert.match(p, /- completed: Already merged price fix/); assert.match(p, /- queued: Queued stations task/);
    assert.doesNotMatch(p, /- no-task: /, 'empty discoveries are not listed as work');
  } finally { f.cleanup(); }
});

test('paid units are the discoveries plus the tasks not written entirely by Qwen', () => {
  const f = kit.setup();
  try {
    const now = Date.now(), at = new Date(now).toISOString();
    f.pilot.state.history = [{ outcome: 'completed', at, implementer: 'qwen', key: 'a' }, { outcome: 'completed', at, implementer: 'claude', key: 'b' }, { outcome: 'completed', at, implementer: 'claude-after-qwen', key: 'c' }, { outcome: 'plan-rejected', at, key: 'd' }];
    f.pilot.state.discoveryTimes = [now];
    assert.equal(f.pilot.paidUnitsToday(now), 3, 'one Claude task + one hand-back to Claude + one discovery; the Qwen task is free; a rejected plan is not a completion');
  } finally { f.cleanup(); }
});
