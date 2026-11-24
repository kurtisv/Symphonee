'use strict';
// Verified solutions: an independent solution that already passed the proof (behaviour test red/green, the repository checks, an independent
// review) can be handed to Qwen as GUIDANCE when Qwen failed even with Claude's coaching. Qwen still applies it itself, and the result goes through
// the same gates as any change: nothing here certifies new code. A solution applies only under its recorded conditions (same files, the same
// content of those files as when it was verified, the same kind of task); outside them it is simply not used.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const FILE = (root) => path.join(root, '.symphonee', 'verified-solutions.json');
const GUIDANCE_MAX = 9000;
const MAX_SOLUTIONS = 60;
const SAFE_ID = /^[a-z0-9][a-z0-9._-]{0,60}$/;

function read(root) {
  try {
    const j = JSON.parse(fs.readFileSync(FILE(root), 'utf8'));
    if (!j || !Array.isArray(j.solutions)) return { solutions: [], error: 'unexpected shape' };
    return { solutions: j.solutions.filter((s) => s && typeof s === 'object' && typeof s.id === 'string') };
  } catch (e) {
    return e.code === 'ENOENT' ? { solutions: [] } : { solutions: [], error: e.message };
  }
}

function write(root, solutions) {
  const file = FILE(root);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp-' + process.pid;
  fs.writeFileSync(tmp, JSON.stringify({ solutions }, null, 2));
  fs.renameSync(tmp, file);
}

const cut = (x, n) => String(x == null ? '' : x).trim().slice(0, n);

// Validates and stores (or replaces, by id) one solution. Evidence is mandatory: a solution without proof is never stored.
function add(root, input) {
  const s = input || {};
  if (!SAFE_ID.test(String(s.id || ''))) throw new Error('id must match ' + SAFE_ID);
  const guidance = cut(s.guidance, GUIDANCE_MAX + 1);
  if (!guidance) throw new Error('guidance is required');
  if (guidance.length > GUIDANCE_MAX) throw new Error('guidance longer than ' + GUIDANCE_MAX + ' characters');
  const files = (Array.isArray(s.files) ? s.files : []).map((f) => cut(f, 300).replace(/\\/g, '/')).filter(Boolean).slice(0, 12);
  if (!files.length) throw new Error('at least one file is required (the conditions of applicability)');
  const keywords = (Array.isArray(s.keywords) ? s.keywords : []).map((k) => cut(k, 60).toLowerCase()).filter(Boolean).slice(0, 12);
  const proof = (Array.isArray(s.evidence && s.evidence.proof) ? s.evidence.proof : []).map((p) => cut(p, 300)).filter(Boolean).slice(0, 12);
  if (!proof.length) throw new Error('evidence.proof is required: a solution without proof is never stored');
  const blobs = {};
  for (const [f, b] of Object.entries(s.fileBlobs || {})) if (/^[0-9a-f]{40}$/.test(String(b))) blobs[String(f).replace(/\\/g, '/')] = String(b);
  const entry = {
    id: s.id, scope: cut(s.scope, 120) || null, title: cut(s.title, 240), files, keywords,
    minKeywords: Number.isInteger(s.minKeywords) ? Math.max(0, Math.min(s.minKeywords, keywords.length)) : Math.min(2, keywords.length),
    fileBlobs: blobs, conditions: cut(s.conditions, 600), guidance,
    evidence: { proof, source: cut(s.evidence && s.evidence.source, 200), verifiedAt: cut(s.evidence && s.evidence.verifiedAt, 40) || new Date().toISOString() },
    createdBy: cut(s.createdBy, 60) || 'unknown', createdAt: new Date().toISOString(), uses: 0, confirmed: 0, failed: 0, retired: false,
  };
  const all = read(root);
  if (all.error) throw new Error('the store is unreadable (' + all.error + '): refusing to overwrite it');
  const list = all.solutions.filter((x) => x.id !== entry.id);
  const old = all.solutions.find((x) => x.id === entry.id);
  if (old) { entry.uses = old.uses || 0; entry.confirmed = old.confirmed || 0; entry.failed = old.failed || 0; }
  list.push(entry);
  write(root, list.slice(-MAX_SOLUTIONS));
  return entry;
}

function remove(root, id) {
  const all = read(root);
  if (all.error) throw new Error('the store is unreadable (' + all.error + ')');
  write(root, all.solutions.filter((x) => x.id !== id));
}

// A solution that failed twice after being relayed is retired by itself (it stays in the file for inspection, but is no longer used).
function recordOutcome(root, id, outcome) {
  const all = read(root);
  if (all.error) return false;
  const s = all.solutions.find((x) => x.id === id);
  if (!s) return false;
  if (outcome === 'completed') s.confirmed = (s.confirmed || 0) + 1;
  else { s.failed = (s.failed || 0) + 1; if (s.failed >= 2 && !(s.confirmed > 0)) s.retired = true; }
  s.lastUsedAt = new Date().toISOString();
  write(root, all.solutions);
  return true;
}

