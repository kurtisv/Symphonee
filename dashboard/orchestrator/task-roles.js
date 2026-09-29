'use strict';
// Task classification: roles, characteristics and the capability class that
// drives LOCAL-FIRST routing. Patterns are bilingual (EN + FR) because users
// write prompts in both ("résume ce fichier" must classify like "summarize").
const ROLES = ['architect', 'investigator', 'coder', 'debugger', 'tester', 'reviewer', 'security-reviewer', 'ui-validator', 'summarizer', 'context-compressor', 'long-running-worker'];

// Capability classes, cheapest-capable first:
//   simple          summary / extract / classify / rephrase / compress  -> local 1.5B
//   readonly-review read-only review / explanation / analysis           -> local 7B (if RAM/ctx allow)
//   small-edit      1-2 file edit, shell command, targeted test         -> cloud (Codex OSS local only if opted in)
//   complex         architecture, migration, prod, ambiguous, big ctx   -> cloud directly
//   security        security review / vulnerability work                -> top-quality cloud
const TASK_CLASSES = ['simple', 'readonly-review', 'small-edit', 'complex', 'security'];

// "Not preceded by a letter": JS \b is ASCII-only, so "d|écris" would count as
// a word start before "é". This lookbehind treats accented letters as letters.
const NL = '(?<![a-z0-9à-öø-ÿ])';
const re = (src) => new RegExp(src.replace(/§/g, NL));

const SECURITY_SRC = String.raw`security|§s[ée]curit[ée]|vulnerab|vuln[ée]rab|§faille|§threat|pentest|\bcve\b|injection|\bxss\b|\bcsrf\b|\bssrf\b|\bjwt\b|password|passwd|mots? de passe|credential|identifiants?\b|\bsecrets?\b|token leak|leak(s|ed|age)? (of )?(the )?(tokens?|secrets?|keys?|credentials?)|access[- ]tokens?|bearer|oauth|traversal|\brce\b|privil[eè]ge|sanitiz|\bcors\b|\bcsp\b|encrypt|§chiffr|cryptograph|\bauth(entication|orization|entification|z|n)?\b|exploit|backdoor|fuite de (mots? de passe|donn[ée]es|secrets?|cl[ée]s?|tokens?)`;
const SECURITY_RE = re(SECURITY_SRC);

const ROLE_PATTERNS = [
  ['security-reviewer', re(SECURITY_SRC + String.raw`|\bpermissions?\b`)],
  ['ui-validator', re(String.raw`\bui\b|visual|§visuel|browser|navigateur|screenshot|capture d'[ée]cran|frontend|\brender|dashboard`)],
  ['reviewer', re(String.raw`review|§revue|§relis|§relire|audit|inspect|§critique\b|verify|§v[ée]rifi|validate|§valide`)],
  ['tester', re(String.raw`\btests?\b|\btesting\b|\bspecs?\b|§r[ée]gression|regression|coverage|\bassert|jest|pytest`)],
  ['debugger', re(String.raw`debug|§d[ée]bog|\bbugs?\b|broken|§cass[ée]|failure|§[ée]chec|\bfix|repair|§r[ée]pare|diagnos|§corrig|§erreur|\berrors?\b|\bcrash|§plante`)],
  ['architect', re(String.raw`architect|\bdesign|§conception|\bplan(s|ning|ifie[rz]?)?\b|decompos|§d[ée]compos|\bsyst[eè]mes?\b|\bstructure`)],
  ['investigator', re(String.raw`investigat|§investigu|research|§recherch|analy[sz]|§analyse|\bfind\b|§trouv|\btrace|understand|§comprend|\bwhy\b|§pourquoi|explain|§explique|§d[ée]cri[st]|describe`)],
  ['summarizer', re(String.raw`summar|§r[ée]sum|§synth[èe]s|explain|§explique|\breport|§rapport|digest|\bcheap\b|simple analysis|extract|§extrai|classif|§classe[rz]?\b|§cat[ée]goris|§reformul|rephrase|paraphras|rewrite|translat|§tradui`)],
  ['context-compressor', re(String.raw`compress|compact|§condens|context packet|token budget`)],
  ['long-running-worker', re(String.raw`long.?running|overnight|§nocturne|toute la nuit|\basync|autonomous|§autonome|background`)],
  ['coder', re(String.raw`implement|§impl[ée]ment|\bcode\b|\bcoding\b|§modif|\bedit|§[ée]dite?\b|refactor|\bbuild\b|\bchanges?\b|\bwrite\b|§[ée]cri[st]\b|§ajout|§faute|typo|§coquille|§renomm|rename|\bupdate|mets? [àa] jour|\bbump\b|upgrade`)],
];

