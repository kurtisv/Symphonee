'use strict';
// Token-free guards of the "deep" Mind Autopilot loop. Everything here runs
// locally: no model call, no network.
//  - linkDirs/unlinkDirs: share heavy folders (node_modules) with a worktree
//    through a directory junction, and remove the junction afterwards so that
//    deleting the worktree can never reach the real folder.
//  - protectedHits: changed files that match a protected path pattern.
//  - diffLint: added lines that weaken verification (.skip/.only/@ts-ignore).
//  - runVerify: run the repository's own checks (type-check, tests) in the
//    worktree, asynchronously, without a shell.
const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

function runGit(cwd, args) {
  const r = spawnSync('git', args, { cwd, timeout: 30000, encoding: 'utf8', windowsHide: true,
    maxBuffer: 64 * 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
  if (r.error || r.status !== 0) throw new Error('git failed: ' + String(r.stderr || r.error?.message || args[0]).slice(0, 200));
  return String(r.stdout || '');
}

// Only plain relative sub-paths: never absolute, never climbing out.
function safeRel(rel) {
  const p = String(rel || '').replace(/\\/g, '/');
  if (!p || p.startsWith('/') || /^[A-Za-z]:/.test(p) || p.split('/').some(s => s === '..' || s === '')) {
    throw new Error('Invalid linked directory: ' + rel);
  }
  return p;
}
function linkDirs(repoPath, worktreePath, dirs = []) {
  const made = [];
  for (const d of dirs) {
    const rel = safeRel(d);
    const target = path.join(repoPath, rel);
    const link = path.join(worktreePath, rel);
    if (!fs.existsSync(target) || fs.existsSync(link)) continue;
    fs.mkdirSync(path.dirname(link), { recursive: true });
    fs.symlinkSync(target, link, 'junction');
    made.push(rel);
  }
  return made;
}
// Removes ONLY links (junction/symlink). A real directory is never touched.
function unlinkDirs(worktreePath, dirs = []) {
  const removed = [];
  for (const d of dirs) {
    let link;
    try { link = path.join(worktreePath, safeRel(d)); } catch (_) { continue; }
    try {
      if (!fs.lstatSync(link).isSymbolicLink()) continue;
      try { fs.rmdirSync(link); } catch (_) { fs.unlinkSync(link); }
      removed.push(d);
    } catch (_) { /* absent: nothing to do */ }
  }
  return removed;
}

// Everything that differs from the base commit: tracked changes, new files,
// AND files the repository ignores (a fresh worktree has none, so any ignored
// entry was created by the run; .gitignore must not hide a protected path).
// Ignored directories are reported collapsed ("secrets/"), which is enough to
// match a path pattern; `skip` lists the junctions Symphonee created itself.
function changedPaths(cwd, base, { skip = [] } = {}) {
  // core.quotepath=off: a path with non-ASCII characters is printed as written, never in Git's quoted form (which would escape every path pattern).
  const lines = (args) => runGit(cwd, ['-c', 'core.quotepath=off', ...args]).split(/\r?\n/).filter(Boolean);
  // --no-renames: a protected file renamed out of its folder shows as a deletion of the protected path AND an addition, never only the new name.
  const tracked = lines(['diff', '--name-only', '--no-renames', base, '--']);
  const untracked = lines(['ls-files', '--others', '--exclude-standard']);
  const own = new Set(skip.map(d => String(d).replace(/\\/g, '/').replace(/\/+$/, '')));
  const ignored = lines(['ls-files', '--others', '--ignored', '--exclude-standard', '--directory'])
    .filter(p => !own.has(p.replace(/\/+$/, '')));
  return [...new Set([...tracked, ...untracked, ...ignored])];
}
function compilePatterns(patterns = []) {
  return patterns.map((p) => { try { return new RegExp(p, 'i'); } catch (_) { throw new Error('Invalid protected path pattern: ' + p); } });
}
function protectedHits(files, patterns = []) {
  const res = compilePatterns(patterns);
  return files.filter(f => res.some(re => re.test(f)));
}

// Added lines only: a change that silences a test or the type-checker is not
// an improvement, whatever the reviewer is told.
const WEAKENERS = [
  [/\b(?:it|test|describe)\.(?:skip|only)\s*\(/, 'test disabled or focused (.skip/.only)'],
  [/\bx(?:it|test|describe)\s*\(/, 'test disabled (xit/xdescribe)'],
  [/@ts-(?:ignore|nocheck)\b/, 'type-check silenced (@ts-ignore/@ts-nocheck)'],
];
// Call sites of the permission and approval machinery: changing any of these lines (added OR removed) is a change to the loop's own permissions.
const ENGINE_CONTROL = /\b(permGate|permissionMode|autoPermit|bypassPermissions|TOKEN_REQUIRED|x-symphonee-token|requirePermission|evaluatePermission)\b/;
function diffLint(cwd, base, { selfProtect = false } = {}) {
  const findings = [];
  const scan = (file, text) => {
    for (const line of text) {
      for (const [re, why] of WEAKENERS) if (re.test(line)) findings.push(file + ': ' + why);
    }
  };
  let file = '';
  for (const line of runGit(cwd, ['diff', '--unified=0', base, '--']).split(/\r?\n/)) {
    if (line.startsWith('+++ ')) { file = line.slice(4).replace(/^b\//, ''); continue; }
    if (line.startsWith('+') && !line.startsWith('+++')) scan(file, [line.slice(1)]);
    if (selfProtect && /^[+-](?![+-]{2} )/.test(line) && ENGINE_CONTROL.test(line)) findings.push(file + ': changes a permission or approval call site (needs a dedicated, explicitly authorised mission)');
  }
  // A file that HOSTS a permission or approval call site cannot be changed by a routine task at all: the check that enforces the result is often on another line.
  if (selfProtect) {
    for (const f of runGit(cwd, ['-c', 'core.quotepath=off', 'diff', '--name-only', '--no-renames', base, '--']).split(/\r?\n/).filter((x) => /\.[jt]sx?$/.test(x))) {
      let body = ''; try { body = fs.readFileSync(path.join(cwd, f), 'utf8'); } catch (_) { try { body = runGit(cwd, ['show', base + ':' + f]); } catch (__) { /* new file */ } }
      let before = ''; try { before = runGit(cwd, ['show', base + ':' + f]); } catch (_) { /* new file */ }
      if (ENGINE_CONTROL.test(body) || ENGINE_CONTROL.test(before)) findings.push(f + ': hosts a permission or approval call site (needs a dedicated, explicitly authorised mission)');
    }
  }
  for (const f of runGit(cwd, ['-c', 'core.quotepath=off', 'ls-files', '--others', '--exclude-standard']).split(/\r?\n/).filter(Boolean)) {
    if (!/\.[jt]sx?$/.test(f)) continue;
    try { scan(f, fs.readFileSync(path.join(cwd, f), 'utf8').split(/\r?\n/)); } catch (_) {}
  }
  return [...new Set(findings)];
}

function validCommands(commands = []) {
  if (!Array.isArray(commands)) throw new Error('verify must be an array');
  return commands.map((c) => {
    if (!c || typeof c.name !== 'string' || !Array.isArray(c.cmd) || c.cmd.length < 1
      || c.cmd.some(x => typeof x !== 'string' || !x)) throw new Error('Each verify entry needs {name, cmd:[...]}');
    // Optional cwd: a sub-folder of the work tree (e.g. "api"), never outside it.
    return { name: c.name.slice(0, 40), cmd: c.cmd.slice(0, 20), timeoutMs: Math.min(Math.max(Number(c.timeoutMs) || 600000, 10000), 30 * 60000),
      ...(c.cwd ? { cwd: safeRel(c.cwd) } : {}) };
  });
}
function killTree(proc) {
  if (!proc || !proc.pid) return;
  if (process.platform === 'win32') {
    try { spawnSync('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { windowsHide: true, timeout: 10000 }); } catch (_) {}
  } else { try { proc.kill('SIGKILL'); } catch (_) {} }
}
// Runs each command in order (no shell); stops at the first failure.
// Resolves { ok, results:[{name, ok, code, ms, timedOut, tail}] }.
async function runVerify(cwd, commands, { onStart } = {}) {
  const results = [];
  for (const c of validCommands(commands)) {
    const t0 = Date.now();
    const r = await new Promise((resolve) => {
      let out = '', done = false, timedOut = false;
      let proc;
      try {
        proc = spawn(c.cmd[0], c.cmd.slice(1), { cwd: c.cwd ? path.join(cwd, c.cwd) : cwd, windowsHide: true, shell: false,
          env: { ...process.env, CI: '1', FORCE_COLOR: '0', NO_COLOR: '1' } });
      } catch (e) { return resolve({ code: -1, out: String(e.message), timedOut: false }); }
      if (onStart) { try { onStart(proc, c); } catch (_) {} }
      const keep = (d) => { out += d.toString(); if (out.length > 200000) out = out.slice(-100000); };
      proc.stdout.on('data', keep); proc.stderr.on('data', keep);
      const timer = setTimeout(() => { timedOut = true; killTree(proc); }, c.timeoutMs);
      const finish = (code) => { if (done) return; done = true; clearTimeout(timer); resolve({ code, out, timedOut }); };
      proc.on('error', (e) => { out += '\n' + e.message; finish(-1); });
      proc.on('close', (code) => finish(code));
    });
    const ok = r.code === 0 && !r.timedOut;
    results.push({ name: c.name, ok, code: r.code, ms: Date.now() - t0, timedOut: r.timedOut,
      tail: ok ? '' : r.out.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '').slice(-6000) });
    if (!ok) break;
  }
  return { ok: results.length > 0 && results.every(x => x.ok), results };
}

module.exports = { linkDirs, unlinkDirs, changedPaths, protectedHits, compilePatterns, diffLint, runVerify, validCommands, killTree };
