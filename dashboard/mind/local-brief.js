'use strict';
// Local pre-triage before an autopilot discovery: a short brief of the
// backlog's P0/P1 items so Claude does not re-read whole backlog files.
//
// 1. Token-free extraction (always): the P0/P1 lines of the configured
//    backlog files, minus excluded topics (e.g. PleinSens for the night loop).
// 2. Optional local model (Qwen in LM Studio): compresses that extract into a
//    few candidate hints. One attempt, loopback only, never a cloud fallback,
//    skipped when free RAM is short. Its output is a HINT: it never validates
//    or decides anything; discovery must verify every claim in the code.
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const PRIORITY = /\bP[01]\b|P0-|P1-|critique|critical/i;
const MAX_EXTRACT = 6000;

function extractPriorities(repoPath, files, { exclude = [] } = {}) {
  const barred = exclude.map((s) => new RegExp(s, 'i'));
  const out = [];
  for (const f of files) {
    let text = '';
    try { text = fs.readFileSync(path.join(repoPath, f), 'utf8'); } catch (_) { continue; }
    const lines = text.split(/\r?\n/);
    let inPrioritySection = false;
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i];
      if (/^#{1,4}\s/.test(l)) inPrioritySection = PRIORITY.test(l);
      const hit = PRIORITY.test(l) || (inPrioritySection && /^\s*([-*]|\d+\.)\s/.test(l));
      if (!hit || !l.trim() || barred.some((re) => re.test(l))) continue;
      out.push(f + ':' + (i + 1) + ' ' + l.trim().slice(0, 300));
    }
  }
  const seen = new Set();
  const uniq = out.filter((l) => { const k = l.replace(/^\S+\s/, ''); if (seen.has(k)) return false; seen.add(k); return true; });
  let s = '', n = 0;
  for (const l of uniq) { if (s.length + l.length > MAX_EXTRACT) break; s += l + '\n'; n++; }
  return { text: s.trim(), lines: n, total: uniq.length };
}

function postJson(url, body, timeoutMs) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const data = JSON.stringify(body);
    const req = http.request({ hostname: u.hostname, port: u.port || 80, path: u.pathname, method: 'POST', timeout: timeoutMs,
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } }, (res) => {
      let buf = ''; res.on('data', (c) => { buf += c; });
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) return reject(new Error('HTTP ' + res.statusCode + ' ' + buf.slice(0, 120)));
        clearTimeout(deadline);
        try { resolve(JSON.parse(buf)); } catch (_) { reject(new Error('invalid JSON')); }
      });
    });
    // Absolute deadline: the socket idle timeout alone lets a slowly streaming
    // answer run past it, which would hold the autopilot tick.
    const deadline = setTimeout(() => req.destroy(new Error('timeout after ' + timeoutMs + ' ms')), timeoutMs);
    deadline.unref?.();
    req.on('timeout', () => req.destroy(new Error('idle timeout after ' + timeoutMs + ' ms')));
    req.on('error', (e) => { clearTimeout(deadline); reject(e); });
    req.on('close', () => clearTimeout(deadline));
    req.end(data);
  });
}

function parseHints(raw) {
  const m = /\{[\s\S]*\}/.exec(String(raw || ''));
  if (!m) return null;
  try {
    const j = JSON.parse(m[0]);
    if (!Array.isArray(j.candidates)) return null;
    return j.candidates.slice(0, 6).map((c) => ({
      priority: String(c.priority || '').slice(0, 4), title: String(c.title || '').slice(0, 200),
      where: String(c.where || '').slice(0, 200), why: String(c.why || '').slice(0, 300) })).filter((c) => c.title);
  } catch (_) { return null; }
}

// def: { provider: { model, baseUrl, timeoutMs, loadRamMB } } ; io for tests.
async function buildBrief({ repoPath, files, exclude = [], attempted = [], sentry = '', local = null }, io = {}) {
  const t0 = Date.now();
  const extract = extractPriorities(repoPath, files, { exclude });
  const brief = { extract: extract.text, lines: extract.lines, total: extract.total, model: null, hints: null, skipped: null, ms: 0 };
  if (!local || !extract.text) { brief.skipped = !local ? 'no local model configured' : 'no P0/P1 line found'; return brief; }
  const freeMB = Math.round((io.freemem || os.freemem)() / 1048576);
  if (freeMB < (local.loadRamMB || 7000) + 1500) { brief.skipped = 'free RAM ' + freeMB + ' MB too low for ' + local.model; brief.ms = Date.now() - t0; return brief; }
  const prompt = [
    'Backlog lines (P0/P1) of a mobile app repository:', extract.text,
    sentry ? 'Production error summary:\n' + String(sentry).slice(0, 2000) : '',
    attempted.length ? 'Already attempted (do not propose again):\n' + attempted.slice(0, 20).map((t) => '- ' + t).join('\n') : '',
    'Pick at most 5 items still worth doing, most severe first. Answer ONLY JSON: {"candidates":[{"priority":"P0|P1","title":"...","where":"file or area named in the line","why":"one sentence quoting the line"}]}.',
    'Use only the lines above; do not invent files.'].filter(Boolean).join('\n\n');
  try {
    const r = await (io.post || postJson)((local.baseUrl || 'http://127.0.0.1:1234') + '/v1/chat/completions', {
      model: local.model, temperature: 0, max_tokens: 900, ttl: 300, // LM Studio unloads it 5 min after
      messages: [{ role: 'system', content: 'You condense backlogs into short JSON. No prose.' }, { role: 'user', content: prompt }] },
      local.timeoutMs || 240000);
    const raw = r && r.choices && r.choices[0] && r.choices[0].message && r.choices[0].message.content;
    brief.hints = parseHints(raw);
    brief.model = local.model;
    brief.usage = r && r.usage ? { prompt: r.usage.prompt_tokens, completion: r.usage.completion_tokens } : null;
    if (!brief.hints) brief.skipped = 'local model answer unusable';
  } catch (e) { brief.skipped = 'local model unavailable: ' + String(e.message).slice(0, 120); }
  brief.ms = Date.now() - t0;
  return brief;
}

function briefText(b) {
  if (!b || !b.extract) return '';
  return ['LOCAL PRE-TRIAGE (token-free extract of the backlog P0/P1 lines' + (b.hints ? ', condensed by local ' + b.model : '') + ').',
    'These are UNVERIFIED hints. Start from them instead of re-reading the whole backlog files; open a backlog file only to confirm the item you pick, and verify every claim in the code.',
    b.hints && b.hints.length ? 'Local hints: ' + JSON.stringify(b.hints) : '',
    'Extract (' + b.lines + '/' + b.total + ' lines):\n' + b.extract].filter(Boolean).join('\n');
}

module.exports = { extractPriorities, buildBrief, briefText, parseHints, postJson };
