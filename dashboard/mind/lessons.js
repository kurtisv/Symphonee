'use strict';
// Lessons from past failures, per pilot (scope). Every refusal or failed review
// is recorded once per distinct mistake (a repeat increments its count), and the
// most frequent/recent ones are injected into every autopilot prompt (Claude,
// Codex) and into the local Qwen pre-triage, so the loops stop repeating them.
// Token-free: the text is taken from the refusal/finding itself.
const fs = require('fs');
const path = require('path');

const MAX = 200;
const fileOf = (root) => path.join(root, '.symphonee', 'lecons.json');

function load(root) {
  try { const j = JSON.parse(fs.readFileSync(fileOf(root), 'utf8')); return Array.isArray(j.lessons) ? j : { lessons: [] }; }
  catch (_) { return { lessons: [] }; }
}
function save(root, data) {
  const f = fileOf(root);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  const tmp = f + '.tmp-' + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, f);
}
// Same mistake, different commit/ids/numbers -> same key.
function normKey(s) {
  return String(s || '').toLowerCase()
    .replace(/\b[0-9a-f]{7,40}\b/g, '#').replace(/\d+/g, '#')
    .replace(/[`'"*_()[\]{}<>:;,.!?]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 90);
}
// The first concrete finding of a reviewer answer (skips headings and the verdict).
function firstFinding(raw) {
  const lines = String(raw || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
    .filter((l) => !/^VERDICT\b/i.test(l) && !/^#+\s/.test(l) && !/^(no findings|findings:?)$/i.test(l));
  const pick = lines.find((l) => /^(-|\*|\d+\.|\[P\d\])/.test(l)) || lines[0] || '';
  return pick.replace(/^(-|\*|\d+\.)\s*/, '').replace(/\*\*/g, '').slice(0, 300);
}
// Records one lesson; returns { isNew, entry } (entry null when nothing usable).
function record(root, { scope, kind, text, key, source }, now = Date.now()) {
  const t = String(text || '').replace(/\s+/g, ' ').trim().slice(0, 400);
  if (!scope || !t) return { isNew: false, entry: null };
  const k = (kind || 'divers') + ':' + normKey(key || t);
  const data = load(root);
  let e = data.lessons.find((x) => x.scope === scope && x.key === k);
  const isNew = !e;
  if (e) { e.count += 1; e.lastAt = now; e.text = t; e.source = source || e.source; }
  else { e = { scope, kind: kind || 'divers', key: k, text: t, count: 1, firstAt: now, lastAt: now, source: source || null }; data.lessons.push(e); }
  // Keep the file bounded: drop the least useful (rare and old) first.
  if (data.lessons.length > MAX) data.lessons = data.lessons.sort((a, b) => b.count - a.count || b.lastAt - a.lastAt).slice(0, MAX);
  save(root, data);
  return { isNew, entry: e };
}
function top(root, scope, n = 8) {
  return load(root).lessons.filter((x) => x.scope === scope)
    .sort((a, b) => b.count - a.count || b.lastAt - a.lastAt).slice(0, n);
}
function promptText(list) {
  if (!list.length) return '';
  return 'LESSONS FROM PAST FAILURES ON THIS REPOSITORY (mistakes already made here and caught by a reviewer, the local checks or the merge gate; '
    + 'do not repeat them, and check your work against each before finishing):\n'
    + list.map((x) => '- [' + x.kind + (x.count > 1 ? ', ' + x.count + ' fois' : '') + '] ' + x.text).join('\n');
}
// Memory card for Mind (shared with every CLI): only for a NEW lesson.
function memorySpec(entry, repoName) {
  return { title: 'Lecon ' + entry.scope + ' : ' + entry.text.slice(0, 80), body: entry.text + (entry.source ? '\nSource : ' + entry.source : ''),
    kindOfMemory: 'gotcha', tags: ['lecon', 'autopilote', entry.scope, entry.kind], scope: repoName ? { repo: repoName } : undefined, createdBy: 'symphonee-lecons' };
}
module.exports = { load, record, top, promptText, firstFinding, normKey, memorySpec, fileOf };
