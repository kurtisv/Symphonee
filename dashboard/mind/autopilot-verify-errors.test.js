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

// The child scripts avoid escape sequences: NL is built with String.fromCharCode(10).
const NL = "String.fromCharCode(10)";

test('a match split between two chunks is counted once, and none is lost', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sym-verr-'));
  try {
    const script = "const nl = " + NL + "; for (let i = 0; i < 50; i++) process.stdout.write('error TS2339 x' + nl); process.stdout.write('error T'); setTimeout(() => { process.stdout.write('S1234 split' + nl); process.exit(1) }, 200)";
    const r = await runVerify(dir, [{ name: 'types', cmd: [process.execPath, '-e', script], timeoutMs: 30000 }]);
    assert.equal(r.results[0].errors, 51);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('the count is not limited by the 200000-character memory buffer', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sym-verr-'));
  try {
    const script = "const nl = " + NL + "; const l = 'error TS2339 ' + 'x'.repeat(90) + nl; for (let i = 0; i < 4000; i++) process.stdout.write(l); process.exit(1)"; // ~400 KB, far beyond the buffer
    const r = await runVerify(dir, [{ name: 'types', cmd: [process.execPath, '-e', script], timeoutMs: 30000 }]);
    assert.equal(r.results[0].errors, 4000);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
