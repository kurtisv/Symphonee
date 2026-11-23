'use strict';
// 2026-11-22: a timing test outside the change failed 1 run in 3 and used up all 5 repairs of a correct task.
const test = require('node:test');
const assert = require('node:assert/strict');
const { verifyWithFlakeRetry } = require('./autopilot');

const V = [{ name: 'lint' }, { name: 'tests-serveur' }, { name: 'tests-interface' }];
const ok = (name) => ({ name, ok: true, code: 0, ms: 1, timedOut: false, tail: '' });
const ko = (name, tail = '') => ({ name, ok: false, code: 1, ms: 1, timedOut: false, tail });
// Scripted runVerify: each call returns the next answer, computed from the commands it receives.
function fake(answers) {
  const calls = [];
  const run = async (cwd, cmds) => { calls.push(cmds.map((c) => c.name)); const results = answers[Math.min(calls.length, answers.length) - 1](cmds); return { ok: results.length > 0 && results.every((x) => x.ok), results }; };
  return { run, calls };
}
const TAIL = 'ok 1\nℹ tests 9\nℹ fail 1\n\n✖ failing tests:\n\ntest at dashboard\\electron\\hard-restart.test.js:3:1\n✖ helper starts the new instance (11010.77ms)\n  AssertionError';

test('no retry when the failing test file is part of the change, or when the failing test is unknown', async () => {
  let f = fake([() => [ok('lint'), ko('tests-serveur', TAIL)], (cmds) => cmds.map((c) => ok(c.name))]);
  let r = await verifyWithFlakeRetry(f.run, '.', V, { changed: ['dashboard/electron/hard-restart.test.js'] });
  assert.equal(r.ok, false); assert.equal(f.calls.length, 1, 'the change\'s own test failing once stays a failure');
  f = fake([() => [ok('lint'), ko('tests-serveur', 'TypeError: crashed before any test ran')], (cmds) => cmds.map((c) => ok(c.name))]);
  r = await verifyWithFlakeRetry(f.run, '.', V, { changed: [] });
  assert.equal(r.ok, false); assert.equal(f.calls.length, 1, 'unknown failing test: not called flaky');
});

test('a check that fails once then passes is a pass, flagged flaky with the test name, rerun from that check on', async () => {
  const f = fake([() => [ok('lint'), ko('tests-serveur', TAIL)], (cmds) => cmds.map((c) => ok(c.name))]);
  const r = await verifyWithFlakeRetry(f.run, '.', V);
  assert.equal(r.ok, true);
  assert.deepEqual(f.calls.slice(0, 2), [['lint', 'tests-serveur', 'tests-interface'], ['tests-serveur', 'tests-interface']]);
  assert.deepEqual(f.calls.slice(2), [['tests-serveur recheck 1'], ['tests-serveur recheck 2'], ['tests-serveur recheck 3']], 'the failing test files alone, three more times');
  assert.deepEqual(r.results.map((x) => x.name), ['lint', 'tests-serveur', 'tests-interface']);
  assert.deepEqual(r.flaky, { name: 'tests-serveur', files: ['dashboard/electron/hard-restart.test.js'], tests: ['✖ helper starts the new instance'] });
});

test('a check that fails twice stays a failure, with the second run as evidence', async () => {
  const f = fake([() => [ok('lint'), ko('tests-serveur', TAIL + ' first')], () => [ko('tests-serveur', 'second')]]);
  const r = await verifyWithFlakeRetry(f.run, '.', V);
  assert.equal(r.ok, false);
  assert.equal(r.flaky, undefined);
  assert.deepEqual(r.results.map((x) => x.name + ':' + x.ok), ['lint:true', 'tests-serveur:false']);
  assert.equal(r.results[1].tail, 'second');
});

test('a later check failing on the rerun is still a failure', async () => {
  const f = fake([() => [ok('lint'), ko('tests-serveur', TAIL)], () => [ok('tests-serveur'), ko('tests-interface')]]);
  const r = await verifyWithFlakeRetry(f.run, '.', V);
  assert.equal(r.ok, false);
  assert.equal(r.flaky, undefined);
});

test('a timeout is not retried, a pass runs once, a stopped task is not retried', async () => {
  let f = fake([() => [{ ...ko('tests-serveur'), timedOut: true }]]);
  assert.equal((await verifyWithFlakeRetry(f.run, '.', V)).ok, false); assert.equal(f.calls.length, 1);
  f = fake([(cmds) => cmds.map((c) => ok(c.name))]);
  assert.equal((await verifyWithFlakeRetry(f.run, '.', V)).ok, true); assert.equal(f.calls.length, 1);
  f = fake([() => [ko('lint')]]);
  assert.equal((await verifyWithFlakeRetry(f.run, '.', V, { still: () => false })).ok, false); assert.equal(f.calls.length, 1);
});

