'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { mountJobs } = require('./jobs-scheduler');

function mount() {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sym-jobs-'));
  const routes = {};
  const addRoute = (m, p, h) => { routes[m + ' ' + p] = h; };
  const json = (res, body) => { res.body = body; };
  let spawned = 0;
  const api = mountJobs(addRoute, json, { repoRoot, orchestrator: { spawnHeadless: () => ({ id: 'ai-' + (++spawned) }) }, broadcast: () => {} });
  const post = (p, body) => new Promise((resolve) => {
    const req = new (require('events'))(); const res = { writeHead(c) { this.code = c; }, end(b) { this.raw = b; resolve(this); } };
    routes['POST ' + p](req, res).then(() => resolve(res));
    setImmediate(() => { req.emit('data', JSON.stringify(body)); req.emit('end'); });
  });
  return { repoRoot, api, post, spawned: () => spawned, cleanup: () => fs.rmSync(repoRoot, { recursive: true, force: true }) };
}
const waitFor = async (pred, ms = 10000) => { const t0 = Date.now(); while (!pred()) { if (Date.now() - t0 > ms) throw new Error('timeout'); await new Promise(r => setTimeout(r, 50)); } };

test('a script job runs node directly, without any AI CLI, and keeps its exit code and output', async () => {
  const m = mount();
  try {
    const script = path.join(m.repoRoot, 'ok.js');
    fs.writeFileSync(script, "console.log('LANCEUR HORS_FENETRE ' + process.argv[2]);");
    const res = await m.post('/api/jobs', { name: 's', kind: 'script', script, args: ['x'], schedule: 'daily 08:00' });
    const job = res.body;
    assert.equal(job.kind, 'script');
    const id = await m.api.runJob(job);
    assert.match(id, /^script:/);
    assert.equal(m.spawned(), 0, 'no AI CLI spawned');
    await waitFor(() => (m.api.readJobs()[0].lastRun || {}).status !== 'running');
    const last = m.api.readJobs()[0].lastRun;
    assert.equal(last.status, 'ok'); assert.equal(last.exitCode, 0);
    assert.match(last.tail, /LANCEUR HORS_FENETRE x/);
  } finally { m.cleanup(); }
});

test('a failing script is recorded as error; a running script is never started twice', async () => {
  const m = mount();
  try {
    const slow = path.join(m.repoRoot, 'slow.js');
    fs.writeFileSync(slow, "setTimeout(() => { console.error('boom'); process.exit(3); }, 400);");
    const job = (await m.post('/api/jobs', { name: 's', kind: 'script', script: slow, schedule: 'every 30m' })).body;
    assert.ok(await m.api.runJob(job));
    assert.equal(await m.api.runJob(m.api.readJobs()[0]), null, 'second start refused while the first runs');
    await waitFor(() => (m.api.readJobs()[0].lastRun || {}).status !== 'running');
    const last = m.api.readJobs()[0].lastRun;
    assert.equal(last.status, 'error'); assert.equal(last.exitCode, 3); assert.match(last.tail, /boom/);
  } finally { m.cleanup(); }
});

test('script jobs are validated: absolute existing .js path, string args', async () => {
  const m = mount();
  try {
    let r = await m.post('/api/jobs', { name: 's', kind: 'script', script: 'relative.js', schedule: 'daily 08:00' });
    assert.equal(r.code, 400);
    r = await m.post('/api/jobs', { name: 's', kind: 'script', script: path.join(m.repoRoot, 'missing.js'), schedule: 'daily 08:00' });
    assert.equal(r.code, 400);
    const ok = path.join(m.repoRoot, 'a.js'); fs.writeFileSync(ok, '');
    r = await m.post('/api/jobs', { name: 's', kind: 'script', script: ok, args: [1], schedule: 'daily 08:00' });
    assert.equal(r.code, 400);
    // An AI job still needs its prompt.
    r = await m.post('/api/jobs', { name: 'ai', schedule: 'daily 08:00' });
    assert.equal(r.code, 400);
  } finally { m.cleanup(); }
});
