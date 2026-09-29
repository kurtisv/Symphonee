'use strict';
// Task classification: roles, characteristics and the capability class that
// drives LOCAL-FIRST routing. Patterns are bilingual (EN + FR) because users
// write prompts in both ("résume ce fichier" must classify like "summarize").
const ROLES = ['architect', 'investigator', 'coder', 'debugger', 'tester', 'reviewer', 'security-reviewer', 'ui-validator', 'summarizer', 'context-compressor', 'long-running-worker'];

// Capability classes, cheapest-capable first:
//   simple          summary / extract / classify / rephrase / compress  -> local 1.5B
//   readonly-review read-only review / explanation / analysis           -> local 7B
//   small-edit      1-2 file edit, shell command, targeted test         -> Codex OSS local
//   complex         architecture, migration, prod, ambiguous, big ctx   -> cloud directly
//   security        security review / vulnerability work                -> top-quality cloud
const TASK_CLASSES = ['simple', 'readonly-review', 'small-edit', 'complex', 'security'];

const ROLE_PATTERNS = [
  ['security-reviewer', /security|s[ée]curit[ée]|vulnerab|vuln[ée]rab|faille|threat|auth|permission|secret|cve|injection|xss|csrf/],
  ['ui-validator', /\bui\b|visual|visuel|browser|navigateur|screenshot|capture d'[ée]cran|frontend|render|dashboard/],
  ['reviewer', /review|revue|relis|relire|audit|inspect|critique|verify|v[ée]rifi|validate|valide/],
  ['tester', /test|spec|regression|r[ée]gression|coverage|assert|jest/],
  ['debugger', /debug|d[ée]bog|bug|broken|cass[ée]|failure|[ée]chec|fix|repair|r[ée]pare|diagnos|corrig|erreur|error/],
  ['architect', /architect|design|conception|plan|decompos|d[ée]compos|system|syst[èe]me|structure/],
  ['investigator', /investigat|investigu|research|recherch|analy[sz]|analyse|find|trouv|trace|understand|comprend|why|pourquoi|explain|explique/],
  ['summarizer', /summar|r[ée]sum|synth[èe]s|explain|explique|report|rapport|digest|cheap|simple analysis|extract|extrai|classif|cat[ée]goris|reformul|rephrase|paraphras|rewrite|translat|tradui/],
  ['context-compressor', /compress|compact|condens|context packet|token budget/],
  ['long-running-worker', /long.?running|overnight|nocturne|toute la nuit|async|autonomous|autonome|background/],
  ['coder', /implement|impl[ée]ment|code|modif|edit|[ée]dit|refactor|build|change|write|[ée]cri|ajout|faute|typo|coquille|renomm|rename/],
];

const COMPLEX_RE = /architect|complex|production|\bprod\b|critical|migration|migrat|multi.?(file|fichier)|plusieurs fichiers|refactor(ing)? (global|complet|large|massi)|ambigu|large context|gros contexte|whole (repo|codebase)|entire (repo|codebase)|tout le (repo|d[ée]p[ôo]t|projet)|complet|compl[èe]te|exhaustive|end.to.end/;
const SECURITY_RE = /security|s[ée]curit[ée]|vulnerab|vuln[ée]rab|faille|threat model|pentest|cve|injection|xss|csrf/;
const SHELL_RE = /\brun\b|lance|ex[ée]cute|execute|npm|npx|node |jest|pytest|shell|command|commande|script|lint|build/;
const SEARCH_RE = /search|cherche|recherch|grep|find (all|every|where)|trouve (tous|toutes|o[uù])|dans (le|tout le) (repo|d[ée]p[ôo]t|projet)|across the (repo|codebase)/;
// Writing is decided by verbs, not by the noun "code": "explique ce code" is read-only.
const WRITE_RE = /implement|impl[ée]ment|modif|\bedit|[ée]dite|refactor|change|write|[ée]cri[st]|ajout|add (a|an|the)|corrig|\bfix|repair|r[ée]pare|faute|typo|coquille|renomm|rename|cr[ée]e (un|une|le|la)|create/;
// The INSTRUCTION verb decides, not words inside the payload: "Classe ce ticket:
// <l'app plante, bug...>" is a classification, not a debugging job.
const LEADING_SIMPLE_RE = /^\s*(please\s+|peux-tu\s+|merci de\s+)?(r[ée]sume|summari[sz]e|classe[rz]?\b|classifie|classify|categori[sz]e|cat[ée]gorise|extrai[st]|extract|reformule|rephrase|paraphrase|rewrite|r[ée][ée]cri[st]|compresse|compress|condense|traduis|translate|synth[ée]tise|donne(-moi)? (un|le|la|les) (r[ée]sum|liste))/;
const SIMPLE_RE = /r[ée]sum|summar|extract|extrai|classif|cat[ée]goris|reformul|rephrase|paraphras|rewrite|compress|compact|condens|translat|tradui|synth[èe]s/;

function taskText(task) {
  return [task.goal, task.prompt, task.description, ...(task.capabilities || [])].filter(Boolean).join(' ').toLowerCase();
}

function deriveTaskClass(task, roles, ch, text) {
  if (task.taskClass && TASK_CLASSES.includes(task.taskClass)) return task.taskClass;
  if (roles.has('security-reviewer') && SECURITY_RE.test(text)) return 'security';
  if (roles.has('security-reviewer') && (roles.has('reviewer') || ch.qualityRequirement === 'high')) return 'security';
  if (ch.complexity === 'high' || ch.longRunning || ch.destructiveRisk === 'high') return 'complex';
  if (LEADING_SIMPLE_RE.test(text)) return 'simple';
  if (ch.repoWriteRequired || ch.shellRequired) return 'small-edit';
  const simpleRole = roles.has('summarizer') || roles.has('context-compressor');
  if (simpleRole && SIMPLE_RE.test(text) && !roles.has('reviewer')) return 'simple';
  if (roles.has('reviewer') || roles.has('investigator') || roles.has('architect') || roles.has('ui-validator')) return 'readonly-review';
  if (simpleRole) return 'simple';
  return 'readonly-review';
}

function classifyTask(task = {}) {
  const text = taskText(task);
  const roles = new Set(Array.isArray(task.roles) ? task.roles.filter(r => ROLES.includes(r)) : []);
  for (const [role, pattern] of ROLE_PATTERNS) if (pattern.test(text)) roles.add(role);
  const noRoleMatched = !roles.size;
  if (!roles.size) roles.add(task.repoWriteRequired ? 'coder' : 'investigator');

  const complexityHigh = COMPLEX_RE.test(text) || SECURITY_RE.test(text);
  const characteristics = {
    complexity: task.complexity || (complexityHigh ? 'high' : 'normal'),
    repoReadRequired: task.repoReadRequired !== undefined ? !!task.repoReadRequired : /repo|repository|d[ée]p[ôo]t|file|fichier|working tree|code/.test(text),
    repoWriteRequired: task.repoWriteRequired !== undefined ? !!task.repoWriteRequired : !LEADING_SIMPLE_RE.test(text) && (roles.has('coder') || roles.has('debugger')) && (WRITE_RE.test(text) || !/review|revue|explain|explique|analy|investig|comprend|understand|why|pourquoi/.test(text)),
    browserRequired: task.browserRequired !== undefined ? !!task.browserRequired : roles.has('ui-validator') || /browser|navigateur|screenshot/.test(text),
    longRunning: !!task.longRunning || roles.has('long-running-worker'),
    destructiveRisk: task.destructiveRisk || (/delete|remove|reset|discard|destroy|supprim|efface|d[ée]truir/.test(text) ? 'high' : 'normal'),
    expectedContextSize: Number(task.expectedContextSize) || 0,
    latencySensitivity: task.latencySensitivity || 'normal',
    qualityRequirement: task.qualityRequirement || task.quality || (roles.has('reviewer') || roles.has('security-reviewer') ? 'high' : 'normal'),
    costSensitivity: task.costSensitivity || (roles.has('summarizer') || roles.has('context-compressor') ? 'high' : 'normal'),
    shellRequired: task.shellRequired !== undefined ? !!task.shellRequired : (roles.has('tester') && SHELL_RE.test(text)) || /\b(npm|npx|jest|pytest|lint)\b/.test(text),
    repoSearchRequired: task.repoSearchRequired !== undefined ? !!task.repoSearchRequired : SEARCH_RE.test(text),
    securitySensitive: SECURITY_RE.test(text) || roles.has('security-reviewer') && /secret|auth|permission/.test(text),
  };
  characteristics.toolsRequired = characteristics.repoWriteRequired || characteristics.shellRequired || characteristics.repoSearchRequired || characteristics.browserRequired;
  characteristics.riskLevel = characteristics.destructiveRisk === 'high' || characteristics.securitySensitive || /production|\bprod\b/.test(text) ? 'high' : 'normal';

  const priority = text.match(/long.?running|overnight|nocturne|async|autonomous|autonome/) ? 'long-running-worker'
    : SECURITY_RE.test(text) && roles.has('security-reviewer') ? 'security-reviewer'
    : text.match(/summar|r[ée]sum|cheap|simple analysis|extract|extrai|classif|compress|compact|condens|reformul|rephrase/) ? (roles.has('summarizer') ? 'summarizer' : 'context-compressor')
    : text.match(/review|revue|audit|inspect|critique|verify|v[ée]rifi|validate/) ? 'reviewer'
    : text.match(/test|spec|regression|coverage|assert|jest/) ? 'tester'
    : text.match(/debug|bug|broken|failure|fix|repair|diagnos|corrig|r[ée]pare|erreur/) ? 'debugger'
    : text.match(/architect|architecture|system design/) ? 'architect'
    : text.match(/implement|code|modify|edit|refactor|build|change|write|modif|faute/) ? 'coder' : null;
  const ordered = priority && roles.has(priority) ? [priority, ...[...roles].filter(r => r !== priority)] : [...roles];
  // A short prompt that matched no role at all ("réponds OK", "donne la date
  // ISO de demain") is simple text work, not an investigation.
  characteristics.taskClass = noRoleMatched && !characteristics.toolsRequired && characteristics.complexity !== 'high' && text.length < 600 && !task.taskClass
    ? 'simple' : deriveTaskClass(task, roles, characteristics, text);
  return { roles: ordered, characteristics, taskClass: characteristics.taskClass };
}

function planWorkflow(task = {}) { const { roles, characteristics } = classifyTask(task); const ordered = ['architect', 'investigator', 'coder', 'debugger', 'tester', 'ui-validator', 'reviewer', 'security-reviewer', 'summarizer', 'context-compressor', 'long-running-worker'].filter(r => roles.includes(r)); return ordered.map((role, index) => ({ id: `${role}-${index + 1}`, role, dependsOn: index ? [`${ordered[index - 1]}-${index}`] : [], characteristics })); }
module.exports = { ROLES, TASK_CLASSES, classifyTask, planWorkflow };
