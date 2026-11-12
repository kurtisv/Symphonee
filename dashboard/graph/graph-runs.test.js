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
