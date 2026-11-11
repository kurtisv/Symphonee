'use strict';
// Symphonee Skill Corpus -- the PROCEDURAL layer of the cognitive loop.
//
// Skills are model-neutral SKILL.md recipes ("how to do X well, the same way,
// every time") that every CLI loads, so behaviour is CONSISTENT across CLIs and
// sessions. This sits alongside the other two memory layers:
//   - Mind     = knowledge ("what we know / decided")          -> /api/mind/*
//   - plugins  = integrations ("how to reach a system")        -> /api/plugins/*
//   - SKILLS   = procedures ("how WE do a task, step by step")  -> /api/skills/*
//
// A skill is a directory under <repoRoot>/skills/<id>/SKILL.md with YAML-ish
// frontmatter (name, description, when?, tags?) and a markdown body. The body is
// the executable procedure; the catalog (name/description/when) is what gets
// injected into bootstrap + dispatched-worker prompts so an agent knows a skill
// exists and fetches the full body on demand.

const fs = require('fs');
const path = require('path');

function corpusDir(repoRoot) { return path.join(repoRoot, 'skills'); }

function safeId(s) {
  return String(s == null ? '' : s)
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
    .replace(/-+$/g, '');
}

// Parse a SKILL.md: leading --- frontmatter --- then markdown body. Frontmatter
// is simple `key: value` lines (no nested YAML) so the parser stays dependency
// free and matches how the rest of Symphonee reads small structured files.
function parseSkill(raw, id) {
  const fm = {};
  let body = String(raw || '');
  const m = body.match(/^﻿?---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/);
  if (m) {
    body = m[2];
    for (const line of m[1].split('\n')) {
      const mm = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
      if (mm) fm[mm[1].trim()] = mm[2].trim().replace(/^["']|["']$/g, '');
    }
  }
  const tags = (fm.tags || '').split(',').map(s => s.trim()).filter(Boolean);
  return {
    id,
    name: fm.name || id,
    description: fm.description || '',
    when: fm.when || '',
    tags,
    body: body.trim(),
    valid: !!(fm.name && fm.description),
    runnable: REQUIRED_SECTIONS.every(title => body.split(/\r?\n/).includes('## ' + title)) && /^\d+\.\s+\S/m.test(body),
  };
}

// Load every skill in the corpus. Never throws -- a missing/empty corpus yields
// an empty list so bootstrap and dispatch keep working before any skill exists.
function loadCorpus(repoRoot) {
  const dir = corpusDir(repoRoot);
  const out = [];
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return out; }
  for (const e of entries) {
    if (!e || !e.isDirectory()) continue;
    let raw;
    try { raw = fs.readFileSync(path.join(dir, e.name, 'SKILL.md'), 'utf8'); } catch (_) { continue; }
    out.push(parseSkill(raw, e.name));
  }
  out.sort((a, b) => a.id.localeCompare(b.id));
  return out;
}

// Light catalog (no body) for prompts/bootstrap.
function catalog(repoRoot) {
  return loadCorpus(repoRoot).map(s => ({
    id: s.id, name: s.name, description: s.description, when: s.when, tags: s.tags, valid: s.valid, runnable: s.runnable,
  }));
}

// Compact text block listing skills, for injection into a dispatched worker's
// prompt. The worker fetches the full procedure body on demand.
function estimateTokens(text) { return Math.ceil(String(text || '').length / 4); }

// Selection is bounded in both rows and approximate tokens. GET /api/skills
// remains the complete editor catalogue; prompt surfaces use this selection.
function selectCatalog(repoRoot, { question = '', max = 24, budget = 1800 } = {}) {
  const full = catalog(repoRoot);
  const cat = full.filter(s => s.valid && s.runnable);
  const words = new Set(String(question).toLowerCase().match(/[a-z0-9-]{3,}/g) || []);
  const rank = s => {
    const text = `${s.id} ${s.description} ${s.when} ${s.tags.join(' ')}`.toLowerCase();
    return [...words].filter(w => text.includes(w)).length * 10 + (s.tags.includes('core') ? 1 : 0);
  };
  cat.sort((a, b) => rank(b) - rank(a) || a.id.localeCompare(b.id));
  const selected = []; let used = 0;
  for (const s of cat) {
    const cost = estimateTokens(JSON.stringify(s));
    if (selected.length >= Math.max(0, Math.min(24, max))) break;
    if (used + cost > Math.max(0, Math.min(2400, budget))) continue;
    selected.push(s); used += cost;
  }
  return { skills: selected, total: full.length, selected: selected.length, estimatedTokens: used,
    fullCatalogTokens: estimateTokens(JSON.stringify(full)), omitted: full.length - selected.length };
}

function catalogText(repoRoot, opts = {}) {
  const selection = selectCatalog(repoRoot, opts);
  const cat = selection.skills;
  if (!cat.length) return '';
  const lines = cat.map(s => {
    const trigger = s.when ? ` (when: ${s.when})` : '';
    return `  - ${s.id}: ${s.description}${trigger}`;
  });
  return `[skills: ${selection.selected}/${selection.total}] Reusable procedures for HOW to do common tasks consistently. Full catalogue: GET /api/skills. ` +
    `Before substantive work, if one matches, fetch and FOLLOW it: GET /api/skills/item?id=<id>.\n` +
    lines.join('\n');
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let buf = '';
    req.on('data', c => buf += c);
    req.on('end', () => { try { resolve(buf ? JSON.parse(buf) : {}); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}

// Render a skill object back to SKILL.md text (used by the author/upsert route,
// which is the seed of the learning loop: the system can write its own skills).
function renderSkill({ name, description, when, tags, body }) {
  const fm = ['---', `name: ${name}`, `description: ${description}`];
  if (when) fm.push(`when: ${when}`);
  if (tags && tags.length) fm.push(`tags: ${Array.isArray(tags) ? tags.join(', ') : tags}`);
  fm.push('---', '');
  return fm.join('\n') + '\n' + String(body || '').trim() + '\n';
}

const REQUIRED_SECTIONS = ['Use when', 'Do not use when', 'Steps (primary path)', 'Safety', 'Verification'];
function safetyIssue(text) {
  text = String(text || '');
  if (/\b(?:sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9]{12,}|AIza[A-Za-z0-9_-]{20,}|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,})|-----BEGIN .*PRIVATE KEY-----/i.test(text)) return 'potential-secret';
  if (/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b|\bBearer\s+[A-Za-z0-9_\-.=]{12,}/.test(text)) return 'potential-secret';
  if (/\b(?:password|passwd|secret|api[_-]?key|(?:access[_-]?|session[_-]?|runtime[_-]?)?token|x-symphonee-token|authorization|credential)["']?\s*[=:]\s*["']?(?!\$|<|process\.env|env:|redacted|undefined|null|false)[A-Za-z0-9_+\/=-]{8,}/i.test(text)) return 'potential-secret';
  if (/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i.test(text)) return 'personal-data';
  if (/[A-Z]:[\\/]+Users[\\/]+[^\s]+|\/(?:home|Users)\/[^\s]+/i.test(text)) return 'personal-path';
  return null;
}
function validateSkill(skill, { strict = false } = {}) {
  if (typeof skill.body !== 'string' || typeof skill.name !== 'string' || typeof skill.description !== 'string') return 'name, description and body must be strings';
  if (!safeId(skill.id || skill.name) || !skill.name || !skill.description || !skill.body) return 'id/name, description and body are required';
  for (const k of ['name', 'description', 'when']) if (/[\r\n]/.test(String(skill[k] || ''))) return 'frontmatter must be single-line';
  if ((Array.isArray(skill.tags) ? skill.tags : [skill.tags || '']).some(t => /[\r\n]/.test(String(t)))) return 'tags must be single-line';
  const issue = safetyIssue(JSON.stringify(skill)); if (issue) return issue;
  if (strict) {
    if (/[^\x09\x0a\x0d\x20-\x7e]/.test(JSON.stringify(skill))) return 'generated skills must be ASCII';
    if (!skill.when || String(skill.body).length > 8000) return 'generated skill trigger/body invalid';
    let previous = -1;
    for (const title of REQUIRED_SECTIONS) {
      const marker = '## ' + title;
      const i = skill.body.search(new RegExp('^' + marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\r?$', 'm'));
      if (i <= previous || !skill.body.slice(i + marker.length).split('\n## ')[0].trim()) return 'missing or empty section: ' + title;
      previous = i;
    }
    const steps = skill.body.split('## Steps (primary path)')[1].split('\n## ')[0];
    if ((steps.match(/^\d+\.\s+\S.+/gm) || []).length < 2) return 'at least two concrete steps required';
  }
  return null;
}
function atomicWrite(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp-' + process.pid;
  try { fs.writeFileSync(tmp, text, 'utf8'); fs.renameSync(tmp, file); }
  finally { try { fs.unlinkSync(tmp); } catch (_) {} }
}
function provenancePath(repoRoot, id) { return path.join(corpusDir(repoRoot), '.provenance', safeId(id) + '.json'); }
function readProvenance(repoRoot, id) { try { return JSON.parse(fs.readFileSync(provenancePath(repoRoot, id), 'utf8')); } catch (_) { return null; } }
function upsertSkill(repoRoot, input, { strict = false, provenance = null, broadcast } = {}) {
  const skill = { ...input, id: safeId(input.id || input.name) };
  const issue = validateSkill(skill, { strict });
  if (issue) throw new Error(issue);
  if (provenance && safetyIssue(JSON.stringify(provenance))) throw new Error('unsafe provenance');
  const file = path.join(corpusDir(repoRoot), skill.id, 'SKILL.md');
  const existed = fs.existsSync(file);
  atomicWrite(file, renderSkill(skill));
  if (provenance) atomicWrite(provenancePath(repoRoot, skill.id), JSON.stringify(provenance, null, 2));
  if (broadcast) broadcast({ type: 'skills-changed', payload: { action: existed ? 'updated' : 'created', id: skill.id } });
  return { ok: true, id: skill.id, action: existed ? 'UPDATED' : 'CREATED' };
}

function mountSkills(addRoute, json, ctx) {
  const { repoRoot, broadcast, permGate } = ctx;

  // List the catalog (no bodies).
  addRoute('GET', '/api/skills', (req, res) => {
    const cat = catalog(repoRoot);
    return json(res, { ok: true, total: cat.length, skills: cat });
  });

  // Fetch one full skill (the executable procedure body).
  addRoute('GET', '/api/skills/item', (req, res) => {
    const url = new URL(req.url, 'http://x');
    const id = safeId(url.searchParams.get('id'));
    if (!id) return json(res, { ok: false, error: 'id required' }, 400);
    const skill = loadCorpus(repoRoot).find(s => s.id === id);
    if (!skill) return json(res, { ok: false, error: 'not found' }, 404);
    return json(res, { ok: true, skill, provenance: readProvenance(repoRoot, id), estimatedBodyTokens: estimateTokens(skill.body) });
  });

  // Author or update a skill. This is the learning-loop seed: a correction or a
  // recurring procedure becomes a durable, shared skill the next CLI inherits.
  addRoute('POST', '/api/skills', async (req, res) => {
    if (permGate && !await permGate(res, 'api', 'POST /api/skills', 'Save canonical skill')) return;
    const b = await readBody(req).catch(() => ({}));
    const id = safeId(b.id || b.name);
    const name = String(b.name || '').trim();
    const description = String(b.description || '').trim();
    const body = String(b.body || '').trim();
    if (!id || !name || !description || !body) {
      return json(res, { ok: false, error: 'id/name, description and body are required' }, 400);
    }
    try {
      upsertSkill(repoRoot, { id, name, description, when: b.when, tags: b.tags, body }, { broadcast });
    } catch (e) {
      return json(res, { ok: false, error: e.message }, 500);
    }
    return json(res, { ok: true, id });
  });

  // Remove a skill from the corpus.
  addRoute('DELETE', '/api/skills/item', async (req, res) => {
    if (permGate && !await permGate(res, 'api', 'DELETE /api/skills/item', 'Delete canonical skill')) return;
    const url = new URL(req.url, 'http://x');
    const id = safeId(url.searchParams.get('id'));
    if (!id) return json(res, { ok: false, error: 'id required' }, 400);
    const dir = path.join(corpusDir(repoRoot), id);
    const resolved = path.resolve(dir);
    if (!resolved.startsWith(path.resolve(corpusDir(repoRoot)))) {
      return json(res, { ok: false, error: 'invalid id' }, 403);
    }
    try { fs.rmSync(resolved, { recursive: true, force: true }); } catch (e) {
      return json(res, { ok: false, error: e.message }, 500);
    }
    try { if (broadcast) broadcast({ type: 'skills-changed', payload: { action: 'delete', id } }); } catch (_) {}
    return json(res, { ok: true, id });
  });

  // Surface the catalog in /api/bootstrap so EVERY CLI session opens knowing
  // which procedures exist (it fetches the body of the one it needs).
  return {
    bootstrapField(opts = {}) {
      const selection = selectCatalog(repoRoot, opts);
      const cat = selection.skills;
      return {
        enabled: cat.length > 0,
        total: selection.total,
        selected: selection.selected,
        omitted: selection.omitted,
        estimatedCatalogTokens: selection.estimatedTokens,
        fullCatalogTokens: selection.fullCatalogTokens,
        skills: cat,
        itemUrl: '/api/skills/item?id=<id>',
        listUrl: '/api/skills',
        message: cat.length
          ? 'Reusable procedures for HOW to do common tasks the same way every time. Before substantive work, check whether a skill matches; if so fetch its body (GET /api/skills/item?id=<id>) and FOLLOW it. When the user corrects a procedure or you find a better repeatable way, author a skill (POST /api/skills) so every future session of every CLI inherits it.'
          : 'No skills authored yet. Author the first with POST /api/skills.',
      };
    },
    catalogText: (opts) => catalogText(repoRoot, opts),
    loadCorpus: () => loadCorpus(repoRoot),
    catalog: () => catalog(repoRoot),
  };
}

module.exports = { mountSkills, loadCorpus, catalog, catalogText, selectCatalog, estimateTokens, parseSkill, renderSkill, safeId, corpusDir, upsertSkill, validateSkill, safetyIssue, REQUIRED_SECTIONS, atomicWrite, readProvenance };
