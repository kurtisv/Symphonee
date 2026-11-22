const test = require('node:test');
const assert = require('node:assert/strict');
const { relaxSelector, tier1RelaxedUIA } = require('./apps-self-healer');

test('relaxSelector drops all listed keys cumulatively', () => {
  const orig = { class: 'a', id: 'b', type: 'c', name: 'n' };
  const r = relaxSelector(orig, ['class', 'id', 'type']);
  assert.deepEqual(r.selector, { name: 'n' });
  assert.deepEqual(r.dropped, ['class', 'id', 'type']);
  assert.deepEqual(orig, { class: 'a', id: 'b', type: 'c', name: 'n' });
  assert.deepEqual(relaxSelector({ class: 'a', id: 'b' }, ['class', 'id']).selector, {});
});

test('relaxSelector returns null when nothing dropped', () => {
  assert.equal(relaxSelector({ name: 'x' }, ['class']), null);
  assert.equal(relaxSelector(null, ['class']), null);
});

test('tier1 find: relaxes progressively until type is dropped', async () => {
  const seen = [];
  const driver = {
    findUIAElement: async (hwnd, sel) => { seen.push(sel); return sel.type ? { ok: false } : { ok: true }; },
  };
  const r = await tier1RelaxedUIA({ driver, hwnd: 1, selector: { class: 'a', id: 'b', type: 'c', name: 'n' }, op: 'find' });
  assert.equal(r.ok, true);
  assert.deepEqual(r.selector, { name: 'n' });
  assert.deepEqual(r.dropped, ['class', 'id', 'type']);
  assert.deepEqual(seen, [
    { id: 'b', type: 'c', name: 'n' },
    { type: 'c', name: 'n' },
    { name: 'n' },
  ]);
});

test('tier1 invoke: skips identical selectors when class/id absent', async () => {
  const seen = [];
  const driver = { invokeUIAElement: async (hwnd, sel) => { seen.push(sel); return { ok: false }; } };
  const r = await tier1RelaxedUIA({ driver, hwnd: 1, selector: { type: 'c', name: 'n' }, op: 'invoke' });
  assert.equal(r.ok, false);
  assert.deepEqual(seen, [{ name: 'n' }]);
});

test('tier1 find: identical relaxed selectors are attempted once', async () => {
  const seen = [];
  const driver = { findUIAElement: async (hwnd, sel) => { seen.push(sel); return { ok: false }; } };
  const r = await tier1RelaxedUIA({ driver, hwnd: 1, selector: { class: 'a', type: 'c', name: 'n' }, op: 'find' });
  assert.equal(r.ok, false);
  assert.deepEqual(seen, [{ type: 'c', name: 'n' }, { name: 'n' }]);
});

test('tier1 returns failure when nothing can be relaxed', async () => {
  let calls = 0;
  const driver = { findUIAElement: async () => { calls++; return { ok: true }; } };
  const r = await tier1RelaxedUIA({ driver, hwnd: 1, selector: { name: 'n' }, op: 'find' });
  assert.equal(r.ok, false);
  assert.equal(calls, 0);
});
