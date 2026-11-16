'use strict';
// Concrete backlog and admission rules for a pilot that works on the engine it runs on.
// Everything here is read-only against the real data (pilot history, merge gate state, git branch names) and deterministic:
// the priority is decided BEFORE any model is chosen, and a task that is not justified is refused by code, not by a prompt.
const fs = require('node:fs');
const path = require('node:path');

// Priority classes, most serious first (the user's order). The discovery contract uses the SEVERITY names.
const CLASSES = Object.freeze([
  { n: 1, severity: 'lost-work', label: 'lost work, wrong repository target, incorrect execution or merge' },
  { n: 2, severity: 'stuck-loop', label: 'blocked loops, defective resumption, repeated tasks' },
  { n: 3, severity: 'wrong-state', label: 'inaccurate displayed state, user decision not transmitted' },
  { n: 4, severity: 'measured-slowness', label: 'measured slowness' },
  { n: 5, severity: 'cleanup-proven', label: 'simplification or cleanup that removes a demonstrated problem' },
]);

// Paths a routine task may NEVER touch: the loop's own permissions, approval criteria, merge policy and protections, isolation and
// memory-certification rules. Changing one needs a dedicated, explicitly authorised mission (a different pilot definition).
// Enforced by the engine (merged into the pilot's protected paths), not by the prompt.
const ENGINE_PROTECTED = Object.freeze([
  '^dashboard/permissions\\.js$', '^dashboard/server\\.js$', '^dashboard/preload[^/]*\\.js$', '^main\\.js$', '^dashboard/automation/', '^scripts/merge-gate\\.js$', '^scripts/api-token\\.js$', '^scripts/_ApiInit\\.ps1$',
  '^dashboard/mind/autopilot[^/]*\\.js$', '^dashboard/mind/usage-capacity[^/]*\\.js$', '^dashboard/mind/lesson[^/]*\\.js$', '^dashboard/mind/qwen-[^/]*\\.js$',
  '^dashboard/orchestrator/', '^dashboard/orchestrator\\.js$', '^dashboard/mind/(security|lock|checkpoint)\\.js$',
  '^FUSION_AUTOMATIQUE\\.md$', '^docs/FUSION_AUTOMATIQUE\\.md$', '(^|/)AGENTS\\.md$', '(^|/)CLAUDE\\.md$', '(^|/)GEMINI\\.md$', '^\\.github/',
  '^\\.symphonee/', '^config/', '(^|/)package(-lock)?\\.json$', '(^|/)\\.env', 'secret',
]);

