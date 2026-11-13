#!/usr/bin/env node
'use strict';
// Watchdog ("veille") for Symphonee's unattended loops. Run by a Windows
// scheduled task every 10 minutes, OUTSIDE Symphonee, so it still works when
// Symphonee is closed, crashed or frozen. Free: alerts are ordinary Sentry
// events (emailed by the project's alert workflow), no cron monitor needed.
//
//   Symphonee closed or crashed (no API, no Electron main process, 2 checks):
//       relaunched automatically + warning message.
//   Symphonee frozen (process present, API silent for 3 checks = 30 min):
//       error message (never killed: open terminals would be lost).
//   Jobs stalled (the 30-minute merge-gate job has not run for 90 min):
//       error message.
//   Back to normal: one "retabli" message.
// A problem is re-sent every 6 hours while it lasts. Pause (no relaunch, no
// message): create .ai-workspace/veille-pause.
const fs = require('fs');
const path = require('path');
const http = require('http');
const { execFileSync, spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const STATE = path.join(ROOT, '.ai-workspace', 'veille.json');
const LOG = path.join(ROOT, '.ai-workspace', 'veille.log');
const PAUSE = path.join(ROOT, '.ai-workspace', 'veille-pause');
const ELECTRON = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
const GATE_JOB = 'job-porte-fusion';
const REPEAT_MS = 6 * 3600000;

function getJson(p, timeoutMs = 15000) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port: 3800, path: p, headers: { Accept: 'application/json' } }, (res) => {
      let s = ''; res.on('data', (c) => { s += c; });
      res.on('end', () => { try { resolve(res.statusCode < 400 ? JSON.parse(s) : null); } catch (_) { resolve(null); } });
    });
    req.on('error', () => resolve(null)); req.setTimeout(timeoutMs, () => req.destroy());
  });
}
// Electron MAIN process of this install (children carry --type=...).
function electronMainRunning() {
  try {
    const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      "Get-CimInstance Win32_Process -Filter \"Name='electron.exe'\" | ForEach-Object { $_.CommandLine }"],
    { encoding: 'utf8', timeout: 60000, windowsHide: true });
    return out.split(/\r?\n/).some((l) => l.toLowerCase().includes(ROOT.toLowerCase()) && !/--type=/.test(l));
  } catch (_) { return null; } // unknown: never relaunch on doubt
}
function relaunch() {
  const p = spawn(ELECTRON, ['.'], { cwd: ROOT, detached: true, stdio: 'ignore', windowsHide: false });
  p.unref();
}

// Pure decision: (observation, previous state, now) -> { state, actions }.
// obs: { api: bool, jobs: [..]|null, electron: true|false|null, paused: bool }
function decide(obs, prev, now) {
  const st = { fails: 0, problems: {}, ...(prev || {}) };
  st.problems = { ...(st.problems || {}) };
  const actions = [];
  const found = {};
  if (obs.api) {
    st.fails = 0;
    const job = (obs.jobs || []).find((j) => j.id === GATE_JOB && j.enabled);
    if (job) {
      const last = (job.lastRun && job.lastRun.at) || job.createdAt || 0;
      if (now - last > 90 * 60000) found['jobs-bloques'] = 'Les jobs de Symphonee ne tournent plus : la porte de fusion n a pas tourne depuis ' + new Date(last).toLocaleString();
    }
  } else {
    st.fails = (st.fails || 0) + 1;
    if (obs.electron === false && st.fails >= 2) {
      if (!obs.paused) actions.push({ type: 'relaunch' });
      found['symphonee-ferme'] = obs.paused ? 'Symphonee est ferme (veille en pause : pas de relance)' : 'Symphonee etait ferme ou plante : relance automatique';
    } else if (obs.electron === true && st.fails >= 3) {
      found['symphonee-fige'] = 'Symphonee ne repond plus depuis ' + st.fails * 10 + ' min alors que son processus tourne (fige ?) : a fermer et relancer';
    }
  }
  for (const [key, msg] of Object.entries(found)) {
    const p = st.problems[key];
    if (!p) { st.problems[key] = { since: now, lastAlert: now }; actions.push({ type: 'alert', key, level: key === 'symphonee-ferme' ? 'warning' : 'error', msg }); }
    else if (now - p.lastAlert >= REPEAT_MS || key === 'symphonee-ferme') {
      // a relaunch is always reported; other problems every 6 h
      if (key !== 'symphonee-ferme' || actions.some((a) => a.type === 'relaunch')) {
        p.lastAlert = now; actions.push({ type: 'alert', key, level: key === 'symphonee-ferme' ? 'warning' : 'error', msg: msg + ' (toujours)' });
      }
    }
  }
  // Recoveries: a problem not seen any more, once Symphonee answers again.
  if (obs.api) {
    for (const key of Object.keys(st.problems)) {
      if (!found[key]) {
        actions.push({ type: 'alert', key, level: 'info', msg: 'Retabli : ' + key + ' (depuis ' + new Date(st.problems[key].since).toLocaleString() + ')' });
        delete st.problems[key];
      }
    }
  }
  if (obs.paused) return { state: st, actions: actions.filter((a) => a.type !== 'alert' || a.level === 'info') };
  return { state: st, actions };
}

async function main() {
  const now = Date.now();
  let prev = {};
  try { prev = JSON.parse(fs.readFileSync(STATE, 'utf8')); } catch (_) {}
  const jobs = await getJson('/api/jobs');
  const obs = { api: Array.isArray(jobs), jobs, paused: fs.existsSync(PAUSE),
    electron: Array.isArray(jobs) ? true : electronMainRunning() };
  const { state, actions } = decide(obs, prev, now);
  fs.writeFileSync(STATE, JSON.stringify(state, null, 2));
  const line = (s) => { try { fs.appendFileSync(LOG, new Date(now).toISOString() + ' VEILLE ' + s + '\n'); } catch (_) {} };
  line((obs.api ? 'ok' : 'API muette x' + state.fails) + (actions.length ? ' ; ' + actions.map((a) => a.type + (a.key ? ':' + a.key : '')).join(', ') : ''));
  let sentry = null;
  try { sentry = require('../dashboard/automation/sentry-report'); } catch (_) {}
  for (const a of actions) {
    if (a.type === 'relaunch') { try { relaunch(); line('relance de Symphonee'); } catch (e) { line('relance impossible : ' + e.message); } }
    if (a.type === 'alert' && sentry) {
      const r = await sentry.event({ message: 'Veille Symphonee : ' + a.msg, level: a.level, loop: 'veille', fingerprint: ['veille', a.key, a.level === 'info' ? 'retabli' : 'probleme'] });
      if (!r.ok) line('Sentry : ' + (r.error || r.skipped));
    }
  }
}

if (require.main === module) main().catch((e) => { try { fs.appendFileSync(LOG, new Date().toISOString() + ' VEILLE ERREUR ' + e.stack + '\n'); } catch (_) {} process.exitCode = 1; });
module.exports = { decide };
