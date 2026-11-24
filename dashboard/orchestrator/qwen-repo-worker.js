'use strict';
// Qwen as a developer on a REAL repository, through an explicit host protocol.
//
// The 4B model is used in TEXT mode: it has no native tools. Each turn it writes plain
// text containing ACTION lines; the host parses them strictly and executes at most a few,
// inside ONE isolated git worktree. The model never gets a shell, an arbitrary path or the
// real checkout. What the host does for it:
//   LIST <dir>                 list a directory (tracked files only)
//   READ <path> [from-to]      read a file, bounded
//   GREP <text> [IN <dir>]     fixed-string search over tracked files
//   EDIT <path> + SEARCH/REPLACE block    exact, unique replacement (the only way to change a file)
//   CREATE <path> + CONTENT block         new file (never overwrites)
//   PLAN / STEP-DONE / NOTE    decomposition and external memory (kept across turns and restarts)
//   RUN                        the host runs the repository's own verification commands
//   DONE <summary> / STUCK <reason>
// DONE is only believed if the host's own RUN passes. Protected paths (secrets, config, auth ...)
// can be neither read nor written. Nothing is committed, pushed or merged.
//
// Guard rails are about PROGRESS and resources, not about Qwen's token count (it runs locally):
// identical re-submissions, repeated identical failures, free RAM, wall-clock slot, model health.
// When the same failure repeats, the host demands a really different strategy (bounded number of
// switches) and then hands the work back (state 'blocked') so Claude can take over.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const cp = require('node:child_process');
const symbols = require('./qwen-symbols');
// Fail closed: when the gate is REQUIRED and breaks, the task is not reported finished (the model is told the behaviour is not verified).
const behaviorLint = async (cwd, base, cfg) => { try { return await require('../mind/behavior-gate').lint(cwd, base, cfg); } catch (e) { return cfg && cfg.required ? ['BEHAVIOUR GATE ERROR: the behaviour of this change could not be verified (' + String(e && e.message || e).slice(0, 120) + ').'] : []; } };

const BASE_URL = 'http://127.0.0.1:1234';
const LIMITS = Object.freeze({
  actionsPerTurn: 4, readChars: 5000, grepHits: 20, listEntries: 60, editFileBytes: 120000, newFileBytes: 60000, noteChars: 300, planSteps: 6,
  maxTurns: 80, maxSwitches: 1, repeatTurnsBeforeDemand: 3, maxRepeatDemands: 2, noChangeDemandTurns: 12, noChangeStuckTurns: 26, ramWaitMs: 180000, ramPollMs: 10000, sameFailureBeforeSwitch: 3, idleRunsBeforeStuck: 3, formatErrorsBeforeStuck: 6, protectedAsksBeforeStuck: 3, emptyTurnsWindow: 8, emptyTurnsBeforeStuck: 4, promptChars: 11000, maxTokens: 2000, minFreeRamBytes: 1.5 * 1024 * 1024 * 1024,
});
const sha = (x) => crypto.createHash('sha256').update(String(x), 'utf8').digest('hex');
const clip = (s, n) => (String(s).length > n ? String(s).slice(0, n) + '\n...[cut]' : String(s));
// Keeps the END (where the most recent and most important results are placed).
const tailClip = (s, n) => (String(s).length > n ? '[cut]...\n' + String(s).slice(-(n - 9)) : String(s));
// Keeps the beginning (what it is) and the end (where it failed, the appended context): a RUN entry holds both.
const midClip = (s, n) => (String(s).length > n ? String(s).slice(0, 200) + '\n...[cut]...\n' + String(s).slice(-(n - 220)) : String(s));

