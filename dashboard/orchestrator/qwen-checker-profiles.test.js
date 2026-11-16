'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const P = require('./qwen-checker-profiles');
const { TASKS } = require('./qwen-fixture-tasks');

test('the strict profile is the only active, selectable one; the extended proposal cannot be selected or used on real projects', () => {
  assert.equal(P.activeProfile().id, 'strict'); assert.equal(P.select('strict'), P.PROFILES.strict);
  assert.throws(() => P.select('extended-experimental'), /proposal and cannot be selected/);
  assert.throws(() => P.select('anything'), /cannot be selected/);
  const e = P.PROFILES['extended-experimental'];
  assert.deepEqual([e.active, e.implemented, e.realProjects, P.PROFILES.strict.realProjects], [false, false, false, false]);
  assert.ok(Object.isFrozen(P.PROFILES) && Object.isFrozen(e.allows));
});

test('every fixture task declares a profile within the strict checker features', () => {
  for (const t of TASKS) { assert.ok(t.profile && t.profile.id === t.id && t.profile.hazard && t.profile.input && t.profile.kind, t.id); assert.ok(t.profile.features.every((f) => P.PROFILES.strict.allows.includes(f))); }
  const overflow = TASKS.filter((t) => t.profile.hazard === 'intermediate-overflow').map((t) => t.id).sort();
  assert.deepEqual(overflow, ['average', 'meanabs', 'meanpos', 'midrange']);
});
