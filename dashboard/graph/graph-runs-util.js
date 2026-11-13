// graph-runs-util -- pure helpers for the graph-run engine: deep config merge,
// {{var}} template rendering, dotted-path read, sandboxed condition eval (vm),
// skip-propagation reachability, the localhost API client, and sleep. Split from
// graph-runs.js so they can be unit-tested directly; the engine imports them.
const http = require('http');
const vm = require('vm');

function deepMerge(a, b) {
  if (Array.isArray(b)) return b.slice();
  if (b === null || typeof b !== 'object') return b;
  const out = { ...(a && typeof a === 'object' && !Array.isArray(a) ? a : {}) };
  for (const [k, v] of Object.entries(b)) {
    if (v && typeof v === 'object' && !Array.isArray(v) && out[k] && typeof out[k] === 'object' && !Array.isArray(out[k])) {
      out[k] = deepMerge(out[k], v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

function renderTemplate(tpl, vars) {
  return String(tpl).replace(/\{\{\s*([^}]+?)\s*\}\}/g, (_, path) => {
    try { return String(readPath(vars, path) ?? ''); } catch (_) { return ''; }
  });
}

function readPath(obj, p) {
  const parts = String(p).split('.').map(s => s.trim()).filter(Boolean);
  let cur = obj;
  for (const part of parts) {
    if (cur == null) return undefined;
    cur = cur[part];
  }
  return cur;
}

function evalSafe(expr, state) {
  return vm.runInNewContext(`(${expr})`, { state }, { timeout: 200 });
}

// Compute the set of nodes that become unreachable when `startId` is skipped,
// given that `alreadySkipped` is the running skip set. A node is unreachable
// only if it has at least one dependency AND every dependency is in the skip
// set. Iterated to a fixed point so chained merges work too.
function unreachableFrom(nodes, startId, alreadySkipped = []) {
  const skip = new Set([...alreadySkipped, startId]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const n of nodes) {
      if (skip.has(n.id)) continue;
      const deps = n.dependsOn || [];
      if (!deps.length) continue; // root nodes are never skipped by propagation
      if (deps.every(d => skip.has(d))) {
        skip.add(n.id);
        changed = true;
      }
    }
  }
  return Array.from(skip);
}

function apiRequest(host, port, method, pathname, body, { timeoutMs = 60000 } = {}) {
  return new Promise((resolveP, rejectP) => {
    // Settles exactly once: a response cut after its headers (aborted / closed
    // without 'end') or a silent server used to leave the promise pending
    // forever, freezing the node's poll loop.
    let settled = false;
    const resolve = (v) => { if (!settled) { settled = true; resolveP(v); } };
    const reject = (e) => { if (!settled) { settled = true; rejectP(e); } };
    const netError = (msg, code) => Object.assign(new Error(msg), { code });
    const data = body !== undefined ? JSON.stringify(body) : null;
    const req = http.request({
      host, port, path: pathname, method,
      // No pooled keep-alive socket: reusing one the server just closed gave
      // "read ECONNRESET" and failed a whole graph node mid-poll.
      agent: false,
      // The server gates every mutating request behind the per-boot token and
      // exports it as SYMPHONEE_TOKEN; without it a worker spawn is a 403.
      headers: Object.assign({ Accept: 'application/json' },
        data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {},
        process.env.SYMPHONEE_TOKEN ? { 'x-symphonee-token': process.env.SYMPHONEE_TOKEN } : {}),
    }, res => {
      let chunks = '';
      res.on('data', c => { chunks += c; });
      res.on('error', reject);
      res.on('aborted', () => reject(netError('response aborted', 'ECONNRESET')));
      res.on('close', () => reject(netError('response closed before end', 'ECONNRESET')));
      res.on('end', () => {
        let parsed;
        try { parsed = chunks ? JSON.parse(chunks) : null; } catch (_) { parsed = chunks; }
        if (res.statusCode >= 400) return reject(Object.assign(new Error(`HTTP ${res.statusCode}`), { body: parsed, statusCode: res.statusCode }));
        resolve(parsed);
      });
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => req.destroy(netError('no answer within ' + timeoutMs + ' ms', 'ETIMEDOUT')));
    if (data) req.write(data);
    req.end();
  });
}


// ── Work windows ──────────────────────────────────────────────────────
// A run may carry schedule { start, end, hardEnd } (local "HH:MM"; a window
// may cross midnight). No node STARTS outside [start, end); a node still
// running at hardEnd is stopped and re-queued for the next window. hardEnd
// defaults to end and must not come before it.
const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;
const toMin = (s) => { const m = HHMM.exec(String(s || '')); return m ? Number(m[1]) * 60 + Number(m[2]) : null; };
function validRunSchedule(s) {
  if (s === undefined || s === null) return null;
  const start = toMin(s.start), end = toMin(s.end), hard = s.hardEnd === undefined ? end : toMin(s.hardEnd);
  if (start === null || end === null || hard === null || start === end) throw new Error('schedule needs {start:"HH:MM", end:"HH:MM", hardEnd?:"HH:MM"}');
  const len = (x) => ((x - start + 1440) % 1440) || 1440;
  if (len(hard) < len(end)) throw new Error('schedule.hardEnd must not come before schedule.end');
  return { start: s.start, end: s.end, hardEnd: s.hardEnd === undefined ? s.end : s.hardEnd };
}
// { canStart, inHard, msToHardEnd, nextStart } at `now` (local time).
function windowState(s, now = Date.now()) {
  const d = new Date(now);
  const exact = d.getHours() * 60 + d.getMinutes() + d.getSeconds() / 60 + d.getMilliseconds() / 60000;
  const start = toMin(s.start);
  const len = (x) => ((x - start + 1440) % 1440) || 1440;
  const elapsed = (exact - start + 1440) % 1440;
  const lenEnd = len(toMin(s.end)), lenHard = len(toMin(s.hardEnd || s.end));
  return {
    canStart: elapsed < lenEnd,
    inHard: elapsed < lenHard,
    msToHardEnd: elapsed < lenHard ? Math.round((lenHard - elapsed) * 60000) : 0,
    nextStart: now + Math.round((1440 - elapsed) * 60000),
  };
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

module.exports = { deepMerge, renderTemplate, readPath, evalSafe, unreachableFrom, apiRequest, sleep, validRunSchedule, windowState };
