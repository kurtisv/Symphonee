'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');
const guard = require('./autopilot-verify');
const { proofBeforeAfter, testFilesOf, commandFor, plan } = require('./autopilot-proof');
delete process.env.NODE_TEST_CONTEXT; // the nested `node --test` below must really run

const sh = (cwd, ...a) => cp.execFileSync('git', ['-C', cwd, ...a], { encoding: 'utf8' }).trim();
const VERIFY = [{ name: 'tests', cmd: [process.execPath, '--test'], timeoutMs: 60000 }];
function repo(t) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'sym-proof-')); t.after(() => { try { cp.execFileSync('git', ['-C', d, 'worktree', 'prune']); } catch (_) {} fs.rmSync(d, { recursive: true, force: true }); });
  sh(d, 'init', '-q'); sh(d, 'config', 'user.email', 'a@b.invalid'); sh(d, 'config', 'user.name', 'a');
  fs.writeFileSync(path.join(d, 'price.js'), 'exports.fmt = (x) => x.toFixed(1);\n'); // the defect: one decimal instead of two
  sh(d, 'add', '-A'); sh(d, 'commit', '-qm', 'base');
  return { dir: d, base: sh(d, 'rev-parse', 'HEAD') };
}
// the fix worktree: a copy of the repository at the base, then the change under test
function fixWorktree(t, r, changes) {
  const w = path.join(os.tmpdir(), 'sym-fix-' + Math.random().toString(16).slice(2, 8)); sh(r.dir, 'worktree', 'add', '--detach', w, r.base);
  t.after(() => { try { sh(r.dir, 'worktree', 'remove', '--force', w); } catch (_) {} });
  for (const [f, c] of Object.entries(changes)) { fs.mkdirSync(path.dirname(path.join(w, f)), { recursive: true }); fs.writeFileSync(path.join(w, f), c); }
  return w;
}
const opts = (r, w, over = {}) => ({ enabled: true, category: 'correctness', cwd: w, base: r.base, repoPath: r.dir, linkDirs: [], verify: VERIFY, runVerify: guard.runVerify, guard, changed: ['price.js', 'price.test.js'], ...over });
const TEST = "const test = require('node:test'); const assert = require('node:assert/strict'); const { fmt } = require('./price.js'); test('two decimals', () => assert.equal(fmt(1.5), '1.50'));\n";
const FIX = 'exports.fmt = (x) => x.toFixed(2);\n';

test('a real fix with a real regression test: red before, green after', async (t) => {
  const r = repo(t), w = fixWorktree(t, r, { 'price.js': FIX, 'price.test.js': TEST });
  const out = await proofBeforeAfter(opts(r, w));
  assert.equal(out.ok, true, JSON.stringify(out)); assert.deepEqual([out.proofRun.failsBefore, out.proofRun.passesAfter], [true, true]); assert.deepEqual(out.proofRun.files, ['price.test.js']);
  assert.match(sh(r.dir, 'worktree', 'list'), /sym-fix-/, 'only the fix worktree is left'); assert.doesNotMatch(sh(r.dir, 'worktree', 'list'), /preuve-/, 'the temporary proof worktree is removed');
});

test('a test that PASSES on the unfixed code proves nothing: refused', async (t) => {
  const r = repo(t), w = fixWorktree(t, r, { 'price.js': FIX, 'price.test.js': "const test = require('node:test'); const assert = require('node:assert/strict'); const { fmt } = require('./price.js'); test('is a string', () => assert.equal(typeof fmt(1.5), 'string'));\n" });
  const out = await proofBeforeAfter(opts(r, w));
  assert.equal(out.ok, false); assert.match(out.result.tail, /PASS on the unfixed code/); assert.equal(out.result.name, 'preuve-avant-apres');
});

test('a test that still FAILS on the fixed code is refused', async (t) => {
  const r = repo(t), w = fixWorktree(t, r, { 'price.js': 'exports.fmt = (x) => x.toFixed(3);\n', 'price.test.js': TEST });
  const out = await proofBeforeAfter(opts(r, w));
  assert.equal(out.ok, false); assert.match(out.proofRun.why, /FAIL on the fixed code/);
});

test('no test file in the change: refused; only a defect (category correctness) needs the proof; off unless asked', async (t) => {
  const r = repo(t), w = fixWorktree(t, r, { 'price.js': FIX });
  const none = await proofBeforeAfter(opts(r, w, { changed: ['price.js'] }));
  assert.equal(none.ok, false); assert.match(none.result.tail, /adds or modifies no test file/);
  assert.equal(await proofBeforeAfter(opts(r, w, { category: 'quality', changed: ['price.js'] })), null, 'a refactor needs no failing test');
  assert.equal(await proofBeforeAfter(opts(r, w, { enabled: false, changed: ['price.js'] })), null, 'switched off in the definition');
});

test('a test that cannot even run on the unfixed code (syntax error) is not accepted as a red proof', async (t) => {
  const r = repo(t), w = fixWorktree(t, r, { 'price.js': FIX, 'price.test.js': 'this is not javascript (((\n' });
  const out = await proofBeforeAfter(opts(r, w));
  assert.equal(out.ok, false); assert.match(out.proofRun.why, /could not be run on the unfixed code|PASS|FAIL/);
});

test('helpers: which files are tests, and the repository command that runs them (sub-packages run in their own folder)', () => {
  assert.deepEqual(testFilesOf(['src/a.ts', 'src/a.test.ts', 'api/src/__tests__/b.ts', 'x\\y.spec.js', 'README.md']), ['src/a.test.ts', 'api/src/__tests__/b.ts', 'x/y.spec.js']);
  const verify = [{ name: 'jest', cmd: ['node', 'node_modules/jest/bin/jest.js', '--ci'] }, { name: 'jest-api', cwd: 'api', cmd: ['node', 'node_modules/jest/bin/jest.js', '--ci'] }];
  assert.deepEqual(commandFor(verify, 'src/a.test.ts').cwd, ''); const api = commandFor(verify, 'api/src/__tests__/b.test.ts'); assert.deepEqual([api.cwd, api.rel], ['api', 'src/__tests__/b.test.ts']);
  assert.equal(commandFor([{ name: 'types', cmd: ['tsc'] }], 'a.test.ts'), null);
  assert.match(plan([{ name: 'types', cmd: ['tsc'] }], ['a.test.ts']).error, /no repository test command/);
});
