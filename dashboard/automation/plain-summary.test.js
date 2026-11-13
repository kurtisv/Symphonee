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
  assert.equal(out[1].titre, 'Titre ap:b'); assert.match(out[1].redaction, /Codex test.*calcule a partir des faits/);
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

test('review 3: any cycle number, gate state for PleinSens, no completion claims, paths refused, bounded polling', async () => {
  const run = (done) => ({ id: 'gr', status: 'completed', cycle: 2, nodes: [{ id: done, status: 'completed' }] });
  assert.equal(p.pleinsensFacts(run('c2-consigner-garde')).state, 'a-integrer');
  assert.equal(p.pleinsensFacts(run('c2-consigner-garde'), { status: 'merged' }).state, 'termine');
  assert.equal(p.pleinsensFacts(run('c2-consigner-garde'), { status: 'refused', note: 'CI' }).state, 'arrete');
  assert.match(p.pleinsensFacts(run('c3-consigner-rejet')).stateText, /essaye et mesure/);
  const ok = { titre: 'Limites contre la triche', fait: 'Chaque personne a sa propre limite.', ameliore: 'Les prix sont plus fiables.' };
  for (const bad of ['La correction est terminee et fusionnee dans l application.', 'Elle est deployee en production.',
    'voir C:\\projet\\notes ici', 'dans dashboard/automation', 'la fonction check_price', 'le fichier .env'])
    assert.equal(p.parseWording(JSON.stringify({ ...ok, fait: bad })), null, bad);
  assert.deepEqual(p.parseWording(JSON.stringify({ ...ok, fait: 'Jusqu a 30 envois par heure, soit 2 par minute.' })).fait, 'Jusqu a 30 envois par heure, soit 2 par minute.');
  let t = 0;
  const w = p.codexWriter({ request: async (h, port, method) => { if (method === 'POST') return { id: 'x' }; throw new Error('down'); }, pollMs: 1, maxMs: 50, now: () => (t += 10) });
  await assert.rejects(w([{ key: 'k', text: 't' }]), /too slow or unreadable/);
});

test('review 4: completion words refused; cached texts re-checked', () => {
  const ok = { titre: 'Limites contre la triche', fait: 'Chaque personne a sa propre limite.', ameliore: 'Les prix sont plus fiables.' };
  for (const bad of ['Tout est fini et integre.', 'Le travail est acheve.', 'La correction est complete.', 'Tout est pret.'])
    assert.equal(p.parseWording(JSON.stringify({ ...ok, ameliore: bad })), null, bad);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clair-old-'));
  const h = { facts: p.autopilotFacts({ outcome: 'completed', title: 'a', commit: 'a', at: 'x' }, null), item: { title: 'a', objective: 'o' } };
  const m0 = p.makeSummaries({ cacheFile: path.join(dir, 'c.json'), write: async () => ({ text: '[]', by: 'x' }) });
  const hash = Object.keys(m0._cache()).length; void hash;
  // An old cache entry written before the stricter check:
  const crypto = require('crypto');
  const text = p.sourceText(h.facts, h.item);
  const old = { [h.facts.key]: { titre: 'T', fait: 'La correction est terminee et fusionnee.', ameliore: 'Mieux.', by: 'x', hash: crypto.createHash('sha256').update(text).digest('hex').slice(0, 16) } };
  fs.writeFileSync(path.join(dir, 'c.json'), JSON.stringify(old));
  const m = p.makeSummaries({ cacheFile: path.join(dir, 'c.json'), write: async () => ({ text: '[]', by: 'x' }) });
  assert.equal(m.present([h])[0].fait, null, 'old text hidden by the current check');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('review 5: arrival / completion paraphrases and generic file names refused; accented words kept', () => {
  const ok = { titre: 'Limites contre la triche', fait: 'Chaque personne a sa propre limite.', ameliore: 'Les prix sont plus fiables.' };
  for (const bad of ['Le changement est maintenant dans l application.', 'Le travail est fait, il ne reste rien a faire.',
    'voir index.html', 'le style.css', 'entre a/b', 'dans C:/projet'])
    assert.equal(p.parseWording(JSON.stringify({ ...ok, fait: bad })), null, bad);
  for (const good of ['Les deplacements mal définis sont ecartes.', 'Les stations gardees restent disponibles.', 'Neuf essais ont reussi.'])
    assert.ok(p.parseWording(JSON.stringify({ ...ok, fait: good })), good);
});
