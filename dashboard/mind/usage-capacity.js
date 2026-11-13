'use strict';
// Adaptive task capacity (0..6 per work window) for the Mind autopilots,
// from the REAL remaining capacity of the Claude and Codex subscriptions.
//
// What is measured, and how reliably:
// - Claude: the documented statusline field `rate_limits` (five_hour /
//   seven_day: used_percentage, resets_at), written to a snapshot file by
//   scripts/statusline-usage.js when the user enables that statusline in
//   Claude Code. Refreshed only while an interactive Claude Code session runs.
// - Codex: the `rate_limits` object of the latest event in Codex's own local
//   session log. UNDOCUMENTED format: only that object is read, nothing else
//   from the file; it can be turned off (sources.codexSessions = false).
// Neither gives a number of tokens left: they give a PERCENT of a window. This
// module never converts percents into tokens.
//
// Cost of one task, per provider (Claude = author, Codex = reviewer): the
// LARGEST percent increase observed over the last tasks (not the average);
// before any observation, a configured prior, shown as an estimate.
// Readings older than maxAgeMin, missing or inconsistent are UNKNOWN: no
// capacity is assumed; the configured fallback (a fixed count, possibly 0)
// applies and is shown as a fallback.
const fs = require('fs');
const path = require('path');
const os = require('os');

const DEFAULTS = Object.freeze({
  enabled: true,
  maxTasks: 6,                 // ceiling per work window, not a target
  marginPct: 10,               // safety margin kept free in every window
  maxAgeMin: 30,               // a reading older than this is unknown
  priorCostPct: { claude: 15, codex: 8 },  // per task, until measured
  costSamples: 10,             // last N measured tasks per provider
  unknown: { mode: 'fallback', tasks: null }, // tasks:null = the pilot's former fixed daily limit; mode 'block' = 0
  sources: { claudeSnapshot: true, codexSessions: true },
});

function settings(def = {}) {
  const d = def && typeof def === 'object' ? def : {};
  const num = (v, lo, hi, dflt) => { const n = Number(v); return Number.isFinite(n) ? Math.min(Math.max(n, lo), hi) : dflt; };
  return {
    enabled: d.enabled !== false,
    maxTasks: Math.round(num(d.maxTasks, 0, 6, DEFAULTS.maxTasks)),
    marginPct: num(d.marginPct, 0, 50, DEFAULTS.marginPct),
    maxAgeMin: num(d.maxAgeMin, 1, 24 * 60, DEFAULTS.maxAgeMin),
    priorCostPct: { claude: num(d.priorCostPct && d.priorCostPct.claude, 0.5, 100, DEFAULTS.priorCostPct.claude),
      codex: num(d.priorCostPct && d.priorCostPct.codex, 0.5, 100, DEFAULTS.priorCostPct.codex) },
    costSamples: Math.round(num(d.costSamples, 1, 50, DEFAULTS.costSamples)),
    unknown: { mode: d.unknown && d.unknown.mode === 'block' ? 'block' : 'fallback',
      tasks: d.unknown && d.unknown.tasks !== null && d.unknown.tasks !== undefined && d.unknown.tasks !== '' && Number.isFinite(Number(d.unknown.tasks)) ? Math.round(num(d.unknown.tasks, 0, 6, 0)) : null },
    sources: { claudeSnapshot: !(d.sources && d.sources.claudeSnapshot === false), codexSessions: !(d.sources && d.sources.codexSessions === false) },
  };
}

