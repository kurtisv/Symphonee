'use strict';
// Symbol lookup for the Qwen repo worker. A small model that does not find a name invents one
// (setStoredQueue next to a real clearStoredQueue). The host knows the repository, so it answers
// "what really exists" itself, in two places:
//   1. right after an EDIT/CREATE: calls to a name that exists nowhere else in the repository;
//   2. right after a failed RUN: names and properties the compiler reports as unknown.
// Read-only (`git grep` + a reader the worker provides). Every line shown is masked BEFORE it is cut, and when the search
// itself fails or runs out of time the module says nothing rather than claiming a name does not exist.
const cp = require('child_process');

const KEYWORDS = new Set(('if for while switch catch return typeof await async function new delete void import require super this ' +
  'else do try finally throw case default of in as yield class const let var').split(' '));
const GLOBALS = new Set(('Array Object String Number Boolean Date Math JSON Promise Error Map Set WeakMap WeakSet RegExp Symbol BigInt Buffer ' +
  'parseInt parseFloat isNaN isFinite setTimeout clearTimeout setInterval clearInterval setImmediate fetch console process require ' +
  'encodeURIComponent decodeURIComponent structuredClone queueMicrotask describe test expect jest beforeEach afterEach beforeAll afterAll ' +
  'useState useEffect useRef useMemo useCallback Alert Platform').split(' '));
const SRC_GLOBS = ['*.ts', '*.tsx', '*.js', '*.jsx', '*.mjs', '*.cjs'];
const DECL_KW = '(function|const|let|var|class|interface|type|enum)';
const GREP_MS = 2500, BUDGET_MS = 5000, MAX_NAMES = 4;
const IDENT = /^[A-Za-z_$][\w$]*$/;
const identity = (x) => x;

// One budget for a whole lookup: after it is spent every search answers "unknown" (null).
function budget(ms = BUDGET_MS) { return { until: Date.now() + ms }; }
function grep(cwd, args, b) {
  const left = b ? b.until - Date.now() : GREP_MS; if (left < 200) return null;
  const r = cp.spawnSync('git', ['grep', '-n', '-I', '--untracked', '--max-count=40', ...args, '--', ...SRC_GLOBS], { cwd, encoding: 'utf8', maxBuffer: 2 * 1024 * 1024, timeout: Math.min(GREP_MS, left), windowsHide: true });
  if (r.error || r.signal || (r.status !== 0 && r.status !== 1)) return null; // a failed search proves nothing
  return String(r.stdout || '').split('\n').filter(Boolean);
}
const parseHit = (l) => { const m = /^([^:]+):(\d+):(.*)$/.exec(l); return m ? { file: m[1], line: Number(m[2]), text: m[3] } : null; };
const shown = (hide, text, n) => hide(String(text).trim()).slice(0, n); // masked first, cut after: a value cut in two would not be recognised
function words(name) { return String(name).replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[_$-]+/g, ' ').toLowerCase().split(/\s+/).filter((w) => w.length >= 3); }
function lev(a, b) {
  const m = a.length, n = b.length; if (!m) return n; if (!n) return m;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) { const cur = [i]; for (let j = 1; j <= n; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)); prev = cur; }
  return prev[n];
}
const declName = (text) => { const m = new RegExp(DECL_KW + '\\s+([A-Za-z_$][\\w$]*)').exec(text); return m ? m[2] : null; };

// Comments and string literals are not calls: blank them out before looking for `name(`.
function stripNonCode(src) {
  const s = String(src); let out = '', i = 0;
  while (i < s.length) {
    const c = s[i], d = s[i + 1];
    if (c === '/' && d === '/') { while (i < s.length && s[i] !== '\n') i++; continue; }
    if (c === '/' && d === '*') { const e = s.indexOf('*/', i + 2); i = e < 0 ? s.length : e + 2; out += ' '; continue; }
    if (c === '"' || c === "'" || c === '`') { const q = c; i++; while (i < s.length && s[i] !== q) { if (s[i] === '\\') i++; if (q !== '`' && s[i] === '\n') break; i++; } i++; out += '""'; continue; }
    out += c; i++;
  }
  return out;
}

// Declared names that share a word with `name`, best first. `secret` = regexes of paths that must never be shown.
function similar(cwd, name, secret = [], limit = 3, b = null, hide = identity) {
  const ws = words(name).map((w) => w.replace(/[^a-z0-9]/g, '')).filter(Boolean); if (!ws.length) return [];
  const lines = grep(cwd, ['-i', '-E', '-e', DECL_KW + '[[:space:]]+[A-Za-z_$0-9]*(' + ws.join('|') + ')'], b); if (!lines) return [];
  const found = new Map();
  for (const h of lines.map(parseHit)) {
    if (!h || secret.some((re) => re.test(h.file))) continue;
    const decl = declName(h.text); if (!decl || decl === name) continue;
    const dw = words(decl), common = ws.filter((w) => dw.includes(w)).length;
    const score = common * 10 - lev(decl.toLowerCase(), String(name).toLowerCase()) * 0.5 + (/\bexport\b/.test(h.text) ? 1 : 0);
    if (common && (!found.has(decl) || found.get(decl).score < score)) found.set(decl, { name: decl, file: h.file, line: h.line, def: shown(hide, h.text, 150), score });
  }
  return [...found.values()].sort((a, c) => c.score - a.score).slice(0, limit);
}
// null = the search failed (say nothing); [] = it ran and nothing defines the name.
function exactDefs(cwd, name, secret = [], b = null, hide = identity) {
  if (!IDENT.test(name)) return [];
  const lines = grep(cwd, ['-E', '-e', DECL_KW + '[[:space:]]+' + name.replace(/\$/g, '\\$') + '([^A-Za-z0-9_$]|$)'], b); if (!lines) return null;
  return lines.map(parseHit).filter((h) => h && !secret.some((re) => re.test(h.file))).slice(0, 2).map((h) => ({ name, file: h.file, line: h.line, def: shown(hide, h.text, 150) }));
}
const fmt = (list) => list.map((s) => '  ' + s.name + '  (' + s.file + ':' + s.line + ')  ' + s.def).join('\n');
const escRe = (n) => n.replace(/\$/g, '\\$');

