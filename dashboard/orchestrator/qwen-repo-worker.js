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

const BASE_URL = 'http://127.0.0.1:1234';
const LIMITS = Object.freeze({
  actionsPerTurn: 4, readChars: 5000, grepHits: 20, listEntries: 60, editFileBytes: 120000, newFileBytes: 60000, noteChars: 300, planSteps: 6,
  maxTurns: 80, maxSwitches: 3, repeatTurnsBeforeDemand: 3, maxRepeatDemands: 2, noChangeDemandTurns: 12, noChangeStuckTurns: 26, ramWaitMs: 180000, ramPollMs: 10000, sameFailureBeforeSwitch: 3, idleRunsBeforeStuck: 3, formatErrorsBeforeStuck: 6, protectedAsksBeforeStuck: 3, emptyTurnsWindow: 8, emptyTurnsBeforeStuck: 4, promptChars: 11000, maxTokens: 1600, minFreeRamBytes: 1.5 * 1024 * 1024 * 1024,
});
const sha = (x) => crypto.createHash('sha256').update(String(x), 'utf8').digest('hex');
const clip = (s, n) => (String(s).length > n ? String(s).slice(0, n) + '\n...[cut]' : String(s));

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
    // Assigned values down to 6 characters (a short password); below that a value is too common to mask safely
    // ("true", "3000", "dev") and would blank out ordinary test output.
    for (const m of text.matchAll(/^\s*(?:export\s+)?[A-Za-z_][\w.-]*\s*[=:]\s*["']?([^"'\r\n#]+?)["']?\s*,?\s*$/gm)) { const v = m[1].trim(); if (v.length >= 6 && !COMMON_VALUE.test(v)) out.add(v); }
    // JSON values in both their written form and their decoded form ("abc#def" is printed as abc#def).
    for (const m of text.matchAll(/"(?:[^"\\]|\\.)+"\s*:\s*"((?:[^"\\]|\\.){6,})"/g)) { out.add(m[1]); try { const d = JSON.parse('"' + m[1] + '"'); if (d.length >= 6) out.add(d); } catch (_) {} }
    // Unquoted values after ":" or "=" (a JSON number {"pin": 123456}, a YAML scalar), from 6 characters.
    for (const m of text.matchAll(/[=:]\s*([^\s,"'{}\[\]]{6,})/g)) if (!COMMON_VALUE.test(m[1])) out.add(m[1]);
    // A quoted value keeps everything between its quotes, # included (TOKEN="abc#def").
    for (const m of text.matchAll(/[=:]\s*(["'])((?:(?!\1).){6,})\1/g)) out.add(m[2]);
    // Whatever the format (a bare token, a PEM body, a YAML value): every whole line and every long word of a secret file.
    for (const line of text.split(/\r?\n/)) {
      const t = line.trim(); if (t.length >= 6 && !/^-----(BEGIN|END) /.test(t) && !/^#/.test(t)) out.add(t); // same 6-char floor as assigned values
      // Every quoted string and every word of 6+ characters, whatever the structure (arrays, lists, nested objects).
      // Double-quoted strings honour backslash escapes (an escaped \" does not end them) and are added decoded too.
      for (const q of t.matchAll(/"((?:[^"\\]|\\.){6,})"/g)) { out.add(q[1]); try { const d = JSON.parse('"' + q[1] + '"'); if (d.length >= 6) out.add(d); } catch (_) {} }
      for (const q of t.matchAll(/(['`])((?:(?!\1).){6,})\1/g)) out.add(q[2]);
      // The value part of a line, whatever precedes it: "- abc def" (YAML list), "key: abc def", "key = abc def".
      const val = t.replace(/^-\s+/, '').replace(/^[\w.-]+\s*[:=]\s*/, '').replace(/^["']|["'],?$/g, '').trim();
      if (val.length >= 6) out.add(val);
      const bare = val.replace(/\s+#.*$/, '').replace(/^["']|["']$/g, '').trim(); // without an inline "# comment"
      if (bare.length >= 6) out.add(bare);
      for (const w of t.split(/[\s=:,;"'`\[\]{}()]+/)) if (w.length >= 6) out.add(w);
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
    if ((m = /^READ\s+(\S+)(?:\s+(\d+)-(\d+))?\s*$/.exec(line))) { actions.push({ type: 'read', file: m[1], from: m[2] ? Number(m[2]) : 1, to: m[3] ? Number(m[3]) : null }); continue; }
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
function locateSearch(text, search, replace) {
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
  return { err: 'the SEARCH text was not found. Copy it exactly from READ output (without the line numbers), whitespace included.' };
}
function doEdit(ctx, a) {
  const { rel, abs } = confine(ctx.worktree, a.file, ctx.prot, true);
  let st; try { st = fs.statSync(abs); } catch { return { err: 'EDIT ' + rel + ': no such file (use CREATE for a new file)' }; }
  if (!st.isFile() || st.size > LIMITS.editFileBytes) return { err: 'EDIT ' + rel + ': not an editable file' };
  const raw = fs.readFileSync(abs, 'utf8'); if (raw.includes('\0')) return { err: 'EDIT ' + rel + ': binary file' };
  const crlf = raw.includes('\r\n'), text = raw.replace(/\r\n/g, '\n');
  if (!a.search.trim()) return { err: 'EDIT ' + rel + ': the SEARCH text is empty' };
  const located = locateSearch(text, a.search, a.replace);
  if (located.err) return { err: 'EDIT ' + rel + ': ' + located.err };
  const next = located.next;
  if (next === text) return { err: 'EDIT ' + rel + ': the replacement is identical to the original' };
  fs.writeFileSync(abs, crlf ? next.replace(/\n/g, '\r\n') : next);
  return { ok: 'EDIT ' + rel + ': applied (' + a.search.split('\n').length + ' line(s) replaced by ' + located.replace.split('\n').length + ')' + (located.note ? ' - note: ' + located.note : ''), file: rel };
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

function buildPrompt(s, task, memoryText, lastObs, demand) {
  const nudge = s.reads > 0 && !s.changed.length ? 'NEXT STEP: you have read what you need. Do NOT read again and do NOT say DONE yet: write the change now with an EDIT or CREATE block exactly like the worked examples, then use RUN.' : '';
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
  if (p.length > LIMITS.promptChars) { const head = p.slice(0, p.indexOf('LAST RESULTS:')); p = clip(head, LIMITS.promptChars - 3500) + '\n\nLAST RESULTS:\n' + clip(lastObs, 3300); }
  return p;
}

// opts: { worktree, base, task:{title, objective, files}, verify:[commands], protectedPatterns:[], skipDirs:[], model, profile, signal, deadlineAt,
//         sessionFile, memoryText, onEvent, dependencies:{fetch, freemem, runVerify, now} }
async function runRepoWorker(opts) {
  const dep = opts.dependencies || {}, fetchLocal = dep.fetch || fetch, freemem = dep.freemem || os.freemem, now = dep.now || Date.now;
  const runVerifyRaw = dep.runVerify || require('../mind/autopilot-verify').runVerify;
  // prot: never written (pilot list + secrets). secret: never read either (secrets + optional extra list).
  const ctx = { worktree: path.resolve(opts.worktree), base: opts.base, prot: compile([...(opts.protectedPatterns || []), ...SECRET_PATTERNS]), secret: compile([...SECRET_PATTERNS, ...(opts.readProtectedPatterns || [])]) };
  if (!opts.profile || opts.profile.mode !== 'text') throw new Error('Not a text-only developer profile');
  // Check output reaches the prompt: secret values are masked first (they are re-read at every RUN, a test may create one).
  const runVerify = async (cwd, cmds) => {
    // Scanned before EVERY check and after the last: a check may create a secret that a later one prints then deletes.
    const mask = secretMask(ctx.worktree, opts.readProtectedPatterns || []);
    const v = await runVerifyRaw(cwd, cmds, { beforeEach: () => mask.observe() });
    const redact = mask();
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
    const obs = [];
    for (const e of errors) obs.push('FORMAT ERROR: ' + e);
    if (!actions.length && !errors.length) obs.push('FORMAT ERROR: no action found. Write one action per line, for example: READ src/file.js');
    if (errors.length || !actions.length) s.formatErrors++; else s.formatErrors = 0;
    if (s.formatErrors >= LIMITS.formatErrorsBeforeStuck) return finish('blocked', 'The model keeps answering outside the protocol (' + s.formatErrors + ' turns in a row)');
    // Empty answers alternating with valid turns never reach the in-a-row limit above: count them over a window.
    s.emptyRecent = [...s.emptyRecent, !actions.length && !errors.length].slice(-LIMITS.emptyTurnsWindow);
    const empties = s.emptyRecent.filter(Boolean).length;
    if (empties >= LIMITS.emptyTurnsBeforeStuck) return finish('blocked', 'The model returned ' + empties + ' empty answers in its last ' + s.emptyRecent.length + ' turns');
    if (!actions.length && !errors.length) obs.push('Your last answer was EMPTY (' + empties + '/' + LIMITS.emptyTurnsBeforeStuck + ' before hand-over). Answer with action lines only: EDIT/CREATE to change code, RUN to test, or STUCK <reason>.');

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
        else if (a.type === 'edit' || a.type === 'create') { const r = a.type === 'edit' ? doEdit(ctx, a) : doCreate(ctx, a, s.created); obs.push(r.err || r.ok); if (r.file && !s.changed.includes(r.file)) s.changed.push(r.file); if (r.created && !s.created.includes(r.file)) s.created.push(r.file); }
        else if (a.type === 'note') { s.notes.push(clip(a.text, LIMITS.noteChars)); s.notes = s.notes.slice(-12); obs.push('NOTE saved'); }
        else if (a.type === 'plan') { if (s.plan.length < LIMITS.planSteps) s.plan.push({ text: clip(a.text, 160), done: false }); obs.push('PLAN step ' + s.plan.length + ' recorded'); }
        else if (a.type === 'stepdone') { if (s.plan[a.n - 1]) s.plan[a.n - 1].done = true; obs.push('Step ' + a.n + ' marked done'); }
        else if (a.type === 'run') {
          ran = true;
          const h = diffHash(ctx);
          if (s.lastDiffHash === h && s.runs.length) { s.idleRuns++; obs.push('RUN skipped: nothing changed since the last RUN (' + s.idleRuns + '/' + LIMITS.idleRunsBeforeStuck + '). Change the code first.'); ranResult = s.runs.at(-1); }
          else {
            s.idleRuns = 0; s.lastDiffHash = h;
            const v = await runVerify(ctx.worktree, opts.verify || []);
            ranResult = { ok: v.ok, results: v.results.map((x) => ({ name: x.name, ok: x.ok, ms: x.ms, timedOut: x.timedOut, tail: x.ok ? '' : clip(String(x.tail || '').slice(-1800), 1800) })), at: now() };
            s.runs.push(ranResult); s.runs = s.runs.slice(-6);
            obs.push('RUN ' + (v.ok ? 'PASSED: ' + v.results.map((x) => x.name).join(', ') : 'FAILED at ' + (v.results.find((x) => !x.ok) || {}).name + ':\n' + ((v.results.find((x) => !x.ok) || {}).tail || '').slice(-1800)));
            const sig = failureSig(ranResult.results);
            if (v.ok) s.sameSigStreak = 0; else if (sig === s.lastRunSig) s.sameSigStreak++; else s.sameSigStreak = 1;
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

    lastObs = clip(obs.join('\n\n'), 6500); s.observations.push(lastObs); s.observations = s.observations.slice(-3);
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
      return finish('blocked', 'The model declared itself stuck: ' + clip(claimedStuck, 400));
    }
    if (claimedDone !== null) {
      if (!s.changed.length && !changedNow(ctx, opts.skipDirs).length) { demand = 'DONE refused: you changed nothing. Make the change, or say STUCK.'; lastObs = (lastObs ? lastObs + '\n\n' : '') + 'DONE refused: nothing was changed yet. Write the change with an EDIT or CREATE block (see the worked examples).'; saveSession(opts.sessionFile, s); continue; }
      const v = ran && ranResult && s.lastDiffHash === diffHash(ctx) ? ranResult : null;
      let check = v;
      if (!check) { const r = await runVerify(ctx.worktree, opts.verify || []); check = { ok: r.ok, results: r.results.map((x) => ({ name: x.name, ok: x.ok, ms: x.ms, tail: x.ok ? '' : clip(String(x.tail || '').slice(-1800), 1800) })), at: now() }; s.runs.push(check); s.lastDiffHash = diffHash(ctx); }
      if (check.ok) return finish('completed', clip(claimedDone, 500), { verified: check });
      lastObs = 'DONE refused: the host verification FAILED at ' + (check.results.find((x) => !x.ok) || {}).name + ':\n' + ((check.results.find((x) => !x.ok) || {}).tail || '').slice(-1800);
      s.observations.push(lastObs); const sig = failureSig(check.results); s.sameSigStreak = sig === s.lastRunSig ? s.sameSigStreak + 1 : 1; s.lastRunSig = sig;
    }
    // No progress: the same verification failure again and again, or RUN without changes.
    if (s.idleRuns >= LIMITS.idleRunsBeforeStuck) return finish('blocked', 'No progress: RUN repeated ' + s.idleRuns + ' times with no change to the code');
    if (s.sameSigStreak >= LIMITS.sameFailureBeforeSwitch) {
      s.strategies.push(clip(s.notes.at(-1) || ('the approach on ' + (s.changed.slice(-2).join(', ') || 'the code') + ' (same failure ' + s.sameSigStreak + ' times)'), 200));
      s.switches++; s.sameSigStreak = 0;
      if (s.switches > LIMITS.maxSwitches) return finish('blocked', 'The same failure persists after ' + LIMITS.maxSwitches + ' changes of strategy');
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
module.exports = { secretMask, runRepoWorker, parseActions, locateSearch, confine, LIMITS, PROTOCOL, failureSig, secretValues, SECRET_PATTERNS };
