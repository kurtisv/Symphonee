'use strict';
// GET /api/automation/loops: one picture of every unattended loop, for the UI
// (Mind > Autopilot overview, the agent office). Read-only, built from the same
// sources the loops use: autopilot snapshots, graph runs, jobs, the PleinSens
// launcher log, the merge gate state and the watchdog log.
//
// Each loop: { id, label, kind, window, status, statusLabel, detail, next,
//   cli, taskId } with status working | resting | stopped | error.
const fs = require('fs');
const path = require('path');
const http = require('http');

const LOOP_PREFIX = 'PleinSens boucle predictions - cycle ';
const STAGE_FR = { discover: 'decouverte', 'plan-review': 'revue du plan (Codex)', implement: 'implementation (Claude)',
  verify: 'verification locale', 'code-review': 'revue du code (Codex)', repair: 'reparation (Claude)' };
const STAGE_CLI = { discover: 'claude', 'plan-review': 'codex', implement: 'claude', verify: 'script', 'code-review': 'codex', repair: 'claude' };

function getJson(port, p) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: p, headers: { Accept: 'application/json' } }, (res) => {
      let s = ''; res.on('data', (c) => { s += c; }); res.on('end', () => { try { resolve(res.statusCode < 400 ? JSON.parse(s) : null); } catch (_) { resolve(null); } });
    });
    req.on('error', () => resolve(null)); req.setTimeout(10000, () => req.destroy());
  });
}
function tail(file, n = 1) {
  try { return fs.readFileSync(file, 'utf8').trim().split(/\r?\n/).slice(-n); } catch (_) { return []; }
}
const hhmm = (t) => { const d = new Date(t); return ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2); };
function whenLabel(t, now) {
  if (!t) return '';
  const d = new Date(t), today = new Date(now);
  const sameDay = d.toDateString() === today.toDateString();
  const tomorrow = new Date(now + 86400000).toDateString() === d.toDateString();
  return (sameDay ? '' : tomorrow ? 'demain ' : d.toLocaleDateString('fr-CA') + ' ') + hhmm(t);
}

// Pure: autopilot snapshot -> loop entry.
function autopilotLoop(snap, label, now) {
  const sch = snap.schedule;
  const base = { id: 'autopilote:' + snap.pilot, pilot: snap.pilot, label, kind: 'autopilot',
    window: sch ? sch.start + '-' + sch.end : 'toute la journee', next: snap.nextAt || null, cli: null, taskId: null };
  if (snap.error) return { ...base, status: 'error', statusLabel: 'en erreur', detail: String(snap.error).slice(0, 200) };
  if (!snap.enabled) return { ...base, status: 'stopped', statusLabel: 'arretee', detail: 'Desactivee : ne lance rien' };
  const a = snap.active;
  if (a && a.stage && a.stage !== 'budget-wait' && (a.taskId || a.stage === 'verify')) {
    return { ...base, status: 'working', statusLabel: 'travaille', cli: STAGE_CLI[a.stage] || 'claude', taskId: a.taskId || null,
      detail: (STAGE_FR[a.stage] || a.stage) + (a.plan && a.plan.title ? ' : ' + a.plan.title : '') };
  }
  if (a && a.waitingStage) {
    const why = a.parkReason === 'window' ? 'fin de plage' : a.parkReason === 'credit' ? 'limite d usage' : a.parkReason === 'restart' ? 'reprise apres redemarrage' : 'quota';
    return { ...base, status: 'resting', statusLabel: 'en pause', detail: (STAGE_FR[a.waitingStage] || a.waitingStage) + ' reprend ' + whenLabel(snap.nextAt, now) + ' (' + why + ')' };
  }
  return { ...base, status: 'resting', statusLabel: 'au repos', detail: snap.nextAt && snap.nextAt > now ? 'Prochaine tache ' + whenLabel(snap.nextAt, now) : 'Pret, verifie toutes les 20 s' };
}

// Pure: PleinSens loop from its active run (detail or null), its job and the launcher's last line.
function pleinsensLoop(run, job, lastLine, now) {
  const base = { id: 'pleinsens', label: 'Boucle PleinSens', kind: 'graph', window: '08:00-13:00', next: null, cli: null, taskId: null };
  if (run) {
    const node = (run.nodes || []).find((n) => n.status === 'running');
    const done = (run.nodes || []).filter((n) => n.status === 'completed').length;
    const cycle = (run.state && run.state.cycle) || '?';
    if (node) return { ...base, status: 'working', statusLabel: 'travaille', cli: node.cli || null, taskId: node.output && node.output.taskId || null,
      detail: 'Cycle ' + cycle + ' : ' + node.id + ' (' + done + '/' + run.nodes.length + ' etapes)' };
    if (run.waitingWindow) return { ...base, status: 'resting', statusLabel: 'en pause', next: run.waitingWindow.until,
      detail: 'Cycle ' + cycle + ' (' + done + '/' + run.nodes.length + ') reprend ' + whenLabel(run.waitingWindow.until, now) };
    return { ...base, status: 'working', statusLabel: 'travaille', detail: 'Cycle ' + cycle + ' en cours (' + done + '/' + run.nodes.length + ')' };
  }
  const line = String(lastLine || '').replace(/^\S+ LANCEUR /, '');
  if (/^ARRET/.test(line)) return { ...base, status: 'error', statusLabel: 'arretee', detail: line.slice(0, 200) };
  if (/^FIN_DE_BOUCLE/.test(line)) return { ...base, status: 'stopped', statusLabel: 'terminee', detail: line.slice(0, 200) };
  if (!job || !job.enabled) return { ...base, status: 'stopped', statusLabel: 'arretee', detail: 'Job de lancement desactive' };
  return { ...base, status: 'resting', statusLabel: 'au repos', next: job.nextRun || null, detail: 'Prochain lancement ' + whenLabel(job.nextRun, now) };
}

