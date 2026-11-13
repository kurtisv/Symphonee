'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { autopilotLoop, pleinsensLoop, gateService, watchdogService } = require('./loops-status');

const NOW = new Date(2026, 10, 12, 21, 50).getTime();
const at = (h, m = 0, dayOffset = 0) => new Date(2026, 10, 12 + dayOffset, h, m).getTime();

test('autopilot: resting until its window, working with its stage, stopped, error', () => {
  const base = { pilot: 'gas-saver', enabled: true, schedule: { start: '22:00', end: '04:00' }, nextAt: at(22) };
  let l = autopilotLoop(base, 'Autopilote Gas Saver', NOW);
  assert.equal(l.status, 'resting'); assert.equal(l.window, '22:00-04:00'); assert.match(l.detail, /Prochaine tache 22:00/);
  l = autopilotLoop({ ...base, active: { stage: 'implement', taskId: 't1', plan: { title: 'Corriger X' } } }, 'A', NOW);
  assert.equal(l.status, 'working'); assert.equal(l.cli, 'claude'); assert.equal(l.taskId, 't1'); assert.match(l.detail, /implementation.*Corriger X/);
  l = autopilotLoop({ ...base, active: { stage: 'budget-wait', waitingStage: 'code-review', parkReason: 'window' }, nextAt: at(22, 0, 1) }, 'A', NOW);
  assert.equal(l.status, 'resting'); assert.match(l.detail, /revue du code.*reprend demain 22:00 \(fin de plage\)/);
  assert.equal(autopilotLoop({ ...base, enabled: false }, 'A', NOW).status, 'stopped');
  assert.equal(autopilotLoop({ ...base, error: 'boom' }, 'A', NOW).status, 'error');
});