test('a fail-then-pass whose failing test fails again on a recheck is a failure (an intermittent defect)', async () => {
  let n = 0;
  const f = fake([() => [ok('lint'), ko('tests-serveur', TAIL)], (cmds) => cmds.map((c) => ok(c.name)), (cmds) => (++n === 2 ? cmds.map((c) => ko(c.name, 'race')) : cmds.map((c) => ok(c.name)))]);
  const r = await verifyWithFlakeRetry(f.run, '.', V);
  assert.equal(r.ok, false);
  assert.equal(r.flaky, undefined);
  assert.equal(r.results.at(-1).tail, 'race');
  assert.equal(f.calls.length, 4, 'stops at the first failing recheck');
});

test('a check run in a sub-folder: its printed test path is compared repository-relative', async () => {
  const VS = [{ name: 'tests-api', cwd: 'api' }];
  const tail = '\u2139 fail 1\n\u2716 failing tests:\n\ntest at src/pay.test.js:4:1\n\u2716 pays (12ms)';
  const f = fake([() => [ko('tests-api', tail)], (cmds) => cmds.map((c) => ok(c.name))]);
  const r = await verifyWithFlakeRetry(f.run, '.', VS, { changed: ['api/src/pay.test.js'] });
  assert.equal(r.ok, false, 'the change touched that test: a failure, not a flake');
  assert.equal(f.calls.length, 1);
});

test('more than FLAKY_MAX_FILES failing test files is never called flaky', async () => {
  const tail = '\u2139 fail 6\n\u2716 failing tests:\n' + [1, 2, 3, 4, 5, 6].map((i) => '\ntest at t' + i + '.test.js:1:1\n\u2716 t' + i).join('\n');
  const f = fake([() => [ok('lint'), ko('tests-serveur', tail)], (cmds) => cmds.map((c) => ok(c.name))]);
  const r = await verifyWithFlakeRetry(f.run, '.', V);
  assert.equal(r.ok, false);
  assert.equal(f.calls.length, 1);
});

test('a truncated output (summary count lost, or fewer entries than failures) is never called flaky', async () => {
  const noCount = '\u2716 failing tests:\n\ntest at a.test.js:1:1\n\u2716 a';
  const fewer = '\u2139 fail 3\n\u2716 failing tests:\n\ntest at a.test.js:1:1\n\u2716 a';
  for (const tail of [noCount, fewer]) {
    const f = fake([() => [ok('lint'), ko('tests-serveur', tail)], (cmds) => cmds.map((c) => ok(c.name))]);
    const r = await verifyWithFlakeRetry(f.run, '.', V);
    assert.equal(r.ok, false); assert.equal(f.calls.length, 1);
  }
});

test('an absolute or dot-dot path of a changed test is still recognised; a path outside the repo is never flaky', async () => {
  const path = require('path');
  const root = path.resolve('.');
  for (const [shown, changed] of [[path.join(root, 'lib', 'x.test.js'), ['lib/x.test.js']], ['lib/../lib/x.test.js', ['lib/x.test.js']], ['../elsewhere/y.test.js', []]]) {
    const tail = '\u2139 fail 1\n\u2716 failing tests:\n\ntest at ' + shown + ':1:1\n\u2716 x';
    const f = fake([() => [ko('t', tail)], (cmds) => cmds.map((c) => ok(c.name))]);
    const r = await verifyWithFlakeRetry(f.run, root, [{ name: 't' }], { changed });
    assert.equal(r.ok, false, shown); assert.equal(f.calls.length, 1, shown);
  }
});

test('on Windows a changed test spelled with another case is still the changed test', { skip: process.platform !== 'win32' }, async () => {
  const tail = '\u2139 fail 1\n\u2716 failing tests:\n\ntest at tests/payment.test.js:1:1\n\u2716 pays';
  const f = fake([() => [ko('t', tail)], (cmds) => cmds.map((c) => ok(c.name))]);
  const r = await verifyWithFlakeRetry(f.run, '.', [{ name: 't' }], { changed: ['tests/Payment.test.js'] });
  assert.equal(r.ok, false); assert.equal(f.calls.length, 1);
});

test('runVerify calls beforeEach before each check is spawned', async () => {
  const { runVerify } = require('./autopilot-verify');
  const order = [];
  await runVerify(process.cwd(), [{ name: 'a', cmd: [process.execPath, '-e', '0'] }, { name: 'b', cmd: [process.execPath, '-e', '0'] }],
    { beforeEach: (c) => order.push('before:' + c.name), onStart: (p, c) => order.push('start:' + c.name) });
  assert.deepEqual(order, ['before:a', 'start:a', 'before:b', 'start:b']);
});