// ── Readers (return { windows:[{name, usedPct, resetsAt}], readAt, source } or { error }) ──
function windowsFromClaude(rl) {
  const out = [];
  for (const [name, label] of [['five_hour', '5 h'], ['seven_day', '7 jours']]) {
    const w = rl && rl[name];
    if (w) out.push({ name: label, usedPct: typeof w.used_percentage === 'number' ? w.used_percentage : NaN, resetsAt: typeof w.resets_at === 'number' ? w.resets_at * 1000 : null });
  }
  return out;
}
function readClaude(file) {
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    const windows = windowsFromClaude(j.rate_limits);
    if (!windows.length) return { error: 'la ligne d etat de Claude Code n a pas encore recu de limites (session sans reponse, ou forfait sans ces champs)' };
    return { windows, readAt: Date.parse(j.at) || null, source: 'Claude Code, ligne d etat (champ documente rate_limits)' };
  } catch (e) {
    return { error: e.code === 'ENOENT' ? 'aucune lecture : la ligne d etat Symphonee n est pas activee dans Claude Code' : 'lecture illisible' };
  }
}

// Extract the LAST "rate_limits":{...} object of a text (balanced braces).
function lastRateLimits(text) {
  const key = '"rate_limits":';
  const i = text.lastIndexOf(key);
  if (i < 0) return null;
  let j = i + key.length; while (text[j] === ' ') j++;
  if (text[j] !== '{') return null;
  let depth = 0, k = j, inStr = false;
  for (; k < text.length; k++) {
    const c = text[k];
    if (inStr) { if (c === '\\') k++; else if (c === '"') inStr = false; continue; }
    if (c === '"') inStr = true; else if (c === '{') depth++; else if (c === '}' && --depth === 0) break;
  }
  try { return JSON.parse(text.slice(j, k + 1)); } catch (_) { return null; }
}
function windowsFromCodex(rl) {
  const out = [];
  for (const slot of ['primary', 'secondary']) {
    const w = rl && rl[slot];
    if (!w) continue;
    const min = Number(w.window_minutes);
    out.push({ name: Number.isFinite(min) && min >= 1440 ? Math.round(min / 1440) + ' jours' : Number.isFinite(min) ? Math.round(min / 60) + ' h' : slot,
      usedPct: typeof w.used_percent === 'number' ? w.used_percent : NaN,
      resetsAt: typeof w.resets_at === 'number' ? w.resets_at * 1000 : null });
  }
  return out;
}
// Reads the session files from their END in 16 KiB steps until the last line
// holding "rate_limits" is found; only that line is decoded, and from it only
// the event timestamp and the rate_limits object are kept. Nothing else from
// the session (conversation, commands) is parsed, stored or returned.
const CHUNK = 16 * 1024;
const MAX_SCAN = 256 * 1024;
function lastRateLimitsLine(file) {
  const st = fs.statSync(file);
  const fd = fs.openSync(file, 'r');
  try {
    let pos = st.size, tail = Buffer.alloc(0);
    while (pos > 0 && st.size - pos < MAX_SCAN) {
      const len = Math.min(CHUNK, pos); pos -= len;
      const buf = Buffer.alloc(len); fs.readSync(fd, buf, 0, len, pos);
      tail = Buffer.concat([buf, tail]);
      const i = tail.lastIndexOf('"rate_limits":');
      if (i < 0) { tail = tail.subarray(0, Math.min(tail.length, 64)); continue; } // keep only a seam for a key split across chunks
      const start = tail.lastIndexOf(10, i) + 1; // line start (or chunk start)
      if (start === 0 && pos > 0) continue;      // line begins in an earlier chunk
      const end = tail.indexOf(10, i);
      return tail.subarray(start, end < 0 ? tail.length : end).toString('utf8');
    }
    return null;
  } finally { fs.closeSync(fd); }
}
function readCodex(sessionsDir, now = Date.now()) {
  try {
    // Newest session files of the last two days (Codex stores them by date).
    const days = [0, 1].map((d) => new Date(now - d * 86400000));
    let files = [];
    for (const d of days) {
      const dir = path.join(sessionsDir, String(d.getFullYear()), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0'));
      try { for (const f of fs.readdirSync(dir)) if (f.endsWith('.jsonl')) files.push(path.join(dir, f)); } catch (_) {}
    }
    files = files.map((f) => ({ f, t: fs.statSync(f).mtimeMs })).sort((a, b) => b.t - a.t).slice(0, 5);
    let best = null;
    for (const { f } of files) {
      const line = lastRateLimitsLine(f);
      if (!line) continue;
      const rl = lastRateLimits(line);
      const ts = /^\{\s*"timestamp"\s*:\s*"([^"]+)"/.exec(line);
      const at = ts ? Date.parse(ts[1]) : NaN;
      const windows = windowsFromCodex(rl);
      // Freshness = the event's own timestamp, never the file's modification time.
      if (!windows.length || !Number.isFinite(at)) continue;
      if (!best || at > best.readAt) best = { windows, readAt: at, source: 'Codex, journal local de session (format non documente)',
        reached: rl.rate_limit_reached_type || null };
    }
    return best || { error: 'aucune limite horodatee trouvee dans les journaux Codex des deux derniers jours' };
  } catch (_) { return { error: 'journaux Codex illisibles' }; }
}

