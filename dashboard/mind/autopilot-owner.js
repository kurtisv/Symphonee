'use strict';
// Owner decisions for the autopilot (decision of 2026-11-24): a task that needs the owner's authorization is SUSPENDED (its whole state kept),
// the pilot goes on with another task, and the suspended task resumes at the same stage once the owner answered in Mind Autopilot.
// This module is pure: the request an agent writes, the per-category policy, the operation key an answer is bound to.
const crypto = require('crypto');

// The line an agent writes INSTEAD of doing an operation that needs the owner (see OWNER_RULE).
const MARKER = 'NEEDS_OWNER_DECISION:';
const CATEGORIES = Object.freeze({
  dependency: 'Ajouter, retirer ou mettre a jour une dependance',
  config: 'Modifier une configuration du depot (hors secrets et CI)',
  'test-infra': 'Modifier l outillage de test',
  'scope-change': 'Elargir le perimetre approuve de la tache',
  product: 'Choix produit ou comportement visible par les utilisateurs',
  'external-service': 'Contacter un service externe',
  'delete-data': 'Supprimer des donnees ou des fichiers utilisateur',
  secrets: 'Lire, modifier ou exposer un secret',
  'bypass-checks': 'Contourner, affaiblir ou desactiver une verification',
  'protected-zone': 'Modifier une zone protegee',
  pleinsens: 'Toucher a PleinSens (gele)',
  deploy: 'Deployer, publier, fusionner ou pousser',
  other: 'Autre',
});
// Never decided by a policy, whatever the owner configured: the owner answers each one (deleting data, secrets, bypassing checks, protected zones,
// PleinSens, deployments, and anything unclassified).
const ALWAYS_ASK = Object.freeze(['delete-data', 'secrets', 'bypass-checks', 'protected-zone', 'pleinsens', 'deploy', 'other']);
// A HEURISTIC on top of the declared category (an agent could misdeclare it): any of these words sends the request to the owner. It narrows what a
// policy can allow; it does not make the agent's category trustworthy, and every allowed change still goes through the checks, the behaviour gate
// and the independent review.
const SENSITIVE_TEXT = /pleinsens|secret|credential|token|password|passwd|\.env\b|api[ _-]?key|private key|delet|remov|supprim|retir|efface|eras|wipe|purg|drop\b|truncat|clear|reset|vider|record|enregistrement|database|base de donn|migration|schema|table|rm -rf|--force|--no-verify|skip|bypass|disable|contourn|desactiv|deploy|d[eé]ploi|publish|publi|release|production|prod\b|merge|fusion|push\b|protected|proteg|billing|factur|auth|permission|ci\b|workflow/i;

const OWNER_RULE = 'OWNER AUTHORIZATION: if the approved work needs an operation you are not allowed to do on your own (a new dependency, a configuration change, widening the approved scope, a product choice, contacting an external service, '
  + 'deleting data, a secret, weakening a check, a protected path, PleinSens, a deployment), DO NOT do it and do not work around it. Stop and end your answer with ONE line: '
  + MARKER + ' {"category":"<' + Object.keys(CATEGORIES).join('|') + '>","question":"<the exact question for the owner>","consequences":"<what happens if allowed, and if refused>"}. '
  + 'Keep the work already done in place. The task is suspended (not failed) and resumes at this stage with the owner\'s answer.';

const clean = (v, n) => String(v == null ? '' : v).replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '').trim().slice(0, n);

// The request at the END of an agent's answer, or null. Only the last marker counts; a malformed one is still a request (the agent stopped).
function parseRequest(raw) {
  const text = String(raw || '');
  const i = text.lastIndexOf(MARKER);
  if (i < 0) return null;
  const rest = text.slice(i + MARKER.length).trim();
  let j = null;
  const end = rest.indexOf('}');
  if (rest.startsWith('{') && end > 0) { try { j = JSON.parse(rest.slice(0, end + 1)); } catch (_) { j = null; } }
  const question = clean(j && j.question, 600) || clean(rest.split('\n')[0], 600) || 'The agent asked for an authorization without stating it.';
  let category = clean(j && j.category, 40).toLowerCase();
  if (!CATEGORIES[category]) category = 'other';
  return { category, question, consequences: clean(j && j.consequences, 1500) };
}

