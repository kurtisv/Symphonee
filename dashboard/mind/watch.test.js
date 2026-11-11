const test = require('node:test');
const assert = require('node:assert/strict');
const { MindWatcher } = require('./watch');

// Drive the watcher through its event entry point with fake timers. No real
// filesystem watcher is started. Context: the watch targets include the CLI
// transcript folders, which change continuously while any agent works, so a
// plain 3 s debounce rebuilt the whole graph back to back all day.

const T0 = 1_000_000;

function setup(t, opts = {}) {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: T0 });
  const calls = [];
  let release = null;
  const w = new MindWatcher({
    repoRoot: '/x', debounceMs: 3000, minIntervalMs: 120000, maxWaitMs: 30000,
    onTrigger: (batch) => {
      calls.push({ at: Date.now(), batch: batch.slice().sort() });
      if (opts.slowBuild) return new Promise((r) => { release = r; });
      return undefined;
    },
  });
  const flush = async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); };
  return { w, calls, flush, releaseBuild: () => { const r = release; release = null; if (r) r(); } };
}

test('a burst of events yields one trigger after the debounce, with every file', async (t) => {
  const { w, calls, flush } = setup(t);
  w._onEvent('change', '/r/a.js'); t.mock.timers.tick(1000);
  w._onEvent('change', '/r/b.js'); t.mock.timers.tick(2999);
  assert.equal(calls.length, 0);
  t.mock.timers.tick(1); await flush();
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].batch, ['/r/a.js', '/r/b.js']);
});

test('events during the cooldown are not lost: they fire once when it ends', async (t) => {
  const { w, calls, flush } = setup(t);
  w._onEvent('change', '/r/a.js'); t.mock.timers.tick(3000); await flush();
  assert.equal(calls.length, 1);
  for (let i = 0; i < 20; i++) { w._onEvent('change', `/r/f${i}.jsonl`); t.mock.timers.tick(5000); await flush(); }
  assert.equal(calls.length, 1, 'no rebuild inside the 120 s cooldown');
  t.mock.timers.tick(20000); await flush();
  assert.equal(calls.length, 2);
  assert.equal(calls[1].batch.length, 20);
  assert.ok(calls[1].at - calls[0].at >= 120000);
});

test('never overlaps a running build, then honours the cooldown from its end', async (t) => {
  const { w, calls, flush, releaseBuild } = setup(t, { slowBuild: true });
  w._onEvent('change', '/r/a.js'); t.mock.timers.tick(3000); await flush();
  assert.equal(calls.length, 1);
  w._onEvent('change', '/r/b.js'); t.mock.timers.tick(300000); await flush();
  assert.equal(calls.length, 1, 'build still running: must not start another');
  releaseBuild(); await flush();
  t.mock.timers.tick(119999); await flush();
  assert.equal(calls.length, 1);
  t.mock.timers.tick(1); await flush();
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1].batch, ['/r/b.js']);
});

test('a steady stream of events cannot postpone the first trigger past maxWait', async (t) => {
  const { w, calls, flush } = setup(t);
  for (let i = 0; i < 40; i++) { w._onEvent('change', '/r/a.js'); t.mock.timers.tick(1000); await flush(); }
  assert.equal(calls.length, 1);
  assert.ok(calls[0].at - T0 <= 30000);
});

test('a failing build does not stop later triggers', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: T0 });
  let n = 0;
  const w = new MindWatcher({
    repoRoot: '/x', debounceMs: 3000, minIntervalMs: 10000, maxWaitMs: 30000,
    onTrigger: () => { n++; if (n === 1) throw new Error('boom'); },
  });
  const flush = async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); };
  const warn = console.warn; console.warn = () => {};
  try {
    w._onEvent('change', '/r/a.js'); t.mock.timers.tick(3000); await flush();
    w._onEvent('change', '/r/b.js'); t.mock.timers.tick(10000); await flush();
  } finally { console.warn = warn; }
  assert.equal(n, 2);
});

test('stop() cancels a pending trigger', async (t) => {
  const { w, calls, flush } = setup(t);
  w._onEvent('change', '/r/a.js');
  w.stop();
  t.mock.timers.tick(600000); await flush();
  assert.equal(calls.length, 0);
});

test('files that are not watched extensions never trigger', async (t) => {
  const { w, calls, flush } = setup(t);
  w._onEvent('change', '/r/image.png');
  t.mock.timers.tick(600000); await flush();
  assert.equal(calls.length, 0);
});
