'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { decide } = require('./watchdog');

const T0 = new Date(2026, 10, 13, 3).getTime();
const M = 60000;
const gate = (lastAt) => [{ id: 'job-porte-fusion', enabled: true, createdAt: T0 - 10 * 3600000, lastRun: lastAt ? { at: lastAt } : null }];
const run = (steps) => { let st = {}; const out = []; for (const [obs, t] of steps) { const r = decide(obs, st, t); st = r.state; out.push(r.actions); } return { st, out }; };

test('all fine: nothing to do', () => {
  const r = decide({ api: true, jobs: gate(T0 - 20 * M), electron: true }, {}, T0);
  assert.deepEqual(r.actions, []);
});

test('closed Symphonee is relaunched after two silent checks, then reported recovered', () => {
  const { out } = run([
    [{ api: false, electron: false }, T0],
    [{ api: false, electron: false }, T0 + 10 * M],
    [{ api: true, jobs: gate(T0 + 15 * M), electron: true }, T0 + 20 * M],
  ]);
  assert.deepEqual(out[0], [], 'one silent check is not enough (it may be restarting)');
  assert.deepEqual(out[1].map((a) => a.type + ':' + (a.level || '')), ['relaunch:', 'alert:warning']);
  assert.match(out[2][0].msg, /^Retabli : symphonee-ferme/);
});

test('a frozen Symphonee is never killed: one error after 30 min, repeated every 6 h', () => {
  const steps = [0, 10, 20, 30].map((m) => [{ api: false, electron: true }, T0 + m * M]);
  const { out, st } = run(steps);
  assert.equal(out.flat().filter((a) => a.type === 'relaunch').length, 0);
  assert.deepEqual(out[2].map((a) => a.level), ['error']);
  assert.deepEqual(out[3], [], 'not repeated every 10 min');
  const later = decide({ api: false, electron: true }, st, T0 + 20 * M + 6 * 3600000);
  assert.match(later.actions[0].msg, /toujours/);
});

test('stalled jobs: error when the 30-minute gate job has not run for 90 min', () => {
  assert.deepEqual(decide({ api: true, jobs: gate(T0 - 60 * M), electron: true }, {}, T0).actions, []);
  const r = decide({ api: true, jobs: gate(T0 - 100 * M), electron: true }, {}, T0);
  assert.equal(r.actions[0].key, 'jobs-bloques');
  assert.equal(r.actions[0].level, 'error');
});

test('unknown process state never triggers a relaunch; pause blocks relaunch and alerts', () => {
  const { out } = run([[{ api: false, electron: null }, T0], [{ api: false, electron: null }, T0 + 10 * M], [{ api: false, electron: null }, T0 + 20 * M]]);
  assert.equal(out.flat().length, 0);
  const p = run([[{ api: false, electron: false, paused: true }, T0], [{ api: false, electron: false, paused: true }, T0 + 10 * M]]);
  assert.equal(p.out.flat().length, 0);
});
