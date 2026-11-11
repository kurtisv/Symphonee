const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const store = require('./store');

// Shared read cache, compact writes and report pruning. Context: graph.json
// reached 229 MB and was re-read + re-parsed (about 1.4 s, about 700 MB of
// heap) on every loadGraph call, on the Electron main event loop.

function mkGraph(n) {
  const nodes = [];
  for (let i = 0; i < n; i++) nodes.push({ id: 'n' + i, label: 'N' + i, kind: 'note' });
  return { version: 1, scope: { space: '_test', isGlobal: false }, nodes, edges: [], hyperedges: [], communities: {}, gods: [], surprises: [], stats: {} };
}
function tmpRoot(tag) { return fs.mkdtempSync(path.join(os.tmpdir(), 'mind-store-' + tag + '-')); }
function countReads(fn) {
  const orig = fs.readFileSync; let n = 0;
  fs.readFileSync = function (p, ...rest) { if (String(p).endsWith('graph.json')) n++; return orig.call(fs, p, ...rest); };
  try { fn(); } finally { fs.readFileSync = orig; }
  return n;
}

test('loadGraphShared parses once while the file is unchanged', () => {
  const root = tmpRoot('once');
  store.saveGraph(root, '_test', mkGraph(3));
  let a; let b;
  const reads = countReads(() => {
    a = store.loadGraphShared(root, '_test');
    b = store.loadGraphShared(root, '_test');
    store.statsFor(root, '_test');
    store.statsFor(root, '_test');
  });
  assert.equal(reads, 1);
  assert.equal(a, b);
  assert.equal(a.nodes.length, 3);
});

test('loadGraphShared sees a save made through saveGraph', () => {
  const root = tmpRoot('save');
  store.saveGraph(root, '_test', mkGraph(2));
  assert.equal(store.loadGraphShared(root, '_test').nodes.length, 2);
  store.saveGraph(root, '_test', mkGraph(5));
  assert.equal(store.loadGraphShared(root, '_test').nodes.length, 5);
  assert.equal(store.statsFor(root, '_test').nodes, 5);
});

test('loadGraphShared sees a write made by another process (same size, new mtime)', () => {
  const root = tmpRoot('ext');
  store.saveGraph(root, '_test', mkGraph(2));
  const p = store.graphPath(root, '_test');
  assert.equal(store.loadGraphShared(root, '_test').nodes[0].label, 'N0');
  const raw = fs.readFileSync(p, 'utf8').replace('"N0"', '"X0"');
  fs.writeFileSync(p, raw, 'utf8');
  const future = new Date(Date.now() + 5000);
  fs.utimesSync(p, future, future);
  assert.equal(store.loadGraphShared(root, '_test').nodes[0].label, 'X0');
});

test('loadGraphShared returns null when the file is missing or removed', () => {
  const root = tmpRoot('missing');
  assert.equal(store.loadGraphShared(root, '_test'), null);
  assert.equal(store.statsFor(root, '_test'), null);
  store.saveGraph(root, '_test', mkGraph(1));
  assert.equal(store.loadGraphShared(root, '_test').nodes.length, 1);
  fs.rmSync(store.graphPath(root, '_test'));
  assert.equal(store.loadGraphShared(root, '_test'), null);
});

test('loadGraph still hands out a private copy that cannot leak into the shared one', () => {
  const root = tmpRoot('private');
  store.saveGraph(root, '_test', mkGraph(2));
  const shared = store.loadGraphShared(root, '_test');
  const mine = store.loadGraph(root, '_test');
  assert.notEqual(mine, shared);
  mine.nodes.push({ id: 'leak', label: 'Leak', kind: 'note' });
  mine.nodes[0].label = 'changed';
  assert.equal(store.loadGraphShared(root, '_test').nodes.length, 2);
  assert.equal(store.loadGraphShared(root, '_test').nodes[0].label, 'N0');
});