test('PleinSens: next launch, running node, waiting for its window, stop line', () => {
  const job = { enabled: true, nextRun: at(8, 0, 1) };
  let l = pleinsensLoop(null, job, '2026-11-12T21:40:05Z LANCEUR HORS_FENETRE', NOW);
  assert.equal(l.status, 'resting'); assert.match(l.detail, /Prochain lancement demain 08:00/);
  const run = { state: { cycle: 1 }, nodes: [{ id: 'c1-conception', status: 'running', cli: 'codex' }, { id: 'x', status: 'pending' }] };
  l = pleinsensLoop(run, job, '', NOW);
  assert.equal(l.status, 'working'); assert.equal(l.cli, 'codex'); assert.match(l.detail, /Cycle 1 : c1-conception \(0\/2/);
  l = pleinsensLoop({ ...run, nodes: [{ id: 'a', status: 'completed' }, { id: 'b', status: 'pending' }], waitingWindow: { until: at(8, 0, 1) } }, job, '', NOW);
  assert.equal(l.status, 'resting'); assert.match(l.detail, /\(1\/2\) reprend demain 08:00/);
  l = pleinsensLoop(null, job, '2026-11-13T13:00:00Z LANCEUR ARRET_403 gr_x', NOW);
  assert.equal(l.status, 'error'); assert.match(l.detail, /^ARRET_403/);
});

test('services: merge gate and watchdog', () => {
  const job = { enabled: true, nextRun: at(22, 10), lastRun: { status: 'running' } };
  assert.equal(gateService(job, { candidates: { k: { status: 'new' } } }, NOW).status, 'working');
  assert.match(gateService({ ...job, lastRun: { status: 'ok' } }, {}, NOW).detail, /Prochain passage 22:10 ; aucune branche/);
  assert.equal(gateService(job, { stopped: { reason: 'CI rouge' } }, NOW).status, 'error');
  assert.equal(watchdogService(new Date(NOW - 5 * 60000).toISOString() + ' VEILLE ok', NOW).status, 'resting');
  assert.equal(watchdogService(new Date(NOW - 40 * 60000).toISOString() + ' VEILLE ok', NOW).status, 'error');
  assert.equal(watchdogService('', NOW).status, 'stopped');
});

test('detail views: graph run nodes and merge gate candidates', () => {
  const { runView, gateView } = require('./loops-status');
  const v = runView({ id: 'gr_1', name: 'PleinSens boucle predictions - cycle 1', status: 'running', createdAt: 1, state: { cycle: 1 },
    nodes: [{ id: 'a', type: 'worker', status: 'completed', cli: 'codex', model: 'm', taskId: 't1', output: { result: 'x'.repeat(900) + 'FIN' } },
      { id: 'b', type: 'worker', status: 'failed', cli: 'claude', error: 'read ECONNRESET' }] });
  assert.equal(v.cycle, 1); assert.equal(v.nodes[0].taskId, 't1');
  assert.ok(v.nodes[0].result.endsWith('FIN') && v.nodes[0].result.length <= 603, 'result tail, bounded');
  assert.equal(v.nodes[1].error, 'read ECONNRESET'); assert.equal(v.nodes[1].result, null);
  const g = gateView({ candidates: { k1: { branch: 'b1', sha: 'a'.repeat(40), status: 'new', createdAt: 1, origin: { title: 'T' }, history: [{ note: 'n1' }] },
    k2: { branch: 'b2', sha: 'b'.repeat(40), status: 'refused', createdAt: 2, history: [] } }, merges: [] });
  assert.deepEqual(g.candidates.map((c) => c.branch), ['b2', 'b1']);
  assert.equal(g.candidates[1].sha, 'aaaaaaaaaa'); assert.equal(g.candidates[1].note, 'n1'); assert.equal(g.candidates[1].title, 'T');
  assert.deepEqual(gateView(null).candidates, []);
});

test('detail route builder: only known loops, constant files, runs from the API', async () => {
  const http = require('http'); const fs = require('fs'); const os = require('os'); const path = require('path');
  const { buildLoopDetail } = require('./loops-status');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loops-'));
  fs.mkdirSync(path.join(root, '.ai-workspace'), { recursive: true });
  fs.writeFileSync(path.join(root, '.ai-workspace', 'boucle-lanceur.log'), 'l1\nl2\n');
  const srv = http.createServer((req, res) => {
    if (req.url === '/api/graph-runs') return res.end(JSON.stringify([{ id: 'gr_a', name: 'PleinSens boucle predictions - cycle 1', createdAt: 2 }, { id: 'gr_x', name: 'autre', createdAt: 3 }]));
    if (req.url === '/api/graph-runs/gr_a') return res.end(JSON.stringify({ id: 'gr_a', name: 'PleinSens boucle predictions - cycle 1', status: 'completed', nodes: [{ id: 'n', status: 'completed' }] }));
    res.statusCode = 404; res.end('{}');
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  try {
    const port = srv.address().port;
    assert.equal(await buildLoopDetail('../../etc', { port, repoRoot: root }), null, 'unknown id: nothing read');
    const d = await buildLoopDetail('pleinsens', { port, repoRoot: root });
    assert.deepEqual(d.runs.map((r) => r.id), ['gr_a'], 'only the loop runs');
    assert.deepEqual(d.log, ['l1', 'l2']);
    const g = await buildLoopDetail('porte-fusion', { port, repoRoot: root });
    assert.deepEqual(g.candidates, []); assert.deepEqual(g.log, []);
  } finally { srv.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

test('PleinSens En clair: each cycle gets its own gate record (origin.run), not the branch status', async () => {
  const http = require('http'); const fs = require('fs'); const os = require('os'); const path = require('path');
  const { buildPlainSummary } = require('./loops-status');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loops-g-'));
  fs.mkdirSync(path.join(root, '.ai-workspace', 'merge-gate'), { recursive: true });
  fs.writeFileSync(path.join(root, '.ai-workspace', 'merge-gate', 'state.json'), JSON.stringify({ candidates: {
    k1: { source: 'pleinsens-loop', branch: 'b', status: 'merged', createdAt: 1, origin: { run: 'gr_1' }, history: [] },
    k2: { source: 'pleinsens-loop', branch: 'b', status: 'new', createdAt: 2, origin: { run: 'gr_2' }, history: [] } } }));
  const garde = (id, c) => ({ id, name: 'PleinSens boucle predictions - cycle ' + c, status: 'completed', createdAt: c, nodes: [{ id: 'c' + c + '-consigner-garde', status: 'completed' }] });
  const srv = http.createServer((req, res) => {
    if (req.url === '/api/graph-runs') return res.end(JSON.stringify([garde('gr_1', 1), garde('gr_2', 2)]));
    const id = req.url.split('/').pop(); res.end(JSON.stringify(garde(id, id === 'gr_1' ? 1 : 2)));
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  try {
    const items = await buildPlainSummary('pleinsens', { port: srv.address().port, repoRoot: root });
    const by = Object.fromEntries(items.map((i) => [i.facts.runId, i.facts.state]));
    assert.equal(by.gr_1, 'termine'); assert.equal(by.gr_2, 'a-integrer');
  } finally { srv.close(); fs.rmSync(root, { recursive: true, force: true }); }
});