const COMPLEX_RE = re(String.raw`architect|complex|production|\bprod\b|critical|migrat|multi.?(file|fichier)|plusieurs fichiers|refactor(ing)? (global|complet|large|massi)|ambigu|large context|gros contexte|\bwhole\b|\bentire\b|§tout le (repo|d[ée]p[ôo]t|projet|code)|all (the )?dependencies|§toutes les d[ée]pendances|upgrade all|race condition|\brace\b|\bdata races?\b|thread.?safe|condition de course|concurren|deadlock|corrupt|§corromp|data loss|perte de donn|memory leak|fuite m[ée]moire|design (a|an|the|new|our)\b|§con[çc]oi[st]|sharding|scalab|§complet|§compl[èe]te|exhaustive|end.to.end`);
const SHELL_RE = re(String.raw`\brun\b|§lance\b|§lancer\b|§ex[ée]cute|execute|\bnpm\b|\bnpx\b|\bnode\b|jest|pytest|\bshell\b|\bcommand\b|§commande|\bscripts?\b|\blint\b|\bbuild\b`);
const SEARCH_RE = re(String.raw`\bsearch|§cherche|§recherch|\bgrep\b|find (all|every|where)|§trouve (tous|toutes|o[uù])|dans (le|tout le) (repo|d[ée]p[ôo]t|projet)|across the (repo|codebase)`);
// Writing is decided by verbs, not by the noun "code": "explique ce code" is read-only.
const WRITE_RE = re(String.raw`implement|§impl[ée]ment|§modif|\bedit|§[ée]dite?\b|refactor|\bchange\b|\bwrite\b|§[ée]cri[st]\b|§r[ée][ée]cri[st]\b|\brewrite\b|§ajout|\badd\b|§corrig|\bfix|repair|§r[ée]pare|§faute|typo|§coquille|§renomm|rename|\bcreate\b|§cr[ée]e[rz]?\b|\bupdate|mets? [àa] jour|\bbump\b|upgrade|\binstall|\bpatch\b|\bapply\b|§applique|\bcommit\b|\bsave\b|§sauvegarde|§enregistre|\bdelete|\bremove|§supprim|§retire|§efface|\bmove\b|§d[ée]place`);
const DESTRUCTIVE_RE = re(String.raw`\bdelete|\bremove|\breset|discard|destroy|§supprim|§efface|§d[ée]trui`);
const NEW_FILE_RE = re(String.raw`(dans|into|to|vers) (un|une|a|an) (nouveau|nouvelle|new|autre|separate|§s[ée]par[ée]e?) (fichier|file|module)`);
const FILE_TARGET_RE = re(String.raw`[\w@~./\\-]+\.(js|mjs|cjs|ts|tsx|jsx|py|json|md|ya?ml|toml|css|scss|html|java|go|rs|cs|cpp|c|h|sh|ps1|rb|php|sql)\b|\b(files?|folder|directory|module|function|class|method|readme|repo|codebase|component)\b|§(fichiers?|dossier|r[ée]pertoire|fonction|m[ée]thode|composant|d[ée]p[ôo]t)\b`);
const CODE_UNIT_RE = re(String.raw`\b(function|method|class|component)\b|§(fonction|m[ée]thode|classe (?!ces|ce |les)|composant)\b`);

// The INSTRUCTION verb decides, not words inside the payload: "Classe ces
// tickets : bug critique, security issue..." is a classification.
const LEADING_SIMPLE_RE = /^\s*(please\s+|peux-tu\s+|merci de\s+)?(r[ée]sume|summari[sz]e|classe[rz]?\b|classifie|classify|categori[sz]e|cat[ée]gorise|extrai[st]|extract|reformule|rephrase|paraphrase|rewrite|r[ée][ée]cri[st]|compresse|compress|condense|traduis|translate|synth[ée]tise|donne(-moi)? (un|le|la|les) (r[ée]sum|liste))/;
const LEADING_TRANSFORM_RE = /^\s*(please\s+|peux-tu\s+|merci de\s+)?(reformule|rephrase|paraphrase|rewrite|r[ée][ée]cri[st]|traduis|translate)/;
const LEADING_EXTRACT_RE = /^\s*(please\s+|peux-tu\s+|merci de\s+)?(extrai[st]|extract)/;
const SIMPLE_RE = /r[ée]sum|summar|extract|extrai|classif|cat[ée]goris|reformul|rephrase|paraphras|rewrite|compress|compact|condens|translat|tradui|synth[èe]s/;
const READONLY_WORDS_RE = re(String.raw`review|§revue|explain|§explique|analy|§investig|§comprend|understand|\bwhy\b|§pourquoi|§d[ée]cri[st]|describe`);

