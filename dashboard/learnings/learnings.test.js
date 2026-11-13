'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'); const os = require('os'); const path = require('path');
const { Learnings } = require('./learnings');

test('add: no ReferenceError; company-specific text rejected, generic text kept', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'learn-'));
  const l = new Learnings({ dataDir: dir, getConfig: () => ({}) });
  assert.equal(l.add({ category: 'shell', summary: 'Our client wants X', detail: '' }), null);
  const ok = l.add({ category: 'shell', summary: 'Use powershell.exe, never pwsh, for scripts', detail: 'generic' });
  assert.ok(ok && ok.summary);
});
