'use strict';
// Startup report: one minute after Symphonee starts, record where every
// unattended loop stands (autopilots, graph runs, scheduled jobs, merge gate)
// in .ai-workspace/startup-report.log and send it to Sentry. Nothing is
// relaunched here: resuming is done by each loop itself (graph runs re-check
// their window, autopilots resume an interrupted stage, overdue jobs fire on
// the scheduler's first tick). This only makes the restart visible.
const fs = require('fs');
const path = require('path');
const http = require('http');

function get(port, p) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: p, headers: { Accept: 'application/json' } }, (res) => {
      let s = ''; res.on('data', (c) => { s += c; }); res.on('end', () => { try { resolve(JSON.parse(s)); } catch (_) { resolve(null); } });
    });
    req.on('error', () => resolve(null)); req.setTimeout(15000, () => req.destroy());
  });
}
const when = (t) => (t ? new Date(t).toLocaleString() : '-');

async function buildReport({ port = 3800, repoRoot }) {
  const lines = [];
  const pilots = await get(port, '/api/mind/autopilots');
  for (const p of (pilots && pilots.pilots) || []) {
    lines.push('Autopilote ' + p.label + ' (' + p.pilot + ') : ' + p.status + (p.repoName ? ' sur ' + p.repoName : ''));
  }
  const runs = await get(port, '/api/graph-runs');
  const active = (Array.isArray(runs) ? runs : []).filter((r) => ['pending', 'running', 'awaiting_approval', 'paused'].includes(r.status));
  if (!active.length) lines.push('Graph runs : aucun en cours');
  for (const r of active) lines.push('Graph run ' + r.name + ' (' + r.id + ') : ' + r.status + ' ' + (r.completedNodes || 0) + '/' + (r.nodeCount || '?') + ' etapes');
  const jobs = await get(port, '/api/jobs');
  for (const j of (Array.isArray(jobs) ? jobs : []).filter((x) => x.enabled)) {
    lines.push('Job ' + j.name + ' : prochain ' + when(j.nextRun) + (j.lastRun ? ', dernier ' + when(j.lastRun.at) + ' ' + (j.lastRun.status || '') : ''));
  }
  try {
    const st = JSON.parse(fs.readFileSync(path.join(repoRoot, '.ai-workspace', 'merge-gate', 'state.json'), 'utf8'));
    const open = Object.values(st.candidates || {}).filter((c) => !['refused', 'confirmed'].includes(c.status));
    lines.push('Porte de fusion : ' + (st.stopped ? 'ARRETEE (' + st.stopped.reason + ')' : 'active') + ', ' + open.length + ' candidate(s) en cours'
      + (open.length ? ' : ' + open.map((c) => c.branch + '=' + c.status).join(', ') : ''));
  } catch (_) { lines.push('Porte de fusion : aucun passage encore'); }
  return lines;
}

function scheduleStartupReport({ repoRoot, port = 3800, delayMs = 60000, sentry = null }) {
  const t = setTimeout(async () => {
    try {
      const lines = await buildReport({ port, repoRoot });
      const text = new Date().toISOString() + ' DEMARRAGE\n  ' + lines.join('\n  ') + '\n';
      try { fs.appendFileSync(path.join(repoRoot, '.ai-workspace', 'startup-report.log'), text); } catch (_) {}
      const s = sentry || (() => { try { return require('./sentry-report'); } catch (_) { return null; } })();
      if (s) await s.event({ message: 'Symphonee demarre : etat des boucles', level: 'info', loop: 'demarrage',
        fingerprint: ['symphonee', 'demarrage'], extra: { etat: lines.join('\n') } });
    } catch (_) { /* a report must never disturb the server */ }
  }, delayMs);
  if (t.unref) t.unref();
  return t;
}

module.exports = { scheduleStartupReport, buildReport };
