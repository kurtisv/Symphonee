'use strict';
// Plain-language summaries ("En clair") of what the unattended loops did, for
// someone who does not read code.
//
// Two layers, on purpose:
// 1. FACTS, computed by code only (never by a model): is the task finished,
//    what is still missing, the verdicts. This is the part that must be
//    reliable, so no model can change it.
// 2. WORDING, written by Codex from the task's own report: "what was done"
//    and "what it improves", in plain French, with an explicit ban on adding
//    facts; checked by code (no file, path or code token) and cached on disk
//    per item and per source text. Without it the facts are still shown.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const clip = (v, n) => { const t = String(v == null ? '' : v).replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n) + '...' : t; };
const tailOf = (v, n) => { const t = String(v == null ? '' : v).trim(); return t.length > n ? t.slice(-n) : t; };

// ── Facts (pure) ─────────────────────────────────────────────────────────
// state: 'termine' (nothing left to do), 'a-integrer' (work done and approved,
// not yet in the app), 'en-cours', 'abandonne', 'arrete'.
// gated: whether the merge gate handles this pilot's branches (config/merge-gate.json).
function autopilotFacts(h, gateCandidate, { gated = true } = {}) {
  const key = 'ap:' + (h.commit || h.key || h.at);
  const base = { key, kind: 'autopilot', at: h.at, rawTitle: clip(h.title, 200), branch: h.worktree && h.worktree.branch || null };
  const g = gateCandidate && gateCandidate.status;
  if (h.outcome === 'completed') {
    if (g === 'merged' || g === 'confirmed') return { ...base, state: 'termine', stateText: 'Termine : la correction est integree a l application (fusionnee).' };
    if (!gated) return { ...base, state: 'a-integrer', stateText: 'Correction faite, testee et approuvee par Codex. Pas encore dans l application : '
      + 'ce depot n a pas de fusion automatique, une personne doit la relire et la fusionner.' };
    if (g === 'refused') return { ...base, state: 'arrete', stateText: 'Correction faite et approuvee, mais refusee par la porte de fusion' + (gateCandidate.note ? ' : ' + clip(gateCandidate.note, 160) : '') + '. Un humain doit decider.' };
    return { ...base, state: 'a-integrer', stateText: 'Correction faite, testee et approuvee par Codex. Pas encore dans l application : elle attend la porte de fusion'
      + (g ? ' (etat : ' + g + ')' : '') + '.' };
  }
  if (h.outcome === 'no-task') return { ...base, state: 'termine', stateText: 'Rien a corriger : aucune tache justifiee trouvee.' };
  if (h.outcome === 'plan-rejected') return { ...base, state: 'abandonne', stateText: 'Idee refusee par Codex avant tout changement : rien n a ete modifie.' };
  if (h.outcome === 'duplicate') return { ...base, state: 'abandonne', stateText: 'Doublon d une tache deja faite : ignoree.' };
  if (h.outcome === 'interrupted') return { ...base, state: 'arrete', stateText: 'Interrompue avant la fin : le travail partiel est garde pour un humain.' };
  return { ...base, state: 'arrete', stateText: 'Arretee (' + h.outcome + ').' };
}

const resultOf = (run, id) => { const n = (run.nodes || []).find((x) => x.id === id); return n && n.result ? String(n.result) : ''; };
const statusOf = (run, id) => { const n = (run.nodes || []).find((x) => x.id === id); return n ? n.status : null; };
function pleinsensFacts(run) {
  const key = 'ps:' + run.id;
  const base = { key, kind: 'pleinsens', at: run.createdAt, rawTitle: 'Cycle ' + (run.cycle || '?') + ' de la boucle PleinSens (' + run.id + ')', runId: run.id };
  const done = (run.nodes || []).filter((n) => n.status === 'completed').length, total = (run.nodes || []).length;
  // No finished step: there is no report to summarise, the facts say it all.
  if (!done) base.noReport = true;
  if (['running', 'pending', 'awaiting_approval', 'paused'].includes(run.status)) {
    const cur = (run.nodes || []).find((n) => n.status === 'running');
    return { ...base, state: 'en-cours', stateText: 'En cours : ' + done + ' etape(s) sur ' + total + ' terminee(s)' + (cur ? ', etape actuelle : ' + cur.id : '')
      + (run.waitingUntil ? ', reprend ' + new Date(run.waitingUntil).toLocaleString('fr-CA') : '') + '.' };
  }
  if (run.status === 'cancelled') return { ...base, state: 'arrete', stateText: 'Arrete a la main avant la fin (' + done + '/' + total + ' etapes).' };
  if (run.status === 'failed') return { ...base, state: 'arrete', stateText: 'Arrete sur une erreur (' + done + '/' + total + ' etapes).' };
  if (statusOf(run, 'c1-consigner-garde') === 'completed')
    return { ...base, state: 'a-integrer', stateText: 'Amelioration mesuree et gardee. Elle attend la porte de fusion pour entrer dans l application.' };
  if (statusOf(run, 'c1-consigner-rejet') === 'completed')
    return { ...base, state: 'termine', stateText: 'Cycle termine : le changement a ete essaye et mesure, mais il n ameliorait pas assez. Il a ete annule ; rien ne change dans l application.' };
  if (statusOf(run, 'c1-consigner-rejet-conception') === 'completed')
    return { ...base, state: 'termine', stateText: 'Cycle termine sans changement : l idee a ete jugee mal concue par la revue, avant toute modification du code. Elle est a repenser.' };
  return { ...base, state: 'termine', stateText: 'Cycle termine (' + done + '/' + total + ' etapes).' };
}

