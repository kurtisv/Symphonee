'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { VectorStore } = require('./vectors');

const space = (root, s) => fs.mkdirSync(path.join(root, '.symphonee', 'mind', 'spaces', s), { recursive: true });
const rnd = (seed) => { let x = seed; return () => (x = (x * 1664525 + 1013904223) % 4294967296) / 4294967296; };
const vec = (dim, r) => Float32Array.from({ length: dim }, () => r() - 0.5);

// Reference: the previous implementation (copy the whole matrix for every new id).
function referenceMatrix(items, dim) {
  let matrix = new Float32Array(0); const ids = [];
  for (const [id, v] of items) {
    let mag = 0; for (const x of v) mag += x * x; mag = Math.sqrt(mag) || 1; const n = Float32Array.from(v, (x) => x / mag);
    const idx = ids.indexOf(id);
    if (idx >= 0) matrix.set(n, idx * dim); else { const next = new Float32Array(matrix.length + dim); next.set(matrix); next.set(n, matrix.length); matrix = next; ids.push(id); }
  }
  return { matrix, ids };
}

test('croissance amortie : meme matrice et memes identifiants que l ancienne implementation (nouveaux ids et mises a jour)', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sym-vg-')); space(root, 's');
  const r = rnd(7); const dim = 16; const items = [];
  for (let i = 0; i < 700; i++) items.push(['id' + (i % 500), vec(dim, r)]); // 200 mises a jour d'ids existants
  const v = new VectorStore(root, 's'); v.init({ dim, provider: 't', model: 'm' });
  for (const [id, x] of items) v.upsert(id, x);
  const ref = referenceMatrix(items, dim);
  assert.equal(v.count(), ref.ids.length); assert.deepEqual(v.ids, ref.ids);
  assert.equal(v.matrix.length, ref.matrix.length);
  assert.ok(Buffer.compare(Buffer.from(v.matrix.buffer, v.matrix.byteOffset, v.matrix.byteLength), Buffer.from(ref.matrix.buffer)) === 0, 'matrices identiques');
});

test('sauvegarde et rechargement : le fichier contient exactement les vecteurs utiles, pas la capacite en trop', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sym-vg-')); space(root, 's');
  const r = rnd(3); const dim = 8; const v = new VectorStore(root, 's'); v.init({ dim, provider: 't', model: 'm' });
  for (let i = 0; i < 37; i++) v.upsert('n' + i, vec(dim, r));
  v.save();
  const bin = path.join(root, '.symphonee', 'mind', 'spaces', 's', 'vectors.bin');
  assert.equal(fs.statSync(bin).size, 37 * dim * 4, 'taille = vecteurs utiles seulement');
  const w = new VectorStore(root, 's'); assert.equal(w.load(), true);
  assert.equal(w.count(), 37);
  const q = w.query(v.matrix.slice(0, dim), 1); assert.equal(q[0].id, 'n0');
  // on peut continuer a ajouter apres un rechargement (le tampon vient du fichier)
  w.upsert('apres', vec(dim, r)); assert.equal(w.count(), 38); assert.equal(w.matrix.length, 38 * dim);
  w.upsert('n3', vec(dim, r)); assert.equal(w.count(), 38);
});

test('remove puis ajout : reste coherent', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sym-vg-')); space(root, 's');
  const r = rnd(5); const dim = 4; const v = new VectorStore(root, 's'); v.init({ dim, provider: 't', model: 'm' });
  for (let i = 0; i < 10; i++) v.upsert('n' + i, vec(dim, r));
  assert.equal(v.remove('n4'), true); assert.equal(v.count(), 9); assert.equal(v.matrix.length, 9 * dim);
  v.upsert('neuf', vec(dim, r)); assert.equal(v.count(), 10); assert.equal(v.ids[9], 'neuf'); assert.equal(v.matrix.length, 10 * dim);
});

test('performance : 20 000 insertions de 384 dimensions en moins de 5 secondes (l ancienne methode copiait tout a chaque ajout)', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sym-vg-')); space(root, 's');
  const r = rnd(11); const dim = 384; const v = new VectorStore(root, 's'); v.init({ dim, provider: 't', model: 'm' });
  const t0 = Date.now(); const x = vec(dim, r);
  for (let i = 0; i < 20000; i++) { x[i % dim] += 0.001; v.upsert('p' + i, x); }
  const ms = Date.now() - t0;
  assert.equal(v.count(), 20000); assert.ok(ms < 5000, 'trop lent : ' + ms + ' ms');
});
