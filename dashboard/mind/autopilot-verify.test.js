'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const guard = require('./autopilot-verify');

function repo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sym-verify-'));
  const g = (...a) => execFileSync('git', a, { cwd: dir, encoding: 'utf8' }).trim();
  g('init', '-q');
  fs.writeFileSync(path.join(dir, 'a.test.js'), "test('one', () => {});\n");
  g('add', '.'); g('-c', 'user.name=T', '-c', 'user.email=t@example.invalid', 'commit', '-qm', 'init');
  return { dir, base: g('rev-parse', 'HEAD'), cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

test('diffLint flags only ADDED lines that weaken verification', () => {
  const r = repo();
  try {
    assert.deepEqual(guard.diffLint(r.dir, r.base), []);
    fs.appendFileSync(path.join(r.dir, 'a.test.js'), "test.skip('two', () => {});\n// @ts-ignore\nconst ok = 1;\n");
    fs.writeFileSync(path.join(r.dir, 'new.test.ts'), "describe.only('x', () => {});\n");
    fs.writeFileSync(path.join(r.dir, 'notes.md'), 'it.skip( in prose is not code\n');
    const found = guard.diffLint(r.dir, r.base).sort();
    assert.deepEqual(found, ['a.test.js: test disabled or focused (.skip/.only)', 'a.test.js: type-check silenced (@ts-ignore/@ts-nocheck)',
      'new.test.ts: test disabled or focused (.skip/.only)']);
  } finally { r.cleanup(); }
});

test('protectedHits matches case-insensitively on changed and new files', () => {
  const r = repo();
  try {
    fs.mkdirSync(path.join(r.dir, 'src', 'PleinSens'), { recursive: true });
    fs.writeFileSync(path.join(r.dir, 'src', 'PleinSens', 'x.ts'), '1');
    fs.writeFileSync(path.join(r.dir, 'ok.ts'), '1');
    const files = guard.changedPaths(r.dir, r.base);
    assert.deepEqual(guard.protectedHits(files, ['^secrets/', 'pleinsens']), ['src/PleinSens/x.ts']);
    assert.throws(() => guard.compilePatterns(['(']), /Invalid protected path pattern/);
  } finally { r.cleanup(); }
});

test('junctions are created and removed without ever touching the real folder', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sym-link-'));
  try {
    const main = path.join(root, 'main'), wt = path.join(root, 'wt');
    fs.mkdirSync(path.join(main, 'node_modules', 'pkg'), { recursive: true });
    fs.writeFileSync(path.join(main, 'node_modules', 'pkg', 'index.js'), 'real');
    fs.mkdirSync(path.join(wt, 'realdir'), { recursive: true });
    fs.writeFileSync(path.join(wt, 'realdir', 'keep.txt'), 'keep');
    assert.deepEqual(guard.linkDirs(main, wt, ['node_modules', 'missing']), ['node_modules']);
    assert.equal(fs.readFileSync(path.join(wt, 'node_modules', 'pkg', 'index.js'), 'utf8'), 'real');
    assert.throws(() => guard.linkDirs(main, wt, ['../outside']), /Invalid linked directory/);
    assert.throws(() => guard.linkDirs(main, wt, ['C:/Windows']), /Invalid linked directory/);
    // A real directory listed by mistake is left alone.
    assert.deepEqual(guard.unlinkDirs(wt, ['node_modules', 'realdir']), ['node_modules']);
    assert.equal(fs.existsSync(path.join(wt, 'node_modules')), false);
    assert.equal(fs.readFileSync(path.join(wt, 'realdir', 'keep.txt'), 'utf8'), 'keep');
    assert.equal(fs.readFileSync(path.join(main, 'node_modules', 'pkg', 'index.js'), 'utf8'), 'real', 'target intact');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('runVerify stops at the first failure, reports its output and enforces timeouts', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sym-run-'));
  try {
    const ok = await guard.runVerify(dir, [{ name: 'a', cmd: ['node', '-e', 'process.exit(0)'] }, { name: 'b', cmd: ['node', '-e', 'console.log(1)'] }]);
    assert.equal(ok.ok, true);
    assert.deepEqual(ok.results.map(r => r.name), ['a', 'b']);
    const bad = await guard.runVerify(dir, [{ name: 'a', cmd: ['node', '-e', "console.error('boom 42'); process.exit(2)"] }, { name: 'never', cmd: ['node', '-e', '0'] }]);
    assert.equal(bad.ok, false);
    assert.equal(bad.results.length, 1, 'later checks are not run');
    assert.match(bad.results[0].tail, /boom 42/);
    const slow = await guard.runVerify(dir, [{ name: 'slow', cmd: ['node', '-e', 'setTimeout(() => {}, 60000)'], timeoutMs: 10000 }]);
    assert.equal(slow.results[0].timedOut, true);
    assert.equal(slow.ok, false);
    assert.throws(() => guard.validCommands([{ name: 'x', cmd: 'node x' }]), /needs \{name, cmd/);
    const missing = await guard.runVerify(dir, [{ name: 'nope', cmd: ['definitely-not-a-command-xyz'] }]);
    assert.equal(missing.ok, false);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('changedPaths also reports files hidden by .gitignore, except the links Symphonee made', () => {
  const r = repo();
  try {
    fs.writeFileSync(path.join(r.dir, '.gitignore'), 'secrets/\nnode_modules/\n');
    fs.mkdirSync(path.join(r.dir, 'secrets'));
    fs.writeFileSync(path.join(r.dir, 'secrets', 'key.txt'), 'x');
    fs.mkdirSync(path.join(r.dir, 'node_modules'));
    fs.writeFileSync(path.join(r.dir, 'node_modules', 'a.js'), '1');
    const files = guard.changedPaths(r.dir, r.base, { skip: ['node_modules'] });
    assert.ok(files.includes('secrets/'), 'ignored directory is reported: ' + files.join(','));
    assert.equal(files.some(f => f.startsWith('node_modules')), false, 'own junction is skipped');
    assert.deepEqual(guard.protectedHits(files, ['^secrets/']), ['secrets/']);
  } finally { r.cleanup(); }
});

test('a verify command may run in a sub-folder of the work tree, never outside it', async () => {
  const fs = require('fs'); const os = require('os'); const path = require('path');
  const { runVerify, validCommands } = require('./autopilot-verify');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-cwd-'));
  try {
    fs.mkdirSync(path.join(dir, 'api'));
    fs.writeFileSync(path.join(dir, 'api', 'marker.txt'), 'x');
    const ok = await runVerify(dir, [{ name: 'in-api', cwd: 'api', cmd: [process.execPath, '-e', "require('fs').accessSync('marker.txt')"] }]);
    assert.equal(ok.ok, true);
    const ko = await runVerify(dir, [{ name: 'root', cmd: [process.execPath, '-e', "require('fs').accessSync('marker.txt')"] }]);
    assert.equal(ko.ok, false, 'without cwd the command runs at the root');
    assert.throws(() => validCommands([{ name: 'x', cwd: '../evil', cmd: ['node'] }]), /Invalid/);
    assert.throws(() => validCommands([{ name: 'x', cwd: 'C:/Windows', cmd: ['node'] }]), /Invalid/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