// Policy as stored in the pilot definition: { <category>: 'auto' | 'ask' }; anything else is 'ask'; ALWAYS_ASK categories are never 'auto'.
function normalizePolicy(p) {
  const out = {};
  for (const [k, v] of Object.entries(p && typeof p === 'object' ? p : {})) if (CATEGORIES[k] && !ALWAYS_ASK.includes(k) && v === 'auto') out[k] = 'auto';
  return out;
}

// 'auto' only for a category the owner set to automatic, never for a sensitive category or a question that reads as sensitive.
function decide(policy, req) {
  if (!req || ALWAYS_ASK.includes(req.category)) return 'ask';
  if (SENSITIVE_TEXT.test(req.question + ' ' + req.consequences)) return 'ask';
  return normalizePolicy(policy)[req.category] === 'auto' ? 'auto' : 'ask';
}

// An answer is bound to ONE operation: its category and its exact question. A later, different operation needs a new answer.
function operationKey(req) {
  return crypto.createHash('sha256').update(req.category + '|' + String(req.question).toLowerCase().replace(/\s+/g, ' ').trim() + (req.fingerprint ? '|' + req.fingerprint : '')).digest('hex').slice(0, 16);
}

// Which stage a suspended task resumes at. An implementation that already wrote something is continued as a repair in the SAME worktree
// (dispatching 'implement' again would create a new worktree).
function resumeStage(stage, hasWork) {
  if (stage === 'implement') return hasWork ? 'repair' : 'implement';
  return stage;
}

// What the owner said, for the agent of THAT task only.
// Only the button "Autoriser" authorizes. A text without that choice is the owner's words, not an authorization.
function isAllowed(d) { return !!(d && d.status === 'answered' && d.answer && d.answer.choice === 'allow'); }
function answerText(req, d, refused) {
  const said = d && d.answer ? [d.answer.choice === 'allow' ? 'ALLOWED' : d.answer.choice === 'refuse' ? 'REFUSED' : '', d.answer.text ? 'the owner wrote: "' + clean(d.answer.text, 1000) + '"' : ''].filter(Boolean).join('; ') : 'REFUSED (dismissed)';
  return 'OWNER DECISION ' + (d ? d.id : '') + ' for exactly this request [' + req.category + '] "' + req.question + '": ' + said + '.\n'
    + (refused
      ? 'The owner did NOT authorize it (refused, or answered without authorizing). Follow the owner\'s words above if any. Do not do it and do not work around it. Find another way that stays inside the approved plan and needs no authorization; if there is none, answer with NO_CHANGE: refused by the owner.'
      : 'This answer covers this operation only. Any other operation that needs authorization needs a new request.');
}

// Every decision of this task, for every later stage prompt (implementer, repair, plan and code reviewers, coach).
function decisionsText(list) {
  const l = (list || []).slice(-6);
  if (!l.length) return '';
  return 'OWNER DECISIONS FOR THIS TASK (each covers ONLY the operation it names; another operation needs a new request):\n' + l.map((x) => '- [' + x.category + '] "' + x.question + '": '
    + (x.allowed ? 'AUTHORIZED' : 'NOT AUTHORIZED') + (x.answer && x.answer.text ? ' - the owner wrote: "' + clean(x.answer.text, 600) + '"' : '') + ' (' + x.decisionId + ')').join('\n');
}
module.exports = { isAllowed, decisionsText, MARKER, CATEGORIES, ALWAYS_ASK, OWNER_RULE, parseRequest, normalizePolicy, decide, operationKey, resumeStage, answerText, clean };
