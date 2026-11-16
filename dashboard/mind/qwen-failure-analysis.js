'use strict';
// Where does a failed attempt come from? Qwen's reasoning, a lesson badly adapted, a
// construct the strict checker refuses, a naming/format slip, or a task that cannot be
// done under the checker's rules. Used for the offline analysis and for clearer messages
// to the developer. It never loosens the checker.
//
// Categories (first match wins):
//   generation-format      nothing usable was produced (empty, no function, unparsable)
//   task-impossible        the task NEEDS a construct the active checker profile refuses
//   naming-slip            an identifier that does not exist here (a placeholder copied from a hint, a wrong parameter name)
//   verifier-restriction   valid JavaScript the strict checker refuses (spread, loops, block bodies, other calls ...)
//   lesson-adaptation      a lesson was shown and the answer is wrong or overflows: the method was copied or half-applied
//   reasoning              wrong values or overflow without a lesson: the algorithm itself is wrong
const SYNTAX = /Unsupported (?:expression|statement|reduce callback)|Index (?:out of range|requires)|Unsupported statement/;
const HINT_PLACEHOLDERS = ['arr', 'array', 'nums', 'numbers', 'list', 'values', 'data', 'xs', 'items', 'input', 'arg', 'args'];

const paramOf = (code) => { const m = /function\s+[A-Za-z_$][\w$]*\s*\(\s*([A-Za-z_$][\w$]*)\s*\)/.exec(String(code || '')); return m ? m[1] : null; };

// Identifiers read but never declared (parameter, const, arrow parameters), via the same parser the checker uses.
function unknownNames(code) {
  let parser; try { parser = require('@babel/parser'); } catch { return []; }
  let ast; try { ast = parser.parse(String(code || ''), { sourceType: 'script', errorRecovery: false }); } catch { return []; }
  const declared = new Set(['Math', 'module', 'exports', 'undefined']), used = new Set();
  (function walk(n, parent, key) {
    if (!n || typeof n.type !== 'string') return;
    if (n.type === 'FunctionDeclaration' || n.type === 'ArrowFunctionExpression') { (n.params || []).forEach((p) => p.type === 'Identifier' && declared.add(p.name)); if (n.id) declared.add(n.id.name); }
    if (n.type === 'VariableDeclarator' && n.id.type === 'Identifier') declared.add(n.id.name);
    if (n.type === 'Identifier' && !(parent && parent.type === 'MemberExpression' && key === 'property' && !parent.computed) && !(parent && parent.type === 'ObjectProperty' && key === 'key')) used.add(n.name);
    for (const k of Object.keys(n)) { const v = n[k]; if (Array.isArray(v)) v.forEach((c) => walk(c, n, k)); else if (v && typeof v.type === 'string') walk(v, n, k); }
  })(ast.program, null, null);
  return [...used].filter((x) => !declared.has(x));
}

function classify({ observation, code = '', lessonShown = false, requires = [], profileFeatures = null }) {
  const o = String(observation || '');
  if (!String(code).trim() || /produced no verifiable proposal|no function|not valid|Source limit/i.test(o)) return { category: 'generation-format', detail: 'no usable proposal' };
  if (profileFeatures && requires.some((f) => !profileFeatures.includes(f))) return { category: 'task-impossible', detail: 'the task needs ' + requires.filter((f) => !profileFeatures.includes(f)).join(', ') + ', which the active checker profile refuses' };
  if (/Unknown identifier/.test(o)) {
    const names = unknownNames(code), slip = names.filter((n) => HINT_PLACEHOLDERS.includes(n));
    return { category: 'naming-slip', detail: names.length ? 'unknown name(s): ' + names.join(', ') + (slip.length ? ' (a placeholder; the array parameter is ' + (paramOf(code) || 'the one in the signature') + ')' : '') : 'unknown name' };
  }
  if (SYNTAX.test(o)) return { category: 'verifier-restriction', detail: (/Unsupported (?:expression|statement|reduce callback)[^|]*/.exec(o) || [o.slice(0, 60)])[0].trim() };
  if (/strictly deep-equal|Unsupported result/.test(o)) return lessonShown ? { category: 'lesson-adaptation', detail: 'a method was shown but the answer is still wrong or not finite' } : { category: 'reasoning', detail: 'wrong value or overflow' };
  return { category: 'reasoning', detail: o.slice(0, 60) };
}

// attempts: [{attempt, code, failure, shown:[...], codexDecision}] (the experiment data shape)
function analyzeRun(attempts, opts = {}) {
  const out = []; let prev = null;
  for (const a of attempts) {
    if (!a.failure) { out.push({ attempt: a.attempt, category: 'passed', repeated: false }); prev = null; continue; }
    const c = classify({ observation: a.failure, code: a.code, lessonShown: (a.shown || []).length > 0, ...opts });
    const repeated = prev !== null && prev === a.code;
    out.push({ attempt: a.attempt, ...c, repeated }); prev = a.code;
  }
  const counts = {}; for (const x of out) if (x.category !== 'passed') counts[x.category] = (counts[x.category] || 0) + 1;
  return { attempts: out, counts, repeatedSubmissions: out.filter((x) => x.repeated).length };
}

module.exports = { classify, analyzeRun, unknownNames, paramOf, HINT_PLACEHOLDERS };