const STOP = new Set('the a an of to in on for and or with from by is are be this that it as at not no into when than then'.split(' '));
const tokens = (s) => new Set(String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').split(' ').filter((w) => w.length > 2 && !STOP.has(w)));
function similarity(a, b) {
  const A = tokens(a), B = tokens(b);
  if (!A.size || !B.size) return 0;
  let n = 0; for (const t of A) if (B.has(t)) n++;
  const jac = n / (A.size + B.size - n), small = Math.min(A.size, B.size);
  // The same task described with an extra clause ("... and add tests") keeps almost all of the shorter title: containment counts too.
  return small >= 4 && n / small >= 0.8 ? Math.max(jac, n / small) : jac;
}
const SIMILAR = 0.6;
// An observation: a location (file:line), an error or exception, a failing test, expected/actual values, a measured duration.
const OBSERVABLE = /:\d+\b|\bline \d+|\b(error|exception|throws?|threw|crash(es|ed)?|fails?|failed|failing|stuck|hangs?|loop(s|ed)? forever|expected|actual|returns?|exit(ed)? (code )?\d|ENOENT|EPERM|undefined|NaN|null)\b|\b\d+(\.\d+)?\s?(ms|s|sec|seconds|min)\b/i;
const WEAK_EVIDENCE = /\b(TODO|FIXME|XXX)\b|no (neighbou?ring |adjacent |unit )?tests?\b|missing (a )?(neighbou?ring |unit )?tests?\b|lacks? (a )?tests?\b|\b\d{3,5}[- ]lines?( long)?\b|large file|big file|too (long|large|big)/i;
// A branch name is a short slug: what matters is how much of it the plan covers.
function coverage(slug, text) { const A = tokens(String(slug).replace(/\d{4}-\d{2}-\d{2}/g, ' ')), B = tokens(text); if (A.size < 3) return 0; let n = 0; for (const t of A) if (B.has(t)) n++; return n / A.size; }
const FAILED = new Set(['interrupted', 'verify-failed', 'review-rejected', 'plan-rejected', 'stuck', 'failed', 'repair-exhausted', 'abandoned']);

// Tasks that failed again and again, with the diagnosis kept: a blocked task is kept, not retried (a new element is required).
function blockedTasks(history, maxAttempts = 3) {
  const groups = [];
  for (const h of history || []) {
    if (!h || !h.title || h.title === '(discovery)' || h.title === '(interrupted)') continue;
    let g = groups.find((x) => similarity(x.title, h.title) >= SIMILAR);
    if (!g) groups.push(g = { title: h.title, attempts: [], done: false });
    if (h.outcome === 'completed') g.done = true;
    else if (FAILED.has(h.outcome)) g.attempts.push({ outcome: h.outcome, at: h.at || null, why: String(h.reviewerEvidence || '').replace(/\s+/g, ' ').slice(0, 240) });
  }
  return groups.filter((g) => !g.done && g.attempts.length >= maxAttempts).map((g) => ({
    title: g.title, attempts: g.attempts.length, outcomes: [...new Set(g.attempts.map((x) => x.outcome))], last: g.attempts[g.attempts.length - 1],
    diagnosis: (g.attempts.slice().reverse().find((x) => x.why) || {}).why || 'no diagnosis recorded' }));
}

function readJson(f) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (_) { return null; } }
// { data } | { missing: true } | { error }: only a missing file means "nothing in flight"; an unreadable one is unknown.
function readGate(f) {
  if (!f) return { missing: true };
  let raw; try { raw = fs.readFileSync(f, 'utf8'); } catch (e) { return e && e.code === 'ENOENT' ? { missing: true } : { error: String(e && e.message || e) }; }
  let data; try { data = JSON.parse(raw); } catch (e) { return { error: 'invalid JSON: ' + e.message }; }
  if (!data || typeof data !== 'object' || Array.isArray(data) || typeof data.candidates !== 'object' || !data.candidates || Array.isArray(data.candidates) || (data.merges !== undefined && !Array.isArray(data.merges))) return { error: 'unexpected shape (no candidates object)' };
  return { data };
}

// Real signals only. Each: { class, severity, key, text, evidence }.
function collectBacklog({ history = [], events = [], error = null, gatePath = null, repoName = null, pilotId = 'default', now = Date.now() }) {
  const out = [];
  const add = (cls, key, text, evidence) => out.push({ class: cls, severity: CLASSES[cls - 1].severity, key, text: String(text).slice(0, 220), evidence: String(evidence || '').slice(0, 300) });
  for (const b of blockedTasks(history, 1)) add(2, 'repeat:' + b.title.slice(0, 40), (b.attempts > 1 ? 'Task repeated without success (' + b.attempts + 'x ' : 'Task ended without success (') + b.outcomes.join('/') + '): ' + b.title, b.diagnosis);
  const gr = readGate(gatePath), g = gr.data || null;
  if (gr.error) add(1, 'gate-unreadable', 'The merge gate state is unreadable: ' + String(gr.error).slice(0, 120), 'cannot see candidates, merges or the stop flag');
  if (g) {
    if (g.stopped) add(1, 'gate-stopped', 'The merge gate is STOPPED: ' + String(g.stopped.reason || '').slice(0, 160), 'gate state: stopped at ' + (Number.isFinite(new Date(Number(g.stopped.at)).getTime()) ? new Date(Number(g.stopped.at)).toISOString() : 'an unknown time'));
    for (const c of Object.values(g.candidates || {})) {
      if (!c || typeof c !== 'object') continue;
      if (repoName && c.repo !== repoName) continue;
      if (c.status === 'refused') {
        const last = (Array.isArray(c.history) ? c.history : []).filter((x) => x && x.status === 'refused').pop();
        add(1, 'gate-refused:' + c.key, 'A finished task was refused by the merge gate (' + String((c.origin && c.origin.title) || c.branch).slice(0, 80) + ')', last && last.note);
      }
    }
    for (const m of Array.isArray(g.merges) ? g.merges : []) if (m && m.status === 'failed-after-merge') add(1, 'merge-failed:' + m.key, 'A merged change failed after the merge (PR #' + m.pr + ')', 'gate merges list');
  }
  const recent = (events || []).filter((e) => e && /error|halt|fail/i.test(String(e.kind)) && now - Date.parse(e.at || 0) < 7 * 86400000);
  for (const e of recent.slice(-3)) add(2, 'event:' + String(e.msg).slice(0, 40), 'Engine event: ' + String(e.msg).slice(0, 120), e.kind + ' at ' + e.at);
  if (error) add(2, 'pilot-error', 'The pilot is halted by an error', String(error).slice(0, 200));
  const failedVerify = (history || []).slice(-10).filter((h) => h && h.outcome === 'verify-failed');
  for (const h of failedVerify.slice(-2)) add(2, 'verify-failed:' + h.title.slice(0, 40), 'A task ended with its verification failing: ' + h.title.slice(0, 100), (h.trace && JSON.stringify(h.trace).slice(0, 200)) || h.outcome);
  return out.sort((a, b) => a.class - b.class);
}

