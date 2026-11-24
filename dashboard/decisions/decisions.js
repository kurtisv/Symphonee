'use strict';
// Decisions ("ask the user"): a small channel for an agent that needs the
// user's opinion. The agent posts a question with choices, the user answers
// from the Bureau tab, and the agent reads the answer (or gets a one-line hint
// in its own terminal). Nothing here decides anything: it only carries a
// question out and an answer back.
//
//   POST /api/decisions          { title, body?, options?, allowText?, from?, ref?, termId? }
//   GET  /api/decisions          { pending, recent }
//   GET  /api/decisions/item?id= one decision, with its answer once given
//   POST /api/decisions/answer   { id, choice?, text? }
//   POST /api/decisions/dismiss  { id }
//
// Everything stored is plain data. Text is stripped of control characters and
// bounded; the Bureau escapes it before showing it. An answer is the user's own
// words, but it is still only data for the agent.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const LIMITS = { title: 200, body: 4000, label: 120, from: 80, ref: 200, answerText: 1000, options: 6, pending: 30, keep: 50 };
const ID_RE = /^[A-Za-z0-9_-]{1,40}$/;
const TERM_RE = /^[A-Za-z0-9_-]{1,64}$/;
const DEC_RE = /^dec_[0-9a-f]{8}$/;

// No control characters (tabs and newlines are kept in bodies), bounded length.
function clean(value, max, keepNewlines) {
  const re = keepNewlines ? /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g : /[\x00-\x1f\x7f]/g;
  return String(value == null ? '' : value).replace(re, keepNewlines ? '' : ' ').trim().slice(0, max);
}

// Validate and normalise a new decision. Returns { value } or { error }.
function normalizeNew(input) {
  const b = input && typeof input === 'object' ? input : {};
  const title = clean(b.title, LIMITS.title);
  if (!title) return { error: 'title is required' };
  let options = [];
  if (b.options !== undefined && !Array.isArray(b.options)) return { error: 'options must be a list' };
  for (const raw of (b.options || [])) {
    const o = typeof raw === 'string' ? { id: null, label: raw } : (raw || {});
    const label = clean(o.label, LIMITS.label);
    if (!label) return { error: 'every option needs a label' };
    options.push({ id: o.id == null ? null : String(o.id), label });
  }
  if (options.length > LIMITS.options) return { error: 'at most ' + LIMITS.options + ' options' };
  // Ids default to o1, o2... and must be unique and simple: they travel in a URL-free body.
  const seen = new Set();
  options = options.map((o, i) => ({ id: o.id || 'o' + (i + 1), label: o.label }));
  for (const o of options) {
    if (!ID_RE.test(o.id)) return { error: 'option ids are letters, digits, _ or - (40 max)' };
    if (seen.has(o.id)) return { error: 'duplicate option id ' + o.id };
    seen.add(o.id);
  }
  const allowText = b.allowText === undefined ? options.length === 0 : !!b.allowText;
  if (!options.length && !allowText) return { error: 'a question needs options or allowText' };
  const termId = b.termId == null || b.termId === '' ? null : String(b.termId);
  if (termId && !TERM_RE.test(termId)) return { error: 'termId is not a valid terminal id' };
  // Optional plain-data context (an autopilot names its pilot, task, stage, category and consequences): fixed keys, bounded strings.
  const meta = {};
  for (const k of META_KEYS) if (b.meta && b.meta[k] != null) meta[k] = clean(b.meta[k], k === 'consequences' ? 1500 : 300, true);
  return { value: { title, body: clean(b.body, LIMITS.body, true), options, allowText, from: clean(b.from, LIMITS.from) || null, ref: clean(b.ref, LIMITS.ref) || null, termId, meta } };
}
const META_KEYS = ['pilot', 'pilotLabel', 'task', 'stage', 'category', 'consequences', 'suspendedId', 'kind'];

