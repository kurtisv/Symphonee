'use strict';
// Codex round 2 of the teacher lot: the number of compiler errors is counted on the WHOLE output, not on the 6000-character tail,
// so errors that fall off the tail still count as a falling error count (measured progress).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { runVerify } = require('./autopilot-verify');

test('errors are counted on the whole output even when the tail keeps only the last 6000 characters', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sym-verr-'));
  try {
    const script = "const l = \"src/t.ts(1,1): error TS2339: Property 'zz' does not exist on type 'Rec'.\\n\"; process.stdout.write(l.repeat(400)); process.exit(1)";
    const r = await runVerify(dir, [{ name: 'types', cmd: [process.execPath, '-e', script], timeoutMs: 20000 }]);
    assert.equal(r.ok, false);
    assert.equal(r.results[0].errors, 400);
    assert.ok(r.results[0].tail.length <= 6000 && (r.results[0].tail.match(/error TS\d+/g) || []).length < 400, 'the tail alone would have under-counted');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a passing check reports zero errors and an empty tail', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sym-verr-'));
  try {
    const r = await runVerify(dir, [{ name: 'ok', cmd: [process.execPath, '-e', 'process.exit(0)'], timeoutMs: 20000 }]);
    assert.equal(r.ok, true); assert.equal(r.results[0].errors, 0); assert.equal(r.results[0].tail, '');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