function taskText(task) {
  return [task.goal, task.prompt, task.description, ...(task.capabilities || [])].filter(Boolean).join(' ').toLowerCase();
}

// "summarize/classify/extract/...: <payload>". The payload is treated as DATA
// (tickets, logs, pasted text) only when it carries no instruction for the
// agent; otherwise it is analysed like a task. Both reviewers showed that
// ignoring it blindly let "Rewrite: src/pay.js ...", "Summarize: review auth.js
// for JWT leaks" or "..., then delete them" through as simple local work.
function instructionOf(text) {
  if (!LEADING_SIMPLE_RE.test(text)) return { instruction: text, payload: '', leadingSimple: false };
  const cut = text.search(/[:\n]/);
  return cut > 0
    ? { instruction: text.slice(0, cut), payload: text.slice(cut + 1), leadingSimple: true }
    : { instruction: text, payload: '', leadingSimple: true };
}

const CLASS_RANK = { simple: 0, 'readonly-review': 1, 'small-edit': 2, complex: 3, security: 4 };
const stricter = (a, b) => (CLASS_RANK[b] > CLASS_RANK[a] ? b : a);

// Imperative verbs a user addresses to the agent (EN + FR).
const ACTION_VERB_SRC = String.raw`(review|audit|check|inspect|verify|§v[ée]rifie|look for|find|§cherche|§trouve|rewrite|§r[ée][ée]cri[st]|fix|§corrige|repair|§r[ée]pare|delete|remove|§supprime|§efface|§retire|update|§mets? [àa] jour|add|§ajoute|create|§cr[ée]e|move|§d[ée]place|rename|§renomme|commit|push|§pousse|save|§sauvegarde|§enregistre|apply|§applique|install|§installe|refactor|implement|§impl[ée]mente|edit|§[ée]dite|modify|§modifie|write|§[ée]cri[st]|run|§lance|execute|§ex[ée]cute|deploy|§d[ée]ploie|merge|§fusionne|replace|§remplace|patch|upgrade|migrate|§migre)`;
// "..., then delete them" / "puis supprime-les" / "and commit it" / "save it as ..."
const AGENT_CHAIN_RE = re(String.raw`(\bthen\b|\bafterwards\b|\bafter that\b|§puis\b|§ensuite\b|§apr[èe]s [çc]a\b|\band\b|§et\b)\s+(\w+\s+){0,2}` + ACTION_VERB_SRC + String.raw`|` + ACTION_VERB_SRC + String.raw`-(les|le|la|moi)\b|\b(save|commit|push|write) (it|them|this|that|the result)\b`);
// A payload line that starts with an imperative (not a bulleted list item).
const IMPERATIVE_LINE_RE = re(String.raw`^\s*(please\s+|peux-tu\s+)?` + ACTION_VERB_SRC + String.raw`\b`);
const PAYLOAD_SCOPE_RE = re(String.raw`\bwhole\b|\bentire\b|every file|all (the )?files|§tout le (repo|d[ée]p[ôo]t|projet|code)|§tous les fichiers|the (repo|codebase|repository)\b`);

function payloadClass(instr, payload, depth) {
  const p = payload.trim();
  if (!p) return 'simple';
  let cls = 'simple';
  // Instructions hidden in the payload: chained actions or an imperative line
  // that is not a list item ("- fix login bug" in a ticket list stays data).
  const lines = p.split('\n').map(l => l.trim()).filter(Boolean);
  const imperative = lines.find(l => !/^([-*•]|\d+[.)])\s/.test(l) && IMPERATIVE_LINE_RE.test(l));
  if (AGENT_CHAIN_RE.test(p) || imperative) {
    const sub = depth < 2 ? classifyTask({ prompt: imperative || p }, depth + 1).taskClass : 'small-edit';
    cls = stricter(cls, sub === 'simple' ? 'small-edit' : sub);
    if (DESTRUCTIVE_RE.test(p)) cls = stricter(cls, 'complex');
  }
  // Short, single-subject payloads are part of the request, not pasted data.
  const short = p.length < 240 && lines.length <= 2;
  if (short) {
    const fileTarget = FILE_TARGET_RE.test(p);
    if (SECURITY_RE.test(p) && (fileTarget || READONLY_WORDS_RE.test(p))) cls = stricter(cls, 'security');
    if (PAYLOAD_SCOPE_RE.test(p)) cls = stricter(cls, 'complex');
    if (NEW_FILE_RE.test(p)) cls = stricter(cls, 'small-edit');
    if (LEADING_TRANSFORM_RE.test(instr) && fileTarget) cls = stricter(cls, 'small-edit');
    if (LEADING_EXTRACT_RE.test(instr) && CODE_UNIT_RE.test(p) && fileTarget) cls = stricter(cls, 'small-edit');
  }
  return cls;
}

