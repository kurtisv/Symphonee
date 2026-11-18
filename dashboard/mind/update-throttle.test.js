'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createUpdateThrottle } = require('./update-throttle');

// Fake clock and timers: no real waiting.
function rig(opts = {}) {
  let t = 1000000; const timers = []; const calls = [];
  const th = createUpdateThrottle({
    run: async (trig) => { calls.push({ at: t, trig }); if (opts.takes) t += opts.takes; if (opts.fail) throw new Error('boom'); },
    minGapMs: 600000, firstDelayMs: 3000, now: () => t,
    setTimer: (fn, ms) => { const h = { fn, at: t + ms, off: false }; timers.push(h); return h; }, clearTimer: (h) => { h.off = true; }, onError: () => { calls.push('erreur'); },
  });
  const advance = async (ms) => { t += ms; for (const h of timers.filter((x) => !x.off && x.at <= t)) { h.off = true; await h.fn(); } await Promise.resolve(); };
  return { th, calls, advance, timers, now: () => t };
}

test('le premier declencheur part apres le delai court, pas apres 10 minutes', async () => {
  const r = rig(); r.th.trigger(['a.js']);
  await r.advance(2999); assert.equal(r.calls.length, 0);
  await r.advance(2); assert.equal(r.calls.length, 1); assert.deepEqual(r.calls[0].trig, ['a.js']);
});

test('une rafale de declencheurs devient UNE seule mise a jour (fichiers fusionnes sans doublon)', async () => {
  const r = rig(); r.th.trigger(['a.js']); r.th.trigger(['b.js', 'a.js']); r.th.trigger(['c.js']);
  await r.advance(4000); assert.equal(r.calls.length, 1); assert.deepEqual(r.calls[0].trig.sort(), ['a.js', 'b.js', 'c.js']);
});

test('apres une mise a jour, la suivante attend au moins 10 minutes ; les declencheurs intermediaires sont regroupes', async () => {
  const r = rig({ takes: 20000 }); r.th.trigger(['a.js']); await r.advance(4000);
  assert.equal(r.calls.length, 1);
  r.th.trigger(['b.js']); r.th.trigger(['c.js']);
  await r.advance(5 * 60000); assert.equal(r.calls.length, 1, 'rien avant 10 min');
  await r.advance(6 * 60000); assert.equal(r.calls.length, 2); assert.deepEqual(r.calls[1].trig.sort(), ['b.js', 'c.js']);
});

test('evenement de connaissance : un objet fusionne les raisons et les identifiants', async () => {
  const r = rig(); r.th.trigger({ knowledgeEvent: true, reasons: ['memory'], nodeIds: ['n1'] }); r.th.trigger({ knowledgeEvent: true, reasons: ['lesson', 'memory'], nodeIds: ['n2', 'n1'] }); r.th.trigger(['x.js']);
  await r.advance(4000); assert.equal(r.calls.length, 1);
  const t = r.calls[0].trig; assert.equal(t.knowledgeEvent, true); assert.deepEqual(t.reasons.sort(), ['lesson', 'memory']); assert.deepEqual(t.nodeIds.sort(), ['n1', 'n2']); assert.deepEqual(t.changedFiles, ['x.js']);
});

test('jamais deux mises a jour en meme temps ; un declencheur pendant une execution est reporte', async () => {
  const r = rig({ takes: 1000 }); r.th.trigger(['a.js']); await r.advance(4000);
  assert.equal(r.th._state().running, false);
  r.th.trigger(['b.js']); assert.equal(r.calls.length, 1);
});

test('une erreur ne bloque pas la suite : la mise a jour suivante a lieu', async () => {
  const r = rig({ fail: true }); r.th.trigger(['a.js']); await r.advance(4000);
  assert.deepEqual(r.calls.map((c) => (c === 'erreur' ? c : 'run')), ['run', 'erreur']);
  r.th.trigger(['b.js']); await r.advance(11 * 60000); assert.equal(r.calls.filter((c) => c !== 'erreur').length, 2);
});

test('declencheur de forme inconnue : une mise a jour quand meme ; rien en file = aucun minuteur', async () => {
  const r = rig(); assert.equal(r.timers.length, 0);
  r.th.trigger(undefined); await r.advance(4000); assert.equal(r.calls.length, 1); assert.equal(r.calls[0].trig.knowledgeEvent, true);
});