// A reading is valid when it has at least one window, every window has a real
// percent 0-100 and a reset time after the reading, and the reading is not dated
// in the future (no tolerance).
function validReading(reading, now = Date.now()) {
  return !!reading && !reading.error && Array.isArray(reading.windows) && reading.windows.length > 0
    && reading.readAt > 0 && reading.readAt <= now
    && reading.windows.every((w) => typeof w.usedPct === 'number' && w.usedPct >= 0 && w.usedPct <= 100
      && typeof w.resetsAt === 'number' && w.resetsAt > reading.readAt);
}

// ── Pure decision ─────────────────────────────────────────────────────────
// reading: reader result; costLog: [{provider, pct}] newest last;
// spans: [{ launchedAt, endedAt }] of the tasks of ALL pilots (they share the
// subscriptions); endedAt null while a task runs or is parked.
const END_SLACK_MS = 60000;
const MIN_WINDOW_COST = 1; // percent: the smallest step a window displays // time for a provider to record the last usage of a task
function providerView(name, reading, costLog, cfg, now, spans = []) {
  const v = { provider: name, status: 'unknown', source: reading && reading.source || null, readAt: reading && reading.readAt || null,
    windows: [], costPct: null, costBasis: null, tasks: null, reserved: 0, why: null };
  if (!reading || reading.error) { v.why = reading ? reading.error : 'source desactivee'; return v; }
  const age = reading.readAt ? (now - reading.readAt) / 60000 : Infinity;
  // Every window needs a real percent 0-100 and a reset time after the reading;
  // a reading dated in the future is not trusted either.
  const bad = !validReading(reading, now);
  if (bad) { v.why = 'lecture incoherente (pourcentage, reinitialisation ou heure de lecture invalide)'; return v; }
  v.windows = reading.windows.map((w) => ({ ...w, expired: !!(w.resetsAt && w.resetsAt <= now), usablePct: Math.max(0, 100 - w.usedPct - cfg.marginPct) }));
  if (age > cfg.maxAgeMin) { v.why = 'lecture perimee (' + Math.round(age) + ' min, limite ' + cfg.maxAgeMin + ' min)'; return v; }
  // Any window reset since the reading makes the whole reading outdated.
  if (v.windows.some((w) => w.expired)) { v.why = 'une fenetre s est reinitialisee depuis la lecture : nouvelle lecture necessaire'; return v; }
  // Cost PER WINDOW: a task can take 7 % of the 5 h window and under 1 % of
  // the 7-day one, so each window is divided by its own measured cost. An old
  // sample without per-window detail counts its overall cost for every window.
  // A window shows whole percents: a measured 0 is floored at MIN_WINDOW_COST.
  const entries = costLog.filter((c) => c.provider === name && (c.windows || c.pct > 0));
  for (const w of v.windows) {
    // The last N samples OF THIS WINDOW (a window absent for a while keeps its own history).
    const vals = entries.map((c) => (c.windows ? c.windows[w.name] : c.pct)).filter((x) => typeof x === 'number' && x >= 0).slice(-cfg.costSamples);
    w.costPct = vals.length ? Math.max(MIN_WINDOW_COST, ...vals) : cfg.priorCostPct[name];
    w.tasks = Math.floor(w.usablePct / w.costPct);
  }
  const samples = entries.slice(-cfg.costSamples).length;
  v.costBasis = samples ? 'plus forte hausse observee par fenetre sur ' + samples + ' tache(s)' : 'estimation initiale (aucune tache mesuree)';
  // Reserved: tasks started after this reading (not in it yet), plus every task
  // still running or parked, whenever it started (the rest of its cost, review
  // included, is still to come). Conservative: a full task cost each.
  // A task is reserved (a full task cost) until a reading taken after its END
  // (plus slack): before that, part or all of its usage is not in the reading.
  v.reserved = spans.filter((t) => t.endedAt == null || reading.readAt < t.endedAt + END_SLACK_MS).length;
  // The limiting window is the one allowing the fewest tasks.
  const tight = v.windows.reduce((a, b) => (a.tasks <= b.tasks ? a : b));
  v.costPct = tight.costPct;
  v.tasks = Math.max(0, tight.tasks - v.reserved);
  v.status = 'known';
  v.why = 'fenetre ' + tight.name + ' : ' + tight.usablePct.toFixed(0) + ' % utilisables / ' + tight.costPct.toFixed(1) + ' % par tache'
    + (v.reserved ? ', ' + v.reserved + ' tache(s) lancee(s) depuis la lecture deja reservee(s)' : '')
    + (v.tasks > 0 ? '' : ' : plus assez de marge' + (tight.resetsAt ? ', reprise ' + new Date(tight.resetsAt).toLocaleString('fr-CA') : ''));
  return v;
}

