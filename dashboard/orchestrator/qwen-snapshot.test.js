'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { snapshotFiles, validateProposal, assertSourceUnchanged } = require('./qwen-snapshot');

test('copies selected files and accepts a bounded proposal without changing the source', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-snapshot-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'app.js'), 'old');
  fs.writeFileSync(path.join(dir, 'test.js'), 'test');
  const before = snapshotFiles(dir, ['app.js', 'test.js']);
  const after = before.map(x => ({ ...x }));
  after[0].content = Buffer.from('new').toString('base64');
  assert.deepEqual(validateProposal(before, after, ['app.js']).map(x => x.path), ['app.js']);
  assert.equal(fs.readFileSync(path.join(dir, 'app.js'), 'utf8'), 'old');
  assert.throws(() => validateProposal(before, after, []), /outside allowed/);
  after[1].path = '../outside';
  assert.throws(() => validateProposal(before, after, ['app.js']), /Invalid relative/);
});

test('source modifications and replacement by a junction are rejected', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-snapshot-'));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-outside-'));
  t.after(() => { fs.rmSync(dir, { recursive: true, force: true }); fs.rmSync(outside, { recursive: true, force: true }); });
  fs.mkdirSync(path.join(dir, 'src')); fs.writeFileSync(path.join(dir, 'src', 'x.js'), 'old');
  const original = snapshotFiles(dir, ['src/x.js']); const root = fs.realpathSync(dir);
  fs.writeFileSync(path.join(dir, 'src', 'x.js'), 'new');
  assert.throws(() => assertSourceUnchanged(dir, original, root), /Source changed/);
  fs.rmSync(path.join(dir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(outside, 'x.js'), 'old');
  fs.symlinkSync(outside, path.join(dir, 'src'), 'junction');
  assert.throws(() => snapshotFiles(dir, ['src/x.js']), /Links are not allowed/);
});

test('rejects paths that could leave or alias the selection', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-snapshot-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'app.js'), 'old');
  for (const p of ['../x', '/x', 'C:/x', 'dir\\x', 'app.js:stream', 'x./z', '.git/config', 'CON.js', 'x\ny.js']) {
    assert.throws(() => snapshotFiles(dir, [p]));
  }
  assert.throws(() => snapshotFiles(dir, ['app.js', 'APP.JS']));
});

test('Qwen3 Docker provider is local, never auto-routed and fails closed', () => {
  const providers = require('./local-providers');
  const { spawnHeadless } = require('./spawn-headless');
  assert.equal(providers.providerLocality('qwen3-4b-docker'), 'local');
  assert.deepEqual(providers.routedTaskClasses('qwen3-4b-docker', {}), []);
  assert.throws(() => spawnHeadless.call({}, { cli: 'qwen3-4b-docker' }), /disabled until/);
});

test('API rejects the disabled provider before local preparation or paid fallback', async () => {
  const { registerOrchestratorRoutes } = require('./routes');
  const handlers = {};
  let launches = 0;
  const orch = { spawnHeadless() { launches++; }, localHealth: { refresh() { launches++; } } };
  registerOrchestratorRoutes((method, route, handler) => { handlers[method + ' ' + route] = handler; },
    (res, data, status) => { res.data = data; res.status = status || 200; }, orch,
    { getConfig: () => ({}), broadcast: () => {}, getUiContext: () => ({}), repoRoot: os.tmpdir() });
  const body = JSON.stringify({ cli: 'qwen3-4b-docker', prompt: 'fix a test' });
  const req = { on(event, fn) { if (event === 'data') fn(Buffer.from(body)); if (event === 'end') fn(); return this; } };
  const res = {};
  await handlers['POST /api/orchestrator/spawn'](req, res);
  assert.equal(res.status, 503);
  assert.equal(launches, 0);
});
