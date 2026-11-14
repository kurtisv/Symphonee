'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const L = require('./lessons');

test('a repeated mistake is counted once, ranked first, and rendered for prompts', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lecons-'));
  let r = L.record(root, { scope: 'p', kind: 'revue', text: 'Missing test for the 999.5 m rounding in abc1234' });
  assert.equal(r.isNew, true);
  r = L.record(root, { scope: 'p', kind: 'revue', text: 'Missing test for the 999.9 m rounding in def5678' });
  assert.equal(r.isNew, false, 'same mistake, other numbers and commit'); assert.equal(r.entry.count, 2);
  L.record(root, { scope: 'p', kind: 'porte', text: 'baseline-facts failed' });
  L.record(root, { scope: 'other', kind: 'revue', text: 'not mine' });
  const top = L.top(root, 'p');
  assert.equal(top.length, 2); assert.equal(top[0].count, 2);
  assert.match(L.promptText(top), /LESSONS FROM PAST FAILURES[\s\S]*\[revue, 2 fois\][\s\S]*\[porte\]/);
  assert.equal(L.promptText([]), '');
  assert.equal(L.record(root, { scope: 'p', kind: 'x', text: '  ' }).entry, null);
});

test('firstFinding skips headings and the verdict', () => {
  assert.equal(L.firstFinding('## Review\n\n- **[P1] Off by one** in x.ts\n- second\n\nVERDICT: FAIL'), '[P1] Off by one in x.ts');
  assert.equal(L.firstFinding('VERDICT: FAIL'), '');
});
