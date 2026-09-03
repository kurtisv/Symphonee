'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { createOllamaHealth, STATES } = require('./ollama-health');

function harness({ probes = [], starts = 0, startResult = true } = {}) {
  let probeIndex = 0;
  let now = 0;
  const events = [];
  const health = createOllamaHealth({
    probe: async () => probes[Math.min(probeIndex++, probes.length - 1)] || false,
    start: async () => { starts++; return startResult; },
    sleep: async () => {},
    now: () => now,
    onChange: s => events.push(s.state),
  });
  return { health, events, get starts() { return starts; }, advance: ms => { now += ms; } };
}

test('already running and ready does not start', async () => {
  const h = harness({ probes: [true] });
  assert.deepEqual(await h.health.ensureReady({ installPath: 'ollama' }), { ok: true, state: STATES.READY });
  assert.equal(h.starts, 0);
});

test('slow startup waits with bounded readiness probes', async () => {
  const h = harness({ probes: [false, false, false, true] });
  const r = await h.health.ensureReady({ installPath: 'ollama' });
  assert.equal(r.ok, true);
  assert.equal(h.starts, 1);
  assert.deepEqual(h.events, [STATES.STARTING, STATES.READY]);
});

test('startup failure becomes unavailable and does not loop', async () => {
  const h = harness({ probes: [false], startResult: false });
  assert.equal((await h.health.ensureReady({ installPath: 'ollama' })).ok, false);
  assert.equal(h.health.status().state, STATES.UNAVAILABLE);
  assert.equal((await h.health.ensureReady({ installPath: 'ollama' })).ok, false);
  assert.equal(h.starts, 1);
});

test('endpoint never ready becomes degraded after finite retries', async () => {
  const h = harness({ probes: [false, false, false, false, false, false] });
  assert.equal((await h.health.ensureReady({ installPath: 'ollama' })).ok, false);
  assert.equal(h.health.status().state, STATES.DEGRADED);
  assert.equal(h.starts, 1);
});

test('one startup attempt is shared by concurrent callers', async () => {
  let resolveStart;
  let starts = 0;
  const h = createOllamaHealth({
    probe: async () => false,
    start: () => { starts++; return new Promise(resolve => { resolveStart = resolve; }); },
    sleep: async () => {},
  });
  const a = h.ensureReady({ installPath: 'ollama' });
  const b = h.ensureReady({ installPath: 'ollama' });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(starts, 1);
  resolveStart(false);
  const results = await Promise.all([a, b]);
  assert.equal(results[0].ok, false);
  assert.equal(results[1].ok, false);
});

test('unavailable endpoint recovers without another startup', async () => {
  let ready = false;
  let starts = 0;
  const h = createOllamaHealth({ probe: async () => ready, start: async () => { starts++; return false; }, sleep: async () => {} });
  await h.ensureReady({ installPath: 'ollama' });
  ready = true;
  assert.equal((await h.ensureReady({ installPath: 'ollama' })).ok, true);
  assert.equal(h.status().state, STATES.READY);
  assert.equal(starts, 1);
});
