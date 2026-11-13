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
