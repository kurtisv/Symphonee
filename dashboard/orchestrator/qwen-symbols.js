'use strict';
// Symbol lookup for the Qwen repo worker. A small model that does not find a name invents one
// (setStoredQueue next to a real clearStoredQueue). The host knows the repository, so it answers
// "what really exists" itself, in two places:
//   1. right after an EDIT/CREATE: calls to a name that exists nowhere else in the repository;
//   2. right after a failed RUN: names and properties the compiler reports as unknown.
// Read-only: it only runs `git grep` and reads files. The caller masks the text before the model sees it.
const cp = require('child_process');
const fs = require('fs');
const path = require('path');

const KEYWORDS = new Set(('if for while switch catch return typeof await async function new delete void import require super this ' +
  'else do try finally throw case default of in as yield class const let var').split(' '));
const GLOBALS = new Set(('Array Object String Number Boolean Date Math JSON Promise Error Map Set WeakMap WeakSet RegExp Symbol BigInt Buffer ' +
  'parseInt parseFloat isNaN isFinite setTimeout clearTimeout setInterval clearInterval setImmediate fetch console process require ' +
  'encodeURIComponent decodeURIComponent structuredClone queueMicrotask describe test expect jest beforeEach afterEach beforeAll afterAll ' +
  'useState useEffect useRef useMemo useCallback Alert Platform').split(' '));
const SRC_GLOBS = ['*.ts', '*.tsx', '*.js', '*.jsx', '*.mjs', '*.cjs'];
const DECL_KW = '(function\\*?|const|let|var|class|interface|type|enum)';

function grep(cwd, args) {
  const r = cp.spawnSync('git', ['grep', '-n', '-I', '--untracked', '--max-count=40', ...args, '--', ...SRC_GLOBS], { cwd, encoding: 'utf8', maxBuffer: 2 * 1024 * 1024, timeout: 8000, windowsHide: true });
  return r.status === 0 || r.status === 1 ? String(r.stdout || '').split('\n').filter(Boolean) : [];
}
const parseHit = (l) => { const m = /^([^:]+):(\d+):(.*)$/.exec(l); return m ? { file: m[1], line: Number(m[2]), text: m[3] } : null; };
function words(name) { return String(name).replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[_$-]+/g, ' ').toLowerCase().split(/\s+/).filter((w) => w.length >= 3); }
function lev(a, b) {
  const m = a.length, n = b.length; if (!m) return n; if (!n) return m;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) { const cur = [i]; for (let j = 1; j <= n; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)); prev = cur; }
  return prev[n];
}
const declName = (text) => { const m = new RegExp(DECL_KW + '\\s+([A-Za-z_$][\\w$]*)').exec(text); return m ? m[2] : null; };

// Declared names that share a word with `name`, best first. `secret` = regexes of paths that must never be shown.
function similar(cwd, name, secret = [], limit = 3) {
  const ws = words(name).map((w) => w.replace(/[^a-z0-9]/g, '')).filter(Boolean); if (!ws.length) return [];
  const found = new Map();
  for (const h of grep(cwd, ['-i', '-E', '-e', DECL_KW.replace('\\\\*', '\\*') + '[[:space:]]+[A-Za-z_$0-9]*(' + ws.join('|') + ')']).map(parseHit)) {
    if (!h || secret.some((re) => re.test(h.file))) continue;
    const decl = declName(h.text); if (!decl || decl === name) continue;
    const dw = words(decl), common = ws.filter((w) => dw.includes(w)).length;
    const score = common * 10 - lev(decl.toLowerCase(), String(name).toLowerCase()) * 0.5 + (/\bexport\b/.test(h.text) ? 1 : 0);
    if (common && (!found.has(decl) || found.get(decl).score < score)) found.set(decl, { name: decl, file: h.file, line: h.line, def: h.text.trim().slice(0, 150), score });
  }
  return [...found.values()].sort((a, b) => b.score - a.score).slice(0, limit);
}
function exactDefs(cwd, name, secret = []) {
  if (!/^[A-Za-z_$][\w$]*$/.test(name)) return [];
  return grep(cwd, ['-E', '-e', DECL_KW.replace('\\\\*', '\\*') + '[[:space:]]+' + name.replace(/\$/g, '\\$') + '([^A-Za-z0-9_$]|$)']).map(parseHit)
    .filter((h) => h && !secret.some((re) => re.test(h.file))).slice(0, 2).map((h) => ({ name, file: h.file, line: h.line, def: h.text.trim().slice(0, 150) }));
}
const fmt = (list) => list.map((s) => '  ' + s.name + '  (' + s.file + ':' + s.line + ')  ' + s.def).join('\n');
const escRe = (n) => n.replace(/\$/g, '\\$');

