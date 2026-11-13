'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'); const os = require('os'); const path = require('path');
const p = require('./plain-summary');

test('facts: finished or not is computed by code from outcome and merge gate', () => {
  const h = { outcome: 'completed', title: 'T', commit: 'c1', at: 'x', worktree: { branch: 'b' } };
  assert.equal(p.autopilotFacts(h, { status: 'new' }).state, 'a-integrer');
  assert.match(p.autopilotFacts(h, null).stateText, /Pas encore dans l application/);
  assert.equal(p.autopilotFacts(h, { status: 'merged' }).state, 'termine');
  assert.equal(p.autopilotFacts(h, { status: 'refused', note: 'CI rouge' }).state, 'arrete');
  assert.equal(p.autopilotFacts({ ...h, outcome: 'plan-rejected' }).state, 'abandonne');
  assert.equal(p.autopilotFacts({ ...h, outcome: 'interrupted' }).state, 'arrete');
  const run = (status, done) => ({ id: 'gr', status, cycle: 1, nodes: [{ id: done, status: 'completed' }, { id: 'x', status: 'running' }] });
  assert.equal(p.pleinsensFacts(run('running', 'a')).state, 'en-cours');
  assert.match(p.pleinsensFacts(run('completed', 'c1-consigner-rejet-conception')).stateText, /avant toute modification du code/);
  assert.equal(p.pleinsensFacts(run('completed', 'c1-consigner-garde')).state, 'a-integrer');
  assert.equal(p.pleinsensFacts(run('completed', 'c1-consigner-rejet')).state, 'termine');
  assert.equal(p.pleinsensFacts(run('cancelled', 'a')).state, 'arrete');
});

test('wording check refuses code, paths and identifiers', () => {
  const ok = { titre: 'Limites contre la triche', fait: 'Chaque utilisateur a maintenant sa propre limite.', ameliore: 'Les prix sont plus fiables.' };
  assert.deepEqual(p.parseWording(JSON.stringify(ok)), ok);
  for (const bad of ['voir prices.ts', 'la route /api/prices', 'le fichier src/utils', 'appel de formatDistance', 'x => y', 'f()'])
    assert.equal(p.parseWording(JSON.stringify({ ...ok, fait: bad })), null, bad);
  assert.equal(p.parseWording('pas de json'), null);
});

test('summaries: one batched call for the missing items, cached, retried later on failure', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clair-'));
  let calls = 0; let fail = false; let t = 0;
  const write = async (jobs) => {
    calls++; if (fail) throw new Error('down');
    return { by: 'Codex test', text: 'voici ' + JSON.stringify(jobs.map((j) => ({ key: j.key, titre: 'Titre ' + j.key, fait: 'Fait simple.', ameliore: 'Mieux.' }))) };
  };
  const m = p.makeSummaries({ cacheFile: path.join(dir, 'c.json'), write, now: () => t });
  const h = (k) => ({ facts: p.autopilotFacts({ outcome: 'completed', title: k, commit: k, at: 'x' }, null), item: { title: k, objective: 'o' } });
  let out = m.present([h('a'), h('b')]);
  assert.equal(out[0].titre, null); assert.match(out[0].redaction, /preparation/);
  await m._drain();
  assert.equal(calls, 1, 'both items in ONE call');
  out = m.present([h('a'), h('b')]);
  assert.equal(out[1].titre, 'Titre ap:b'); assert.match(out[1].redaction, /Codex test.*calcule, pas redige/);
  await m._drain(); assert.equal(calls, 1, 'cached: no new call');
  fail = true; m.present([h('c')]); await m._drain(); assert.equal(calls, 2);
  m.present([h('c')]); await m._drain(); assert.equal(calls, 2, 'no retry within 30 minutes');
  fail = false; t += 31 * 60000; m.present([h('c')]); await m._drain(); assert.equal(calls, 3);
  const reload = p.makeSummaries({ cacheFile: path.join(dir, 'c.json'), write, now: () => t });
  assert.equal(reload.present([h('a')])[0].titre, 'Titre ap:a', 'cache survives a restart');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('facts: a pilot the merge gate does not handle needs a person to merge', () => {
  const f = p.autopilotFacts({ outcome: 'completed', title: 'T', commit: 'c', at: 'x' }, null, { gated: false });
  assert.equal(f.state, 'a-integrer');
  assert.match(f.stateText, /pas de fusion automatique/);
});

test('a run with no finished step is not sent to the writer', async () => {
  let calls = 0;
  const m = p.makeSummaries({ cacheFile: path.join(os.tmpdir(), 'clair-none-' + process.pid + '.json'), write: async () => { calls++; return { text: '[]', by: 'x' }; } });
  const run = { id: 'gr_z', status: 'cancelled', nodes: [{ id: 'a', status: 'failed' }] };
  const out = m.present([{ facts: p.pleinsensFacts(run), item: run }]);
  await m._drain();
  assert.equal(calls, 0);
  assert.match(out[0].redaction, /rien a resumer/);
  assert.match(out[0].stateText, /Arrete a la main/);
});