function recordUse(root, id) {
  const all = read(root);
  if (all.error) return false;
  const s = all.solutions.find((x) => x.id === id);
  if (!s) return false;
  s.uses = (s.uses || 0) + 1; s.lastUsedAt = new Date().toISOString();
  write(root, all.solutions);
  return true;
}

function blobOf(repoPath, sha, file) {
  const r = spawnSync('git', ['rev-parse', '--verify', sha + ':' + file], { cwd: repoPath, encoding: 'utf8', timeout: 15000, windowsHide: true });
  return r.status === 0 ? String(r.stdout).trim() : null;
}

// The solution that applies to this task, or null with the reason. namedFiles = the tracked files the approved plan names.
function find(root, { scope, plan, namedFiles, repoPath, baseSha }) {
  const all = read(root);
  if (all.error) return { solution: null, reason: 'store unreadable: ' + all.error };
  const text = [plan && plan.title, plan && plan.objective, ...((plan && plan.evidence) || []).map((x) => typeof x === 'string' ? x : JSON.stringify(x))].join(' ').toLowerCase();
  const named = new Set((namedFiles || []).map((f) => String(f).replace(/\\/g, '/')));
  const why = [];
  for (const s of all.solutions) {
    if (s.retired) { why.push(s.id + ': retired'); continue; }
    if (s.scope && scope && s.scope !== scope) { why.push(s.id + ': another scope'); continue; }
    if (!s.files.every((f) => named.has(f))) { why.push(s.id + ': files not named by the plan'); continue; }
    const hits = (s.keywords || []).filter((k) => text.includes(k)).length;
    if (hits < (s.minKeywords || 0)) { why.push(s.id + ': the task does not look like it (' + hits + '/' + s.minKeywords + ' keywords)'); continue; }
    const stale = Object.entries(s.fileBlobs || {}).filter(([f, b]) => !baseSha || !repoPath || blobOf(repoPath, baseSha, f) !== b).map(([f]) => f);
    if (stale.length) { why.push(s.id + ': ' + stale.join(', ') + ' changed since the solution was verified'); continue; }
    return { solution: s, reason: 'applies' };
  }
  return { solution: null, reason: why.length ? why.join('; ').slice(0, 400) : 'no verified solution stored' };
}

// A solution drawn from a task Claude finished after Qwen gave up: only from a change that passed everything (checks, behaviour gate, review, commit).
// The diff is the "independent solution": bounded, and never stored when it does not fit (a truncated diff would mislead Qwen).
function fromCommit({ repoPath, baseSha, commit, plan, scope, proof, createdBy }) {
  const diff = spawnSync('git', ['diff', '--no-color', '-U3', baseSha, commit], { cwd: repoPath, encoding: 'utf8', timeout: 20000, windowsHide: true, maxBuffer: 8 * 1024 * 1024 });
  if (diff.status !== 0) return { ok: false, reason: 'git diff failed' };
  const names = spawnSync('git', ['diff', '--name-only', baseSha, commit], { cwd: repoPath, encoding: 'utf8', timeout: 20000, windowsHide: true });
  const changed = String(names.stdout || '').split('\n').filter(Boolean);
  const isTest = (f) => /(^|\/)(__tests__|tests?)\/|\.(test|spec)\.[a-z]+$/i.test(f);
  const source = changed.filter((f) => !isTest(f) && !/^docs\//.test(f));
  if (!source.length) return { ok: false, reason: 'no source file changed' };
  if (!changed.some(isTest)) return { ok: false, reason: 'no behaviour test in the change' };
  const head = 'INDEPENDENT SOLUTION ALREADY VERIFIED (checks, behaviour test red then green, independent review) on this same code. It is a REFERENCE: apply the same design yourself with SEARCH/REPLACE blocks, use only names that exist in the file, and create the test file it contains. The host checks your result like any other change.\n';
  const guidance = head + String(diff.stdout);
  if (guidance.length > GUIDANCE_MAX) return { ok: false, reason: 'the change is longer than ' + GUIDANCE_MAX + ' characters' };
  const blobs = {}; for (const f of source) { const b = blobOf(repoPath, baseSha, f); if (b) blobs[f] = b; }
  const words = [...new Set(String(plan && plan.title || '').toLowerCase().match(/[a-z_][a-z0-9_]{5,}/g) || [])].slice(0, 6);
  return { ok: true, solution: { id: 'auto-' + crypto.createHash('sha256').update(String(commit)).digest('hex').slice(0, 10), scope, title: plan && plan.title, files: source, fileBlobs: blobs,
    keywords: words, minKeywords: Math.min(2, words.length), conditions: 'Same files with the same content as when verified (commit ' + String(commit).slice(0, 10) + '); the same kind of task.', guidance,
    evidence: { proof, source: 'commit ' + String(commit).slice(0, 10) }, createdBy: createdBy || 'autopilot' } };
}

module.exports = { FILE, GUIDANCE_MAX, read, add, remove, find, recordUse, recordOutcome, fromCommit, blobOf };
