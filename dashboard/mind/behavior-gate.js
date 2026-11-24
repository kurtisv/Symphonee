'use strict';
// Behaviour gate: a green type check or a green existing suite does not prove that a task is finished
// (2026-11-23, replay 9: the 9B passed tsc and filtered events by sessionId, which dropped the very events the task had to keep).
// Two checks, both local and token-free, run before the independent review:
//   1. lint():      a change to SOURCE code must come with a change to a TEST file (otherwise the repair prompt says so);
//   2. redGreen():  the tests the change adds or edits must FAIL on the code as it was (they detect the problem) and PASS on the change.
// Configured per pilot: def.behavior = { required, sourceDirs:[prefix], testPatterns:[regex source], testCmd:[... '{files}' ...],
//   linkDirs:[], timeoutMs, allowLoadErrorRed }. Off unless required === true.
// FAIL CLOSED: when git cannot say what changed, or the gate itself throws, the answer is "not verified", never "fine".
// KNOWN LIMIT (documented on purpose): "red" means the test run failed on the old code. A test that fails there because it cannot LOAD
// (a missing module, a syntax error) is not evidence about behaviour, so it is refused as "red for the wrong reason" unless
// allowLoadErrorRed is set (for a task that adds a brand-new module there is no old behaviour to detect). Beyond that, the gate cannot
// judge whether a test is a GOOD test: the independent review still does.
// Without testCmd the gate is lint-only (a test must exist, nothing is executed): redGreen() reports it as skipped, startVerify logs it.
const cp = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const GIT_MS = 30000;
const LOAD_ERROR = /Cannot find module|MODULE_NOT_FOUND|ERR_MODULE_NOT_FOUND|Test suite failed to run|SyntaxError|Cannot find name|error TS\d+/i;
const posix = (p) => String(p).replace(/\\/g, '/');
function safeLink(d) { const n = path.posix.normalize(posix(d)); return !n.startsWith('/') && !/^[A-Za-z]:/.test(n) && !n.split('/').includes('..') && n !== '.'; }
function normalize(c) {
  if (!c || c.required !== true) return { required: false };
  const arr = (x, n) => (Array.isArray(x) ? x.map(String).filter(Boolean).slice(0, n) : []);
  const testPatterns = arr(c.testPatterns, 10).filter((s) => { try { new RegExp(s); return true; } catch { return false; } });
  const testCmd = arr(c.testCmd, 20);
  // Repository-relative prefixes: "." or "./" means the whole repository, "./src/" means "src/"; absolute paths and ".." are never valid.
  const sourceDirs = arr(c.sourceDirs, 20).map(posix).filter((d) => !d.startsWith('/') && !/^[A-Za-z]:/.test(d) && !d.split('/').includes('..')).map((d) => (d === '.' || d === './' ? '.' : d.replace(/^\.\//, ''))); // "." (the whole repository) is kept as "." so that normalising twice gives the same result
  // A REQUIRED gate that cannot do what it promises must say so, not switch itself off: no sourceDirs means no change would ever count as
  // source, no runnable testCmd means no red/green (lint-only must be asked for explicitly with lintOnly: true).
  const invalid = [];
  if (!sourceDirs.length) invalid.push('sourceDirs is empty (no change would count as source code)');
  if (!testCmd.includes('{files}') && c.lintOnly !== true) invalid.push('testCmd must be a command containing "{files}" (or set lintOnly: true to accept a presence-only check)');
  return { required: true, invalid, lintOnly: c.lintOnly === true, sourceDirs, testPatterns: testPatterns.length ? testPatterns : ['(^|/)__tests__/', '\\.(test|spec)\\.[jt]sx?$'],
    testCmd: testCmd.includes('{files}') ? testCmd : [], linkDirs: arr(c.linkDirs, 8).map(posix).filter(safeLink), allowLoadErrorRed: c.allowLoadErrorRed === true,
    timeoutMs: Math.min(Math.max(Number(c.timeoutMs) || 600000, 10000), 30 * 60000) };
}
// Asynchronous (the server is never frozen by a slow git) with a hard timeout, and no path quoting: "src/caf\u00e9.js" must come back as itself.
function git(cwd, args) {
  return new Promise((resolve) => {
    let out = '', err = '', done = false, proc, timer = null;
    const end = (status) => { if (done) return; done = true; clearTimeout(timer); resolve({ status, stdout: out, stderr: err }); };
    try { proc = cp.spawn('git', ['-c', 'core.quotePath=false', ...args], { cwd, windowsHide: true }); } catch (e) { return resolve({ status: -1, stdout: '', stderr: String(e.message) }); }
    proc.stdout.on('data', (d) => { out += d; if (out.length > 32e6) out = out.slice(-16e6); });
    proc.stderr.on('data', (d) => { err += d; if (err.length > 1e6) err = err.slice(-5e5); });
    timer = setTimeout(() => { try { proc.kill(); } catch { /* ignore */ } try { proc.stdout.destroy(); proc.stderr.destroy(); } catch { /* ignore */ } end(-1); }, GIT_MS);
    proc.on('error', () => end(-1));
    proc.on('close', (c) => end(c === null ? -1 : c));
  });
}
// { files, deleted } of the change since `base`, or null when git could not tell (the caller must fail closed).
async function changed(cwd, base) {
  const a = await git(cwd, ['diff', '--name-status', '--no-renames', base, '--']), b = await git(cwd, ['ls-files', '--others', '--exclude-standard']);
  if (a.status !== 0 || b.status !== 0) return null;
  const files = new Set(), deleted = new Set();
  for (const line of String(a.stdout).split('\n')) { const m = /^([A-Z])\t(.+)$/.exec(line.trim()); if (!m) continue; (m[1] === 'D' ? deleted : files).add(posix(m[2])); }
  for (const f of String(b.stdout).split('\n').map((s) => posix(s.trim())).filter(Boolean)) files.add(f);
  return { files: [...files], deleted: [...deleted] };
}
function classify(ch, cfg) {
  const isTest = (f) => cfg.testPatterns.some((p) => new RegExp(p).test(f));
  const isSource = (f) => !isTest(f) && cfg.sourceDirs.some((d) => d === '.' || f.startsWith(d)) && /\.[cm]?[jt]sx?$/.test(f);
  return { tests: ch.files.filter(isTest), source: [...ch.files, ...ch.deleted].filter(isSource) };
}
const MISCONFIGURED = (cfg) => 'BEHAVIOUR GATE MISCONFIGURED (it is required but cannot verify anything): ' + cfg.invalid.join('; ') + '. Fix def.behavior in the pilot definition.';
const GIT_FAILED = 'BEHAVIOUR GATE COULD NOT READ THE CHANGE (git failed or timed out): the behaviour of this change is not verified.';
// Findings for the repair prompt; [] when the gate is off or the change touches no source code.
async function lint(cwd, base, rawCfg) {
  const cfg = normalize(rawCfg); if (!cfg.required) return [];
  if (cfg.invalid.length) return [MISCONFIGURED(cfg)];
  const ch = await changed(cwd, base); if (!ch) return [GIT_FAILED];
  const { source, tests } = classify(ch, cfg);
  if (!source.length || tests.length) return [];
  return ['BEHAVIOUR TEST REQUIRED: you changed ' + source.slice(0, 4).join(', ') + ' but no test file. Add or extend a test that FAILS on the old code (it must reproduce the problem the task describes: a concrete sequence of events, not only that the code compiles) and PASSES on your change. A passing type check does not prove the task is done.'];
}
// The child must not think it is a sub-test of whatever runs us (node:test sets NODE_TEST_CONTEXT, which changes how a nested `node --test` reports).
function cleanEnv() { const e = { ...process.env, CI: '1', FORCE_COLOR: '0', NO_COLOR: '1' }; delete e.NODE_TEST_CONTEXT; return e; }
// Asynchronous on purpose: this runs inside the server, a synchronous test run would freeze it for minutes.
// After the timeout the process tree is killed AND the promise is settled even if a descendant keeps the pipes open.
function runCmd(cmd, cwd, files, timeoutMs) {
  const full = cmd.flatMap((x) => (x === '{files}' ? files : [x]));
  return new Promise((resolve) => {
    let out = '', done = false, timedOut = false, proc, grace = null, started = false;
    const end = (code) => { if (done) return; done = true; clearTimeout(timer); if (grace) clearTimeout(grace); resolve({ code, out, timedOut, started }); };
    try { proc = cp.spawn(full[0], full.slice(1), { cwd, windowsHide: true, shell: false, env: cleanEnv() }); } catch (e) { return resolve({ code: -1, out: String(e.message), timedOut: false, started: false }); }
    proc.on('spawn', () => { started = true; });
    const keep = (d) => { out += d.toString(); if (out.length > 200000) out = out.slice(-100000); };
    proc.stdout.on('data', keep); proc.stderr.on('data', keep);
    const timer = setTimeout(() => {
      timedOut = true;
      try { require('./autopilot-verify').killTree(proc); } catch { /* ignore */ }
      try { proc.stdout.destroy(); proc.stderr.destroy(); } catch { /* ignore */ }
      grace = setTimeout(() => end(-1), 3000);
    }, timeoutMs);
    proc.on('error', (e) => { out += '\n' + e.message; started = started && false; end(-1); });
    proc.on('close', (code) => end(code === null ? -1 : code));
  });
}
// Removes a scratch checkout without ever following a link into the real one. Returns false when something had to be left behind.
async function removeScratch(repo, tmp, links) {
  for (const l of links) { try { const p = path.join(tmp, l); if (fs.lstatSync(p).isSymbolicLink()) fs.rmdirSync(p); } catch { try { cp.spawnSync('cmd', ['/c', 'rmdir', path.join(tmp, l)], { windowsHide: true, timeout: 10000 }); } catch { /* left for the OS temp cleaner */ } } }
  const stillLinked = links.some((l) => { try { return fs.lstatSync(path.join(tmp, l)).isSymbolicLink(); } catch { return false; } });
  if (stillLinked) return false; // never delete through a link that could not be removed
  const rm = await git(repo, ['worktree', 'remove', '--force', tmp]);
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
  await git(repo, ['worktree', 'prune']); // a directory that is gone must not stay registered
  return rm.status === 0 || !fs.existsSync(tmp);
}
// True when a file or any parent folder (below the scratch root) is a symbolic link / junction: writing there would go elsewhere.
function underSymlink(root, rel) {
  let cur = path.resolve(root);
  for (const part of posix(rel).split('/').filter(Boolean)) {
    cur = path.join(cur, part);
    try { if (fs.lstatSync(cur).isSymbolicLink()) return true; } catch { return false; } // not there yet: nothing to follow
  }
  return false;
}
// Red then green. `ok` is true only when the tests fail on the base (for a behavioural reason) and pass on the change.
async function redGreen({ cwd, base, config, linkFrom = null, redact = null }) {
  const cfg = normalize(config);
  if (!cfg.required) return { ok: true, skipped: true, message: 'behaviour gate: off' };
  if (cfg.invalid.length) return { ok: false, message: MISCONFIGURED(cfg) };
  if (!cfg.testCmd.length) return { ok: true, skipped: true, message: 'behaviour gate: lint only (lintOnly: true), the tests are required but not executed' };
  const ch = await changed(cwd, base); if (!ch) return { ok: false, message: GIT_FAILED };
  const { source, tests } = classify(ch, cfg);
  if (!source.length) return { ok: true, skipped: true, message: 'behaviour gate: no source change' };
  if (!tests.length) return { ok: false, message: (await lint(cwd, base, config))[0] || 'BEHAVIOUR TEST REQUIRED' };
  const t0 = Date.now(), tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'behavior-gate-')), links = [];
  const topRun = await git(cwd, ['rev-parse', '--show-toplevel']), top = String(topRun.stdout || '').trim();
  if (topRun.status !== 0 || !top) { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ } return { ok: false, message: GIT_FAILED }; }
  try {
    const add = await git(top, ['worktree', 'add', '--detach', tmp, base]);
    if (add.status !== 0) return { ok: false, message: 'behaviour gate could not create a checkout of the base: ' + String(add.stderr || '').slice(0, 300) };
    for (const d of cfg.linkDirs) {
      const from = path.resolve(linkFrom || cwd, d), to = path.resolve(tmp, d);
      if (!to.startsWith(path.resolve(tmp) + path.sep)) continue; // never outside the scratch checkout
      if (underSymlink(tmp, d)) continue; // nor through a link the base itself contains (a parent of the link target may point elsewhere)
      if (fs.existsSync(from) && !fs.existsSync(to)) { fs.mkdirSync(path.dirname(to), { recursive: true }); fs.symlinkSync(from, to, 'junction'); links.push(d); }
    }
    for (const f of tests) { if (cfg.linkDirs.some((d) => f === d || f.startsWith(d + '/'))) return { ok: false, message: 'behaviour gate refused a test located under a linked folder (' + f + '): it would be written through the link' }; const to = path.resolve(tmp, f); if (!to.startsWith(path.resolve(tmp) + path.sep)) return { ok: false, message: 'behaviour gate refused a test path outside the checkout: ' + f }; if (underSymlink(tmp, f)) return { ok: false, message: 'behaviour gate refused a test path that goes through a symbolic link of the base: ' + f }; fs.mkdirSync(path.dirname(to), { recursive: true }); fs.copyFileSync(path.join(cwd, f), to); }
    const red = await runCmd(cfg.testCmd, tmp, tests, cfg.timeoutMs);
    if (!red.started) return { ok: false, red: false, green: false, message: 'BEHAVIOUR TEST COULD NOT RUN on the old code (the test command did not start: ' + String(red.out).trim().split('\n').pop().slice(0, 200) + '). Check def.behavior.testCmd and linkDirs.', tests, scratch: tmp };
    const green = await runCmd(cfg.testCmd, cwd, tests, cfg.timeoutMs);
    const wrongReason = red.code !== 0 && !red.timedOut && !cfg.allowLoadErrorRed && LOAD_ERROR.test(red.out) && !/(AssertionError|expect\(|Expected[: ]|Received[: ])/.test(red.out); // an ASSERTION failed: that is behaviour. A failed file summary alone (✖, FAIL, not ok) also appears when the file cannot load.
    const ok = red.code !== 0 && !red.timedOut && !wrongReason && green.code === 0;
    const message = ok ? 'behaviour gate: the ' + tests.length + ' test file(s) fail on the old code and pass on the change'
      : red.code === 0 ? 'BEHAVIOUR TEST TOO WEAK: ' + tests.join(', ') + ' PASS on the old code too, so they do not detect the problem. Write a test that reproduces the failure (it must fail before your change).'
        : red.timedOut ? 'BEHAVIOUR TEST TIMED OUT on the old code: ' + tests.join(', ')
          : wrongReason ? 'BEHAVIOUR TEST IS RED FOR THE WRONG REASON: ' + tests.join(', ') + ' fail on the old code because they cannot load (missing module or syntax error), not because the behaviour is wrong. Test the behaviour of code that already exists.'
            : 'BEHAVIOUR TEST FAILS on your change: ' + tests.join(', ') + (typeof redact === 'function' ? '\n' + redact(green.out.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '')).slice(-1500) : ' (the test output is not included: no masker was provided)'); // masked BEFORE it is cut, never the other way round
    return { ok, red: red.code !== 0 && !wrongReason, green: green.code === 0, message, ms: Date.now() - t0, tests, scratch: tmp };
  } catch (e) {
    return { ok: false, message: 'behaviour gate error: ' + String(e.message || e).slice(0, 300) };
  } finally { if (!(await removeScratch(top, tmp, links))) console.warn('[behavior-gate] scratch checkout left behind: ' + tmp); }
}

module.exports = { normalize, changed, classify, lint, redGreen, safeLink, underSymlink };
