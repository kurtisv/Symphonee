import test from 'node:test';
import assert from 'node:assert/strict';
import { makeLatest } from './latest.js';

test('only the latest request may paint (A -> B -> A, invalidate)', () => {
  const g = makeLatest();
  const a1 = g.start(); const b = g.start(); const a2 = g.start();
  assert.equal(a1(), false, 'first A is stale even though A is selected again');
  assert.equal(b(), false);
  assert.equal(a2(), true);
  g.invalidate();
  assert.equal(a2(), false, 'leaving the view invalidates the pending request');
});
