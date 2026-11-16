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

test('queue order: what Qwen can take comes first, Claude tasks only while paid units remain', () => {
  const f = kit.setup();
  try {
    f.pilot.state.repoPath = f.repo;
    const hard = task('Hard task on protected secrets', { evidence: ['secrets/key.txt:1 holds a value the task must change'] });
    const easy = task('Easy task on the helper', { evidence: ['index.js:1 has no test for run()'] });
    f.pilot.enqueue([hard, easy]);
    assert.equal(f.pilot.qwenCanTake(easy), true); assert.equal(f.pilot.qwenCanTake(hard), false, 'a protected file is never given to Qwen');
    assert.equal(f.pilot.pickQueued(false), 1, 'Qwen task first even though it was queued second');
    assert.equal(f.pilot.pickQueued(true), 1);
    f.pilot.state.queue = f.pilot.state.queue.filter(x => x.plan.title !== easy.title);
    assert.equal(f.pilot.pickQueued(false), -1, 'only a Claude task left and no paid unit left: nothing starts');
    assert.equal(f.pilot.pickQueued(true), 0, 'with a paid unit left, the Claude task starts');
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