// 1. Calls in freshly written text to names that exist nowhere else in the repository.
function unknownCalls(cwd, written, before = '', secret = [], hide = identity) {
  const code = stripNonCode(written), b = budget();
  const declared = new Set([...code.matchAll(/(?:function\*?|const|let|var|class)\s+([A-Za-z_$][\w$]*)/g)].map((m) => m[1]));
  for (const m of code.matchAll(/\(([^()]*)\)\s*(?:=>|\{)/g)) for (const p of m[1].split(',')) { const n = /^\s*(?:\.\.\.)?([A-Za-z_$][\w$]*)/.exec(p); if (n) declared.add(n[1]); }
  const had = new Set([...String(before).matchAll(/[A-Za-z_$][\w$]*/g)].map((m) => m[0]));
  const names = [];
  for (const m of code.matchAll(/(?<![.\w$])([A-Za-z_$][\w$]{3,})\s*\(/g)) {
    const n = m[1]; if (KEYWORDS.has(n) || GLOBALS.has(n) || declared.has(n) || had.has(n) || names.includes(n)) continue;
    names.push(n); if (names.length >= MAX_NAMES) break;
  }
  const out = [];
  for (const n of names) {
    const inWritten = String(written).split('\n').filter((l) => new RegExp('(^|[^\\w$])' + escRe(n) + '([^\\w$]|$)').test(l)).length;
    const hits = grep(cwd, ['-w', '-F', '-e', n], b);
    if (!hits || hits.length > inWritten) continue; // search failed (no claim) or the name is used / defined elsewhere: it exists
    out.push({ name: n, like: similar(cwd, n, secret, 3, b, hide) });
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

// 2. Names and properties the compiler reports as unknown. `readLines(rel, fromLine, count)` is provided by the worker
// (confined to the worktree, refuses protected paths and symbolic links, size-limited) and returns an array of lines or null.
function fromErrors(cwd, tail, secret = [], hide = identity, readLines = null) {
  const text = String(tail || ''), notes = [], seen = new Set(), b = budget();
  const unknown = [];
  for (const line of text.split('\n')) {
    const m = /error TS(2304|2552|2305|2724|2614)\b/.exec(line); if (!m) continue;
    // 2304/2552: Cannot find name 'X'.  2305/2724/2614: Module '"m"' has no exported member (named) 'X'.  Never the module name.
    const x = /Cannot find name '([^']+)'/.exec(line) || /has no exported member(?: named)? '([^']+)'/.exec(line);
    if (x && IDENT.test(x[1])) unknown.push(x[1]);
  }
  for (const n of unknown) {
    if (seen.has(n) || notes.length >= 3) continue; seen.add(n);
    const ex = exactDefs(cwd, n, secret, b, hide); if (ex === null) continue;
    if (ex.length) { notes.push(n + ' EXISTS, it is only not imported or not exported here:\n' + fmt(ex)); continue; }
    const like = similar(cwd, n, secret, 3, b, hide);
    notes.push(n + ' does not exist. Real names that look like it:\n' + (like.length ? fmt(like) : '  (no close match: use GREP)'));
  }
  for (const m of text.matchAll(/Property '([A-Za-z_$][\w$]*)' does not exist on type '([^']+)'/g)) {
    const prop = m[1], ty = (/([A-Za-z_$][\w$]*)(?:<[^>]*>)?(?:\[\])?$/.exec(m[2].replace(/\s*\|.*$/, '').trim()) || [])[1], key = prop + '@' + ty;
    if (!ty || seen.has(key) || notes.length >= 4) continue; seen.add(key);
    const lines = grep(cwd, ['-E', '-e', '(interface|type|class)[[:space:]]+' + ty + '([^A-Za-z0-9_$]|$)'], b); if (!lines) continue;
    const d = lines.map(parseHit).find((h) => h && !secret.some((re) => re.test(h.file)));
    if (!d || !readLines) { notes.push('Property ' + prop + ' is not on ' + m[2] + '; use GREP for "' + ty + '" to read its definition.'); continue; }
    let body = null; try { body = readLines(d.file, d.line, 18); } catch { body = null; }
    if (!body) { notes.push('Property ' + prop + ' is not on ' + m[2] + '; use GREP for "' + ty + '" to read its definition.'); continue; }
    notes.push(prop + ' is not a field of ' + ty + '. The real definition (' + d.file + ':' + d.line + '):\n' + body.map((l) => '  ' + shown(hide, l, 140)).join('\n'));
  }
  if (!notes.length) return '';
  return hide('\nWHAT REALLY EXISTS (the host searched the repository; use these exact names, do not invent others):\n' + notes.join('\n').slice(0, 1700));
}

module.exports = { similar, exactDefs, unknownCalls, unknownCallsNote, fromErrors, stripNonCode, words, lev };
