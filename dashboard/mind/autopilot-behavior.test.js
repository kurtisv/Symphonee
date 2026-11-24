'use strict';
// The behaviour gate inside the real startVerify / finishVerify: no test, a weak test and a good test.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');
const { MindAutopilot } = require('./autopilot');

const NL = String.fromCharCode(10);
const BEHAVIOR = { required: true, sourceDirs: ['src/'], testCmd: [process.execPath, '--test', '{files}'], timeoutMs: 60000 };

function repo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'abh-'));
  const g = (...a) => cp.spawnSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...a], { cwd: dir, encoding: 'utf8' });
  fs.mkdirSync(path.join(dir, 'src'));
  fs.writeFileSync(path.join(dir, 'src/add.js'), 'function add(a, b) { return a }' + NL + 'module.exports = { add }' + NL);
  g('init', '-q'); g('add', '.'); g('commit', '-qm', 'base');
  return { dir, base: g('rev-parse', 'HEAD').stdout.trim(), clean: () => fs.rmSync(dir, { recursive: true, force: true }) };
}
const T = (body) => "const test = require('node:test'); const assert = require('node:assert/strict'); const { add } = require('./add');" + NL + body + NL;

function pilot(r, behavior) {
  const p = Object.create(MindAutopilot.prototype);
  const a = { stage: 'implement', plan: { title: 'Fix add' }, worktree: { path: r.dir, branch: 'x' }, baseSha: r.base, repairs: 0 };
  p.def = { verify: [{ name: 'suite', cmd: [process.execPath, '-e', 'process.exit(0)'], timeoutMs: 20000 }], linkDirs: [], protectedPaths: [], behavior: require('./behavior-gate').normalize(behavior) };
  p.state = { active: a, repoPath: r.dir + '-main', history: [] };
  p.limits = { repairs: 3 }; p.logs = []; p.lessons = []; p.dispatched = [];
  p.log = (k, m) => p.logs.push(k + ': ' + m); p.trace = () => {}; p.save = () => {}; p.learn = (k, t) => p.lessons.push(k + ': ' + t);
  p.dispatch = (stage) => { p.dispatched.push(stage); return {}; };
  p.tick = async () => { p.finishVerify(); };
  return { p, a };
}
const settle = async (a) => { for (let i = 0; i < 200 && !(a.verify && a.verify.done && a.reviewOrRepairDone !== false); i++) await new Promise((r) => setTimeout(r, 50)); await new Promise((r) => setTimeout(r, 100)); };

test('a source change with no test goes back to the repair stage with the behaviour message (the type/suite checks are not enough)', async () => {
  const r = repo();
  try {
    fs.writeFileSync(path.join(r.dir, 'src/add.js'), 'function add(a, b) { return a + b }' + NL + 'module.exports = { add }' + NL);
    const { p, a } = pilot(r, BEHAVIOR); p.startVerify(); await settle(a);
    assert.equal(a.verify.ok, false);
    assert.deepEqual(p.dispatched, ['repair']);
    assert.match(a.review, /The change has no behaviour test/); assert.match(a.review, /BEHAVIOUR TEST REQUIRED: you changed src\/add\.js/);
    assert.ok(p.lessons.some((l) => /sans test de comportement/.test(l)));
  } finally { r.clean(); }
});

test('a test that also passes on the old code is refused as too weak', async () => {
  const r = repo();
  try {
    fs.writeFileSync(path.join(r.dir, 'src/add.js'), 'function add(a, b) { return a + b }' + NL + 'module.exports = { add }' + NL);
    fs.writeFileSync(path.join(r.dir, 'src/weak.test.js'), T("test('is a function', () => { assert.equal(typeof add, 'function') })"));
    const { p, a } = pilot(r, BEHAVIOR); p.startVerify(); await settle(a);
    assert.equal(a.verify.ok, false);
    assert.equal(a.verify.results.at(-1).name, 'behavior-red-green');
    assert.match(a.review, /Check "behavior-red-green" failed/); assert.match(a.review, /BEHAVIOUR TEST TOO WEAK/);
    assert.deepEqual(p.dispatched, ['repair']);
  } finally { r.clean(); }
});

test('a test that fails before and passes after goes on to the independent review', async () => {
  const r = repo();
  try {
    fs.writeFileSync(path.join(r.dir, 'src/add.js'), 'function add(a, b) { return a + b }' + NL + 'module.exports = { add }' + NL);
    fs.writeFileSync(path.join(r.dir, 'src/add.test.js'), T("test('adds', () => { assert.equal(add(2, 3), 5) })"));
    const { p, a } = pilot(r, BEHAVIOR); p.startVerify(); await settle(a);
    assert.equal(a.verify.ok, true, JSON.stringify(a.verify.results.at(-1)));
    assert.deepEqual(p.dispatched, ['code-review']);
    assert.ok(p.logs.some((l) => /Behaviour gate PASSED/.test(l)));
  } finally { r.clean(); }
});

test('without a behaviour section nothing changes: the same weak change still reaches the review', async () => {
  const r = repo();
  try {
    fs.writeFileSync(path.join(r.dir, 'src/add.js'), 'function add(a, b) { return a + b }' + NL + 'module.exports = { add }' + NL);
    const { p, a } = pilot(r, undefined); p.startVerify(); await settle(a);
    assert.equal(a.verify.ok, true); assert.deepEqual(p.dispatched, ['code-review']);
  } finally { r.clean(); }
});

test('a pilot with the gate required but NO ordinary check command is still gated (no bypass)', async () => {
  const r = repo();
  try {
    fs.writeFileSync(path.join(r.dir, 'src/add.js'), 'function add(a, b) { return a + b }' + NL + 'module.exports = { add }' + NL);
    fs.writeFileSync(path.join(r.dir, 'src/weak.test.js'), T("test('is a function', () => { assert.equal(typeof add, 'function') })"));
    const { p, a } = pilot(r, BEHAVIOR); p.def.verify = []; p.startVerify(); await settle(a);
    assert.equal(a.verify.ok, false); assert.equal(a.verify.results.at(-1).name, 'behavior-red-green'); assert.deepEqual(p.dispatched, ['repair']);
  } finally { r.clean(); }
});

test('a required gate without sourceDirs refuses every change with the reason instead of silently passing', async () => {
  const r = repo();
  try {
    fs.writeFileSync(path.join(r.dir, 'src/add.js'), 'function add(a, b) { return a + b }' + NL + 'module.exports = { add }' + NL);
    const { p, a } = pilot(r, { required: true, testCmd: BEHAVIOR.testCmd }); p.startVerify(); await settle(a);
    assert.equal(a.verify.ok, false); assert.match(a.review, /BEHAVIOUR GATE MISCONFIGURED/); assert.deepEqual(p.dispatched, ['repair']);
  } finally { r.clean(); }
});