// 1. Calls in freshly written text to names that exist nowhere else in the repository.
function unknownCalls(cwd, written, before = '', secret = []) {
  const declared = new Set([...String(written).matchAll(/(?:function\*?|const|let|var|class)\s+([A-Za-z_$][\w$]*)/g)].map((m) => m[1]));
  for (const m of String(written).matchAll(/\(([^()]*)\)\s*(?:=>|\{)/g)) for (const p of m[1].split(',')) { const n = /^\s*(?:\.\.\.)?([A-Za-z_$][\w$]*)/.exec(p); if (n) declared.add(n[1]); }
  const had = new Set([...String(before).matchAll(/[A-Za-z_$][\w$]*/g)].map((m) => m[0]));
  const names = [];
  for (const m of String(written).matchAll(/(?<![.\w$])([A-Za-z_$][\w$]{3,})\s*\(/g)) {
    const n = m[1]; if (KEYWORDS.has(n) || GLOBALS.has(n) || declared.has(n) || had.has(n) || names.includes(n)) continue;
    names.push(n); if (names.length >= 6) break;
  }
  const out = [];
  for (const n of names) {
    const inWritten = String(written).split('\n').filter((l) => new RegExp('(^|[^\\w$])' + escRe(n) + '([^\\w$]|$)').test(l)).length;
    if (grep(cwd, ['-w', '-F', '-e', n]).length > inWritten) continue; // used or defined somewhere else: it exists
    out.push({ name: n, like: similar(cwd, n, secret) });
  }
  return out;
}
function unknownCallsNote(items) {
  if (!items.length) return '';
  const names = items.map((i) => i.name + '(...)').join(', ');
  const hits = items.filter((i) => i.like.length).map((i) => 'Instead of ' + i.name + ' the repository has:\n' + fmt(i.like)).join('\n');
  return '\nHOST CHECK: ' + names + (items.length > 1 ? ' appear' : ' appears') + ' NOWHERE else in the repository, so you probably invented ' + (items.length > 1 ? 'them' : 'it') + '. ' +
    (hits ? hits + '\nRead the signature above, then fix your EDIT before you RUN.' : 'No close match found: use GREP to find the real helper before you RUN.');
}

// 2. Names and properties the compiler reports as unknown.
function fromErrors(cwd, tail, secret = [], hide = (x) => x) {
  const text = String(tail || ''), notes = [], seen = new Set();
  for (const m of text.matchAll(/TS(?:2304|2552|2305|2724|2614)[^\n]*?['"`]([A-Za-z_$][\w$]*)['"`]/g)) {
    const n = m[1]; if (seen.has(n) || notes.length >= 3) continue; seen.add(n);
    const ex = exactDefs(cwd, n, secret);
    notes.push(ex.length ? n + ' EXISTS, it is only not imported or not exported here:\n' + fmt(ex) : n + ' does not exist. Real names that look like it:\n' + (fmt(similar(cwd, n, secret)) || '  (no close match: use GREP)'));
  }
  for (const m of text.matchAll(/Property '([A-Za-z_$][\w$]*)' does not exist on type '([^']+)'/g)) {
    const prop = m[1], ty = (/([A-Za-z_$][\w$]*)(?:<[^>]*>)?(?:\[\])?$/.exec(m[2].replace(/\s*\|.*$/, '').trim()) || [])[1], key = prop + '@' + ty;
    if (!ty || seen.has(key) || notes.length >= 4) continue; seen.add(key);
    const d = grep(cwd, ['-E', '-e', '(interface|type|class)[[:space:]]+' + ty + '([^A-Za-z0-9_$]|$)']).map(parseHit).find((h) => h && !secret.some((re) => re.test(h.file)));
    if (!d) { notes.push('Property ' + prop + ' is not on ' + m[2] + '; its definition was not found, GREP for "' + ty + '".'); continue; }
    try {
      const lines = fs.readFileSync(path.join(cwd, d.file), 'utf8').replace(/\r\n/g, '\n').split('\n').slice(d.line - 1, d.line + 17);
      notes.push(prop + ' is not a field of ' + ty + '. The real definition (' + d.file + ':' + d.line + '):\n' + lines.map((l) => '  ' + l.slice(0, 140)).join('\n'));
    } catch { /* unreadable: no note */ }
  }
  if (!notes.length) return '';
  return hide('\nWHAT REALLY EXISTS (the host searched the repository; use these exact names, do not invent others):\n' + notes.join('\n').slice(0, 1700));
}

module.exports = { similar, exactDefs, unknownCalls, unknownCallsNote, fromErrors, words, lev };
