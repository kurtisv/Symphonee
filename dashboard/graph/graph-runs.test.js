'use strict';
// Engine-level test against a fake Symphonee API: a worker node's timeoutMs
// must reach /api/orchestrator/spawn as workerTimeoutMs (without it a cloud
// worker is cut at the 15 min task-store default), and a node without one
// must not send the field.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { GraphRunsEngine } = require('./graph-runs');

test('worker node timeoutMs is forwarded to the spawn as workerTimeoutMs', async () => {
  const spawns = [];
  const server = http.createServer((req, res) => {
    let s = '';
    req.on('data', (c) => { s += c; });
    req.on('end', () => {
      res.setHeader('Content-Type', 'application/json');
      if (req.method === 'POST' && req.url === '/api/orchestrator/spawn') {
        spawns.push(JSON.parse(s));
        return res.end(JSON.stringify({ id: 'task-' + spawns.length }));
      }
      if (req.method === 'GET' && req.url.startsWith('/api/orchestrator/task')) {
        return res.end(JSON.stringify({ state: 'completed', result: 'ok' }));
      }
      res.statusCode = 404; res.end('{}');
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sym-graph-'));
  try {
    const engine = new GraphRunsEngine({ repoRoot, apiHost: '127.0.0.1', apiPort: server.address().port });
    const done = new Promise((resolve) => engine.on('run-updated', (r) => {
      if (['completed', 'failed'].includes(r.status)) resolve(r);
    }));
    engine.createRun({
      name: 't', state: {}, nodes: [
        { id: 'long', type: 'worker', cli: 'codex', noFallback: true, prompt: 'a', timeoutMs: 4 * 3600000 },
        { id: 'short', type: 'worker', cli: 'codex', noFallback: true, prompt: 'b', dependsOn: ['long'] },
      ],
    });
    const run = await done;
    assert.equal(run.status, 'completed');
    assert.equal(spawns.length, 2);
    assert.equal(spawns[0].workerTimeoutMs, 4 * 3600000);
    assert.equal('workerTimeoutMs' in spawns[1], false);
  } finally {
    server.close();
    fs.rmSync(repoRoot, { recursive: true, force: true });
  }
});

// ── Work windows ──────────────────────────────────────────────────────
function fakeApi() {
  const calls = { spawns: [], cancels: [] };
  let taskState = 'completed';
  const server = http.createServer((req, res) => {
    let s = '';
    req.on('data', (c) => { s += c; });
    req.on('end', () => {
      res.setHeader('Content-Type', 'application/json');
      if (req.method === 'POST' && req.url === '/api/orchestrator/spawn') { calls.spawns.push(JSON.parse(s)); return res.end(JSON.stringify({ id: 'task-' + calls.spawns.length })); }
      if (req.method === 'POST' && req.url === '/api/orchestrator/cancel') { calls.cancels.push(JSON.parse(s)); return res.end('{"ok":true}'); }
      if (req.method === 'GET' && req.url.startsWith('/api/orchestrator/task')) return res.end(JSON.stringify({ state: taskState, result: 'ok' }));
      res.statusCode = 404; res.end('{}');
    });
  });
  return { server, calls, setTaskState: (v) => { taskState = v; },
    listen: () => new Promise((r) => server.listen(0, '127.0.0.1', r)), port: () => server.address().port };
}
const OPEN = { canStart: true, inHard: true, msToHardEnd: 4 * 3600000, nextStart: Date.now() + 86400000 };
const CLOSED = { canStart: false, inHard: false, msToHardEnd: 0, nextStart: Date.now() + 3600000 };
const waitFor = async (pred, ms = 8000) => { const t0 = Date.now(); while (!pred()) { if (Date.now() - t0 > ms) throw new Error('timeout'); await new Promise(r => setTimeout(r, 50)); } };
const SCHED = { start: '08:00', end: '13:00', hardEnd: '14:00' };

test('outside its window a run starts nothing, waits, and runs when the window opens', async () => {
  const api = fakeApi(); await api.listen();
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sym-graph-'));
  try {
    const engine = new GraphRunsEngine({ repoRoot, apiPort: api.port() });
    let w = CLOSED; engine.windowStateFn = () => w;
    const run = await engine.createRun({ name: 'w', schedule: SCHED, nodes: [{ id: 'a', type: 'worker', cli: 'codex', noFallback: true, prompt: 'a' }] });
    await waitFor(() => run.waitingWindow);
    assert.equal(api.calls.spawns.length, 0, 'nothing spawned outside the window');
    assert.equal(run.status, 'pending');
    w = OPEN;
    await engine._executeNextBatch(run.id);
    assert.equal(api.calls.spawns.length, 1);
    assert.equal(run.status, 'completed');
    assert.equal(run.waitingWindow, undefined);
    for (const t of engine.windowTimers.values()) clearTimeout(t);
  } finally { api.server.close(); fs.rmSync(repoRoot, { recursive: true, force: true }); }
});

test('a node needing more time than is left before hardEnd does not start', async () => {
  const api = fakeApi(); await api.listen();
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sym-graph-'));
  try {
    const engine = new GraphRunsEngine({ repoRoot, apiPort: api.port() });
    engine.windowStateFn = () => ({ ...OPEN, msToHardEnd: 3600000 });
    const run = await engine.createRun({ name: 'w', schedule: SCHED, nodes: [{ id: 'long', type: 'worker', cli: 'codex', noFallback: true, prompt: 'a', minWindowMs: 3 * 3600000 }] });
    await waitFor(() => run.waitingWindow);
    assert.equal(api.calls.spawns.length, 0, 'one hour left, three needed: waits for the next window');
    for (const t of engine.windowTimers.values()) clearTimeout(t);
  } finally { api.server.close(); fs.rmSync(repoRoot, { recursive: true, force: true }); }
});

test('at hardEnd a running node is stopped, re-queued (not failed) and the run waits', async () => {
  const api = fakeApi(); await api.listen(); api.setTaskState('running');
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sym-graph-'));
  try {
    const engine = new GraphRunsEngine({ repoRoot, apiPort: api.port() });
    let w = OPEN; engine.windowStateFn = () => w;
    const run = await engine.createRun({ name: 'w', schedule: SCHED, nodes: [{ id: 'a', type: 'worker', cli: 'codex', noFallback: true, prompt: 'a' }] });
    await waitFor(() => api.calls.spawns.length === 1);
    w = CLOSED;
    await waitFor(() => run.waitingWindow, 10000);
    const node = run.nodes[0];
    assert.deepEqual(api.calls.cancels, [{ taskId: 'task-1' }], 'the worker task was cancelled');
    assert.equal(node.status, 'pending');
    assert.equal(node.windowStops, 1);
    assert.equal(node.error, null);
    assert.notEqual(run.status, 'failed');
    for (const t of engine.windowTimers.values()) clearTimeout(t);
  } finally { api.server.close(); fs.rmSync(repoRoot, { recursive: true, force: true }); }
});

test('after a restart a waiting run is resumed and runs once its window is open', async () => {
  const api = fakeApi(); await api.listen();
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sym-graph-'));
  try {
    const e1 = new GraphRunsEngine({ repoRoot, apiPort: api.port() });
    e1.windowStateFn = () => CLOSED;
    const run = await e1.createRun({ name: 'w', schedule: SCHED, nodes: [{ id: 'a', type: 'worker', cli: 'codex', noFallback: true, prompt: 'a' }] });
    await waitFor(() => run.waitingWindow);
    for (const t of e1.windowTimers.values()) clearTimeout(t);
    // New server process: the run is loaded from disk and its window re-checked.
    const e2 = new GraphRunsEngine({ repoRoot, apiPort: api.port() });
    e2.windowStateFn = () => OPEN; // set before the deferred resume runs
    await waitFor(() => (e2.runs.get(run.id) || {}).status === 'completed');
    assert.equal(api.calls.spawns.length, 1);
  } finally { api.server.close(); fs.rmSync(repoRoot, { recursive: true, force: true }); }
});

test('an invalid schedule is refused at creation', async () => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sym-graph-'));
  try {
    const engine = new GraphRunsEngine({ repoRoot, apiPort: 1 });
    await assert.rejects(engine.createRun({ name: 'x', schedule: { start: '13:00', end: '08:00', hardEnd: '07:00' }, nodes: [] }), /hardEnd/);
  } finally { fs.rmSync(repoRoot, { recursive: true, force: true }); }
});

// ── Dropped connections and adopting a finished task ──────────────────
test('a dropped poll connection does not fail the node; a failed node adopts its finished task', async () => {
  let resets = 2, polls = 0, hang = 0; // hang = n: cut the n-th next poll
  const spawns = [];
  let taskState = 'completed';
  const owners = {}; // taskId -> from
  const server = http.createServer((req, res) => {
    let s = ''; req.on('data', (c) => { s += c; });
    req.on('end', () => {
      if (req.method === 'POST' && req.url === '/api/orchestrator/spawn') { spawns.push(JSON.parse(s)); return res.end(JSON.stringify({ id: 'task-' + spawns.length })); }
      if (req.url.startsWith('/api/orchestrator/task')) {
        polls++;
        if (resets > 0) { resets--; return req.socket.destroy(); } // ECONNRESET / socket hang up
        const id = decodeURIComponent(req.url.split('id=')[1]);
        if (hang && --hang === 0) { res.writeHead(200); res.write('{"sta'); return setTimeout(() => req.socket.destroy(), 50); } // cut after headers
        return res.end(JSON.stringify({ state: taskState, result: 'done ' + id, from: owners[id] || null }));
      }
      res.statusCode = 404; res.end('{}');
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sym-graph-'));
  try {
    const engine = new GraphRunsEngine({ repoRoot, apiPort: server.address().port });
    const run = await engine.createRun({ name: 'n', nodes: [{ id: 'a', type: 'worker', cli: 'codex', noFallback: true, prompt: 'a' }] });
    await waitFor(() => ['completed', 'failed'].includes(run.status), 15000);
    assert.equal(run.nodes[0].status, 'completed', 'two dropped polls, then the result');
    assert.equal(run.nodes[0].taskId, 'task-1');

    taskState = 'failed';
    const r2 = await engine.createRun({ name: 'm', nodes: [{ id: 'b', type: 'worker', cli: 'codex', noFallback: true, prompt: 'b' }] });
    await waitFor(() => r2.nodes[0].status === 'failed', 15000);
    taskState = 'completed';
    await assert.rejects(engine.retryNode(r2.id, 'b', { taskId: 'bad id!' }), /invalid taskId/);
    owners['task-foreign'] = 'main';
    await assert.rejects(engine.retryNode(r2.id, 'b', { taskId: 'task-foreign' }), /was not spawned by run/);
    owners['task-old'] = 'graph-run:' + r2.id;
    r2.nodes[0].taskId = null; // pre-fix node: no recorded taskId
    hang = 2; // ownership check passes, then the first adopted poll is cut after its headers: must not freeze
    await engine.retryNode(r2.id, 'b', { taskId: 'task-old' });
    await waitFor(() => r2.status === 'completed', 15000);
    assert.equal(spawns.length, 2, 'the adopted task was not spawned again');
    assert.equal(r2.nodes[0].output.result, 'done task-old');
    assert.equal(r2.nodes[0].adoptTaskId, undefined, 'cleared once the node settled');
    await assert.rejects(engine.retryNode(r2.id, 'b'), /run is completed/);
  } finally { server.close(); fs.rmSync(repoRoot, { recursive: true, force: true }); }
});

test('a pending node keeps its adopted task across a restart', async () => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sym-graph-'));
  const spawns = [];
  const server = http.createServer((req, res) => {
    let s = ''; req.on('data', (c) => { s += c; });
    req.on('end', () => {
      if (req.url === '/api/orchestrator/spawn') { spawns.push(1); return res.end('{"id":"new"}'); }
      return res.end(JSON.stringify({ state: 'completed', result: 'r ' + req.url.split('id=')[1] }));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    const e1 = new GraphRunsEngine({ repoRoot, apiPort: server.address().port });
    e1.windowStateFn = () => CLOSED;
    const run = await e1.createRun({ name: 'p', schedule: SCHED, nodes: [{ id: 'a', type: 'worker', cli: 'codex', noFallback: true, prompt: 'a' }] });
    await waitFor(() => run.waitingWindow);
    run.nodes[0].adoptTaskId = 'kept1'; e1._persist(run);
    for (const t of e1.windowTimers.values()) clearTimeout(t);
    const e2 = new GraphRunsEngine({ repoRoot, apiPort: server.address().port });
    e2.windowStateFn = () => OPEN;
    await e2._executeNextBatch(run.id);
    const r = e2.getRun(run.id);
    assert.equal(spawns.length, 0, 'no new worker after the restart');
    assert.equal(r.nodes[0].output.result, 'r kept1');
    for (const t of e2.windowTimers.values()) clearTimeout(t);
  } finally { server.close(); fs.rmSync(repoRoot, { recursive: true, force: true }); }
});

test('a run definition cannot pre-set an adopted task; a hardEnd stop drops the adoption', async () => {
  const api = fakeApi(); await api.listen();
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sym-graph-'));
  try {
    const engine = new GraphRunsEngine({ repoRoot, apiPort: api.port() });
    const run = await engine.createRun({ name: 'x', nodes: [{ id: 'a', type: 'worker', cli: 'codex', noFallback: true, prompt: 'a', adoptTaskId: 'foreign', taskId: 'foreign' }] });
    await waitFor(() => run.status === 'completed');
    assert.equal(api.calls.spawns.length, 1, 'a real worker was spawned, the foreign task ignored');
    assert.equal(run.nodes[0].taskId, 'task-1');

    api.setTaskState('running');
    let w = OPEN;
    engine.windowStateFn = () => w;
    const r2 = await engine.createRun({ name: 'y', schedule: SCHED, nodes: [{ id: 'b', type: 'worker', cli: 'codex', noFallback: true, prompt: 'b' }] });
    await waitFor(() => r2.nodes[0].status === 'running');
    r2.nodes[0].adoptTaskId = r2.nodes[0].taskId || 'task-2';
    w = { ...CLOSED, inHard: false };
    await waitFor(() => r2.nodes[0].status === 'pending' && r2.nodes[0].windowStops === 1);
    assert.equal(r2.nodes[0].adoptTaskId, undefined, 'the cancelled task is not adopted next window');
    for (const t of engine.windowTimers.values()) clearTimeout(t);
  } finally { api.server.close(); fs.rmSync(repoRoot, { recursive: true, force: true }); }
});