// In-flight or already-done work, to refuse a duplicate before spending a model on it.
function inFlight({ history = [], queue = [], gatePath = null, repoName = null, pilotId = 'default', branches = [], active = null }) {
  const items = [];
  for (const h of history) if (h && h.outcome === 'completed' && h.title) items.push({ where: 'done', title: h.title });
  for (const q of queue) if (q && q.plan) items.push({ where: 'queued', title: q.plan.title });
  if (active && active.title) items.push({ where: 'the active task', title: active.title });
  const gr = readGate(gatePath), g = gr.data || null;
  if (gr.error) items.degraded = gr.error;
  if (g && Object.values(g.candidates || {}).some((c) => !c || typeof c !== 'object' || Array.isArray(c) || typeof c.repo !== 'string' || typeof c.status !== 'string' || typeof c.branch !== 'string' || typeof c.source !== 'string' || (c.source === 'autopilot' && (!repoName || c.repo === repoName) && !['confirmed', 'merged', 'refused'].includes(c.status) && !(c.origin && typeof c.origin.title === 'string' && c.origin.title.length > 0)))) items.degraded = 'a candidate entry of the gate state is damaged';
  if (g) for (const c of Object.values(g.candidates || {})) {
    if (!c || typeof c !== 'object') continue;
    if ((repoName && c.repo !== repoName) || (c.origin && c.origin.pilot && c.origin.pilot !== pilotId)) continue;
    if (!['confirmed', 'merged', 'refused'].includes(c.status) && c.origin && c.origin.title) items.push({ where: 'awaiting merge (' + c.status + (c.pr ? ', PR #' + c.pr : '') + ')', title: c.origin.title });
  }
  for (const b of branches) items.push({ where: 'branch', title: String(b).replace(/^.*mind-autopilot\//, '').replace(/^\d{4}-\d{2}-\d{2}-?/, '').replace(/[-_/]+/g, ' ') });
  return items;
}

// Admission: the engine's own gate on a discovered plan. -> { ok, reason, code }.
function admit(plan, ctx) {
  const { history = [], queue = [], opts = {} } = ctx;
  if (!plan || plan.decision === 'NO_TASK') return { ok: true };
  const text = plan.title + ' ' + plan.objective;
  const flight = inFlight(ctx);
  if (flight.degraded && opts.strict) return { ok: false, code: 'unverifiable', reason: 'the merge gate state exists but cannot be read (' + String(flight.degraded).slice(0, 100) + '): in-flight work cannot be checked, so no new task is admitted' };
  const dup = flight.find((x) => (x.where === 'branch' ? (tokens(String(x.title).replace(/\d{4}-\d{2}-\d{2}/g, ' ')).size >= 3 && coverage(x.title, plan.title) >= 0.85) : (similarity(text, x.title) >= SIMILAR || similarity(plan.title, x.title) >= SIMILAR)));
  if (dup) return { ok: false, code: 'duplicate', reason: 'duplicates work that is ' + dup.where + ': ' + String(dup.title).slice(0, 90) };
  const rejectedAll = (ctx.rejected || []).concat((history || []).filter((h) => h && ['plan-rejected', 'review-rejected'].includes(h.outcome)).map((h) => ({ title: h.title, evidence: String(h.reviewerEvidence || '') + ' ' + (h.evidence || []).join(' ') })))
    .filter((r) => r && r.title && similarity(plan.title, r.title) >= SIMILAR);
  const rejected = rejectedAll[0];
  if (rejected && !blockedTasks(history, opts.maxAttempts || 3).some((b) => similarity(plan.title, b.title) >= SIMILAR)) {
    const ne = String(plan.newEvidence || '').trim();
    if (ne.length < 20) return { ok: false, code: 'blocked', reason: 'a similar plan was already REJECTED by review and this one states no new element (newEvidence)' };
    if (rejectedAll.some((r) => similarity(ne, String(r.evidence || '')) >= 0.6)) return { ok: false, code: 'blocked', reason: 'the stated new element repeats what the rejecting review already said' };
  }
  const blocked = blockedTasks(history, opts.maxAttempts || 3).find((b) => similarity(plan.title, b.title) >= SIMILAR);
  if (blocked) {
    const ne = String(plan.newEvidence || '').trim(), maxA = opts.maxAttempts || 3;
    if (blocked.attempts >= maxA * 2) return { ok: false, code: 'blocked', reason: 'was attempted ' + blocked.attempts + ' times: it needs a human decision or a dedicated mission, not another attempt' };
    if (ne.length < 20) return { ok: false, code: 'blocked', reason: 'was attempted ' + blocked.attempts + ' times without success (' + blocked.outcomes.join(', ') + ') and the plan states no new element (newEvidence)' };
    if (rejectedAll.some((r) => similarity(ne, String(r.evidence || '')) >= 0.6)) return { ok: false, code: 'blocked', reason: 'the stated new element repeats what a rejecting review already said' };
    const seen = (history || []).filter((h) => h && h.title && similarity(plan.title, h.title) >= SIMILAR).flatMap((h) => [h.newEvidence, h.reviewerEvidence]).filter(Boolean);
    if (seen.some((x) => similarity(ne, x) >= 0.6)) return { ok: false, code: 'blocked', reason: 'the stated new element repeats what was already known about the failed attempts' };
  }
  if (opts.strict) {
    const ev = (plan.evidence || []).map(String);
    if (!ev.some((e) => OBSERVABLE.test(e) && !WEAK_EVIDENCE.test(e))) return { ok: false, code: 'unjustified', reason: 'no evidence item states an observation (file:line, an error, a failing test, an expected/actual value or a measure): a TODO, a file size or a missing neighbouring test does not justify a change' };
    if (plan.category === 'cleanup' && !(plan.severity === 'cleanup-proven' && plan.proof !== 'inferred')) return { ok: false, code: 'unjustified', reason: 'a cleanup needs severity cleanup-proven and a proof that the code is unused (including dynamic and plugin loading)' };
    if (plan.proof === 'inferred' && !(ctx.signals || []).some((s) => similarity(text, s.text) >= 0.3)) return { ok: false, code: 'unjustified', reason: 'proof is only "inferred" and the task matches no backlog signal: a TODO, a large file or a missing neighbouring test does not justify a change' };
    if (plan.severity === 'other' && plan.category !== 'correctness' && plan.category !== 'testing') return { ok: false, code: 'unjustified', reason: 'severity "other" is not one of the five priority classes' };
  }
  return { ok: true };
}

const rank = (severity) => { const c = CLASSES.find((x) => x.severity === severity); return c ? c.n : 9; };
module.exports = { CLASSES, ENGINE_PROTECTED, similarity, blockedTasks, collectBacklog, inFlight, admit, rank, tokens, FAILED, SIMILAR };
