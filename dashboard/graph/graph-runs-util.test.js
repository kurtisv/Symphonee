'use strict';
// Unit tests for the graph-run pure helpers extracted from graph-runs.js.
// The reachability + merge + template + sandbox-eval logic drives real run
// branching but was previously only reachable through the engine.
const test = require('node:test');
const assert = require('node:assert');
const u = require('./graph-runs-util');

test('deepMerge recurses objects, replaces arrays, overwrites scalars', () => {
  assert.deepEqual(u.deepMerge({ a: 1, b: { c: 2, d: 3 } }, { b: { c: 9 }, e: 5 }),
    { a: 1, b: { c: 9, d: 3 }, e: 5 });
  assert.deepEqual(u.deepMerge({ a: [1, 2] }, { a: [3] }), { a: [3] }); // arrays replaced, not merged
  assert.equal(u.deepMerge({ a: 1 }, 7), 7); // scalar b wins
});

test('readPath / renderTemplate resolve dotted paths and tolerate misses', () => {
  const vars = { user: { name: 'Ada' }, n: 2 };
  assert.equal(u.readPath(vars, 'user.name'), 'Ada');
  assert.equal(u.readPath(vars, 'user.missing.deep'), undefined);
  assert.equal(u.renderTemplate('hi {{ user.name }} x{{n}}', vars), 'hi Ada x2');
  assert.equal(u.renderTemplate('{{ nope.nope }}!', vars), '!'); // missing -> empty
});

test('evalSafe evaluates a sandboxed expression against state', () => {
  assert.equal(u.evalSafe('state.x > 3 && state.y === "go"', { x: 5, y: 'go' }), true);
  assert.equal(u.evalSafe('state.x > 3', { x: 1 }), false);
});

test('unreachableFrom propagates skips only when ALL deps are skipped', () => {
  const nodes = [
    { id: 'a' },                         // root
    { id: 'b', dependsOn: ['a'] },
    { id: 'c', dependsOn: ['a'] },
    { id: 'd', dependsOn: ['b', 'c'] },  // needs both b and c
  ];
  // skipping b alone: d still reachable via c, so only b is skipped
  assert.deepEqual(u.unreachableFrom(nodes, 'b').sort(), ['b']);
  // skipping b when c already skipped: d becomes unreachable (both deps gone)
  assert.deepEqual(u.unreachableFrom(nodes, 'b', ['c']).sort(), ['b', 'c', 'd']);
});

test('re-exported helpers are stable from graph-runs.js too', () => {
  const gr = require('./graph-runs');
  assert.equal(gr.deepMerge, u.deepMerge);
  assert.equal(gr.renderTemplate, u.renderTemplate);
});

test('apiRequest sends the per-boot token so gated POSTs (worker spawn) are not refused', async () => {
  const http = require('http');
  const seen = [];
  const srv = http.createServer((req, res) => { seen.push(req.headers['x-symphonee-token']); res.end('{"ok":true}'); });
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  const prev = process.env.SYMPHONEE_TOKEN;
  try {
    process.env.SYMPHONEE_TOKEN = 'tok-123';
    assert.deepEqual(await u.apiRequest('127.0.0.1', srv.address().port, 'POST', '/x', { a: 1 }), { ok: true });
    delete process.env.SYMPHONEE_TOKEN;
    await u.apiRequest('127.0.0.1', srv.address().port, 'GET', '/y');
    assert.deepEqual(seen, ['tok-123', undefined]);
  } finally {
    if (prev === undefined) delete process.env.SYMPHONEE_TOKEN; else process.env.SYMPHONEE_TOKEN = prev;
    srv.close();
  }
});

test('work windows: validation, start/hard-end state, crossing midnight', () => {
  const at = (h, m = 0) => new Date(2026, 10, 13, h, m).getTime();
  assert.equal(u.validRunSchedule(undefined), null);
  assert.deepEqual(u.validRunSchedule({ start: '08:00', end: '13:00' }), { start: '08:00', end: '13:00', hardEnd: '13:00' });
  assert.throws(() => u.validRunSchedule({ start: '08:00', end: '13:00', hardEnd: '12:00' }), /hardEnd/);
  assert.throws(() => u.validRunSchedule({ start: '8h', end: '13:00' }), /schedule needs/);
  const s = u.validRunSchedule({ start: '08:00', end: '13:00', hardEnd: '14:00' });
  let w = u.windowState(s, at(9));
  assert.equal(w.canStart, true); assert.equal(w.inHard, true); assert.equal(w.msToHardEnd, 5 * 3600000);
  w = u.windowState(s, at(13, 30));
  assert.equal(w.canStart, false, 'no new node after 13:00'); assert.equal(w.inHard, true, 'a running node may go on until 14:00');
  w = u.windowState(s, at(14));
  assert.equal(w.inHard, false); assert.equal(w.nextStart, at(8) + 24 * 3600000, 'next start is tomorrow 08:00');
  w = u.windowState(s, at(7));
  assert.equal(w.canStart, false); assert.equal(w.nextStart, at(8), 'before the window: today 08:00');
  const night = u.validRunSchedule({ start: '22:00', end: '04:00', hardEnd: '05:00' });
  assert.equal(u.windowState(night, at(2)).canStart, true);
  assert.equal(u.windowState(night, at(4, 30)).canStart, false);
  assert.equal(u.windowState(night, at(4, 30)).inHard, true);
  assert.equal(u.windowState(night, at(12)).inHard, false);
  assert.equal(u.windowState(night, at(12)).nextStart, at(22));
});
