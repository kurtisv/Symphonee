'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const { readTarget } = require('./local-edit-proposal');
const src = path.join(__dirname, 'windows-checked-write.cs');
function run(root, hash, rel, rootIdentity) {
  const code = "Add-Type -Path $env:SY_TEST_CS; try { [SymphoneeCheckedWrite]::Apply($env:SY_TEST_ROOT,$env:SY_TEST_REL,$env:SY_TEST_ID,$env:SY_TEST_HASH,'return a - b;','return a + b;'); exit 0 } catch { exit 1 }";
  return spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', code], { env: { ...process.env, SY_TEST_CS: src, SY_TEST_ROOT: root, SY_TEST_REL: rel, SY_TEST_ID: rootIdentity, SY_TEST_HASH: hash }, encoding: 'utf8', timeout: 30000, windowsHide: true });
}
function setup(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'checked-qwen-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const text = 'function add(a,b) { return a - b; }\n'; fs.writeFileSync(path.join(root, 'calc.js'), text);
  return { root, text, hash: crypto.createHash('sha256').update(text).digest('hex'), rootIdentity: readTarget(root, 'calc.js', { protectedHits: () => [] }).rootIdentity };
}
test('Windows handle writer changes only the expected existing file', { skip: process.platform !== 'win32' }, t => {
  const { root, hash, rootIdentity } = setup(t); const r = run(root, hash, 'calc.js', rootIdentity);
  assert.equal(r.status, 0, r.stderr); assert.match(fs.readFileSync(path.join(root, 'calc.js'), 'utf8'), /a \+ b/);
});
test('Windows handle writer rejects stale content and multiple hard links', { skip: process.platform !== 'win32' }, t => {
  const { root, hash, text, rootIdentity } = setup(t); assert.notEqual(run(root, 'invalid', 'calc.js', rootIdentity).status, 0);
  fs.linkSync(path.join(root, 'calc.js'), path.join(root, 'alias.js'));
  assert.notEqual(run(root, hash, 'calc.js', rootIdentity).status, 0); assert.equal(fs.readFileSync(path.join(root, 'calc.js'), 'utf8'), text);
});
test('Windows handle writer rejects a junction leading outside the worktree', { skip: process.platform !== 'win32' }, t => {
  const { root, hash, rootIdentity } = setup(t), outside = fs.mkdtempSync(path.join(os.tmpdir(), 'checked-outside-'));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  const text = 'function add(a,b) { return a - b; }\n'; fs.writeFileSync(path.join(outside, 'calc.js'), text);
  fs.symlinkSync(outside, path.join(root, 'escape'), 'junction');
  assert.notEqual(run(root, hash, 'escape/calc.js', rootIdentity).status, 0);
  assert.equal(fs.readFileSync(path.join(outside, 'calc.js'), 'utf8'), text);
});
test('Windows handle writer rejects an internal junction into a protected directory', { skip: process.platform !== 'win32' }, t => {
  const { root, hash, rootIdentity } = setup(t), protectedDir = path.join(root, '.github'); fs.mkdirSync(protectedDir);
  const text = 'function add(a,b) { return a - b; }\n'; fs.writeFileSync(path.join(protectedDir, 'calc.js'), text);
  fs.symlinkSync(protectedDir, path.join(root, 'safe'), 'junction');
  assert.notEqual(run(root, hash, 'safe/calc.js', rootIdentity).status, 0);
  assert.equal(fs.readFileSync(path.join(protectedDir, 'calc.js'), 'utf8'), text);
});
test('root replacement is rejected even when content is identical', { skip: process.platform !== 'win32' }, t => {
  const { root, hash, text, rootIdentity } = setup(t), old = root + '-old';
  fs.renameSync(root, old); t.after(() => fs.rmSync(old, { recursive: true, force: true }));
  fs.mkdirSync(root); fs.writeFileSync(path.join(root, 'calc.js'), text);
  assert.notEqual(run(root, hash, 'calc.js', rootIdentity).status, 0);
  assert.equal(fs.readFileSync(path.join(root, 'calc.js'), 'utf8'), text);
});
test('read rejects hardlinked files and a worktree reached through a parent junction', { skip: process.platform !== 'win32' }, t => {
  const { root } = setup(t), policy = { protectedHits: () => [] };
  fs.linkSync(path.join(root, 'calc.js'), path.join(root, 'alias.js'));
  assert.throws(() => readTarget(root, 'calc.js', policy));
  fs.unlinkSync(path.join(root, 'alias.js'));
  const container = fs.mkdtempSync(path.join(os.tmpdir(), 'checked-parent-'));
  t.after(() => fs.rmSync(container, { recursive: true, force: true }));
  fs.symlinkSync(root, path.join(container, 'rootlink'), 'junction');
  assert.throws(() => readTarget(path.join(container, 'rootlink'), 'calc.js', policy));
});