// ── path confinement ────────────────────────────────────────────────────
// Two levels (decision of 2026-11-22): the pilot's protected paths can be READ for context but never changed;
// secrets can be neither read nor changed. A secret the model reads could be copied into code that leaves
// the PC (Codex review in the cloud, commits).
const SECRET_PATTERNS = Object.freeze([
  '(^|/)\\.env(rc)?$', '(^|/)\\.env\\.(?!(example|sample|template|dist)$)[^/]+$', '(^|/)secrets/', '(^|/)secrets?\\.(json|ya?ml|txt)$', 'google-services\\.json$', 'GoogleService-Info\\.plist$', '(^|/)eas\\.json$',
  '\\.(pem|key|p12|pfx|jks|keystore|mobileprovision)$', '(^|/)id_(rsa|ed25519|ecdsa)', '(^|/)\\.npmrc$', '(^|/)credentials?(\\.json)?$', '(^|/)config/runtime\\.json$',
]);
// Values held by the worktree's secret files, read by the HOST only, so that a test or build that prints one
// (stack trace, config dump) cannot pass it to the model through RUN output. Short values are ignored (too common).
function secretValues(worktree, secretRe) {
  const out = new Set();
  // --directory: an ignored folder (node_modules) is one entry, not thousands. A failed listing (buffer, timeout) is an incomplete scan.
  const l1 = git(worktree, ['ls-files', '--cached', '--others', '--exclude-standard'], 64 * 1024 * 1024), l2 = git(worktree, ['ls-files', '--others', '--ignored', '--exclude-standard', '--directory'], 64 * 1024 * 1024);
  let incomplete = !l1.ok || !l2.ok;
  const list = l1.out + '\n' + l2.out;
  // An ignored secret folder comes back as one "dir/" entry: walk it (bounded), so secrets/credentials.json counts.
  // Every ignored folder is walked (bounded; node_modules and .git skipped): a secret file can sit in any of them
  // (.config/credentials.json). Inside a folder that is itself secret (secrets/), every file counts.
  const files = [], isSecret = (rel) => secretRe.some((re) => re.test(rel));
  let visited = 0;
  const walk = (rel, depth, all) => {
    let entries; try { entries = fs.readdirSync(path.join(worktree, rel), { withFileTypes: true }); } catch { incomplete = true; return; }
    for (const e of entries) {
      if (files.length >= 500 || ++visited > 100000) { incomplete = true; return; }
      const r = rel + e.name; if (e.name === 'node_modules' || e.name === '.git') continue;
      // A link is not followed (it may lead anywhere, e.g. to a folder holding a .env): any link makes the scan
      // incomplete (fail closed). node_modules (dependency junctions, third-party code) is skipped above by name.
      if (e.isSymbolicLink()) { incomplete = true; continue; }
      if (e.isDirectory()) { if (depth < 8) walk(r + '/', depth + 1, all || isSecret(r + '/') || isSecret(r)); else incomplete = true; }
      else if (e.isFile() && (all || isSecret(r))) files.push(r);
    }
  };
  for (const rel of list.split('\n').map((s) => s.trim().replace(/\\/g, '/')).filter(Boolean)) {
    if (rel.startsWith('"')) { incomplete = true; continue; } // a quoted (escaped) path cannot be matched reliably: fail closed
    if (/(^|\/)node_modules(\/|$)/.test(rel)) continue;
    if (rel.endsWith('/')) { walk(rel, 0, isSecret(rel) || isSecret(rel.slice(0, -1))); continue; }
    // A listed link (tracked or not) may point at a secret a check could print: fail closed, as inside folders.
    try { if (fs.lstatSync(path.join(worktree, rel)).isSymbolicLink()) { incomplete = true; continue; } } catch (_) {}
    if (isSecret(rel)) files.push(rel);
  }
  for (const rel of files) {
    let text; try { const abs = path.join(worktree, rel); if (fs.statSync(abs).size > 262144) { incomplete = true; continue; } text = fs.readFileSync(abs, 'utf8'); } catch { incomplete = true; continue; }
    // What is masked (2026-11-23): a value that LOOKS like a secret (a digit, mixed case, or a special character) or any value
    // carried by a sensitive key (password, token, secret, key...), from 6 characters. Plain lowercase words of config files
    // ("services", "development", "completed") are structure, not secrets: masking them blanked ordinary test output
    // (src/__tests__/[REDACTED]/...). A bare list item ("- abc def") is a value by structure and is always masked.
    const add = (v, sens) => { v = String(v).trim(); if (v.length >= 6 && (sens || TOKEN_LIKE(v))) out.add(v); };
    const addJson = (raw, sens) => { add(raw, sens); try { add(JSON.parse('"' + raw + '"'), sens); } catch (_) {} };
    // The items of an inline array value: ["a", 'b', c]
    const itemsOf = (raw) => { const r = []; const body = raw.replace(/^\s*\[/, '').replace(/\]\s*[,;]?\s*$/, ''); for (const m of body.matchAll(/"((?:[^"\\]|\\.)*)"|'([^']*)'|([^,\s][^,]*)/g)) r.push((m[1] !== undefined ? m[1] : m[2] !== undefined ? m[2] : m[3]).trim()); return r; };
    // Is the position inside a bracket ('[' or '{', quotes honoured) opened by a sensitive key, at any depth of the same line?
    const sensStackAt = (line, pos) => {
      const stack = []; let q = null;
      for (let i = 0; i < pos && i < line.length; i++) {
        const c = line[i];
        if (q) { if (c === '\\') i++; else if (c === q) q = null; continue; }
        if (c === '"' || c === "'") { q = c; continue; }
        if (c === '[' || c === '{') { const km = /["']?([A-Za-z_][\w.-]*)["']?\s*[:=]\s*$/.exec(line.slice(0, i)); stack.push(!!km && SENSITIVE_KEY.test(km[1])); }
        else if (c === ']' || c === '}') stack.pop();
      }
      return stack.some(Boolean);
    };
    // Is the value that starts at `pos` introduced by a sensitive key (KEY: value, KEY=value, anywhere in the line)?
    const sensKeyBefore = (line, pos) => { const km = /["']?([A-Za-z_][\w.-]*)["']?\s*[:=]\s*[\[{]?\s*$/.exec(line.slice(0, pos)); return !!km && SENSITIVE_KEY.test(km[1]); };
    const KV = /^(?:-\s+)?(?:export\s+)?["']?([A-Za-z_][\w.-]*)["']?\s*[:=]\s*(.*?)\s*,?$/;
    const open = []; // indentation of sensitive keys whose value continues on the following (deeper) lines
    for (const line of text.split(/\r?\n/)) {
      const t = line.trim(); if (!t || /^#/.test(t) || /^-----(BEGIN|END) /.test(t)) continue;
      const indent = line.length - line.trimStart().length;
      while (open.length && (indent < open[open.length - 1] || (indent === open[open.length - 1] && !/^-\s/.test(t)))) open.pop();
      const inherited = open.length > 0;
      const kv = KV.exec(t);
      const item = !kv && /^-\s+(.+)$/.exec(t);
      // 0) inside the value of a sensitive key (block scalar, multi-line array or mapping): every content line is a value
      if (inherited) { add(t.replace(/^-\s+/, '').replace(/[,;]$/, '').replace(/^["']|["']$/g, '').replace(/\s+#.*$/, ''), true); }
      // 1) KEY=value / key: value / "key": value / - key: value : the value, without quotes or an inline comment; arrays item by item
      if (kv) {
        const sens = SENSITIVE_KEY.test(kv[1]) || inherited; let v = kv[2];
        if (/^\s*\[/.test(v)) { for (const it of itemsOf(v)) addJson(it, sens); }
        else { const q = /^(["'])((?:(?!\1).)*)\1/.exec(v); v = q ? q[2] : v.replace(/\s+#.*$/, ''); addJson(v, sens); }
        // The value continues on the next lines: empty, a block scalar (| >), or an array/object opened and not closed on this line.
        const unclosed = (kv[2].match(/[\[{]/g) || []).length > (kv[2].match(/[\]}]/g) || []).length;
        if (SENSITIVE_KEY.test(kv[1]) && (kv[2] === '' || /^[|>][+-]?$/.test(kv[2]) || unclosed)) open.push(indent);
      }
      // 2) a bare list item: always a value
      if (item) { add(item[1].replace(/\s+#.*$/, '').replace(/^["']|["']$/g, ''), true); }
      // 3) every quoted string that is not a key; inside an array it takes the sensitivity of the key that opened the array
      for (const m of t.matchAll(/"((?:[^"\\]|\\.)+)"(\s*:)?/g)) { if (m[2]) continue; addJson(m[1], inherited || sensStackAt(t, m.index) || sensKeyBefore(t, m.index)); }
      for (const m of t.matchAll(/(['`])((?:(?!\1).)+)\1/g)) add(m[2], inherited || sensStackAt(t, m.index) || sensKeyBefore(t, m.index));
      // 4) unquoted values after ':' or '=' (a JSON number, a YAML scalar)
      for (const m of t.matchAll(/[=:]\s*([^\s,"'{}\[\]]{6,})/g)) add(m[1], inherited || sensStackAt(t, m.index) || sensKeyBefore(t, m.index + 1));
      // 5) a line that is neither a pair nor a prose sentence: a bare token or a PEM body line
      if (!kv && !item && !/\s/.test(t)) add(t, false);
      // 6) token-shaped words of the line (key names and snake_case identifiers are structure: dropped first)
      // Inside a bracket opened by a sensitive key (or an indented continuation of one) EVERY word is a value, whatever its shape.
      const blank = (m) => ' '.repeat(m.length);
      const tv = t.replace(/["']?[A-Za-z_][\w.-]*["']?\s*:/g, blank).replace(/^(?:-\s+)?(?:export\s+)?[A-Za-z_][\w.-]*=/, blank);
      for (const m of tv.matchAll(/[^\s=:,;"'`\[\]{}()]+/g)) { const w = m[0]; if (w.length < 6) continue; if (inherited || sensStackAt(t, m.index) || (TOKEN_LIKE(w) && !/^[A-Za-z]+(_[A-Za-z]+)+$/.test(w))) out.add(w); }
    }
    if (out.size > 5000) { incomplete = true; break; }
  }
  const values = [...out].sort((x, y) => y.length - x.length);
  values.incomplete = incomplete; // the caller must then fail closed (it cannot know every secret value)
  return values;
}
// When the secret scan was incomplete, only node:test result and assertion lines pass (fail closed), still masked.
// Counts only: test names, error messages and actual/expected values could all carry an unknown secret.
const SAFE_LINE = /^\s*ℹ (tests|suites|pass|fail|cancelled|skipped|todo) \d+\s*$/;
// Nothing of 6+ characters from a secret file is exempt ("password: production" is a secret too): masking an
// ordinary word in Qwen's view of the output costs readability only. Under 6 characters values are not masked.
const COMMON_VALUE = /^$/;
const TOKEN_LIKE = (v) => /\d/.test(v) || (/[A-Z]/.test(v) && /[a-z]/.test(v)) || /[^A-Za-z0-9 ]/.test(v);
const SENSITIVE_KEY = /((^|[^a-z])keys?([^a-z]|$)|pass|secret|token|api[_-]?key|access[_-]?key|private|credential|auth|(^|[^a-z])pin([^a-z]|$)|bearer|signature|salt|cert|licen[cs]e)/i;
const redactWith = (values) => (s) => {
  let t = String(s || '');
  if (values.incomplete) t = '[output reduced to test results: the secret scan of this worktree was incomplete]\n' + t.split(/\r?\n/).filter((l) => SAFE_LINE.test(l)).join('\n');
  for (const v of values) if (t.includes(v)) t = t.split(v).join('[REDACTED]');
  return t;
};
function confine(worktree, rel, protectedRe, writing = false) {
  const r = String(rel || '').trim().replace(/\\/g, '/').replace(/^\.\//, '');
  if (!r || r.length > 240 || r.includes('\0') || path.isAbsolute(r) || /^[A-Za-z]:/.test(r)) throw new Error('Path refused: use a relative path inside the repository');
  const parts = r.split('/');
  if (parts.some((p) => p === '..' || p === '' || p === '.git' || p.toLowerCase() === '.git')) throw new Error('Path refused: outside the working tree or inside .git');
  // Windows aliases of a name: trailing dots or spaces (".env." is ".env"), alternate data streams ("a:b"), 8.3 short names ("ENV~1").
  if (parts.some((p) => /[. ]$/.test(p) || p.includes(':') || /~\d/.test(p))) throw new Error('Path refused: write the exact file name (no trailing dot or space, no ":" and no short "~1" name)');
  // The name Windows really opens is checked as well (case, short names, any alias the rules above missed).
  let real = r; try { real = path.relative(fs.realpathSync.native(worktree), fs.realpathSync.native(path.resolve(worktree, r))).replace(/\\/g, '/'); } catch (_) {}
  if ((protectedRe || []).some((re) => re.test(r) || re.test(real))) throw new Error(writing ? 'Path refused: protected (restricted area); you may READ it but it can never be changed' : 'Path refused: protected (secrets); it cannot be read or changed');
  const abs = path.resolve(worktree, r), root = path.resolve(worktree);
  if (abs !== root && !abs.startsWith(root + path.sep)) throw new Error('Path refused: outside the working tree');
  // a symbolic link or junction must not lead out of the worktree
  let cur = root;
  for (const p of parts) { cur = path.join(cur, p); let st; try { st = fs.lstatSync(cur); } catch { break; } if (st.isSymbolicLink()) throw new Error('Path refused: symbolic link'); }
  return { rel: r, abs };
}
const compile = (patterns) => (patterns || []).map((p) => { try { return new RegExp(p, 'i'); } catch { return null; } }).filter(Boolean);

function git(cwd, args, max = 4 * 1024 * 1024) {
  // core.quotePath=false: paths come back unquoted, so a secret path with accents (cafe/.env) still matches the patterns.
  const r = cp.spawnSync('git', ['-c', 'core.quotePath=false', ...args], { cwd, encoding: 'utf8', timeout: 20000, windowsHide: true, maxBuffer: max, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
  return { ok: r.status === 0, out: String(r.stdout || ''), err: String(r.stderr || '') };
}

// ── protocol parser (strict on content; the model's text is data) ───────
// A 4B model often gets the FORM of a block slightly wrong (2026-11-22: every real-repository failure was a
// malformed SEARCH/REPLACE block). The markers are therefore read tolerantly (indentation, 5-9 marker
// characters, case, a ``` fence around the block, a quoted path); what is searched and written is unchanged.
const MARK = {
  search: /^\s*<{5,9}\s*SEARCH\s*$/i, content: /^\s*<{5,9}\s*CONTENT\s*$/i,
  sep: /^\s*={5,9}\s*$/, replace: /^\s*>{5,9}\s*REPLACE\s*$/i, end: /^\s*>{5,9}\s*END\s*$/i,
};
const FENCE = /^\s*```[\w-]*\s*$/;
function parseActions(text) {
  const lines = String(text || '').replace(/\r\n/g, '\n').split('\n'), actions = [], errors = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    let m;
    if ((m = /^\s*(EDIT|CREATE)\s*:?\s+(\S.*?)\s*$/i.exec(line))) {
      const kind = m[1].toUpperCase(), file = m[2].replace(/^[`'"*]+|[`'"*:]+$/g, ''); const open = kind === 'EDIT' ? MARK.search : MARK.content;
      let k = i + 1; while (k < lines.length && (FENCE.test(lines[k]) || !lines[k].trim()) && k - i <= 3) k++;
      // No block follows: a prose sentence ("Create a helper first.") is ignored, not counted as a format error.
      // Only an UPPERCASE keyword followed by a single path-like token is a real, malformed action.
      if ((!lines[k] || !open.test(lines[k])) && (m[1] !== m[1].toUpperCase() || /\s/.test(file) || !/[./\\]/.test(file))) continue;
      if (!lines[k] || !open.test(lines[k])) { errors.push(kind + ' ' + file + ': the block must start on the next line with ' + (kind === 'EDIT' ? '<<<<<<< SEARCH' : '<<<<<<< CONTENT')); continue; }
      let j = k + 1; const a = [], b = []; let sep = false, closed = false;
      for (; j < lines.length; j++) {
        if (kind === 'EDIT') {
          if (!sep && MARK.sep.test(lines[j])) { sep = true; continue; }
          if (MARK.replace.test(lines[j])) { closed = true; break; }
          (sep ? b : a).push(lines[j]);
        } else { if (MARK.end.test(lines[j])) { closed = true; break; } a.push(lines[j]); }
      }
      if (!closed || (kind === 'EDIT' && !sep)) { errors.push(kind + ' ' + file + ': incomplete block' + (kind === 'EDIT' ? ' (needs ======= and >>>>>>> REPLACE)' : ' (needs >>>>>>> END)')); i = j; continue; }
      actions.push(kind === 'EDIT' ? { type: 'edit', file, search: a.join('\n'), replace: b.join('\n') } : { type: 'create', file, content: a.join('\n') });
      i = j; continue;
    }
    if ((m = /^LIST\s+(\S.*?)\s*$/.exec(line)) || /^LIST\s*$/.test(line)) { actions.push({ type: 'list', dir: m ? m[1] : '.' }); continue; }
    // READ <path> [from-to]. A small model writes the range in its own words ("from 260 to 350", "lines 260..350", "from-265 to-320",
    // "from-to=1-350"); seen 2026-11-23: every such request was rejected as "no action", so it never reached the code it needed.
    // Whatever follows the path: two numbers are a range, one number is a start line; no number is a plain READ.
    // (anything else after the path, e.g. a sentence, is not a READ: the line stays unrecognised, as before)
    if ((m = /^READ\s+`?([^\s`]+)`?(.*)$/.exec(line)) && m[2].replace(/\b(from|to|lines?|through|until|range)\b/gi, '').replace(/[^A-Za-z]/g, '') === '') {
      const nums = (m[2].match(/\d+/g) || []).map(Number);
      let from = 1, to = null;
      if (nums.length >= 2) { from = Math.min(nums[0], nums[1]) || 1; to = Math.max(nums[0], nums[1]); } else if (nums.length === 1) from = nums[0] || 1;
      actions.push({ type: 'read', file: m[1], from, to }); continue;
    }
    if ((m = /^GREP\s+(.+?)(?:\s+IN\s+(\S+))?\s*$/.exec(line))) { actions.push({ type: 'grep', text: m[1].replace(/^["'`]|["'`]$/g, ''), dir: m[2] || '.' }); continue; }
    if (/^RUN\s*$/.test(line)) { actions.push({ type: 'run' }); continue; }
    if ((m = /^NOTE\s+(.+)$/.exec(line))) { actions.push({ type: 'note', text: m[1] }); continue; }
    if ((m = /^PLAN\s+(.+)$/.exec(line))) { actions.push({ type: 'plan', text: m[1] }); continue; }
    if ((m = /^STEP-DONE\s+(\d+)\s*$/.exec(line))) { actions.push({ type: 'stepdone', n: Number(m[1]) }); continue; }
    if ((m = /^DONE\b\s*(.*)$/.exec(line))) { actions.push({ type: 'done', text: m[1] }); continue; }
    if ((m = /^STUCK\b\s*(.*)$/.exec(line))) { actions.push({ type: 'stuck', text: m[1] }); continue; }
  }
  return { actions, errors };
}

// ── actions executed by the host ────────────────────────────────────────
function doList(ctx, a) {
  const { rel } = a.dir === '.' ? { rel: '' } : confine(ctx.worktree, a.dir, ctx.secret);
  const r = git(ctx.worktree, ['ls-files', '--', rel || '.']);
  if (!r.ok) return 'LIST failed';
  const prefix = rel ? rel + '/' : '', seen = new Set();
  for (const f of r.out.split('\n').filter(Boolean)) { if (f.startsWith('"') || ctx.secret.some((re) => re.test(f))) continue; const rest = f.slice(prefix.length), head = rest.split('/')[0]; seen.add(rest.includes('/') ? head + '/' : head); }
  const list = [...seen].sort(); return 'LIST ' + (rel || '.') + ' (' + list.length + '):\n' + list.slice(0, LIMITS.listEntries).join('\n') + (list.length > LIMITS.listEntries ? '\n...[more]' : '');
}
function doRead(ctx, a) {
  const { rel, abs } = confine(ctx.worktree, a.file, ctx.secret);
  let st; try { st = fs.statSync(abs); } catch { return 'READ ' + rel + ': no such file'; }
  if (!st.isFile()) return 'READ ' + rel + ': not a file (use LIST)';
  if (st.size > 400000) return 'READ ' + rel + ': file too large (' + st.size + ' bytes); GREP it and READ a line range';
  const buf = fs.readFileSync(abs); if (buf.includes(0)) return 'READ ' + rel + ': binary file';
  const all = buf.toString('utf8').replace(/\r\n/g, '\n').split('\n'), from = Math.max(1, a.from || 1), to = Math.min(all.length, a.to || all.length);
  let out = '', n = from;
  for (; n <= to; n++) { const l = String(n).padStart(4) + ' ' + all[n - 1] + '\n'; if (out.length + l.length > LIMITS.readChars) break; out += l; }
  return 'READ ' + rel + ' lines ' + from + '-' + (n - 1) + ' of ' + all.length + (n <= to ? ' (cut at ' + LIMITS.readChars + ' characters; ask for the next range)' : '') + ':\n' + out;
}
function doGrep(ctx, a) {
  if (!a.text || a.text.length < 2 || a.text.length > 120) return 'GREP: the text must be 2 to 120 characters';
  const { rel } = a.dir === '.' ? { rel: '' } : confine(ctx.worktree, a.dir, ctx.secret);
  const r = git(ctx.worktree, ['grep', '-n', '-I', '-F', '--max-count=3', '-e', a.text, '--', rel || '.']);
  // A path git had to quote (tab, newline, control character) cannot be checked reliably: its lines are dropped.
  const hits = r.out.split('\n').filter(Boolean).filter((l) => !l.startsWith('"') && !ctx.secret.some((re) => re.test(l.split(':')[0])));
  return 'GREP "' + a.text + '": ' + hits.length + ' hit(s)\n' + hits.slice(0, LIMITS.grepHits).map((l) => clip(l, 200)).join('\n');
}
// Exact unique match first. Two narrow fallbacks, each still requiring ONE unique match:
// (1) the READ line numbers were copied into SEARCH (and REPLACE); (2) only trailing spaces differ.
const LINE_NO = /^\s*\d+ /;
// A "SEARCH not found" with nothing else makes a small model repeat itself (seen 2026-11-23: 13 failed EDITs of code it
// had never read, lines 275-300 of a 429-line file, 27 turns, nothing changed). Tell it WHERE the code really is and show it.
function whereHint(text, search, full = true) {
  const tl = text.split('\n');
  const show = (at) => {
    if (!full) return ' (READ the file around line ' + (at + 1) + ' to see the real text; the lines were already shown once in this answer)';
    const from = Math.max(0, at - 2), to = Math.min(tl.length, from + 16);
    // Each line is cut (a minified line must not fill the observation) and the whole block stays small.
    return clip(tl.slice(from, to).map((l, i) => String(from + i + 1).padStart(4) + ' ' + clip(l, 160)).join('\n'), 1800);
  };
  for (const w of search.split('\n').map((l) => l.trim()).filter((l) => l.length >= 8)) {
    const at = tl.findIndex((l) => l.trim() === w);
    if (at >= 0) return ' Your SEARCH is close to line ' + (at + 1) + ' (the line "' + clip(w, 70) + '" is there).' + (full ? ' The real text around it (copy SEARCH from here, never from memory; line numbers are NOT part of the code):\n' : '') + show(at);
  }
  for (const w of (search.match(/[A-Za-z_][A-Za-z0-9_]{5,}/g) || []).sort((x, y) => y.length - x.length)) {
    const at = tl.findIndex((l) => l.includes(w));
    if (at >= 0) return ' The name "' + clip(w, 60) + '" first appears at line ' + (at + 1) + '.' + (full ? ' The real text around it (copy SEARCH from here, never from memory; line numbers are NOT part of the code):\n' : '') + show(at);
  }
  return ' Nothing from your SEARCH text appears in this file: you are guessing code you have not READ, or this is the wrong file. Use GREP <word> to find where the code is, then READ that line range.';
}
function locateSearch(text, search, replace, opts) {
  const exact = text.split(search).length - 1;
  if (exact === 1) return { next: text.replace(search, () => replace), replace };
  if (exact > 1) return { err: 'the SEARCH text occurs ' + exact + ' times; add surrounding lines so that it is unique.' };
  const sl = search.split('\n'), nonEmpty = sl.filter((l) => l.trim());
  if (nonEmpty.length && nonEmpty.every((l) => LINE_NO.test(l))) {
    const strip = (l) => l.replace(LINE_NO, '');
    const s2 = sl.map(strip).join('\n'), rl = replace.split('\n'), r2 = rl.filter((l) => l.trim()).every((l) => LINE_NO.test(l)) ? rl.map(strip).join('\n') : replace;
    const c = text.split(s2).length - 1;
    if (c === 1) return { next: text.replace(s2, () => r2), replace: r2, note: 'the READ line numbers you copied into SEARCH were removed; never copy them' };
    if (c > 1) return { err: 'the SEARCH text occurs ' + c + ' times; add surrounding lines so that it is unique.' };
  }
  const tl = text.split('\n'), want = sl.map((l) => l.replace(/\s+$/, ''));
  while (want.length && !want[want.length - 1]) want.pop();
  const hits = [];
  if (want.length) for (let i = 0; i + want.length <= tl.length; i++) { let ok = true; for (let k = 0; k < want.length; k++) if (tl[i + k].replace(/\s+$/, '') !== want[k]) { ok = false; break; } if (ok) hits.push(i); }
  if (hits.length === 1) {
    const i = hits[0], out = [...tl.slice(0, i), ...replace.split('\n'), ...tl.slice(i + want.length)];
    return { next: out.join('\n'), replace, note: 'matched ignoring trailing spaces' };
  }
  if (hits.length > 1) return { err: 'the SEARCH text occurs ' + hits.length + ' times; add surrounding lines so that it is unique.' };
  return { err: 'the SEARCH text was not found. Copy it exactly from READ output (without the line numbers), whitespace included.' + whereHint(text, search, !opts || opts.fullHint !== false) };
}
// A failed check names a file and a line; a small model then re-READS the top of the file instead (seen 2026-11-23: the type error was
// at line 291, the model read lines 1-140 again and again). Show the real lines around the reported line, for readable files only.
// The observations of one turn are cut to the prompt budget WITHOUT losing the parts the model must see: a RUN result, a format error,
// a refusal. The long ones (READ output, hints) share what is left.
function fitObs(obs, max) {
  const all = obs.join('\n\n'); if (all.length <= max) return all;
  const prio = (o) => /^(RUN |FORMAT ERROR|REFUSED|YOUR ANSWER|DONE refused|STUCK refused)/.test(o);
  let hi = obs.filter(prio); const lo = obs.filter((o) => !prio(o));
  let seenFmt = 0; // many malformed blocks say the same thing: keep the first two (by position, duplicates included)
  hi = hi.filter((o) => !/^FORMAT ERROR/.test(o) || ++seenFmt <= 2);
  const hiText = hi.map((o) => midClip(o, 2800)).join('\n\n');
  const per = Math.floor(Math.max(300, max - hiText.length - 2) / Math.max(1, lo.length));
  const loText = lo.map((o) => clip(o, per)).join('\n\n');
  const out = (loText ? loText + '\n\n' : '') + hiText;
  return out.length > max ? tailClip(out, max) : out;
}
function errorContext(ctx, tail) {
  const seen = new Set(), out = [], hide = ctx.lastRedact || ((x) => x);
  const re = /([A-Za-z0-9_@.\/\\-]+\.(?:tsx?|jsx?|mjs|cjs))[(:](\d+)(?:[,:]\d+)?\)?/g;
  for (const m of String(tail || '').matchAll(re)) {
    if (out.length >= 2) break;
    const rel = m[1].replace(/\\/g, '/').replace(/^\.\//, ''), line = Number(m[2]), key = rel + ':' + line;
    if (seen.has(key) || /(^|\/)node_modules\//.test(rel)) continue; seen.add(key);
    let abs; try { abs = confine(ctx.worktree, rel, ctx.secret).abs; } catch { continue; }
    let lines; try { if (fs.statSync(abs).size > 400000) continue; lines = fs.readFileSync(abs, 'utf8').replace(/\r\n/g, '\n').split('\n'); } catch { continue; }
    if (!(line >= 1 && line <= lines.length)) continue;
    const from = Math.max(0, line - 6), to = Math.min(lines.length, line + 5);
    out.push(rel + ' around line ' + line + ':\n' + lines.slice(from, to).map((l, i) => String(from + i + 1).padStart(4) + (from + i + 1 === line ? '>' : ' ') + ' ' + clip(hide(l), 160)).join('\n')); // masked BEFORE the cut: a value cut in two would no longer be recognised
  }
  return out.length ? '\nWHERE THE CHECK FAILED (the real lines, > marks the reported line; line numbers are not part of the code):\n' + hide(clip(out.join('\n'), 1800)) : '';
}
// Right after a write: calls to a name that exists nowhere else in the repository are most likely invented. Never blocks the edit.
function inventedNames(ctx, a, located) {
  try {
    const items = symbols.unknownCalls(ctx.worktree, located.replace, a.search, ctx.secret);
    if (!items.length) return ''; // the common case costs one bounded search and NO secret scan
    const hide = ctx.maskNow(); // a fresh scan: before the first RUN no masker exists yet, and a secret may have been written since the last one
    return hide(symbols.unknownCallsNote(items, hide));
  } catch { return ''; } // no masker, no note
}

function doEdit(ctx, a) {
  confine(ctx.worktree, a.file, ctx.secret); // a file the model may not READ must not be answered with its content either (hints)
  const { rel, abs } = confine(ctx.worktree, a.file, ctx.prot, true);
  let st; try { st = fs.statSync(abs); } catch { return { err: 'EDIT ' + rel + ': no such file (use CREATE for a new file)' }; }
  if (!st.isFile() || st.size > LIMITS.editFileBytes) return { err: 'EDIT ' + rel + ': not an editable file' };
  const raw = fs.readFileSync(abs, 'utf8'); if (raw.includes('\0')) return { err: 'EDIT ' + rel + ': binary file' };
  const crlf = raw.includes('\r\n'), text = raw.replace(/\r\n/g, '\n');
  if (!a.search.trim()) return { err: 'EDIT ' + rel + ': the SEARCH text is empty' };
  const located = locateSearch(text, a.search, a.replace, { fullHint: !ctx.hintShown });
  if (located.err && /SEARCH text was not found/.test(located.err)) ctx.hintShown = true; // later misses of this answer get the one-line pointer only
  if (located.err) return { err: 'EDIT ' + rel + ': ' + located.err };
  const next = located.next;
  if (next === text) return { err: 'EDIT ' + rel + ': the replacement is identical to the original' };
  fs.writeFileSync(abs, crlf ? next.replace(/\n/g, '\r\n') : next);
  return { ok: 'EDIT ' + rel + ': applied (' + a.search.split('\n').length + ' line(s) replaced by ' + located.replace.split('\n').length + ')' + (located.note ? ' - note: ' + located.note : '') + inventedNames(ctx, a, located), file: rel };
}
function doCreate(ctx, a, mine) {
  const { rel, abs } = confine(ctx.worktree, a.file, ctx.prot, true);
  const replacing = fs.existsSync(abs);
  if (replacing && !(mine || []).includes(rel)) return { err: 'CREATE ' + rel + ': the file exists (use EDIT)' };
  if (Buffer.byteLength(a.content) > LIMITS.newFileBytes) return { err: 'CREATE ' + rel + ': too large' };
  fs.mkdirSync(path.dirname(abs), { recursive: true }); fs.writeFileSync(abs, a.content.endsWith('\n') ? a.content : a.content + '\n');
  return { ok: 'CREATE ' + rel + (replacing ? ': rewritten (it is a file you created)' : ': created'), file: rel, created: true };
}

// ── state kept outside the model's context (survives restarts) ──────────
function loadSession(file) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } }
function saveSession(file, s) { if (!file) return; fs.mkdirSync(path.dirname(file), { recursive: true }); const tmp = file + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(s)); fs.renameSync(tmp, file); }
const freshSession = () => ({ v: 1, turns: 0, plan: [], notes: [], changed: [], runs: [], switches: 0, strategies: [], idleRuns: 0, formatErrors: 0, lastRunSig: null, sameSigStreak: 0, lastDiffHash: null, created: [], stuckRefusals: 0, reads: 0, recent: [], log: [], repeatStreak: 0, lastTurnSig: null, repeatDemands: 0, turnsSinceChange: 0, noChangeDemanded: false, usage: { input: 0, output: 0, calls: 0 }, observations: [], events: [] });

function diffHash(ctx) { const r = git(ctx.worktree, ['diff', '--no-color', ctx.base]); const u = git(ctx.worktree, ['ls-files', '--others', '--exclude-standard']); return sha(r.out + '\n' + u.out); }
function changedNow(ctx, skip) {
  const a = git(ctx.worktree, ['diff', '--name-only', ctx.base]).out.split('\n').filter(Boolean), b = git(ctx.worktree, ['ls-files', '--others', '--exclude-standard']).out.split('\n').filter(Boolean);
  return [...new Set([...a, ...b])].filter((f) => !(skip || []).some((d) => f === d || f.startsWith(d + '/')));
}
// How many problems the first failing check reports: a number that falls from one RUN to the next is measured progress, even when the normalised signature (digits replaced) looks the same.
const failureCount = (results) => { const bad = (results || []).find((r) => !r.ok); return bad ? (Number.isFinite(bad.errors) ? bad.errors : (String(bad.tail || '').match(/error TS\d+/g) || []).length) : 0; }; // compiler errors only: one per problem and stable. Test-runner output is too variable to count (a limit, kept on purpose)
function sawProgress(s, results) { const n = failureCount(results), better = s.lastFailCount != null && n < s.lastFailCount; s.lastFailCount = n; return better; }
const failureSig = (results) => { const bad = (results || []).find((r) => !r.ok); return bad ? bad.name + ':' + sha(String(bad.tail || '').replace(/\d+(\.\d+)?/g, '#').replace(/\s+/g, ' ').slice(-400)).slice(0, 12) : null; };

const PROTOCOL = [
  'You are a careful software developer working inside a git repository through a text protocol. You have NO shell and NO other tool: only the action lines below, one per line, at the start of a line. Everything else you write is ignored.',
  'LIST <dir>  |  READ <path> [from-to]  |  GREP <text> [IN <dir>]  |  RUN (the host runs the repository tests)',
  'PLAN <short step>  (up to 6, to split the work)  |  STEP-DONE <n>  |  NOTE <one fact worth remembering>  |  DONE <summary>  |  STUCK <reason>',
  'To change a file, EXACTLY this block (SEARCH must be copied verbatim from READ output without line numbers and must occur once):',
  'EDIT <path>\n<<<<<<< SEARCH\nold lines\n=======\nnew lines\n>>>>>>> REPLACE',
  'To add a file: CREATE <path>\n<<<<<<< CONTENT\nlines\n>>>>>>> END  (a file you created yourself can be rewritten with a new CREATE)',
  'Worked examples (unrelated to your task):\nCREATE lib/hello.test.js\n<<<<<<< CONTENT\nconst test = require("node:test");\nconst assert = require("node:assert/strict");\nconst { hello } = require("./hello");\ntest("hello greets", () => { assert.equal(hello("a"), "hi a"); });\n>>>>>>> END\n\nEDIT lib/hello.js\n<<<<<<< SEARCH\n  return "hi";\n=======\n  return "hi " + name;\n>>>>>>> REPLACE',
  'Read before you edit. Make small changes. Use RUN after each change. Say DONE only after RUN passed. If you are blocked, say STUCK and why: a stronger developer will take over. Paths are relative to the repository root. Secret files (.env, keys, credentials) are not available. Restricted files can be READ for context but never changed.',
].join('\n');

function realNames(ctx, tail) {
  try { return symbols.fromErrors(ctx.worktree, tail, ctx.secret, () => ctx.lastRedact || ctx.maskNow(), ctx.readLines); } catch { return ''; }
}

// What a senior developer needs to teach instead of redo: the failing check, what really exists in the repository, and the code as it is now.
// Built once, when Qwen stops for lack of progress (not on every turn). Everything is masked, secret and protected paths are left out.
function teachEvidence(ctx, s) {
  try {
    const failing = s.runs.filter((r) => !r.ok), last = failing.at(-1);
    const tail = last ? last.results.filter((x) => !x.ok).map((x) => x.name + ':\n' + String(x.tail || '')).join('\n') : '';
    const hide = ctx.lastRedact || ctx.maskNow();
    const files = s.changed.filter((f) => !ctx.secret.some((re) => re.test(f)) && !ctx.prot.some((re) => re.test(f))).slice(0, 4); // a protected file cannot be changed by Qwen: it is never part of Qwen's diff
    const tracked = files.filter((f) => !(s.created || []).includes(f));
    const diff = tracked.length ? git(ctx.worktree, ['diff', '--no-color', '-U2', ctx.base, '--', ...tracked]).out : '';
    const fresh = (s.created || []).filter((f) => !ctx.secret.some((re) => re.test(f)) && !ctx.prot.some((re) => re.test(f))).slice(0, 2)
      .map((f) => { let body = null; try { body = ctx.readLines(f, 1, 40); } catch { body = null; } return body ? '+++ NEW FILE ' + f + '\n' + body.map((l) => '+' + l).join('\n') : ''; }).filter(Boolean).join('\n');
    return [
      'FAILING CHECK (' + failing.length + ' failing run(s); last signature repeated ' + (s.sameSigStreak || 0) + ' time(s) since the last change of strategy):',
      clip(hide(tail), 1100) + realNames(ctx, tail),
      'QWEN CODE AS IT IS NOW (' + (files.join(', ') || 'no file') + ', diff against the start of the task):',
      clip(hide([diff, fresh].filter(Boolean).join('\n')), 1700) || '(no change)',
    ].join('\n');
  } catch { return ''; }
}

function buildPrompt(s, task, memoryText, lastObs, demand) {
  const runNudge = s.needsRun ? 'NEXT STEP: you changed files and have not run the checks since. Use RUN now (the host runs the repository checks). Do NOT READ the file again. If RUN fails, fix what it reports and RUN again; say DONE only after RUN passed.' : '';
  const nudge = runNudge || (s.reads > 0 && !s.changed.length ? 'NEXT STEP: you have read what you need. Do NOT read again and do NOT say DONE yet: write the change now with an EDIT or CREATE block exactly like the worked examples, then use RUN. Use ONLY function, type and property names you saw in text you READ; if you need another one, GREP for it first (the host warns you when a name exists nowhere in the repository).' : '');
  const parts = [PROTOCOL,
    'TASK: ' + task.title + '\n' + clip(task.objective, 1800) + (task.files && task.files.length ? '\nFiles the plan mentions: ' + task.files.slice(0, 8).join(', ') : ''),
    memoryText ? clip(memoryText, 1800) : '', // the caller supplies the heading: verified methods and unverified observations are labelled differently
    s.plan.length ? 'PLAN:\n' + s.plan.map((p, i) => (i + 1) + '. [' + (p.done ? 'x' : ' ') + '] ' + p.text).join('\n') : 'No plan yet: start with PLAN lines.',
    s.notes.length ? 'YOUR NOTES:\n' + s.notes.slice(-8).map((n) => '- ' + n).join('\n') : '',
    s.strategies.length ? 'APPROACHES ALREADY TRIED THAT FAILED:\n' + s.strategies.slice(-4).map((x, i) => (i + 1) + '. ' + x).join('\n') : '',
    s.changed.length ? 'FILES YOU CHANGED: ' + s.changed.slice(0, 10).join(', ') : '',
    demand || '', nudge,
    'LAST RESULTS:\n' + (lastObs || '(none yet)')];
  let p = parts.filter(Boolean).join('\n\n');
  if (p.length > LIMITS.promptChars) { const head = p.slice(0, p.indexOf('LAST RESULTS:')); p = clip(head, LIMITS.promptChars - 3500) + '\n\nLAST RESULTS:\n' + tailClip(lastObs, 3300); }
  return p;
}

// opts: { worktree, base, task:{title, objective, files}, verify:[commands], protectedPatterns:[], skipDirs:[], model, profile, signal, deadlineAt,
//         sessionFile, memoryText, onEvent, dependencies:{fetch, freemem, runVerify, now} }
async function runRepoWorker(opts) {
  const dep = opts.dependencies || {}, fetchLocal = dep.fetch || fetch, freemem = dep.freemem || os.freemem, now = dep.now || Date.now;
  const runVerifyRaw = dep.runVerify || require('../mind/autopilot-verify').runVerify;
  // prot: never written (pilot list + secrets). secret: never read either (secrets + optional extra list).
  const ctx = { worktree: path.resolve(opts.worktree), base: opts.base, prot: compile([...(opts.protectedPatterns || []), ...SECRET_PATTERNS]), secret: compile([...SECRET_PATTERNS, ...(opts.readProtectedPatterns || [])]) };
  ctx.maskNow = () => secretMask(ctx.worktree, opts.readProtectedPatterns || [])();
  // The only file read the symbol lookup does: same confinement as READ (protected paths, symbolic links), regular file, size-limited.
  ctx.readLines = (rel, from, count) => {
    const { abs } = confine(ctx.worktree, rel, ctx.secret);
    const st = fs.lstatSync(abs); if (!st.isFile() || st.isSymbolicLink() || st.size > 400000) return null;
    return fs.readFileSync(abs, 'utf8').replace(/\r\n/g, '\n').split('\n').slice(from - 1, from - 1 + count);
  };
  if (!opts.profile || opts.profile.mode !== 'text') throw new Error('Not a text-only developer profile');
  // Check output reaches the prompt: secret values are masked first (they are re-read at every RUN, a test may create one).
  const runVerify = async (cwd, cmds) => {
    // Scanned before EVERY check and after the last: a check may create a secret that a later one prints then deletes.
    const mask = secretMask(ctx.worktree, opts.readProtectedPatterns || []);
    const v = await runVerifyRaw(cwd, cmds, { beforeEach: () => mask.observe() });
    const redact = mask(); ctx.lastRedact = redact;
    return { ...v, results: (v.results || []).map((x) => ({ ...x, tail: redact(x.tail) })) };
  };
  const s = (opts.sessionFile && loadSession(opts.sessionFile)) || freshSession();
  // Fields added after the first sessions were saved: a resumed old session gets them empty.
  if (!s.protectedAsks || typeof s.protectedAsks !== 'object') s.protectedAsks = {};
  if (!Array.isArray(s.emptyRecent)) s.emptyRecent = [];
  const ev = (kind, msg) => { s.events.push({ at: now(), kind, msg: clip(msg, 300) }); s.events = s.events.slice(-60); if (opts.onEvent) { try { opts.onEvent(kind, msg); } catch (_) {} } };
  const finish = (state, summary, extra = {}) => { ev(state, summary); saveSession(opts.sessionFile, s); return { state, summary, turns: s.turns, switches: s.switches, changed: changedNow(ctx, opts.skipDirs), notes: s.notes, plan: s.plan, log: s.log, usage: s.usage, strategies: s.strategies, lastRun: s.runs.at(-1) || null, events: s.events, ...extra }; };

  let lastObs = s.observations.slice(-2).join('\n---\n'), demand = '';
  for (;;) {
    if (opts.signal && opts.signal.aborted) return finish('interrupted', 'Cancelled; progress saved');
    if (opts.deadlineAt && now() > opts.deadlineAt) return finish('interrupted', 'Work slot ended; progress saved, the task resumes in the next slot');
    if (s.turns >= LIMITS.maxTurns) return finish('blocked', 'Turn limit reached (' + LIMITS.maxTurns + ') without a passing verification');
    if (freemem() < LIMITS.minFreeRamBytes) {
      const sleep = dep.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
      for (let waited = 0; freemem() < LIMITS.minFreeRamBytes && waited < LIMITS.ramWaitMs; waited += LIMITS.ramPollMs) { if (opts.signal && opts.signal.aborted) break; await sleep(LIMITS.ramPollMs); }
      if (freemem() < LIMITS.minFreeRamBytes) return finish('interrupted', 'Free RAM below ' + Math.round(LIMITS.minFreeRamBytes / 1048576) + ' MB for ' + Math.round(LIMITS.ramWaitMs / 1000) + ' s; paused, progress saved');
    }
    let status; try { status = await fetchLocal(BASE_URL + '/api/v0/models', { signal: AbortSignal.timeout(5000) }); } catch { return finish('interrupted', 'LM Studio unreachable; progress saved'); }
    if (!status.ok) return finish('interrupted', 'LM Studio unavailable (HTTP ' + status.status + ')');
    let models; try { models = await status.json(); } catch { return finish('interrupted', 'LM Studio unreachable (status reply cut); progress saved'); } // still an outage, not a Qwen failure
    if (!models.data?.some((m) => m.id === opts.model && m.state === 'loaded' && m.loaded_context_length >= opts.profile.minContext)) return finish('interrupted', opts.model + ' with ' + opts.profile.minContext + ' context is not loaded');

    const prompt = buildPrompt(s, opts.task, opts.memoryText, lastObs, demand); demand = '';
    s.turns++;
    let json;
    try {
      const r = await fetchLocal(BASE_URL + '/v1/chat/completions', { method: 'POST', headers: { 'content-type': 'application/json' },
        signal: AbortSignal.any([...(opts.signal ? [opts.signal] : []), AbortSignal.timeout(opts.profile.wallSeconds * 1000)]),
        body: JSON.stringify({ model: opts.model, messages: [{ role: 'user', content: prompt }], temperature: s.formatErrors > 2 || s.emptyRecent.slice(-2).includes(true) ? 0.5 : 0.2, max_tokens: LIMITS.maxTokens, stream: false, ...(opts.profile.reasoningEffort ? { reasoning_effort: opts.profile.reasoningEffort } : {}) }) });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      json = await r.json();
    } catch (e) { s.turns--; return finish('interrupted', 'Model call failed (' + String(e.message || e).slice(0, 80) + '); progress saved'); }
    const u = json.usage || {}; s.usage.input += u.prompt_tokens || 0; s.usage.output += u.completion_tokens || 0; s.usage.calls++;
    const { actions, errors } = parseActions(json.choices?.[0]?.message?.content);
    const obs = []; ctx.hintShown = false;
    // The model server says when an answer hit the token limit. A block that is cut is not closed, so it was ignored: say
    // so plainly (seen 2026-11-23: a whole new test file written as ONE block, cut 7 times in a row, task lost).
    if (json.choices?.[0]?.finish_reason === 'length') obs.push('YOUR ANSWER WAS CUT OFF at the length limit (' + LIMITS.maxTokens + ' tokens): what came after the cut was lost and a block that was not closed was ignored (see the results below for what was applied). Write a SMALLER step: to add a new file, CREATE it with a first small version (a few short tests), RUN, then add more with a short EDIT. Never write the whole file in one answer.');
    for (const e of errors) obs.push('FORMAT ERROR: ' + e);
    const rawAnswer = String(json.choices?.[0]?.message?.content || '').trim();
    if (!actions.length && !errors.length) obs.push('FORMAT ERROR: no action found' + (rawAnswer ? ' in what you wrote ("' + clip(rawAnswer.replace(/\s+/g, ' '), 90) + '")' : ': your answer was empty') + '. Write one action per line, starting the line with the keyword, for example: READ src/file.js 260-350  |  GREP flushEvents  |  RUN');
    if (errors.length || !actions.length) s.formatErrors++; else s.formatErrors = 0;
    if (s.formatErrors >= LIMITS.formatErrorsBeforeStuck) return finish('blocked', 'The model keeps answering outside the protocol (' + s.formatErrors + ' turns in a row)');
    // Empty answers alternating with valid turns never reach the in-a-row limit above: count them over a window.
    s.emptyRecent = [...s.emptyRecent, !actions.length && !errors.length && !rawAnswer].slice(-LIMITS.emptyTurnsWindow); // truly empty only: text without an action is a format error, counted by formatErrors
    const empties = s.emptyRecent.filter(Boolean).length;
    if (empties >= LIMITS.emptyTurnsBeforeStuck) return finish('blocked', 'The model returned ' + empties + ' empty answers in its last ' + s.emptyRecent.length + ' turns');
    if (!actions.length && !errors.length && !rawAnswer) obs.push('Your last answer was EMPTY (' + empties + '/' + LIMITS.emptyTurnsBeforeStuck + ' before hand-over). Answer with action lines only: EDIT/CREATE to change code, RUN to test, or STUCK <reason>.');

    let ran = false, ranResult = null, claimedDone = null, claimedStuck = null, executed = 0, protectedStuck = null, overLimit = false; const closers = new Set();
    for (const a of actions) {
      // RUN, DONE and STUCK close a turn: they are never dropped by the per-turn limit, or the model edits without ever seeing the checks.
      // Only ONE closing action of each kind per turn: several RUN lines would run the whole suite again and again.
      if (['run', 'done', 'stuck'].includes(a.type)) { if (closers.has(a.type)) continue; closers.add(a.type); }
      else if (executed >= LIMITS.actionsPerTurn) { if (!overLimit) obs.push('(more than ' + LIMITS.actionsPerTurn + ' actions: the extra ' + a.type.toUpperCase() + ' and later actions other than RUN/DONE/STUCK were ignored)'); overLimit = true; continue; }
      executed++;
      try {
        if (a.type === 'list') obs.push(doList(ctx, a));
        else if (a.type === 'read') { const r = doRead(ctx, a); obs.push(r); if (!/: (no such file|not a file|file too large|binary)/.test(r)) s.reads++; }
        else if (a.type === 'grep') obs.push(doGrep(ctx, a));
        else if (a.type === 'edit' || a.type === 'create') { const r = a.type === 'edit' ? doEdit(ctx, a) : doCreate(ctx, a, s.created); obs.push(r.err || r.ok); if (r.ok) s.needsRun = true; if (r.file && !s.changed.includes(r.file)) s.changed.push(r.file); if (r.created && !s.created.includes(r.file)) s.created.push(r.file); }
        else if (a.type === 'note') { s.notes.push(clip(a.text, LIMITS.noteChars)); s.notes = s.notes.slice(-12); obs.push('NOTE saved'); }
        else if (a.type === 'plan') { if (s.plan.length < LIMITS.planSteps) s.plan.push({ text: clip(a.text, 160), done: false }); obs.push('PLAN step ' + s.plan.length + ' recorded'); }
        else if (a.type === 'stepdone') { if (s.plan[a.n - 1]) s.plan[a.n - 1].done = true; obs.push('Step ' + a.n + ' marked done'); }
        else if (a.type === 'run') {
          ran = true; s.needsRun = false;
          const h = diffHash(ctx);
          if (s.lastDiffHash === h && s.runs.length) { s.idleRuns++; obs.push('RUN skipped: nothing changed since the last RUN (' + s.idleRuns + '/' + LIMITS.idleRunsBeforeStuck + '). Change the code first.'); ranResult = s.runs.at(-1); }
          else {
            s.idleRuns = 0; s.lastDiffHash = h;
            const v = await runVerify(ctx.worktree, opts.verify || []);
            ranResult = { ok: v.ok, results: v.results.map((x) => ({ name: x.name, ok: x.ok, ms: x.ms, timedOut: x.timedOut, errors: x.errors, tail: x.ok ? '' : clip(String(x.tail || '').slice(-1800), 1800) })), at: now() };
            s.runs.push(ranResult); s.runs = s.runs.slice(-6);
            obs.push('RUN ' + (v.ok ? 'PASSED: ' + v.results.map((x) => x.name).join(', ') : 'FAILED at ' + (v.results.find((x) => !x.ok) || {}).name + ':\n' + ((v.results.find((x) => !x.ok) || {}).tail || '').slice(-1800)) + (v.ok ? '' : errorContext(ctx, (v.results.find((x) => !x.ok) || {}).tail) + realNames(ctx, (v.results.find((x) => !x.ok) || {}).tail)) + '\n[RUN RESULT: ' + (v.ok ? 'PASSED' : 'FAILED at ' + (v.results.find((x) => !x.ok) || {}).name) + ']');
            const sig = failureSig(ranResult.results);
            const progressed = v.ok ? false : sawProgress(s, v.results); if (v.ok) { s.sameSigStreak = 0; s.lastFailCount = null; } else if (sig === s.lastRunSig && !progressed) s.sameSigStreak++; else s.sameSigStreak = 1;
            s.lastRunSig = v.ok ? null : sig;
          }
        } else if (a.type === 'done') claimedDone = a.text || 'done';
        else if (a.type === 'stuck') claimedStuck = a.text || 'no reason given';
      } catch (e) {
        const msg = String(e.message || e);
        if (/Path refused: protected/.test(msg) && a.file) {
          // A protected path never becomes readable: say so plainly and stop the task quickly if the model insists.
          const key = String(a.file).trim().replace(/\\/g, '/').replace(/^\.\//, '');
          const n = s.protectedAsks[key] = (s.protectedAsks[key] || 0) + 1;
          obs.push(/may READ it/.test(msg)
            ? 'REFUSED: ' + key + ' is PROTECTED: you may READ it, but it will NEVER be changed in this task (tried ' + n + '/' + LIMITS.protectedAsksBeforeStuck + '). Do not try to change it again. Solve the task in other files, or say STUCK and explain why ' + key + ' must change.'
            : 'REFUSED: ' + key + ' holds SECRETS and will NEVER be readable or editable in this task (asked ' + n + '/' + LIMITS.protectedAsksBeforeStuck + '). Do not ask for it again. Work from what you already have (RUN shows the failing checks), or say STUCK and name the file you need.');
          ev('refused', msg + ' (' + key + ', ' + n + ')');
          if (n >= LIMITS.protectedAsksBeforeStuck) { protectedStuck = key; break; }
        } else { obs.push('REFUSED: ' + msg.slice(0, 200)); ev('refused', msg); }
      }
    }
    // Anything protected that appeared in the worktree (even through the repository's own scripts) is reverted.
    const bad = changedNow(ctx, opts.skipDirs).filter((f) => ctx.prot.some((re) => re.test(f)));
    if (bad.length) { for (const f of bad) { git(ctx.worktree, ['checkout', '--', f]); try { if (!git(ctx.worktree, ['ls-files', '--error-unmatch', f]).ok) fs.rmSync(path.join(ctx.worktree, f), { force: true }); } catch (_) {} } obs.push('REFUSED: changes to protected path(s) were reverted: ' + bad.slice(0, 4).join(', ')); ev('protected', bad.join(', ')); }
    if (protectedStuck) { s.observations.push(clip(obs.join('\n\n'), 6500)); s.observations = s.observations.slice(-3); return finish('blocked', 'The model needs the protected file ' + protectedStuck + ', which it may not use that way (refused ' + s.protectedAsks[protectedStuck] + ' times)'); }

    lastObs = fitObs(obs, 6500); s.observations.push(lastObs); s.observations = s.observations.slice(-3);
    // Diagnostics that survive restarts: what each turn asked for and what came back.
    const turnSig = sha(actions.map((a) => a.type + ':' + (a.file || a.dir || a.text || a.n || '') + ':' + (a.search || '').length + ':' + (a.content || '').length).join('|') + '#' + lastObs.slice(0, 400));
    s.log.push({ turn: s.turns, acts: actions.map((a) => a.type + (a.file || a.dir ? ' ' + (a.file || a.dir) : '')).join('; ').slice(0, 160), errors: errors.length, obs: lastObs.replace(/\s+/g, ' ').slice(0, 140) }); s.log = s.log.slice(-60);
    s.recent = [...s.recent, turnSig].slice(-8); s.repeatStreak = s.recent.filter((x) => x === turnSig).length >= 3 ? LIMITS.repeatTurnsBeforeDemand : 1; s.lastTurnSig = turnSig;
    const dh = diffHash(ctx); if (s.changeHash === undefined) s.changeHash = dh; if (dh !== s.changeHash) { s.changeHash = dh; s.turnsSinceChange = 0; s.noChangeDemanded = false; } else s.turnsSinceChange++;
    if (s.repeatStreak >= LIMITS.repeatTurnsBeforeDemand) {
      s.repeatDemands++; s.repeatStreak = 0; s.recent = []; // a warning gives the model a fresh chance
      if (s.repeatDemands > LIMITS.maxRepeatDemands) return finish('blocked', 'The model repeats the same actions with the same results (' + s.repeatDemands + ' warnings ignored)');
      demand = 'YOU ARE REPEATING THE SAME ACTIONS and getting the same result (' + s.repeatDemands + '/' + LIMITS.maxRepeatDemands + '). Do something different now: use the information you already have to EDIT or CREATE a file, or say STUCK.';
      ev('repeat', 'identical turns, warning ' + s.repeatDemands);
    }
    if (!s.noChangeDemanded && s.turnsSinceChange >= LIMITS.noChangeDemandTurns && !s.changed.length) { s.noChangeDemanded = true; demand = (demand ? demand + '\n' : '') + 'AFTER ' + s.turnsSinceChange + ' TURNS YOU HAVE CHANGED NOTHING. Stop exploring: write the change now (EDIT or CREATE), or say STUCK with the reason.'; ev('no-change', s.turnsSinceChange + ' turns without a change'); }
    if (s.turnsSinceChange >= LIMITS.noChangeStuckTurns && !s.changed.length) return finish('blocked', 'No change to the repository after ' + s.turnsSinceChange + ' turns of exploration');
    if (claimedStuck) {
      const failing = s.runs.filter((r) => !r.ok).length;
      if (s.stuckRefusals < 2 && s.turns < 8 && failing < 3 && s.changed.length) { s.stuckRefusals++; lastObs = (lastObs ? lastObs + '\n\n' : '') + 'STUCK refused (' + s.stuckRefusals + '/2): you have tried only ' + failing + ' time(s) to make the checks pass. Read the failure above carefully, find what differs from what you expected, and fix it with EDIT or a new CREATE of your own file.'; s.observations.push(lastObs); s.observations = s.observations.slice(-3); saveSession(opts.sessionFile, s); continue; }
      return finish('blocked', 'The model declared itself stuck: ' + clip(claimedStuck, 400), { teach: teachEvidence(ctx, s) });
    }
    if (claimedDone !== null) {
      if (!s.changed.length && !changedNow(ctx, opts.skipDirs).length) { demand = 'DONE refused: you changed nothing. Make the change, or say STUCK.'; lastObs = (lastObs ? lastObs + '\n\n' : '') + 'DONE refused: nothing was changed yet. Write the change with an EDIT or CREATE block (see the worked examples).'; saveSession(opts.sessionFile, s); continue; }
      const v = ran && ranResult && s.lastDiffHash === diffHash(ctx) ? ranResult : null;
      let check = v;
      if (!check) { const r = await runVerify(ctx.worktree, opts.verify || []); check = { ok: r.ok, results: r.results.map((x) => ({ name: x.name, ok: x.ok, ms: x.ms, errors: x.errors, tail: x.ok ? '' : clip(String(x.tail || '').slice(-1800), 1800) })), at: now() }; s.runs.push(check); s.lastDiffHash = diffHash(ctx); }
      // The checks are green. Without a test that reproduces the problem the task is not finished (replay 9: tsc green, behaviour wrong).
      const bf = check.ok && opts.behavior && opts.behavior.required ? await behaviorLint(ctx.worktree, ctx.base, opts.behavior) : [];
      if (check.ok && !bf.length) return finish('completed', clip(claimedDone, 500), { verified: check });
      if (check.ok) { lastObs = 'DONE refused: ' + bf[0]; s.observations.push(lastObs); saveSession(opts.sessionFile, s); continue; }
      lastObs = 'DONE refused: the host verification FAILED at ' + (check.results.find((x) => !x.ok) || {}).name + ':\n' + ((check.results.find((x) => !x.ok) || {}).tail || '').slice(-1800);
      s.observations.push(lastObs); const sig = failureSig(check.results); s.sameSigStreak = sig === s.lastRunSig && !sawProgress(s, check.results) ? s.sameSigStreak + 1 : 1; s.lastRunSig = sig;
    }
    // No progress: the same verification failure again and again, or RUN without changes.
    if (s.idleRuns >= LIMITS.idleRunsBeforeStuck) return finish('blocked', 'No progress: RUN repeated ' + s.idleRuns + ' times with no change to the code', { teach: teachEvidence(ctx, s) });
    if (s.sameSigStreak >= LIMITS.sameFailureBeforeSwitch) {
      s.strategies.push(clip(s.notes.at(-1) || ('the approach on ' + (s.changed.slice(-2).join(', ') || 'the code') + ' (same failure ' + s.sameSigStreak + ' times)'), 200));
      s.switches++; s.sameSigStreak = 0;
      if (s.switches > LIMITS.maxSwitches) return finish('blocked', 'The same failure persists after ' + LIMITS.maxSwitches + ' change of strategy', { teach: teachEvidence(ctx, s) });
      demand = 'STRATEGY SWITCH REQUIRED (' + s.switches + '/' + LIMITS.maxSwitches + '): the same failure repeated ' + LIMITS.sameFailureBeforeSwitch + ' times. Do NOT repeat your approach. First write a NOTE saying what you will do differently (another function, another cause, or undo your last edit by editing it back), then act.';
      ev('switch', 'strategy switch ' + s.switches);
    }
    saveSession(opts.sessionFile, s);
  }
}

// For the autopilot's own verification gate: the same masking, computed from the secret files seen before and after.
// Each observe() is a scan; call it before every check so a secret created by one check and printed then deleted
// by a later one is still known. mask() scans a last time and returns the redactor over everything seen.
function secretMask(worktree, extraPatterns = []) {
  const re = compile([...SECRET_PATTERNS, ...extraPatterns]), root = path.resolve(worktree);
  const seen = new Set(); let incomplete = false;
  const observe = () => { const v = secretValues(root, re); for (const x of v) seen.add(x); if (v.incomplete) incomplete = true; };
  observe();
  const mask = () => { observe(); const values = [...seen].sort((x, y) => y.length - x.length); values.incomplete = incomplete; return redactWith(values); };
  mask.observe = observe;
  return mask;
}
module.exports = { fitObs, secretMask, runRepoWorker, parseActions, locateSearch, confine, LIMITS, PROTOCOL, failureSig, secretValues, SECRET_PATTERNS };