// What the local model may read for one item: the item's own reports, bounded.
function sourceText(f, item) {
  if (f.kind === 'autopilot') {
    return ['Titre : ' + clip(item.title, 400), 'Objectif : ' + clip(item.objective, 1500),
      'Preuves : ' + (item.evidence || []).slice(0, 2).map((e) => clip(e, 400)).join(' | '),
      'Revue Codex : ' + clip(item.reviewerEvidence, 900)].join('\n');
  }
  return ['Conception : ' + tailOf(resultOf(item, 'c1-conception'), 900), 'Revue de la conception : ' + tailOf(resultOf(item, 'c1-revue-conception'), 1200),
    'Mesures : ' + tailOf(resultOf(item, 'c1-implementation'), 700), 'Revue finale : ' + tailOf(resultOf(item, 'c1-revue-finale'), 700),
    'Consignation : ' + tailOf(resultOf(item, 'c1-consigner-garde') || resultOf(item, 'c1-consigner-rejet') || resultOf(item, 'c1-consigner-rejet-conception'), 500)].join('\n');
}

const PROMPT_RULES = [
  'Tu ecris pour une personne qui ne connait rien a la programmation.',
  'A partir du RAPPORT ci-dessous et de lui seul, reponds UNIQUEMENT en JSON : {"titre":"...","fait":"...","ameliore":"..."}.',
  '- titre : 4 a 10 mots, en francais simple, ce que la tache concerne.',
  '- fait : 1 ou 2 phrases simples, ce qui a ete fait concretement.',
  '- ameliore : 1 phrase simple, le probleme que cela regle ou ce qui devient meilleur (fiabilite, equite, securite, exactitude des prix, vitesse...), tel que le rapport le decrit. Seulement si le rapport dit explicitement que rien ne change, ecris "Aucun changement visible."',
  'Interdits : noms de fichiers, de fonctions, code, anglais, sigles techniques, chiffres absents du rapport, et toute information absente du rapport.',
  'N ecris pas si la tache est terminee : cela est indique ailleurs.'].join('\n');

