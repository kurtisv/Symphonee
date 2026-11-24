'use strict';
// Symbol lookup for the Qwen repo worker. A small model that does not find a name invents one
// (setStoredQueue next to a real clearStoredQueue). The host knows the repository, so it answers
// "what really exists" itself, in two places:
//   1. right after an EDIT/CREATE: calls to a name that exists nowhere else in the repository's source files;
//   2. right after a failed RUN: names and properties the compiler reports as unknown.
// Read-only (`git grep` + a reader the worker provides). Every line shown is masked BEFORE it is cut; the masker is only
// built when there is something to show (it scans the repository). When a search fails or runs out of time the module
// says nothing rather than claiming a name does not exist.
const cp = require('child_process');

const KEYWORDS = new Set(('if for while switch catch return typeof await async function new delete void import require super this ' +
  'else do try finally throw case default of in as yield class const let var').split(' '));
const GLOBALS = new Set(('parseInt parseFloat isNaN isFinite setTimeout clearTimeout setInterval clearInterval setImmediate fetch console process require ' +
  'encodeURIComponent decodeURIComponent structuredClone queueMicrotask describe test expect jest beforeEach afterEach beforeAll afterAll ' +
  'useState useEffect useRef useMemo useCallback').split(' '));
const SRC_GLOBS = ['*.ts', '*.tsx', '*.js', '*.jsx', '*.mjs', '*.cjs'];
const DECL_KW = '(function|const|let|var|class|interface|type|enum)';
const GREP_MS = 2500, BUDGET_MS = 5000, MAX_NAMES = 4;
const IDENT = /^[A-Za-z_$][\w$]*$/;
const identity = (x) => x;

// One budget for a whole lookup: after it is spent every search answers "unknown" (null).
function budget(ms = BUDGET_MS) { return { until: Date.now() + ms }; }
function grep(cwd, args, b) {
  const left = b ? b.until - Date.now() : GREP_MS; if (left < 200) return null;
  // core.quotePath=false: a path with accents or spaces must come back as itself, or the secret-path check would not match it.
  const r = cp.spawnSync('git', ['-c', 'core.quotePath=false', 'grep', '-n', '-I', '--untracked', '--max-count=40', ...args, '--', ...SRC_GLOBS], { cwd, encoding: 'utf8', maxBuffer: 2 * 1024 * 1024, timeout: Math.min(GREP_MS, left), windowsHide: true });
  if (r.error || r.signal || (r.status !== 0 && r.status !== 1)) return null; // a failed search proves nothing
  return String(r.stdout || '').split('\n').filter(Boolean);
}
// A path git still had to quote is dropped: it cannot be checked reliably.
const parseHit = (l) => { if (l.startsWith('"')) return null; const m = /^([^:]+):(\d+):(.*)$/.exec(l); return m ? { file: m[1], line: Number(m[2]), text: m[3].slice(0, 20000) } : null; };
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
// Results carry the raw line (`raw`); the caller masks it when it renders (fmt).
function similar(cwd, name, secret = [], limit = 3, b = null) {
  const ws = words(name).map((w) => w.replace(/[^a-z0-9]/g, '')).filter(Boolean); if (!ws.length) return [];
  const lines = grep(cwd, ['-i', '-E', '-e', DECL_KW + '[[:space:]]+[A-Za-z_$0-9]*(' + ws.join('|') + ')'], b); if (!lines) return [];
  const found = new Map();
  for (const h of lines.map(parseHit)) {
    if (!h || secret.some((re) => re.test(h.file))) continue;
    const decl = declName(h.text); if (!decl || decl === name) continue;
    const dw = words(decl), common = ws.filter((w) => dw.includes(w)).length;
    const score = common * 10 - lev(decl.toLowerCase(), String(name).toLowerCase()) * 0.5 + (/\bexport\b/.test(h.text) ? 1 : 0);
    if (common && (!found.has(decl) || found.get(decl).score < score)) found.set(decl, { name: decl, file: h.file, line: h.line, raw: h.text, score });
  }
  return [...found.values()].sort((a, c) => c.score - a.score).slice(0, limit);
}
// null = the search failed (say nothing); [] = it ran and no source file declares the name.
function exactDefs(cwd, name, secret = [], b = null) {
  if (!IDENT.test(name)) return [];
  const lines = grep(cwd, ['-E', '-e', DECL_KW + '[[:space:]]+' + name.replace(/\$/g, '\\$') + '([^A-Za-z0-9_$]|$)'], b); if (!lines) return null;
  return lines.map(parseHit).filter((h) => h && !secret.some((re) => re.test(h.file))).slice(0, 2).map((h) => ({ name, file: h.file, line: h.line, raw: h.text }));
}
// Where else the name is used (an import from a package, a re-export): null when the search failed.
function usages(cwd, name, secret = [], b = null) {
  const lines = grep(cwd, ['-w', '-F', '-e', name], b); if (!lines) return null;
  return lines.map(parseHit).filter((h) => h && !secret.some((re) => re.test(h.file))).slice(0, 2).map((h) => ({ name, file: h.file, line: h.line, raw: h.text }));
}
const fmt = (list, hide = identity) => list.map((s) => '  ' + s.name + '  (' + s.file + ':' + s.line + ')  ' + shown(hide, s.raw, 150)).join('\n');
const escRe = (n) => n.replace(/\$/g, '\\$');