// launched: tasks already started in this work window. fallbackTasks: the
// pilot's former fixed limit. Returns the whole decision, for the UI.
function decide({ claude, codex, costLog = [], launched = 0, spans = [], fallbackTasks = 2, cfg: rawCfg, now = Date.now() }) {
  const cfg = settings(rawCfg);
  const pv = { claude: providerView('claude', claude, costLog, cfg, now, spans), codex: providerView('codex', codex, costLog, cfg, now, spans) };
  const left = Math.max(0, cfg.maxTasks - launched);
  const base = { at: now, maxTasks: cfg.maxTasks, marginPct: cfg.marginPct, launched, providers: pv };
  const unknown = Object.values(pv).filter((p) => p.status !== 'known');
  const known = Object.values(pv).filter((p) => p.status === 'known');
  if (unknown.length) {
    const fb = cfg.unknown.mode === 'block' ? 0 : (cfg.unknown.tasks != null ? cfg.unknown.tasks : fallbackTasks);
    // A provider that IS known still limits the fallback (no author task without its review).
    const knownCap = known.length ? Math.min(...known.map((p) => p.tasks)) : Infinity;
    const admissible = Math.max(0, Math.min(left, fb - launched, knownCap));
    return { ...base, mode: 'fallback', admissible,
      reason: 'Usage inconnu pour ' + unknown.map((p) => p.provider + ' (' + p.why + ')').join(' ; ') + '. Repli '
        + (cfg.unknown.mode === 'block' ? 'bloquant : aucune tache payante sans lecture.' : 'sur la limite fixe de ' + fb + ' tache(s) par plage, sans capacite supposee')
        + (known.length ? ' ; ' + known.map((p) => p.provider + ' mesure : ' + p.tasks + ' tache(s) possible(s)').join(', ') + '.' : '.') };
  }
  const byQuota = Math.min(pv.claude.tasks, pv.codex.tasks);
  const admissible = Math.max(0, Math.min(left, byQuota));
  const limiting = pv.claude.tasks <= pv.codex.tasks ? pv.claude : pv.codex;
  return { ...base, mode: 'measured', admissible,
    reason: admissible > 0 ? admissible + ' tache(s) encore possible(s) : ' + limiting.provider + ' est le plus contraignant (' + limiting.why + ').'
      : left === 0 ? 'Plafond de ' + cfg.maxTasks + ' taches atteint pour cette plage.'
        : 'Aucune tache : ' + limiting.provider + ' (' + limiting.why + '). La revue Codex est toujours reservee avec la tache Claude.' };
}


