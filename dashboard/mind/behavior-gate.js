'use strict';
// Behaviour gate: a green type check or a green existing suite does not prove that a task is finished
// (2026-11-23, replay 9: the 9B passed tsc and filtered events by sessionId, which dropped the very events the task had to keep).
// Two checks, both local and token-free, run before the independent review:
//   1. lint():    a change to SOURCE code must come with a change to a TEST file (otherwise the repair prompt says so);
//   2. redGreen(): the tests the change adds or edits must FAIL on the code as it was (they detect the problem) and PASS on the change.
// Configured per pilot: def.behavior = { required, sourceDirs:[prefix], testPatterns:[regex source], testCmd:[... '{files}' ...], linkDirs:[], timeoutMs }.
// Off unless required === true.
const cp = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const posix = (p) => String(p).replace(/\\/g, '/');
function normalize(c) {
  if (!c || c.required !== true) return { required: false };
  const arr = (x, n) => (Array.isArray(x) ? x.map(String).filter(Boolean).slice(0, n) : []);
  const testPatterns = arr(c.testPatterns, 10).filter((s) => { try { new RegExp(s); return true; } catch { return false; } });
  const testCmd = arr(c.testCmd, 20);
  return { required: true, sourceDirs: arr(c.sourceDirs, 20).map(posix), testPatterns: testPatterns.length ? testPatterns : ['(^|/)__tests__/', '\\.(test|spec)\\.[jt]sx?$'],
    testCmd: testCmd.includes('{files}') ? testCmd : [], linkDirs: arr(c.linkDirs, 8).map(posix).filter((d) => !d.startsWith('..') && !path.isAbsolute(d)), timeoutMs: Math.min(Math.max(Number(c.timeoutMs) || 600000, 10000), 30 * 60000) };
}
function git(cwd, args, opts = {}) { return cp.spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true, maxBuffer: 16 * 1024 * 1024, ...opts }); }
function changed(cwd, base) {
  const a = git(cwd, ['diff', '--name-only', '--diff-filter=ACMR', base, '--']).stdout || '', b = git(cwd, ['ls-files', '--others', '--exclude-standard']).stdout || '';
  return [...new Set([...a.split('\n'), ...b.split('\n')].map((s) => posix(s.trim())).filter(Boolean))];
}
function classify(files, cfg) {
  const isTest = (f) => cfg.testPatterns.some((p) => new RegExp(p).test(f));
  const tests = files.filter(isTest);
  const source = files.filter((f) => !isTest(f) && cfg.sourceDirs.some((d) => f.startsWith(d)) && /\.[cm]?[jt]sx?$/.test(f));
  return { source, tests };
}
// Findings for the repair prompt; [] when the gate is off or the change touches no source code.
function lint(cwd, base, rawCfg) {
  const cfg = normalize(rawCfg); if (!cfg.required) return [];
  const { source, tests } = classify(changed(cwd, base), cfg);
  if (!source.length || tests.length) return [];
  return ['BEHAVIOUR TEST REQUIRED: you changed ' + source.slice(0, 4).join(', ') + ' but no test file. Add or extend a test that FAILS on the old code (it must reproduce the problem the task describes: a concrete sequence of events, not only that the code compiles) and PASSES on your change. A passing type check does not prove the task is done.'];
}
// The child must not think it is a sub-test of whatever runs us (node:test sets NODE_TEST_CONTEXT, which changes how a nested `node --test` reports).
function cleanEnv() { const e = { ...process.env, CI: '1', FORCE_COLOR: '0', NO_COLOR: '1' }; delete e.NODE_TEST_CONTEXT; return e; }
// Asynchronous on purpose: this runs inside the server, a synchronous test run would freeze it for minutes.
function runCmd(cmd, cwd, files, timeoutMs) {
  const full = cmd.flatMap((x) => (x === '{files}' ? files : [x]));
  return new Promise((resolve) => {
    let out = '', done = false, timedOut = false, proc;
    const end = (code) => { if (done) return; done = true; clearTimeout(timer); resolve({ code, out, timedOut }); };
    try { proc = cp.spawn(full[0], full.slice(1), { cwd, windowsHide: true, shell: false, env: cleanEnv() }); } catch (e) { return resolve({ code: -1, out: String(e.message), timedOut: false }); }
    const keep = (d) => { out += d.toString(); if (out.length > 200000) out = out.slice(-100000); };
    proc.stdout.on('data', keep); proc.stderr.on('data', keep);
    const timer = setTimeout(() => { timedOut = true; try { require('./autopilot-verify').killTree(proc); } catch { /* ignore */ } }, timeoutMs);
    proc.on('error', (e) => { out += '\n' + e.message; end(-1); });
    proc.on('close', (code) => end(code === null ? -1 : code));
  });
}
// Removes a scratch checkout without ever following a link into the real one.
function removeScratch(repo, tmp, links) {
  for (const l of links) { try { const p = path.join(tmp, l); if (fs.lstatSync(p).isSymbolicLink()) fs.rmdirSync(p); } catch { try { cp.spawnSync('cmd', ['/c', 'rmdir', path.join(tmp, l)], { windowsHide: true }); } catch { /* left for the OS temp cleaner */ } } }
  const stillLinked = links.some((l) => { try { return fs.lstatSync(path.join(tmp, l)).isSymbolicLink(); } catch { return false; } });
  if (stillLinked) return; // never delete through a link that could not be removed
  git(repo, ['worktree', 'remove', '--force', tmp]);
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
}
// Red then green. `ok` is true only when the tests fail on the base and pass on the change.
async function redGreen({ cwd, base, config, linkFrom = null }) {
  const cfg = normalize(config);
  if (!cfg.required || !cfg.testCmd.length) return { ok: true, skipped: true, message: 'behaviour gate: no test command configured' };
  const { source, tests } = classify(changed(cwd, base), cfg);
  if (!source.length) return { ok: true, skipped: true, message: 'behaviour gate: no source change' };
  if (!tests.length) return { ok: false, message: lint(cwd, base, config)[0] || 'BEHAVIOUR TEST REQUIRED' };
  const t0 = Date.now(), tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'behavior-gate-')), links = [];
  const top = (git(cwd, ['rev-parse', '--show-toplevel']).stdout || '').trim();
  try {
    const add = git(top || cwd, ['worktree', 'add', '--detach', tmp, base]);
    if (add.status !== 0) return { ok: false, message: 'behaviour gate could not create a checkout of the base: ' + String(add.stderr || '').slice(0, 300) };
    for (const d of cfg.linkDirs) { const from = path.join(linkFrom || cwd, d), to = path.join(tmp, d); if (fs.existsSync(from) && !fs.existsSync(to)) { fs.mkdirSync(path.dirname(to), { recursive: true }); fs.symlinkSync(from, to, 'junction'); links.push(d); } }
    for (const f of tests) { const to = path.join(tmp, f); fs.mkdirSync(path.dirname(to), { recursive: true }); fs.copyFileSync(path.join(cwd, f), to); }
    const red = await runCmd(cfg.testCmd, tmp, tests, cfg.timeoutMs);
    const green = await runCmd(cfg.testCmd, cwd, tests, cfg.timeoutMs);
    const ok = red.code !== 0 && !red.timedOut && green.code === 0;
    const message = ok ? 'behaviour gate: the ' + tests.length + ' test file(s) fail on the old code and pass on the change'
      : red.code === 0 ? 'BEHAVIOUR TEST TOO WEAK: ' + tests.join(', ') + ' PASS on the old code too, so they do not detect the problem. Write a test that reproduces the failure (it must fail before your change).'
        : red.timedOut ? 'BEHAVIOUR TEST TIMED OUT on the old code: ' + tests.join(', ')
          : 'BEHAVIOUR TEST FAILS on your change: ' + tests.join(', ') + '\n' + green.out.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '').slice(-1500);
    return { ok, red: red.code !== 0, green: green.code === 0, message, ms: Date.now() - t0, tests };
  } catch (e) {
    return { ok: false, message: 'behaviour gate error: ' + String(e.message || e).slice(0, 300) };
  } finally { removeScratch(top || cwd, tmp, links); }
}

module.exports = { normalize, changed, classify, lint, redGreen };
