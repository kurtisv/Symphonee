'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { writeJsonChunked } = require('./async-json');

const tmpFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sym-aj-')), 'out.json');
const same = async (value, slice) => {
  const f = tmpFile();
  await writeJsonChunked(f, value, { slice });
  assert.equal(fs.readFileSync(f, 'utf8'), JSON.stringify(value));
  assert.deepEqual(fs.readdirSync(path.dirname(f)), ['out.json'], 'aucun fichier temporaire restant');
};

test('identique a JSON.stringify : graphe typique (tableaux et objets volumineux) avec de petites tranches', async () => {
  const nodes = Array.from({ length: 53 }, (_, i) => ({ id: 'n' + i, label: 'Noeud "' + i + '"', tags: ['a', 'b'], x: i % 3 ? i : undefined, d: new Date(0) }));
  const edges = Array.from({ length: 101 }, (_, i) => ({ from: 'n' + (i % 53), to: 'n' + ((i + 1) % 53), w: i / 7 }));
  const entries = Object.fromEntries(Array.from({ length: 77 }, (_, i) => ['f' + i + '.js', { sha256: 'h' + i, contributors: ['n' + i] }]));
  for (const slice of [1, 2, 7, 50, 1500]) {
    await same({ version: 1, nodes, edges, communities: entries, stats: { nodes: 53 } }, slice);
    await same({ entries }, slice);
  }
});

test('identique a JSON.stringify : valeurs particulieres (undefined, null, fonctions, vides, unicode)', async () => {
  await same({}, 3); await same([], 3); await same({ a: [], b: {}, c: null }, 1);
  await same({ a: undefined, b: () => 1, c: Symbol('s'), d: 'zzé中\n"\\', e: [undefined, () => 1, null, NaN, Infinity] }, 1);
  await same({ big: Array.from({ length: 10 }, (_, i) => (i % 2 ? undefined : i)) }, 3);
  await same('texte', 1); await same(42, 1); await same([1, 2, 3, 4, 5], 2);
});

test('le serveur reste reactif : l ecriture rend la main a la boucle d evenements', async () => {
  const nodes = Array.from({ length: 60000 }, (_, i) => ({ id: 'node-' + i, label: 'Etiquette numero ' + i, body: 'x'.repeat(200), tags: ['t1', 't2', 't3'] }));
  const f = tmpFile();
  let ticks = 0, maxGap = 0, last = Date.now();
  const timer = setInterval(() => { const n = Date.now(); maxGap = Math.max(maxGap, n - last); last = n; ticks++; }, 1);
  const t0 = Date.now();
  await writeJsonChunked(f, { nodes });
  clearInterval(timer);
  assert.equal(fs.readFileSync(f, 'utf8').length, JSON.stringify({ nodes }).length);
  assert.ok(ticks > 5, 'la boucle a tourne pendant l ecriture (' + ticks + ' battements en ' + (Date.now() - t0) + ' ms)');
  assert.ok(maxGap < 250, 'plus long blocage : ' + maxGap + ' ms');
});

test('erreur d ecriture : propagee, aucun fichier temporaire laisse, ancien fichier intact', async () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'sym-aj-')); const f = path.join(d, 'out.json');
  fs.writeFileSync(f, '{"ancien":true}');
  const circular = {}; circular.self = circular;
  await assert.rejects(writeJsonChunked(f, { a: [circular] }), /circular|Converting/i);
  assert.equal(fs.readFileSync(f, 'utf8'), '{"ancien":true}');
  assert.deepEqual(fs.readdirSync(d), ['out.json']);
  await assert.rejects(writeJsonChunked(path.join(d, 'inexistant', 'x.json'), { a: 1 }));
});
