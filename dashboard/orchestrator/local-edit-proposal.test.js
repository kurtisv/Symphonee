'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { readTarget, validateProposal, requestProposal, applyProposal } = require('./local-edit-proposal');
function fixture(t, text = 'function add(a,b) { return a - b; }\n') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-edit-proposal-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'calc.js'), text);
  return root;
}
test('exact replacement stays in memory and carries the original hash', t => {
  const root = fixture(t), snap = readTarget(root, 'calc.js', { protectedHits: () => [] });
  const out = validateProposal(snap, { path: 'calc.js', baseSha256: snap.sha256, oldText: 'return a - b;', newText: 'return a + b;' });
  assert.match(out.content, /a \+ b/); assert.match(fs.readFileSync(path.join(root, 'calc.js'), 'utf8'), /a - b/);
});
test('refuses stale hashes, invented paths and ambiguous old text', t => {
  const root = fixture(t, 'x x'), snap = readTarget(root, 'calc.js', { protectedHits: () => [] });
  assert.throws(() => validateProposal(snap, { path: 'calc.js', baseSha256: snap.sha256, oldText: 'x', newText: 'y' }));
  assert.throws(() => validateProposal(snap, { path: 'else.js', baseSha256: snap.sha256, oldText: 'x x', newText: 'y' }));
  assert.throws(() => validateProposal(snap, { path: 'calc.js', baseSha256: 'stale', oldText: 'x x', newText: 'y' }));
});
test('refuses traversal, Git internals and protected paths', t => {
  const root = fixture(t);
  for (const rel of ['../calc.js', 'C:/calc.js', '.git/config', 'a\\b.js']) assert.throws(() => readTarget(root, rel, { protectedHits: () => [] }));
  assert.throws(() => readTarget(root, 'calc.js'));
  assert.throws(() => readTarget(root, 'calc.js', { protectedHits: x => x }));
});
test('untrusted model output cannot choose another file or bypass the exact match', async t => {
  const root = fixture(t), snap = readTarget(root, 'calc.js', { protectedHits: () => [] });
  await assert.rejects(requestProposal(snap, 'Fix add', async () => ({ json: { path: '../outside', baseSha256: snap.sha256, oldText: 'return a - b;', newText: 'return a + b;' } })));
  await assert.rejects(requestProposal(snap, 'Fix add', async () => ({ json: { decision: 'NO_CHANGE' } })));
  assert.match(fs.readFileSync(path.join(root, 'calc.js'), 'utf8'), /a - b/);
});
test('bounded proposal applies to the expected file, stale state fails closed', { skip: process.platform !== 'win32' }, async t => {
  const root = fixture(t), policy = { protectedHits: () => [] }, snap = readTarget(root, 'calc.js', policy);
  const proposal = { path: 'calc.js', baseSha256: snap.sha256, oldText: 'return a - b;', newText: 'return a + b;' };
  const result = applyProposal(root, snap, proposal, policy);
  assert.match(fs.readFileSync(path.join(root, 'calc.js'), 'utf8'), /a \+ b/); assert.equal(result.path, 'calc.js');
  assert.throws(() => applyProposal(root, snap, proposal, policy), /stale/);
});