function leadingSimpleClass(instr, payload = '', depth = 0) {
  const afterVerb = instr.replace(LEADING_SIMPLE_RE, ' ');
  let cls = 'simple';
  // Security named in the instruction itself ("summarize our threat model").
  if (SECURITY_RE.test(instr)) cls = 'security';
  else if (COMPLEX_RE.test(instr)) cls = 'complex';
  else if (DESTRUCTIVE_RE.test(afterVerb)) cls = 'complex';
  else if (WRITE_RE.test(afterVerb) || NEW_FILE_RE.test(instr)) cls = 'small-edit';
  else if (LEADING_TRANSFORM_RE.test(instr) && FILE_TARGET_RE.test(instr)) cls = 'small-edit';
  else if (LEADING_EXTRACT_RE.test(instr) && CODE_UNIT_RE.test(instr)) cls = 'small-edit';
  return stricter(cls, payloadClass(instr, payload, depth));
}

function deriveTaskClass(task, roles, ch, text) {
  if (task.taskClass && TASK_CLASSES.includes(task.taskClass)) return task.taskClass;
  if (ch.leadingSimple) return ch.leadingClass;
  if (SECURITY_RE.test(text) || (roles.has('security-reviewer') && roles.has('reviewer'))) return 'security';
  if (ch.complexity === 'high' || ch.longRunning || ch.destructiveRisk === 'high') return 'complex';
  if (ch.repoWriteRequired || ch.shellRequired) return 'small-edit';
  const simpleRole = roles.has('summarizer') || roles.has('context-compressor');
  if (simpleRole && SIMPLE_RE.test(text) && !roles.has('reviewer')) return 'simple';
  if (roles.has('reviewer') || roles.has('investigator') || roles.has('architect') || roles.has('ui-validator')) return 'readonly-review';
  if (simpleRole) return 'simple';
  return 'readonly-review';
}