test('the shared graph refuses in-place structural mutation loudly', () => {
  const root = tmpRoot('frozen');
  store.saveGraph(root, '_test', mkGraph(2));
  const g = store.loadGraphShared(root, '_test');
  assert.throws(() => g.nodes.push({ id: 'x', label: 'x', kind: 'note' }), TypeError);
  assert.throws(() => g.nodes.sort(), TypeError);
  assert.throws(() => g.edges.push({}), TypeError);
});

test('a corrupt graph.json throws on a shared read and is never cached', () => {
  const root = tmpRoot('corrupt');
  store.saveGraph(root, '_test', mkGraph(2));
  const p = store.graphPath(root, '_test');
  fs.writeFileSync(p, '{ not json', 'utf8');
  const future = new Date(Date.now() + 5000);
  fs.utimesSync(p, future, future);
  assert.throws(() => store.loadGraphShared(root, '_test'), /corrupt/);
  assert.throws(() => store.loadGraphShared(root, '_test'), /corrupt/);
});

test('invalidateShared forces the next shared read to hit the disk', () => {
  const root = tmpRoot('inval');
  store.saveGraph(root, '_test', mkGraph(2));
  store.loadGraphShared(root, '_test');
  store.invalidateShared(root, '_test');
  const reads = countReads(() => { store.loadGraphShared(root, '_test'); });
  assert.equal(reads, 1);
});

test('saveGraph keeps small graphs readable and writes large graphs compact, same content', () => {
  const root = tmpRoot('compact');
  store.saveGraph(root, 'small', mkGraph(3));
  assert.match(fs.readFileSync(store.graphPath(root, 'small'), 'utf8'), /\n  "nodes"/);
  const big = mkGraph(store.COMPACT_THRESHOLD + 10);
  store.saveGraph(root, 'big', big);
  const raw = fs.readFileSync(store.graphPath(root, 'big'), 'utf8');
  assert.doesNotMatch(raw, /\n/);
  const back = store.loadGraph(root, 'big');
  assert.equal(back.nodes.length, store.COMPACT_THRESHOLD + 10);
  assert.deepEqual(back.nodes[7], big.nodes[7]);
});

test('pruneReports keeps only the newest N reports and nothing else', () => {
  const root = tmpRoot('prune');
  store.ensureDirs(root, '_test');
  const dir = store.reportsDir(root, '_test');
  for (let i = 1; i <= 12; i++) fs.writeFileSync(path.join(dir, `report-${1000 + i}.md`), 'r' + i);
  fs.writeFileSync(path.join(dir, 'keep-me.txt'), 'not a report');
  const removed = store.pruneReports(root, '_test', 5);
  assert.equal(removed, 7);
  const left = fs.readdirSync(dir).sort();
  assert.deepEqual(left, ['keep-me.txt', 'report-1008.md', 'report-1009.md', 'report-1010.md', 'report-1011.md', 'report-1012.md']);
  assert.equal(store.pruneReports(root, '_test', 5), 0);
});

test('a save is seen even when the new file has the same size and the same mtime', () => {
  // The stat check alone cannot tell these two files apart. saveGraph must
  // drop the shared instance explicitly.
  const root = tmpRoot('same-stat');
  const p = store.graphPath(root, '_test');
  const a = mkGraph(2);
  store.saveGraph(root, '_test', a);
  // Pin the mtime to a whole second: utimes cannot restore sub-ms precision.
  const pinned = new Date(Math.floor(Date.now() / 1000) * 1000 - 60000);
  fs.utimesSync(p, pinned, pinned);
  const st = fs.statSync(p);
  assert.equal(store.loadGraphShared(root, '_test').nodes[0].label, 'N0');
  const b = mkGraph(2);
  b.nodes[0].label = 'Z0';
  b.generatedAt = a.generatedAt;
  const realNow = Date.prototype.toISOString;
  Date.prototype.toISOString = function () { return a.generatedAt; };
  try { store.saveGraph(root, '_test', b); } finally { Date.prototype.toISOString = realNow; }
  fs.utimesSync(p, pinned, pinned);
  const st2 = fs.statSync(p);
  assert.equal(st2.size, st.size);
  assert.equal(st2.mtimeMs, st.mtimeMs);
  assert.equal(store.loadGraphShared(root, '_test').nodes[0].label, 'Z0');
});
