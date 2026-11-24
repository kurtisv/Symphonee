'use strict';
// The behaviour gate: a change to source code must come with a test that fails on the old code and passes on the change.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');
const gate = require('./behavior-gate');

const CFG = { required: true, sourceDirs: ['src/'], testCmd: [process.execPath, '--test', '{files}'], timeoutMs: 60000 };
const NL = String.fromCharCode(10);

function repo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bgate-'));
  const g = (...a) => cp.spawnSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...a], { cwd: dir, encoding: 'utf8' });
  fs.mkdirSync(path.join(dir, 'src'));
  // the bug: add() ignores the second argument
  fs.writeFileSync(path.join(dir, 'src/add.js'), 'function add(a, b) { return a }' + NL + 'module.exports = { add }' + NL);
  g('init', '-q'); g('add', '.'); g('commit', '-qm', 'base');
  return { dir, base: g('rev-parse', 'HEAD').stdout.trim(), g, clean: () => fs.rmSync(dir, { recursive: true, force: true }) };
}
const fix = (dir) => fs.writeFileSync(path.join(dir, 'src/add.js'), 'function add(a, b) { return a + b }' + NL + 'module.exports = { add }' + NL);
const behaviourTest = (dir, name = 'add.test.js') => fs.writeFileSync(path.join(dir, 'src', name),
  "const test = require('node:test'); const assert = require('node:assert/strict'); const { add } = require('./add');" + NL + "test('adds', () => { assert.equal(add(2, 3), 5) })" + NL);
const weakTest = (dir) => fs.writeFileSync(path.join(dir, 'src/weak.test.js'),
  "const test = require('node:test'); const assert = require('node:assert/strict'); const { add } = require('./add');" + NL + "test('is a function', () => { assert.equal(typeof add, 'function') })" + NL);

test('the gate is off unless required is true', () => {
  const r = repo();
  try { fix(r.dir); assert.deepEqual(gate.lint(r.dir, r.base, undefined), []); assert.deepEqual(gate.lint(r.dir, r.base, { required: false, sourceDirs: ['src/'] }), []); } finally { r.clean(); }
});

test('lint: a source change without any test file is refused, with the reason a repair prompt needs', () => {
  const r = repo();
  try {
    fix(r.dir);
    const f = gate.lint(r.dir, r.base, CFG);
    assert.equal(f.length, 1); assert.match(f[0], /BEHAVIOUR TEST REQUIRED: you changed src\/add\.js but no test file/);
    assert.match(f[0], /FAILS on the old code/); assert.match(f[0], /passing type check does not prove/);
  } finally { r.clean(); }
});

test('lint: a test file (new or edited) satisfies it; a change outside the source dirs, or tests only, is not concerned', () => {
  const r = repo();
  try {
    fix(r.dir); behaviourTest(r.dir);
    assert.deepEqual(gate.lint(r.dir, r.base, CFG), []);
  } finally { r.clean(); }
  const r2 = repo();
  try {
    fs.writeFileSync(path.join(r2.dir, 'README.md'), 'doc' + NL);
    assert.deepEqual(gate.lint(r2.dir, r2.base, CFG), [], 'a docs-only change needs no test');
    behaviourTest(r2.dir, 'only.test.js');
    assert.deepEqual(gate.lint(r2.dir, r2.base, CFG), [], 'a tests-only change is not a source change');
  } finally { r2.clean(); }
});

test('red-green: a test that fails on the old code and passes on the fix is accepted', async () => {
  const r = repo();
  try {
    fix(r.dir); behaviourTest(r.dir);
    const out = await gate.redGreen({ cwd: r.dir, base: r.base, config: CFG });
    assert.equal(out.ok, true, out.message); assert.equal(out.red, true); assert.equal(out.green, true);
    assert.match(out.message, /fail on the old code and pass on the change/);
  } finally { r.clean(); }
});

test('red-green: a test that PASSES on the old code too is refused as too weak (it does not detect the problem)', async () => {
  const r = repo();
  try {
    fix(r.dir); weakTest(r.dir);
    const out = await gate.redGreen({ cwd: r.dir, base: r.base, config: CFG });
    assert.equal(out.ok, false); assert.equal(out.red, false);
    assert.match(out.message, /BEHAVIOUR TEST TOO WEAK: src\/weak\.test\.js PASS on the old code too/);
  } finally { r.clean(); }
});

test('red-green: a test that still fails on the change is refused with its output', async () => {
  const r = repo();
  try {
    behaviourTest(r.dir); // the source is NOT fixed: the test fails on base and on the change
    fs.appendFileSync(path.join(r.dir, 'src/add.js'), '// touched' + NL);
    const out = await gate.redGreen({ cwd: r.dir, base: r.base, config: CFG });
    assert.equal(out.ok, false); assert.equal(out.green, false);
    assert.match(out.message, /BEHAVIOUR TEST FAILS on your change: src\/add\.test\.js/);
  } finally { r.clean(); }
});

test('red-green: without a test file the answer is the lint message; without a command or without source change it is skipped', async () => {
  const r = repo();
  try {
    fix(r.dir);
    assert.match((await gate.redGreen({ cwd: r.dir, base: r.base, config: CFG })).message, /BEHAVIOUR TEST REQUIRED/);
    assert.equal((await gate.redGreen({ cwd: r.dir, base: r.base, config: { ...CFG, testCmd: [] } })).skipped, true);
    assert.equal((await gate.redGreen({ cwd: r.dir, base: r.base, config: undefined })).skipped, true);
  } finally { r.clean(); }
  const r2 = repo();
  try { fs.writeFileSync(path.join(r2.dir, 'README.md'), 'x' + NL); assert.equal((await gate.redGreen({ cwd: r2.dir, base: r2.base, config: CFG })).skipped, true); } finally { r2.clean(); }
});

test('the scratch checkout is removed, and a linked folder (node_modules) is never deleted through its link', async () => {
  const r = repo();
  const shared = fs.mkdtempSync(path.join(os.tmpdir(), 'bgate-shared-'));
  try {
    fs.writeFileSync(path.join(shared, 'keep.txt'), 'must survive');
    fs.symlinkSync(shared, path.join(r.dir, 'node_modules'), 'junction');
    fix(r.dir); behaviourTest(r.dir);
    const before = fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith('behavior-gate-')).length;
    const out = await gate.redGreen({ cwd: r.dir, base: r.base, config: { ...CFG, linkDirs: ['node_modules'] } });
    assert.equal(out.ok, true, out.message);
    assert.equal(fs.readFileSync(path.join(shared, 'keep.txt'), 'utf8'), 'must survive', 'the linked folder is untouched');
    assert.equal(fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith('behavior-gate-')).length, before, 'no scratch checkout left behind');
  } finally { try { fs.rmdirSync(path.join(r.dir, 'node_modules')); } catch { /* ignore */ } fs.rmSync(shared, { recursive: true, force: true }); r.clean(); }
});

test('normalize: bad patterns are dropped, a command without {files} is ignored, links cannot leave the checkout', () => {
  const n = gate.normalize({ required: true, sourceDirs: ['src\\'], testPatterns: ['(', '\\.spec\\.js$'], testCmd: ['node', '--test'], linkDirs: ['node_modules', '../x', 'C:\\x'] });
  assert.deepEqual(n.sourceDirs, ['src/']); assert.deepEqual(n.testPatterns, ['\\.spec\\.js$']); assert.deepEqual(n.testCmd, []); assert.deepEqual(n.linkDirs, ['node_modules']);
});