function classifyTask(task = {}, depth = 0) {
  const fullText = taskText(task);
  const { instruction, payload, leadingSimple } = instructionOf(fullText);
  const leadingClass = leadingSimple ? leadingSimpleClass(instruction, payload, depth) : null;
  // A leading-simple request whose payload is only data is reasoned about on
  // its instruction; if the payload turned out to carry work, on everything.
  const text = leadingSimple && leadingClass === 'simple' ? instruction : fullText;
  const roles = new Set(Array.isArray(task.roles) ? task.roles.filter(r => ROLES.includes(r)) : []);
  for (const [role, pattern] of ROLE_PATTERNS) if (pattern.test(text)) roles.add(role);
  const noRoleMatched = !roles.size;
  if (!roles.size) roles.add(task.repoWriteRequired ? 'coder' : 'investigator');

  const complexityHigh = leadingSimple ? ['complex', 'security'].includes(leadingClass) : (COMPLEX_RE.test(text) || SECURITY_RE.test(text));
  const characteristics = {
    leadingSimple, leadingClass,
    complexity: task.complexity || (complexityHigh ? 'high' : 'normal'),
    repoReadRequired: task.repoReadRequired !== undefined ? !!task.repoReadRequired : re(String.raw`\brepo|repository|§d[ée]p[ôo]t|\bfiles?\b|§fichiers?\b|working tree|\bcode\b`).test(text) || FILE_TARGET_RE.test(text),
    repoWriteRequired: task.repoWriteRequired !== undefined ? !!task.repoWriteRequired
      : leadingSimple ? leadingClass === 'small-edit'
      : (roles.has('coder') || roles.has('debugger') || roles.has('tester')) && (WRITE_RE.test(text) || (!READONLY_WORDS_RE.test(text) && !roles.has('tester'))),
    browserRequired: task.browserRequired !== undefined ? !!task.browserRequired : roles.has('ui-validator') || /browser|navigateur|screenshot/.test(text),
    longRunning: !!task.longRunning || roles.has('long-running-worker'),
    destructiveRisk: task.destructiveRisk || (DESTRUCTIVE_RE.test(leadingSimple ? text.replace(LEADING_SIMPLE_RE, ' ') : text) ? 'high' : 'normal'),
    expectedContextSize: Number(task.expectedContextSize) || 0,
    latencySensitivity: task.latencySensitivity || 'normal',
    qualityRequirement: task.qualityRequirement || task.quality || (!leadingSimple && (roles.has('reviewer') || roles.has('security-reviewer')) ? 'high' : 'normal'),
    costSensitivity: task.costSensitivity || (roles.has('summarizer') || roles.has('context-compressor') ? 'high' : 'normal'),
    shellRequired: task.shellRequired !== undefined ? !!task.shellRequired : !leadingSimple && ((roles.has('tester') && SHELL_RE.test(text)) || /\b(npm|npx|jest|pytest|lint)\b/.test(text)),
    repoSearchRequired: task.repoSearchRequired !== undefined ? !!task.repoSearchRequired : !leadingSimple && SEARCH_RE.test(text),
    securitySensitive: leadingSimple ? leadingClass === 'security' : SECURITY_RE.test(text),
  };
  characteristics.toolsRequired = characteristics.repoWriteRequired || characteristics.shellRequired || characteristics.repoSearchRequired || characteristics.browserRequired;
  characteristics.riskLevel = characteristics.destructiveRisk === 'high' || characteristics.securitySensitive || /production|\bprod\b/.test(text) ? 'high' : 'normal';

  const priority = leadingSimple && leadingClass === 'simple' ? (roles.has('summarizer') ? 'summarizer' : 'context-compressor')
    : /long.?running|overnight|nocturne|async|autonomous|autonome/.test(text) ? 'long-running-worker'
    : SECURITY_RE.test(text) && roles.has('security-reviewer') ? 'security-reviewer'
    : /summar|r[ée]sum|cheap|simple analysis|extract|extrai|classif|compress|compact|condens|reformul|rephrase/.test(text) ? (roles.has('summarizer') ? 'summarizer' : 'context-compressor')
    : /review|revue|audit|inspect|critique|verify|v[ée]rifi|validate/.test(text) ? 'reviewer'
    : /\btests?\b|spec|regression|coverage|assert|jest/.test(text) ? 'tester'
    : /debug|\bbugs?\b|broken|failure|\bfix|repair|diagnos|corrig|r[ée]pare|erreur/.test(text) ? 'debugger'
    : /architect|architecture|system design/.test(text) ? 'architect'
    : /implement|\bcode\b|modify|\bedit|refactor|\bbuild\b|\bchange|\bwrite\b|modif|faute|update|bump/.test(text) ? 'coder' : null;
  const ordered = priority && roles.has(priority) ? [priority, ...[...roles].filter(r => r !== priority)] : [...roles];
  // A short prompt that matched no role at all ("réponds OK", "donne la date
  // ISO de demain") is simple text work -- unless it writes, deletes, touches
  // security or is complex.
  // A question that names a file ("is there a race in scheduler.js?") is code
  // analysis, not simple text work.
  const shortPlain = !leadingSimple && noRoleMatched && !characteristics.toolsRequired && characteristics.complexity !== 'high'
    && characteristics.destructiveRisk !== 'high' && !WRITE_RE.test(text) && !SECURITY_RE.test(text) && !FILE_TARGET_RE.test(fullText)
    && fullText.length < 600 && !task.taskClass;
  characteristics.taskClass = shortPlain ? 'simple' : deriveTaskClass(task, roles, characteristics, text);
  return { roles: ordered, characteristics, taskClass: characteristics.taskClass };
}

function planWorkflow(task = {}) { const { roles, characteristics } = classifyTask(task); const ordered = ['architect', 'investigator', 'coder', 'debugger', 'tester', 'ui-validator', 'reviewer', 'security-reviewer', 'summarizer', 'context-compressor', 'long-running-worker'].filter(r => roles.includes(r)); return ordered.map((role, index) => ({ id: `${role}-${index + 1}`, role, dependsOn: index ? [`${ordered[index - 1]}-${index}`] : [], characteristics })); }
module.exports = { ROLES, TASK_CLASSES, classifyTask, planWorkflow, SECURITY_RE, WRITE_RE };