function parseWording(raw) {
  const m = /\{[\s\S]*\}/.exec(String(raw || ''));
  if (!m) return null;
  try {
    const j = JSON.parse(m[0]);
    const ok = (v, n) => typeof v === 'string' && v.trim().length > 2 && v.length <= n;
    if (!ok(j.titre, 140) || !ok(j.fait, 600) || !ok(j.ameliore, 400)) return null;
    // A file name or code token means the model did not follow the rules: rejected.
    // Also refused: API paths, source folders, camelCase identifiers.
    if ([j.titre, j.fait, j.ameliore].some((t) => /[\w-]+\.(ts|tsx|js|json|md|py|sql)\b|`|\(\)|=>|\/api\/|\b(src|api|app)\/|\b[a-z][a-z0-9]*[A-Z][A-Za-z0-9]+\b/.test(t))) return null;
    return { titre: j.titre.trim(), fait: j.fait.trim(), ameliore: j.ameliore.trim() };
  } catch (_) { return null; }
}

// ── Cache + background writer ────────────────────────────────────────────
// The wording is written by Codex, in ONE call for every item still missing
// (a local 7B model was tested on 2026-11-13 and inverted the meaning of a
// fix: not reliable enough for a text people trust). Each item is written
// once and cached; a failed batch is retried at most every 30 minutes.
const BATCH_MAX = 10;
const RETRY_MS = 30 * 60000;

function batchPrompt(jobs) {
  return [PROMPT_RULES.replace('reponds UNIQUEMENT en JSON : {"titre":"...","fait":"...","ameliore":"..."}',
      'reponds UNIQUEMENT par un tableau JSON, un objet par rapport : [{"key":"...","titre":"...","fait":"...","ameliore":"..."}]'),
    'Ne lis aucun fichier et ne lance aucune commande : tout est dans les rapports. Reprends chaque "key" telle quelle.',
    ...jobs.map((j) => '=== RAPPORT key=' + j.key + '\n' + j.text)].join('\n\n');
}
function parseBatch(raw, jobs) {
  const m = /\[[\s\S]*\]/.exec(String(raw || ''));
  if (!m) return {};
  let arr; try { arr = JSON.parse(m[0]); } catch (_) { return {}; }
  const keys = new Set(jobs.map((j) => j.key)); const out = {};
  for (const o of Array.isArray(arr) ? arr : []) {
    if (!o || !keys.has(o.key)) continue;
    const w = parseWording(JSON.stringify({ titre: o.titre, fait: o.fait, ameliore: o.ameliore }));
    if (w) out[o.key] = w;
  }
  return out;
}

// Default writer: one Codex worker through the local orchestrator (read-only).
function codexWriter({ host = '127.0.0.1', port = 3800, cwd, model = 'gpt-6.1-sol' } = {}) {
  const { apiRequest } = require('../graph/graph-runs-util');
  return async (jobs) => {
    const t = await apiRequest(host, port, 'POST', '/api/orchestrator/spawn',
      { cli: 'codex', model, effort: 'low', readOnly: true, cwd, from: 'en-clair', prompt: batchPrompt(jobs) });
    if (!t || !t.id) throw new Error('spawn refused');
    const t0 = Date.now();
    for (;;) {
      await new Promise((r) => setTimeout(r, 3000));
      let task; try { task = await apiRequest(host, port, 'GET', '/api/orchestrator/task?id=' + t.id); } catch (_) { continue; }
      if (task.state === 'completed') return { text: task.result, by: 'Codex ' + model };
      if (['failed', 'cancelled', 'timeout'].includes(task.state)) throw new Error('worker ' + task.state);
      if (Date.now() - t0 > 15 * 60000) throw new Error('worker too slow');
    }
  };
}

function makeSummaries({ cacheFile, write, log = () => {}, now = Date.now }) {
  let cache = {};
  try { cache = JSON.parse(fs.readFileSync(cacheFile, 'utf8')); } catch (_) {}
  const queue = []; let busy = false; let lastFail = -Infinity;
  const hashOf = (t) => crypto.createHash('sha256').update(t).digest('hex').slice(0, 16);
  const save = () => { try { fs.mkdirSync(path.dirname(cacheFile), { recursive: true }); fs.writeFileSync(cacheFile, JSON.stringify(cache, null, 1)); } catch (_) {} };

  async function drain() {
    if (busy || !queue.length || now() - lastFail < RETRY_MS) return;
    busy = true;
    try {
      const jobs = queue.splice(0, BATCH_MAX).filter((j) => !(cache[j.key] && cache[j.key].hash === j.hash));
      if (!jobs.length) return;
      let res;
      try { res = await write(jobs); } catch (e) { lastFail = now(); log('resumes impossibles : ' + e.message); return; }
      const got = parseBatch(res && res.text, jobs);
      for (const j of jobs) {
        cache[j.key] = got[j.key] ? { ...got[j.key], hash: j.hash, by: res.by, at: new Date(now()).toISOString() }
          : { hash: j.hash, failed: true, at: new Date(now()).toISOString() };
      }
      save();
    } finally { busy = false; }
    if (queue.length) setImmediate(() => { drain().catch(() => {}); });
  }

  // items: [{ facts, item }]. Returns facts + cached wording; queues the missing ones.
  function present(items) {
    const out = [];
    for (const { facts, item } of items) {
      if (facts.noReport) { out.push({ ...facts, titre: null, fait: null, ameliore: null, redaction: 'Aucune etape terminee : rien a resumer.' }); continue; }
      const text = sourceText(facts, item); const hash = hashOf(text);
      const c = cache[facts.key];
      const fresh = c && c.hash === hash && !c.failed ? c : null;
      if (!c || c.hash !== hash) { if (!queue.some((q) => q.key === facts.key)) queue.push({ key: facts.key, hash, text }); }
      out.push({ ...facts, titre: fresh ? fresh.titre : null, fait: fresh ? fresh.fait : null, ameliore: fresh ? fresh.ameliore : null,
        redaction: fresh ? 'Texte redige automatiquement par ' + fresh.by + ' a partir du rapport de la tache ; l etat ci-dessus est calcule, pas redige.'
          : (c && c.failed && c.hash === hash ? 'Resume indisponible pour cette tache (texte refuse par le controle).' : 'Resume en preparation.') });
    }
    setImmediate(() => { drain().catch(() => {}); });
    return out;
  }
  return { present, _drain: drain, _cache: () => cache };
}

module.exports = { autopilotFacts, pleinsensFacts, sourceText, parseWording, parseBatch, batchPrompt, makeSummaries, codexWriter, PROMPT_RULES };