const DEFAULT_PATHS = {
  claudeSnapshot: (repoRoot) => path.join(repoRoot, '.ai-workspace', 'usage', 'claude-rate-limits.json'),
  codexSessions: () => path.join(os.homedir(), '.codex', 'sessions'),
};
function readAll(repoRoot, rawCfg, now = Date.now()) {
  const cfg = settings(rawCfg);
  return { claude: cfg.sources.claudeSnapshot ? readClaude(DEFAULT_PATHS.claudeSnapshot(repoRoot)) : { error: 'source desactivee' },
    codex: cfg.sources.codexSessions ? readCodex(DEFAULT_PATHS.codexSessions(), now) : { error: 'source desactivee' } };
}

// Percent used per live window, { name: { usedPct, resetsAt } } (before/after a task).
function usedNow(reading, now = Date.now()) {
  if (!reading || reading.error) return null;
  const out = {};
  for (const w of reading.windows) if (!(w.resetsAt && w.resetsAt <= now)) out[w.name] = { usedPct: w.usedPct, resetsAt: w.resetsAt };
  return Object.keys(out).length ? out : null;
}
// Every window of a reading, expired or not ({ name: { usedPct, resetsAt } }), for calibration.
function allWindows(reading) {
  if (!reading || reading.error || !Array.isArray(reading.windows) || !reading.windows.length) return null;
  const out = {};
  for (const w of reading.windows) out[w.name] = { usedPct: w.usedPct, resetsAt: w.resetsAt };
  return out;
}
// Cost of one task in percent: the largest increase over the windows present
// before and after, skipping a window that was reset in between. null = not measurable.
// Bounded cost log that never drops the last samples of any provider/window:
// keeps the newest `max` entries plus the newest `perWindow` of each window.
function trimCostLog(log, max = 50, perWindow = DEFAULTS.costSamples) {
  const keep = new Set();
  for (let i = Math.max(0, log.length - max); i < log.length; i++) keep.add(i);
  const counts = {};
  for (let i = log.length - 1; i >= 0; i--) {
    const c = log[i];
    for (const w of c.windows ? Object.keys(c.windows) : ['*']) {
      const k = c.provider + '|' + w;
      if ((counts[k] = (counts[k] || 0) + 1) <= perWindow) keep.add(i);
    }
  }
  return log.filter((_, i) => keep.has(i));
}
function taskCost(before, after) {
  const by = taskCostByWindow(before, after);
  return by ? Math.max(...Object.values(by)) : null;
}
// The same measure, window by window ({ name: increase }), or null.
function taskCostByWindow(before, after) {
  if (!before || !after) return null;
  // The same windows on both sides, or no sample.
  const names = Object.keys(before);
  if (!names.length || names.length !== Object.keys(after).length) return null;
  const out = {};
  for (const name of Object.keys(before)) {
    const a = before[name], b = after[name];
    // A window missing or reset during the task: the sample is incomplete and
    // would under-estimate the cost, so the WHOLE sample is discarded.
    if (!b || a.resetsAt !== b.resetsAt) return null;
    const d = b.usedPct - a.usedPct;
    if (d < 0) return null; // usage dropped without a reset: incoherent sample, discarded
    out[name] = d;
  }
  return out;
}

module.exports = { DEFAULTS, settings, decide, validReading, allWindows, readClaude, readCodex, readAll, lastRateLimits, usedNow, taskCost, taskCostByWindow, trimCostLog, DEFAULT_PATHS };