function gateService(job, state, now) {
  const base = { id: 'porte-fusion', label: 'Porte de fusion', kind: 'script', window: 'toutes les 30 min (tests 13-14 h, 19-22 h)', cli: 'script' };
  if (state && state.stopped) return { ...base, status: 'error', statusLabel: 'arretee', detail: state.stopped.reason };
  const open = Object.values((state && state.candidates) || {}).filter((c) => !['refused', 'confirmed'].includes(c.status));
  const sum = open.length ? open.length + ' branche(s) : ' + open.map((c) => c.status).join(', ') : 'aucune branche en cours';
  if (!job || !job.enabled) return { ...base, status: 'stopped', statusLabel: 'arretee', detail: 'Job desactive' };
  if (job.lastRun && job.lastRun.status === 'running') return { ...base, status: 'working', statusLabel: 'travaille', detail: 'Verifie les branches (' + sum + ')' };
  return { ...base, status: 'resting', statusLabel: 'au repos', next: job.nextRun, detail: 'Prochain passage ' + whenLabel(job.nextRun, now) + ' ; ' + sum };
}
function watchdogService(lastLine, now) {
  const base = { id: 'veille', label: 'Veille', kind: 'script', window: 'toutes les 10 min', cli: 'script' };
  const t = Date.parse(String(lastLine || '').split(' ')[0]);
  if (!t) return { ...base, status: 'stopped', statusLabel: 'inactive', detail: 'Aucun passage enregistre' };
  if (now - t > 25 * 60000) return { ...base, status: 'error', statusLabel: 'silencieuse', detail: 'Dernier passage ' + whenLabel(t, now) + ' (tache Windows arretee ?)' };
  return { ...base, status: 'resting', statusLabel: 'surveille', detail: 'Dernier passage ' + whenLabel(t, now) + ' : ' + String(lastLine).split(' VEILLE ')[1] };
}

async function buildLoops({ port = 3800, repoRoot }) {
  const now = Date.now();
  const list = await getJson(port, '/api/mind/autopilots');
  const pilots = (list && list.pilots) || [];
  const snaps = await Promise.all(pilots.map((p) => getJson(port, '/api/mind/autopilot?pilot=' + encodeURIComponent(p.pilot))));
  const runs = await getJson(port, '/api/graph-runs');
  const activeRun = (Array.isArray(runs) ? runs : []).filter((r) => String(r.name || '').startsWith(LOOP_PREFIX) && ['pending', 'running', 'awaiting_approval', 'paused'].includes(r.status))
    .sort((a, b) => b.createdAt - a.createdAt)[0];
  const runDetail = activeRun ? await getJson(port, '/api/graph-runs/' + activeRun.id) : null;
  const jobs = (await getJson(port, '/api/jobs')) || [];
  const loopJob = jobs.find((j) => /PleinSens boucle/.test(j.name || ''));
  const gateJob = jobs.find((j) => j.id === 'job-porte-fusion');
  let gateState = null;
  try { gateState = JSON.parse(fs.readFileSync(path.join(repoRoot, '.ai-workspace', 'merge-gate', 'state.json'), 'utf8')); } catch (_) {}
  const LABEL = { 'gas-saver': 'Autopilote Gas Saver', default: 'Autopilote Principale (Symphonee)' };
  const loops = [];
  const byId = Object.fromEntries(pilots.map((p, i) => [p.pilot, snaps[i]]));
  if (byId['gas-saver']) loops.push(autopilotLoop({ ...byId['gas-saver'], pilot: 'gas-saver' }, LABEL['gas-saver'], now));
  loops.push(pleinsensLoop(runDetail, loopJob, tail(path.join(repoRoot, '.ai-workspace', 'boucle-lanceur.log'))[0], now));
  if (byId.default) loops.push(autopilotLoop({ ...byId.default, pilot: 'default' }, LABEL.default, now));
  for (const p of pilots) if (!LABEL[p.pilot] && byId[p.pilot]) loops.push(autopilotLoop({ ...byId[p.pilot], pilot: p.pilot }, 'Autopilote ' + p.label, now));
  const services = [gateService(gateJob, gateState, now), watchdogService(tail(path.join(repoRoot, '.ai-workspace', 'veille.log'))[0], now)];
  return { now, loops, services };
}

function mountLoopsStatus(addRoute, json, { repoRoot, port = 3800 }) {
  addRoute('GET', '/api/automation/loops', async (_req, res) => {
    try { json(res, await buildLoops({ port, repoRoot })); }
    catch (e) { json(res, { error: e.message }, 500); }
  });
}

module.exports = { mountLoopsStatus, buildLoops, autopilotLoop, pleinsensLoop, gateService, watchdogService };