// The store keeps decisions in memory and mirrors them to a JSON file.
function createStore({ file, now = Date.now, newId = () => 'dec_' + crypto.randomBytes(4).toString('hex') } = {}) {
  let items = [];
  function load() {
    if (!file) return;
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (Array.isArray(parsed)) items = parsed.filter((d) => d && DEC_RE.test(String(d.id)));
    } catch (_) { items = []; }
  }
  function save() {
    // Keep every pending decision and the most recent finished ones.
    const open = items.filter((d) => d.status === 'pending');
    const done = items.filter((d) => d.status !== 'pending').sort((a, b) => (b.answeredAt || b.createdAt) - (a.answeredAt || a.createdAt)).slice(0, LIMITS.keep);
    items = open.concat(done).sort((a, b) => a.createdAt - b.createdAt);
    if (!file) return true;
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const tmp = file + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(items, null, 2));
      fs.renameSync(tmp, file);
      return true;
    } catch (_) { return false; } // the caller undoes the change and reports it: an answer is never "recorded" when it is not on disk
  }
  load();

  return {
    create(input) {
      const n = normalizeNew(input);
      if (n.error) return { error: n.error };
      if (items.filter((d) => d.status === 'pending').length >= LIMITS.pending) return { error: 'too many pending decisions (' + LIMITS.pending + '); answer or dismiss some first', code: 429 };
      let id = newId();
      while (items.some((d) => d.id === id)) id = newId();
      const d = Object.assign({ id, status: 'pending', createdAt: now(), answeredAt: null, answer: null, notified: null }, n.value);
      items.push(d);
      if (!save()) { items = items.filter((x) => x !== d); return { error: 'the decision could not be written to disk', code: 500 }; }
      return { decision: d };
    },
    list() {
      const pending = items.filter((d) => d.status === 'pending');
      const recent = items.filter((d) => d.status !== 'pending').sort((a, b) => (b.answeredAt || 0) - (a.answeredAt || 0)).slice(0, 10);
      return { pending, recent };
    },
    get(id) { return items.find((d) => d.id === id) || null; },
    answer(id, input) {
      const d = this.get(id);
      if (!d) return { error: 'decision not found', code: 404 };
      if (d.status !== 'pending') return { error: 'decision is already ' + d.status, code: 409 };
      const b = input && typeof input === 'object' ? input : {};
      const choice = b.choice == null || b.choice === '' ? null : String(b.choice);
      const text = clean(b.text, LIMITS.answerText);
      if (choice !== null && !d.options.some((o) => o.id === choice)) return { error: 'unknown choice' };
      if (choice === null && !text) return { error: 'answer with a choice or some text' };
      if (text && !d.allowText) return { error: 'this question takes a choice only' };
      // Who answered (the page, the phone, or a policy the owner set): recorded, never used to decide.
      const by = ['ui', 'phone', 'bureau', 'policy'].includes(b.by) ? b.by : 'ui';
      d.status = 'answered'; d.answeredAt = now(); d.answer = { choice, text: text || null, by };
      if (!save()) { d.status = 'pending'; d.answeredAt = null; d.answer = null; return { error: 'the answer could not be written to disk; nothing was recorded, try again', code: 500 }; }
      return { decision: d };
    },
    dismiss(id) {
      const d = this.get(id);
      if (!d) return { error: 'decision not found', code: 404 };
      if (d.status !== 'pending') return { error: 'decision is already ' + d.status, code: 409 };
      d.status = 'dismissed'; d.answeredAt = now();
      if (!save()) { d.status = 'pending'; d.answeredAt = null; return { error: 'the decision could not be written to disk', code: 500 }; }
      return { decision: d };
    },
    markNotified(id, ok) { const d = this.get(id); if (d) { d.notified = !!ok; save(); } },
    _items: () => items,
  };
}

// The line typed into the asking agent's terminal when its question is answered.
function hintFor(d) {
  const picked = d.answer && d.answer.choice ? (d.options.find((o) => o.id === d.answer.choice) || {}).label : '';
  const said = [picked, d.answer && d.answer.text].filter(Boolean).join(' / ');
  return clean('[DECISION ANSWERED ' + d.id + '] ' + (d.status === 'dismissed' ? 'dismissed by the user' : said) + '. Read it: GET /api/decisions/item?id=' + d.id, 300);
}

// ONE store per file in the process: the routes and the autopilot read and write the same decisions (two copies in memory would overwrite each other).
const shared = new Map();
function sharedStore(repoRoot) {
  const file = path.join(repoRoot, '.symphonee', 'decisions.json');
  if (!shared.has(file)) shared.set(file, createStore({ file }));
  return shared.get(file);
}

function mountDecisions(addRoute, json, deps) {
  const { repoRoot, broadcast, inject } = deps;
  const { readBody } = require('../lib/http-helpers');
  const store = sharedStore(repoRoot);
  const body = (req) => readBody(req).catch(() => ({}));
  const changed = () => { try { broadcast && broadcast({ type: 'decisions-changed' }); } catch (_) { /* nobody listening */ } };
  const reply = (res, r, status) => (r.error ? json(res, { error: r.error }, r.code || 400) : json(res, { ok: true, decision: r.decision }, status || 200));

  function tellAgent(d) {
    if (!d.termId || typeof inject !== 'function') return;
    let ok = false;
    try { ok = !!(inject(d.termId, hintFor(d)) || {}).ok; } catch (_) { ok = false; }
    store.markNotified(d.id, ok);
  }

  addRoute('GET', '/api/decisions', (_req, res) => json(res, store.list()));
  addRoute('GET', '/api/decisions/item', (req, res) => {
    const id = new URL(req.url, 'http://127.0.0.1').searchParams.get('id') || '';
    const d = DEC_RE.test(id) ? store.get(id) : null;
    return d ? json(res, { ok: true, decision: d }) : json(res, { error: 'decision not found' }, 404);
  });
  addRoute('POST', '/api/decisions', async (req, res) => { const r = store.create(await body(req)); if (!r.error) changed(); reply(res, r, 201); });
  addRoute('POST', '/api/decisions/answer', async (req, res) => {
    const b = await body(req); const r = store.answer(String(b.id || ''), b);
    if (!r.error) { changed(); tellAgent(r.decision); }
    reply(res, r);
  });
  addRoute('POST', '/api/decisions/dismiss', async (req, res) => {
    const b = await body(req); const r = store.dismiss(String(b.id || ''));
    if (!r.error) { changed(); tellAgent(r.decision); }
    reply(res, r);
  });
  return store;
}

module.exports = { LIMITS, clean, normalizeNew, createStore, sharedStore, hintFor, mountDecisions };
