'use strict';
// Engine-enforced proof for a DEFECT fix: the regression test the change adds must FAIL on the unfixed code and PASS on the fixed code.
// Written as code, not as a prompt: a change that cannot show both is sent back to repair, whoever wrote it (Qwen or Claude).
//
//   before: a detached worktree at the task's base, with ONLY the changed test files copied over from the fix (sources stay unfixed);
//           the repository's own test command, limited to those files, must fail on at least one test.
//   after:  the same command on the fixed worktree must pass.
//
// Applies only where the pilot's definition asks for it (def.proof.beforeAfter) and to category "correctness".
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const cp = require('node:child_process');

const TEST_FILE = /(^|\/)(__tests__\/.+|[^/]+\.(test|spec)\.[cm]?[jt]sx?)$/;
// What a red run looks like for the usual runners (jest, vitest, node:test). Anything else red is "could not run", not "proved".
const FAIL_PATTERN = /Tests?:\s+\d+ failed|✕|×|FAIL\b|# fail [1-9]|failing tests:/;
// A test that fails because it cannot LOAD (missing module, syntax error) shows nothing about the defect.
const LOAD_ERROR = /Cannot find module|ERR_MODULE_NOT_FOUND|MODULE_NOT_FOUND|SyntaxError|Test suite failed to run|ERR_REQUIRE_ESM|Unexpected token/;
const TIMEOUT_MS = 20 * 60000;

const git = (cwd, args) => cp.execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true, timeout: 120000, maxBuffer: 16 * 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } }).trim();
const testFilesOf = (paths) => [...new Set((paths || []).map((p) => String(p).replace(/\\/g, '/')).filter((p) => TEST_FILE.test(p)))];

// The repository's own test command, restricted to some files: the pilot's check named "jest" (or any check that runs jest/vitest/node --test)
// plus a path filter; a file under a sub-package that has its own check (cwd) runs there, with its path made relative to it.
function commandFor(verify, file) {
  const checks = (verify || []).filter((v) => /jest|vitest|--test/.test((v.cmd || []).join(' ')));
  const own = checks.find((v) => v.cwd && file.startsWith(v.cwd.replace(/\\/g, '/').replace(/\/?$/, '/')));
  const v = own || checks.find((v) => !v.cwd) || checks[0];
  if (!v) return null;
  const rel = v.cwd && file.startsWith(v.cwd.replace(/\\/g, '/').replace(/\/?$/, '/')) ? file.slice(v.cwd.replace(/\\/g, '/').replace(/\/?$/, '/').length) : file;
  return { name: v.name, cwd: v.cwd || '', cmd: v.cmd, rel, timeoutMs: Math.min(v.timeoutMs || TIMEOUT_MS, TIMEOUT_MS) };
}
// Groups the test files by command, so one run covers every file of the same sub-package.
function plan(verify, files) {
  const groups = new Map();
  for (const f of files) {
    const c = commandFor(verify, f);
    if (!c) return { error: 'no repository test command to run the new tests with' };
    const k = c.name + '|' + c.cwd;
    if (!groups.has(k)) groups.set(k, { name: c.name, cwd: c.cwd, cmd: c.cmd, timeoutMs: c.timeoutMs, files: [] });
    groups.get(k).files.push(c.rel);
  }
  return { groups: [...groups.values()] };
}
const asCheck = (g, label) => ({ name: label + ':' + g.name, cwd: g.cwd || undefined, cmd: [...g.cmd, ...(/jest/.test(g.cmd.join(' ')) ? ['--runTestsByPath'] : []), ...g.files], timeoutMs: g.timeoutMs });

// opts: { cwd (the fix worktree), base (sha), repoPath (main checkout, for the worktree), linkDirs, verify, runVerify, changed: [paths], category, enabled }
// -> null when it does not apply; else { ok, result (a failing check in runVerify's shape, when !ok), proofRun }
async function proofBeforeAfter(opts) {
  const { enabled, category } = opts;
  if (!enabled || category !== 'correctness') return null;
  const files = testFilesOf(opts.changed);
  const fail = (why, extra = {}) => ({ ok: false, result: { name: 'preuve-avant-apres', ok: false, code: 1, ms: 0, timedOut: false, tail: 'PROOF OF A DEFECT FIX MISSING: ' + why }, proofRun: { ok: false, why, files, ...extra } });
  if (!files.length) return fail('the change adds or modifies no test file. A defect fix needs a regression test that fails before the fix and passes after it.');
  const p = plan(opts.verify, files);
  if (p.error) return fail(p.error);
  const run = opts.runVerify;
  const tmp = path.join(os.tmpdir(), 'preuve-' + crypto.randomBytes(4).toString('hex'));
  let linked = [];
  try {
    git(opts.repoPath, ['worktree', 'add', '--detach', tmp, opts.base]);
    try { linked = opts.linkDirs && opts.linkDirs.length ? opts.guard.linkDirs(opts.repoPath, tmp, opts.linkDirs) : []; } catch (_) { linked = []; }
    for (const f of files) { // only the tests come over: the sources stay UNFIXED
      const src = path.join(opts.cwd, f), dst = path.join(tmp, f);
      if (!fs.existsSync(src)) continue; // a deleted test is not a proof
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      // Never write through a symlink of the base: the destination itself is replaced, a symlinked parent is refused.
      try { if (fs.lstatSync(dst).isSymbolicLink()) fs.unlinkSync(dst); } catch (_) { /* absent */ }
      const realRoot = fs.realpathSync(tmp), realDir = fs.realpathSync(path.dirname(dst));
      if (realDir !== realRoot && !realDir.startsWith(realRoot + path.sep)) return fail('a test path goes through a link that leaves the proof worktree: ' + f);
      fs.copyFileSync(src, dst);
    }
    const before = [];
    for (const g of p.groups) {
      const r = await run(tmp, [asCheck(g, 'avant')]);
      const item = r.results[0] || {};
      before.push({ group: g.name, ok: r.ok, red: !r.ok && !item.timedOut && FAIL_PATTERN.test(String(item.tail || '')) && !LOAD_ERROR.test(String(item.tail || '')), timedOut: !!item.timedOut });
    }
    if (before.some((b) => b.ok)) return fail('the new tests PASS on the unfixed code (' + before.filter((b) => b.ok).map((b) => b.group).join(', ') + '): they prove nothing about the defect.', { before });
    if (before.some((b) => !b.red)) return fail('the new tests could not be run on the unfixed code (not a clean test failure): the failure before the fix is not demonstrated.', { before });
  } finally {
    try { if (opts.guard) opts.guard.unlinkDirs(tmp, opts.linkDirs || []); } catch (_) { /* links first, never a recursive delete through them */ }
    try { git(opts.repoPath, ['worktree', 'remove', '--force', tmp]); } catch (_) { /* reported by the caller's cleanup */ }
  }
  const after = [];
  for (const g of p.groups) {
    const r = await run(opts.cwd, [asCheck(g, 'apres')]);
    after.push({ group: g.name, ok: r.ok });
    if (!r.ok) return { ok: false, result: { ...(r.results[0] || {}), name: 'preuve-avant-apres', ok: false }, proofRun: { ok: false, why: 'the new tests FAIL on the fixed code', files, after } };
  }
  return { ok: true, proofRun: { ok: true, files, failsBefore: true, passesAfter: true, groups: p.groups.map((g) => g.name) } };
}

module.exports = { proofBeforeAfter, testFilesOf, commandFor, plan, TEST_FILE, FAIL_PATTERN };
