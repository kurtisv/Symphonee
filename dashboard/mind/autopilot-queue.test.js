'use strict';
// Discovered tasks stay in memory: one discovery can return several tasks, they wait in a queue, and no new discovery
// happens while the queue has work. Pure parsing + queue bookkeeping (no model, no network).
const test = require('node:test');
const assert = require('node:assert/strict');
const { parsePlanList, taskKey } = require('./autopilot');
const kit = require('./qwen-repo-test-kit');

const task = (title, extra = {}) => ({ category: 'testing', title, objective: 'Add a focused regression test for ' + title + ' in the module.', evidence: ['module.js:3 has no test for ' + title], acceptance: ['node --test passes'], ...extra });

test('one discovery answer carries its first task and up to two more, all validated', () => {
  const raw = JSON.stringify({ ...task('First helper test'), decision: 'TASK', more: [task('Second helper test'), task('Third helper test'), task('Fourth helper test'), { title: 'x' }] });
  const plans = parsePlanList(raw);
  assert.deepEqual(plans.map(p => p.title), ['First helper test', 'Second helper test', 'Third helper test'], 'at most 3 in total; invalid extras are dropped');
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

test('the queue is capped at six, so a bad discovery cannot pile up work', () => {
  const f = kit.setup();
  try {
    const many = Array.from({ length: 10 }, (_, i) => task('Helper number ' + i + ' test'));
    assert.equal(f.pilot.enqueue(many), 6);
  } finally { f.cleanup(); }
});
