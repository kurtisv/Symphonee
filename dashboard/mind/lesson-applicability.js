'use strict';
// Which validated lessons may be shown to the developer for THIS task (fixtures only).
//
// A lesson carries structured metadata (the problem it solves, the hazard, the kind of
// input and task, the syntax it needs, its limits, how it was validated). Before it is
// transmitted, the task's profile (declared by the host, never derived from word
// overlap) must be compatible. If nothing applies, the developer works without extra
// memory. Word similarity alone never makes a structured lesson applicable; only old
// lessons without metadata ("legacy-format") fall back to the historical word rule.
//
// Usage statistics are ASSOCIATIONS (a method was shown, then the run did or did not
// succeed). They lower a lesson's priority or hide it on a task where it never worked;
// they never prove that the lesson caused a success, and nothing is deleted.

// Syntax features of the strict checker profile that a lesson's validated code may rely on.
const FEATURES = Object.freeze(['const', 'index', 'length', 'reduce', 'Math.abs', 'Math.max', 'Math.min', 'conditional', 'logical', 'comparison', 'arithmetic']);
const NEED = [['reduce', /\.reduce\s*\(/], ['Math.abs', /Math\.abs\s*\(/], ['Math.max', /Math\.max\s*\(/], ['Math.min', /Math\.min\s*\(/], ['index', /\bv\s*\[|\w\[\w+\]/], ['conditional', /\?[^?:]*:/], ['logical', /&&|\|\|/], ['comparison', /===|!==|<=|>=|(?<![=!<>-])[<>](?!=)/]];
const featuresOf = (code) => NEED.filter(([, re]) => re.test(String(code || ''))).map(([n]) => n);

const MIN_USES_TO_HIDE = 2, MIN_USES_TO_DEMOTE = 4, DEMOTE_BELOW = 0.25;
const isStr = (x, lo, hi) => typeof x === 'string' && x.trim().length >= lo && x.length <= hi;
const strList = (x, max, hi) => Array.isArray(x) && x.length <= max && x.every((s) => isStr(s, 1, hi));

// Built by the host when a lesson is validated: profile fields come from the task, the
// code features from the validated code, the proofs from the evidence. Nothing from the teacher.
function buildApplicability({ profile, code, family, wide, review = true }) {
  if (!profile || !isStr(profile.hazard, 2, 60) || !isStr(profile.input, 2, 60) || !isStr(profile.kind, 2, 60)) return null;
  return {
    version: 1,
    problem: String(profile.problem || ('avoid the hazard "' + profile.hazard + '"')).slice(0, 240),
    hazard: profile.hazard, inputKinds: [profile.input], taskKinds: [profile.kind], validatedOn: [family],
    requires: featuresOf(code),
    limits: ['validated on "' + family + '" only; applying it to another function is a transfer that is not established',
      wide ? 'stress-checked on ' + wide.inputs + ' inputs with 0 mismatches' : 'no stress check was required for this family'].slice(0, 3),
    level: (review ? 'independent-checks+codex-review' : 'independent-checks') + (wide ? '+stress' : ''),
  };
}
function applicabilityProblems(a) {
  if (!a || typeof a !== 'object' || Array.isArray(a)) return ['applicability missing'];
  const p = [];
  if (a.version !== 1) p.push('version');
  if (!isStr(a.problem, 5, 240)) p.push('problem');
  if (!isStr(a.hazard, 2, 60)) p.push('hazard');
  if (!strList(a.inputKinds, 4, 60) || !a.inputKinds.length) p.push('inputKinds');
  if (!strList(a.taskKinds, 4, 60) || !a.taskKinds.length) p.push('taskKinds');
  if (!strList(a.validatedOn, 6, 40) || !a.validatedOn.length) p.push('validatedOn');
  if (!Array.isArray(a.requires) || a.requires.some((f) => !FEATURES.includes(f))) p.push('requires');
  if (!strList(a.limits, 4, 240)) p.push('limits');
  if (!isStr(a.level, 5, 80)) p.push('level');
  return p;
}

// usage: { uses, usesSucceeded, byTask: { [taskId]: { uses, ok } } }  (associations only)
function assess(lesson, profile, usage = {}) {
  const a = lesson && lesson.applicability;
  if (!a) return { applicable: null, score: 0, reasons: ['legacy-format: no structured applicability'] };
  if (applicabilityProblems(a).length) return { applicable: false, score: 0, reasons: ['applicability metadata is invalid'] };
  if (!profile) return { applicable: true, score: 1, reasons: ['no task profile given: structural check skipped'] };
  const no = (why) => ({ applicable: false, score: 0, reasons: [why] });
  if (a.hazard !== profile.hazard) return no('different hazard (' + a.hazard + ' vs ' + profile.hazard + ')');
  if (!a.inputKinds.includes(profile.input)) return no('different input kind (' + a.inputKinds.join('/') + ' vs ' + profile.input + ')');
  if (!a.taskKinds.includes(profile.kind)) return no('different kind of task (' + a.taskKinds.join('/') + ' vs ' + profile.kind + ')');
  const allowed = profile.features || FEATURES, missing = a.requires.filter((f) => !allowed.includes(f));
  if (missing.length) return no('needs syntax this task profile does not allow: ' + missing.join(', '));
  const mine = (usage.byTask || {})[profile.id];
  if (mine && mine.uses >= MIN_USES_TO_HIDE && mine.ok === 0) return no('shown ' + mine.uses + ' times on this task and never followed by a success: hidden here (history kept)');
  let score = 1 + (a.validatedOn.includes(profile.id) ? 0.5 : 0);
  const reasons = ['same hazard, input kind and kind of task'];
  if (usage.uses >= MIN_USES_TO_DEMOTE && usage.usesSucceeded / usage.uses < DEMOTE_BELOW) { score *= 0.5; reasons.push('lower priority: followed by a success in only ' + usage.usesSucceeded + ' of ' + usage.uses + ' uses (association, not causality)'); }
  return { applicable: true, score, reasons };
}

// From assessed candidates [{lesson, usage, id}] keep what may be shown: applicable ones,
// never two methods for the same hazard (the best wins, so the developer never gets contradictory
// advice), at most `max`. Returns the kept list and a decision log for every candidate.
function select(candidates, profile, { max = 2, legacyWordRelevant = () => false } = {}) {
  const decisions = [], ok = [];
  for (const c of candidates) {
    const r = assess(c.lesson, profile, c.usage);
    if (r.applicable === null) {
      const keep = Boolean(legacyWordRelevant(c));
      decisions.push({ id: c.id, shown: false, legacy: true, reasons: r.reasons.concat(keep ? ['word-relevant: candidate only if no structured lesson applies'] : ['not word-relevant']) });
      if (keep) ok.push({ ...c, score: 0.25, legacy: true, hazard: '__legacy__' });
      continue;
    }
    decisions.push({ id: c.id, shown: false, reasons: r.reasons });
    if (r.applicable) ok.push({ ...c, score: r.score, hazard: c.lesson.applicability ? c.lesson.applicability.hazard : '__none__' });
  }
  const structured = ok.filter((x) => !x.legacy);
  const pool = structured.length ? structured : ok; // legacy only when nothing structured applies
  const byHazard = new Map();
  for (const x of pool.sort((p, q) => q.score - p.score)) if (!byHazard.has(x.hazard)) byHazard.set(x.hazard, x);
  const kept = [...byHazard.values()].slice(0, max);
  for (const d of decisions) {
    if (kept.some((k) => k.id === d.id)) { d.shown = true; }
    else if (!d.reasons.some((r) => /^(different|needs|shown|not word|applicability)/.test(r))) d.reasons.push('not shown: another applicable method for the same hazard ranks higher, or the limit was reached');
  }
  return { kept, decisions };
}

module.exports = { FEATURES, featuresOf, buildApplicability, applicabilityProblems, assess, select, MIN_USES_TO_HIDE, MIN_USES_TO_DEMOTE, DEMOTE_BELOW };
