'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createIntentManager } = require('./intent');

test('concurrent force and debounced recomputes share one onRecompute call', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sym-intent-'));
  try {
    let calls = 0;
    let release;
    const manager = createIntentManager({
      repoRoot: root,
      getUiContext: () => ({ activeRepo: 'demo' }),
      onRecompute: async () => { calls++; await new Promise(r => { release = r; }); return { summary: 'working', confidence: 0.8 }; },
    });
    manager.notify({ kind: 'edit', detail: 'a.js' });
    const a = manager.forceRecompute();
    const b = manager.forceRecompute();
    assert.equal(calls, 1);
    release();
    assert.ok(await a);
    assert.deepEqual(await b, JSON.parse(JSON.stringify(await a)));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