// 1. Calls in freshly written text to names that exist nowhere else in the repository's source files.
// Skipped on purpose: keywords, JS globals, `new X(`, names starting with a capital (classes, components, platform constructors),
// method declarations, declared locals and parameters, and anything in a comment or a string.
function unknownCalls(cwd, written, before = '', secret = []) {
  const code = stripNonCode(written), b = budget();
  const declared = new Set([...code.matchAll(/(?:function\*?|const|let|var|class)\s+([A-Za-z_$][\w$]*)/g)].map((m) => m[1]));
  for (const m of code.matchAll(/\(([^()]*)\)\s*(?:=>|\{)/g)) for (const p of m[1].split(',')) { const n = /^\s*(?:\.\.\.)?([A-Za-z_$][\w$]*)/.exec(p); if (n) declared.add(n[1]); }
  for (const m of code.matchAll(/(?<![.\w$])([A-Za-z_$][\w$]*)\s*=>/g)) declared.add(m[1]); // `x => x(1)`: the parameter is a local
  for (const line of code.split('\n')) { // a method declaration is not a call: `render() {`, `async load(x): Promise<void> {`, `get size() {`
    const m = /^\s*(?:(?:public|private|protected|static|async|get|set|readonly|override|abstract)\s+)*([A-Za-z_$][\w$]*)\s*(?:<[^>]*>)?\s*\([^)]*\)\s*(?::[^{=;]+)?\{/.exec(line);
    if (m && !KEYWORDS.has(m[1])) declared.add(m[1]);
  }
  const had = new Set([...String(before).matchAll(/[A-Za-z_$][\w$]*/g)].map((m) => m[0]));
  const names = [];
  for (const m of code.matchAll(/(?<![.\w$])(new\s+)?([A-Za-z_$][\w$]{3,})\s*\(/g)) {
    const n = m[2]; if (m[1] || /^[A-Z]/.test(n) || KEYWORDS.has(n) || GLOBALS.has(n) || declared.has(n) || had.has(n) || names.includes(n)) continue;
    names.push(n); if (names.length >= MAX_NAMES) break;
  }
  const out = [];
  for (const n of names) {
    const inWritten = String(written).split('\n').filter((l) => new RegExp('(^|[^\\w$])' + escRe(n) + '([^\\w$]|$)').test(l)).length;
    const hits = grep(cwd, ['-w', '-F', '-e', n], b);
    if (!hits || hits.length > inWritten) continue; // search failed (no claim) or the name is used / defined elsewhere: it exists
    out.push({ name: n, like: similar(cwd, n, secret, 3, b) });
  }
  return out;
}
function unknownCallsNote(items, hide = identity) {
  if (!items.length) return '';
  const names = items.map((i) => i.name + '(...)').join(', ');
  const hits = items.filter((i) => i.like.length).map((i) => 'Instead of ' + i.name + ' the repository has:\n' + fmt(i.like, hide)).join('\n');
  return '\nHOST CHECK: ' + names + (items.length > 1 ? ' appear' : ' appears') + " NOWHERE else in the repository's source files (dependencies are not searched), so you may have invented " + (items.length > 1 ? 'them' : 'it') + '. ' +
    (hits ? hits + '\nIf one of these is what you meant, fix your EDIT before you RUN; if the name comes from a package you import, ignore this.' : 'No close match found: use GREP to find the real helper before you RUN.');
}

// 2. Names and properties the compiler reports as unknown. The hint is LOCAL first: what the failing file itself says beats
// a same-named thing in an unrelated package. `readLines(rel, fromLine, count)` is provided by the worker (confined to the worktree,
// refuses protected paths and symbolic links, size-limited) and returns an array of lines or null. `getHide()` returns the masker;
// it is only called when there is a note to show.
const dirOf = (p) => String(p).replace(/[^/]*$/, '');
function fromErrors(cwd, tail, secret = [], getHide = null, readLines = null) {
  const text = String(tail || ''), notes = [], seen = new Set(), b = budget();
  const unknown = []; // { name, file }
  for (const line of text.split('\n')) {
    if (!/error TS(2304|2552|2305|2724|2614)\b/.test(line)) continue;
    // 2304/2552: Cannot find name 'X'.  2305/2724/2614: Module '"m"' has no exported member (named) 'X'.  Never the module name.
    const x = /Cannot find name '([^']+)'/.exec(line) || /has no exported member(?: named)? '([^']+)'/.exec(line);
    const file = (/^\s*([^\s(]+)\(\d+,\d+\)/.exec(line) || [])[1] || null;
    if (x && IDENT.test(x[1])) unknown.push({ name: x[1], file: file ? file.replace(/\\/g, '/') : null });
  }
  const own = (file) => { if (!file || !readLines) return ''; try { const l = readLines(file, 1, 3000); return l ? l.join('\n') : ''; } catch { return ''; } };
  for (const { name: n, file } of unknown) {
    if (seen.has(n) || notes.length >= 3) continue; seen.add(n);
    const src = own(file), esc = n.replace(/\$/g, '\\$');
    // 1. the failing file uses it as a PROPERTY (CONFIG.batchSize): the name is not a variable.
    const prop = new RegExp('([A-Za-z_$][\\w$]*)\\.' + esc + '\\b').exec(src);
    const declaredHere = new RegExp(DECL_KW + '\\s+' + esc + '\\b|\\b(?:const|let|var)\\s*\\{[^}]*\\b' + esc + '\\b[^}]*\\}|function\\s*[\\w$]*\\s*\\([^)]*\\b' + esc + '\\b[^)]*\\)|\\([^)]*\\b' + esc + '\\b[^)]*\\)\\s*=>').test(src); // a declaration, a destructuring, or a PARAMETER list (function f(n) / (n) =>): `if (x >= n) {` is not one
    if (prop && !declaredHere) { notes.push(() => n + ' is not a variable here. This file uses it as a PROPERTY of ' + prop[1] + ': write ' + prop[1] + '.' + n + '.'); continue; }
    const ex = exactDefs(cwd, n, secret, b); if (ex === null) continue;
    const near = ex.filter((e) => file && dirOf(e.file) === dirOf(file));
    if (near.length) { notes.push((hide) => n + ' EXISTS next to this file, it is only not imported here:\n' + fmt(near, hide)); continue; }
    const used = usages(cwd, n, secret, b);
    // only used in the failing file itself and declared nowhere: a leftover of a rename or a removal, not a missing import
    const elsewhere = (used || []).filter((u) => !file || u.file !== file);
    if (!ex.length && used && used.length && !elsewhere.length) { notes.push(() => n + ' is used in this file but declared nowhere: you probably renamed or removed it. Use the variable you declared in this function, or declare ' + n + '.'); continue; }
    if (ex.length) { notes.push((hide) => n + ' is declared elsewhere in the repository (not next to this file; it may be unrelated):\n' + fmt(ex, hide)); continue; }
    const like = similar(cwd, n, secret, 6, b).filter((l) => !file || dirOf(l.file) === dirOf(file)).slice(0, 3); // a look-alike from another package is noise
    if (elsewhere.length) { notes.push((hide) => n + ' is not declared in a source file, but other files use it (it probably comes from a package: copy how they import it):\n' + fmt(elsewhere, hide)); continue; }
    notes.push((hide) => n + ' is not declared in any source file of this repository (it may come from a package: check the import, or use GREP).' + (like.length ? '\nNames that look like it, next to this file:\n' + fmt(like, hide) : ''));
  }
  for (const m of text.matchAll(/Property '([A-Za-z_$][\w$]*)' does not exist on type '([^']+)'/g)) {
    const prop = m[1], ty = (/([A-Za-z_$][\w$]*)(?:<[^>]*>)?(?:\[\])?$/.exec(m[2].replace(/\s*\|.*$/, '').trim()) || [])[1], key = prop + '@' + ty;
    if (!ty || seen.has(key) || notes.length >= 4) continue; seen.add(key);
    const lines = grep(cwd, ['-E', '-e', '(interface|type|class)[[:space:]]+' + ty + '([^A-Za-z0-9_$]|$)'], b); if (!lines) continue;
    const d = lines.map(parseHit).find((h) => h && !secret.some((re) => re.test(h.file)));
    const pointer = 'Property ' + prop + ' is not on ' + m[2] + '; use GREP for "' + ty + '" to read its definition.';
    if (!d || !readLines) { notes.push(() => pointer); continue; }
    // A type alias that is a union of string literals has no properties at all: the property belongs to the object that CONTAINS the value.
    if (new RegExp('type\\s+' + ty + '\\s*=\\s*$|type\\s+' + ty + '\\s*=\\s*[\'"]').test(d.text)) {
      notes.push(() => ty + ' is a union of string values (' + d.file + ':' + d.line + '), it has no properties: ' + prop + ' is not on it. Look for the object type that holds a ' + ty + ' in a field (' + prop + ' is probably not part of the data at all).');
      continue;
    }
    let body = null; try { body = readLines(d.file, d.line, 18); } catch { body = null; }
    if (!body) { notes.push(() => pointer); continue; }
    const indent = (/^\s*/.exec(body[0] || '') || [''])[0], end = body.findIndex((l, i) => i > 0 && l.startsWith(indent + '}')); // the definition stops at its own closing brace
    const own2 = end >= 0 ? body.slice(0, end + 1) : body;
    notes.push((hide) => prop + ' is not a field of ' + ty + '. The real definition (' + d.file + ':' + d.line + '):\n' + own2.map((l) => '  ' + hide(String(l).replace(/\s+$/, '')).slice(0, 140)).join('\n'));
  }
  if (!notes.length) return '';
  let hide; try { hide = typeof getHide === 'function' ? getHide() : identity; } catch { return ''; } // no masker, no note
  return hide('\nWHAT REALLY EXISTS (the host searched the repository; use these exact names, do not invent others):\n' + notes.map((fn) => fn(hide)).join('\n').slice(0, 1700));
}

module.exports = { similar, exactDefs, usages, unknownCalls, unknownCallsNote, fromErrors, stripNonCode, words, lev };
