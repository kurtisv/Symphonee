import test from 'node:test';
import assert from 'node:assert/strict';
import { createSnapshotStore } from './autopilot-state.js';
test('older HTTP response cannot overwrite a newer socket snapshot or another pilot', () => {
  const store = createSnapshotStore();
  assert.equal(store.accept({ pilot: 'default', updatedAt: 200 }), true);
  assert.equal(store.accept({ pilot: 'default', updatedAt: 100 }), false);
  assert.equal(store.accept({ pilot: 'gas-saver', updatedAt: 150 }), true);
  assert.equal(store.get('default').updatedAt, 200);
  assert.equal(store.get('gas-saver').updatedAt, 150);
});
test('missing timestamps do not replace reliable state', () => {
  const store = createSnapshotStore();
  store.accept({ pilot: 'default', updatedAt: 200 });
  assert.equal(store.accept({ pilot: 'default' }), false);
});
