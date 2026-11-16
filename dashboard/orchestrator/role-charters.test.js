'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { CHARTERS, hasCharter, charterText, applyRoleCharter } = require('./role-charters');
const { ROLES } = require('./task-roles');

test('every charter belongs to a real router role', () => {
  for (const role of Object.keys(CHARTERS)) assert.ok(ROLES.includes(role), role);
});

test('text-only roles have no charter', () => {
  for (const role of ['summarizer', 'context-compressor', 'long-running-worker']) assert.equal(hasCharter(role), false);
});

test('charters are plain ASCII and compact', () => {
  for (const role of Object.keys(CHARTERS)) {
    const t = charterText(role);
    assert.ok(/^[\x09\x0a\x20-\x7e]+$/.test(t), role + ' has non-ASCII characters');
    assert.ok(t.length < 1800, role + ' is too long: ' + t.length);
  }
});

test('read-only roles say not to edit', () => {
  for (const [role, c] of Object.entries(CHARTERS)) {
    if (c.readOnly) assert.match(charterText(role), /Do not edit any file/, role);
  }
});

test('reviewer charter keeps the anti-noise rules', () => {
  const t = charterText('reviewer');
  assert.match(t, /80 percent/);
  assert.match(t, /Zero findings is a valid/);
  assert.match(t, /file and line/);
});

test('applyRoleCharter prepends once and keeps the original prompt', () => {
  const out = applyRoleCharter('review src/a.js', 'reviewer');
  assert.ok(out.startsWith('[ROLE CHARTER: reviewer]'));
  assert.ok(out.endsWith('review src/a.js'));
  assert.equal(applyRoleCharter(out, 'reviewer'), out);
});

test('unknown or missing role leaves the prompt unchanged', () => {
  assert.equal(applyRoleCharter('hello', 'summarizer'), 'hello');
  assert.equal(applyRoleCharter('hello', undefined), 'hello');
  assert.equal(applyRoleCharter(undefined, 'coder').includes('undefined'), false);
});
