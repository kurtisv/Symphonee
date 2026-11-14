#!/usr/bin/env node
'use strict';
// Merge gate entry point (dashboard/automation/merge-gate.js holds the rules).
// Run by the Symphonee script job "Porte de fusion" every 30 minutes.
//   node scripts/merge-gate.js            one real pass
//   node scripts/merge-gate.js --essai    dry run: discovery + path/size/secret/proof rules only;
//                                         no chain, no push, no PR, no merge, no message, no state write
// Policy: config/merge-gate.json. State and journal: .ai-workspace/merge-gate/.
// Emergency stop: create .ai-workspace/merge-gate/STOP (or set "enabled": false).
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const gate = require('../dashboard/automation/merge-gate');
const guard = require('../dashboard/mind/autopilot-verify');
const sentry = require('../dashboard/automation/sentry-report');
const { authHeaders } = require('./api-token');

const ROOT = path.join(__dirname, '..');
const POLICY = path.join(ROOT, 'config', 'merge-gate.json');
const DIR = path.join(ROOT, '.ai-workspace', 'merge-gate');
const STATE = path.join(DIR, 'state.json');
const JOURNAL = path.join(DIR, 'journal.log');
const LOCK = path.join(DIR, 'lock');
const STOP = path.join(DIR, 'STOP');
const ESSAI = process.argv.includes('--essai');
fs.mkdirSync(DIR, { recursive: true });

function log(line) {
  const l = new Date().toISOString() + ' PORTE ' + (ESSAI ? 'ESSAI ' : '') + line;
  console.log(l);
  if (!ESSAI) try { fs.appendFileSync(JOURNAL, l + '\n'); } catch (_) {}
}
function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', timeout: 600000, maxBuffer: 64 * 1024 * 1024, windowsHide: true,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } }).trim();
}
function isAncestor(cwd, a, b) {
  try { execFileSync('git', ['merge-base', '--is-ancestor', a, b], { cwd, windowsHide: true, stdio: 'ignore' }); return true; } catch (_) { return false; }
}
function api(method, p, body) {
  return new Promise((ok, ko) => {
    const data = body ? JSON.stringify(body) : '';
    const req = http.request({ host: '127.0.0.1', port: 3800, path: p, method,
      headers: { Accept: 'application/json', ...(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}), ...authHeaders() } },
    (res) => { let s = ''; res.on('data', (c) => { s += c; }); res.on('end', () => {
      let j; try { j = JSON.parse(s); } catch (_) { j = { raw: s }; }
      if (res.statusCode >= 400) return ko(new Error('HTTP ' + res.statusCode + ' ' + p + ' ' + String(s).slice(0, 300)));
      ok(j); }); });
    req.on('error', ko); req.setTimeout(120000, () => req.destroy(new Error('delai depasse ' + p)));
    req.end(data);
  });
}
function readPilot(id) {
  const f = path.join(ROOT, '.symphonee', id === 'default' ? 'mind-autopilot.json' : 'mind-autopilot-' + id + '.json');
  try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (_) { return null; }
}

// Temporary worktree at `base`, cleaned up with its links removed FIRST (a
// junction must never be followed by a recursive delete into node_modules).
async function withWorktree(repo, base, fn) {
  const dir = path.join(os.tmpdir(), 'porte-' + crypto.randomBytes(4).toString('hex'));
  git(repo.path, ['worktree', 'add', '--detach', dir, base]);
  let links = [];
  try {
    links = guard.linkDirs(repo.path, dir, repo.linkDirs || []);
    return await fn(dir);
  } finally {
    guard.unlinkDirs(dir, repo.linkDirs || []);
    const left = (repo.linkDirs || []).filter((d) => { try { return fs.lstatSync(path.join(dir, d)).isSymbolicLink(); } catch (_) { return false; } });
    if (left.length) log('ATTENTION liens non retires, worktree laissee en place : ' + dir + ' (' + left.join(', ') + ')');
    else { try { git(repo.path, ['worktree', 'remove', '--force', dir]); } catch (e) { log('worktree temporaire non retiree : ' + dir + ' : ' + e.message.split('\n')[0]); } }
  }
}
// Temporary worktrees left by a killed pass: links removed FIRST, then the
// worktree; a worktree whose links cannot be removed is left and reported.
function cleanupLeftovers(policy) {
  for (const repo of policy.repos) {
    let list = '';
    try { list = git(repo.path, ['worktree', 'list', '--porcelain']); } catch (_) { continue; }
    for (const line of list.split(/\r?\n/)) {
      const dir = line.startsWith('worktree ') ? line.slice(9).trim() : '';
      if (!dir || !/[\\/]porte-[0-9a-f]{8}$/.test(dir)) continue;
      const native = path.resolve(dir);
      if (path.dirname(native).toLowerCase() !== path.resolve(os.tmpdir()).toLowerCase()) continue;
      guard.unlinkDirs(native, repo.linkDirs || []);
      const left = (repo.linkDirs || []).filter((d) => { try { return fs.lstatSync(path.join(native, d)).isSymbolicLink(); } catch (_) { return false; } });
      if (left.length) { log('ATTENTION reste d un passage interrompu, liens non retires : ' + native); continue; }
      try { git(repo.path, ['worktree', 'remove', '--force', native]); log('reste d un passage interrompu nettoye : ' + native); }
      catch (e) { log('reste non retire ' + native + ' : ' + e.message.split('\n')[0]); }
    }
  }
}
// NUL-separated git output, never trimmed (paths are taken literally).
function rawSplit(out) { return String(out || '').split('\0').filter(Boolean); }
// Tracked changes and untracked files of a worktree (both sides of a rename).
function changedPaths(dir) {
  const tracked = rawSplit(execFileSync('git', ['diff', '--name-only', '-z', 'HEAD'], { cwd: dir, encoding: 'utf8' }));
  const untracked = rawSplit(execFileSync('git', ['ls-files', '-z', '--others', '--exclude-standard'], { cwd: dir, encoding: 'utf8' }));
  return [...new Set([...tracked, ...untracked])];
}
async function runChain(repo, base, sha) {
  return withWorktree(repo, base, async (dir) => {
    try { git(dir, ['-c', 'user.name=Porte de fusion', '-c', 'user.email=porte-fusion@symphonee.invalid', 'merge', '--no-ff', '-m', 'Fusion automatique encadree (' + gate.MARK + ') : ' + sha, sha]); }
    catch (_) {
      const allowed = (repo.regeneratePaths || []).map((x) => new RegExp(x));
      let conflicted = [];
      try { conflicted = rawSplit(execFileSync('git', ['diff', '--name-only', '--diff-filter=U', '-z'], { cwd: dir, encoding: 'utf8' })); } catch (__) {}
      const onlyGenerated = (repo.regenerate || []).length && conflicted.length && conflicted.every((f) => allowed.some((rx) => rx.test(f)));
      if (!onlyGenerated) { try { git(dir, ['merge', '--abort']); } catch (__) {} return { ok: false, conflict: true, results: [] }; }
      // Only generated documents conflict: take the base side, regeneration below rebuilds them.
      git(dir, ['--literal-pathspecs', 'checkout', '--ours', '--', ...conflicted]);
      git(dir, ['--literal-pathspecs', 'add', '--', ...conflicted]);
      git(dir, ['-c', 'user.name=Porte de fusion', '-c', 'user.email=porte-fusion@symphonee.invalid', 'commit', '--no-edit']);
    }
    // The exact tree tested: the merge GitHub makes must have this content.
    // Generated documents (e.g. counts of test files) are recomputed ON the merge
    // and folded into the merge commit, so they can never conflict between
    // branches; only the listed paths may change, and the commands may not commit.
    if ((repo.regenerate || []).length) {
      const allowed = (repo.regeneratePaths || []).map((x) => new RegExp(x));
      const head = git(dir, ['rev-parse', 'HEAD']);
      try {
        for (const r of repo.regenerate) execFileSync(r.cmd[0], r.cmd.slice(1), { cwd: path.join(dir, r.cwd || ''), stdio: 'pipe', timeout: r.timeoutMs || 300000, windowsHide: true });
      } catch (e) { return { ok: false, regenError: 'commande en echec : ' + String(e.message || e).split('\n')[0].slice(0, 200), results: [] }; }
      if (git(dir, ['rev-parse', 'HEAD']) !== head) return { ok: false, regenError: 'une commande de regeneration a modifie l historique', results: [] };
      const changed = changedPaths(dir);
      const bad = changed.filter((f) => !allowed.some((rx) => rx.test(f)));
      if (bad.length) return { ok: false, regenError: 'chemins non autorises modifies : ' + bad.slice(0, 5).join(', '), results: [] };
      if (changed.length) {
        git(dir, ['--literal-pathspecs', 'add', '--', ...changed]);
        git(dir, ['-c', 'user.name=Porte de fusion', '-c', 'user.email=porte-fusion@symphonee.invalid', 'commit', '--amend', '--no-edit']);
        // Only the allowed paths differ from the merge as it was before regeneration.
        const diff = rawSplit(execFileSync('git', ['diff', '--name-only', '-z', head, 'HEAD'], { cwd: dir, encoding: 'utf8' }));
        if (diff.some((f) => !allowed.some((rx) => rx.test(f)))) return { ok: false, regenError: 'le commit regenere touche des chemins non autorises', results: [] };
      }
    }
    const tree = git(dir, ['rev-parse', 'HEAD^{tree}']);
    // The tested merge commit itself (kept in the shared object store): a repo
    // without CI pushes exactly this commit, fast-forward only.
    const merge = git(dir, ['rev-parse', 'HEAD']);
    const lint = guard.diffLint(dir, base);
    if (lint.length) return { ok: false, lint, results: [], tree, merge };
    const r = { ...(await guard.runVerify(dir, repo.chain)), tree, merge };
    if (!r.ok) {
      // Was this check already red on the base? (stated in the message; still refused)
      const failed = r.results.find((x) => !x.ok);
      const cmd = repo.chain.find((c) => c.name === failed.name);
      const onBase = await withWorktree(repo, base, (bdir) => guard.runVerify(bdir, [cmd]));
      failed.preexisting = !onBase.ok;
    }
    return r;
  });
}
async function openRevert(repo, m) {
  const branch = 'revert/porte-fusion-pr-' + m.pr;
  await withWorktree(repo, 'origin/' + repo.base, async (dir) => {
    git(dir, ['-c', 'user.name=Porte de fusion', '-c', 'user.email=porte-fusion@symphonee.invalid', 'revert', '-m', '1', '--no-edit', m.sha]);
    git(dir, ['push', 'origin', 'HEAD:refs/heads/' + branch]);
  });
  const pr = await api('POST', '/api/github/pulls/create', { repo: repo.github, head: branch, base: repo.base,
    title: 'Annulation de la fusion automatique #' + m.pr + ' (CI rouge)',
    body: 'Ouverte par la porte de fusion apres une CI rouge sur ' + repo.base + '. **Non fusionnee automatiquement** : a valider par un humain.' });
  return pr && pr.url;
}
// Sentry sends still in flight; awaited before the explicit exit below.
const pendingSends = [];
function notify(level, message, fingerprint, extra = {}) {
  if (ESSAI) return log('MESSAGE ' + level + ' : ' + message);
  pendingSends.push(sentry.event({ message, level, loop: 'porte-fusion', fingerprint, extra }).then((r) => { if (!r.ok) log('Sentry : ' + (r.error || r.skipped)); }));
}

async function main() {
  let policy;
  try { policy = JSON.parse(fs.readFileSync(POLICY, 'utf8')); } catch (e) { log('ARRET politique illisible ' + POLICY + ' : ' + e.message); process.exitCode = 1; return; }
  if (ESSAI) return dryRun(policy);
  // One pass at a time (the job never overlaps, but a manual run could). A lock
  // only counts while its process is alive: a pass killed by the system (low
  // memory, reboot) must not block the gate.
  try {
    const holder = Number(fs.readFileSync(LOCK, 'utf8'));
    let alive = false;
    try { if (holder && holder !== process.pid) { process.kill(holder, 0); alive = true; } } catch (_) {}
    if (alive && Date.now() - fs.statSync(LOCK).mtimeMs < 6 * 3600000) { log('EN_COURS le passage ' + holder + ' tient le verrou'); return; }
    if (!alive) log('verrou orphelin du passage ' + holder + ' retire');
  } catch (_) {}
  fs.writeFileSync(LOCK, String(process.pid));
  cleanupLeftovers(policy);
  const t0 = Date.now();
  const ci = await sentry.checkIn({ slug: 'porte-fusion', status: 'in_progress', monitor: { schedule: { type: 'interval', value: 30, unit: 'minute' }, margin: 30, maxRuntime: 240 } });
  let state = {};
  try { state = JSON.parse(fs.readFileSync(STATE, 'utf8')); } catch (_) {}
  let failed = null;
  try {
    await gate.pass(policy, state, { git, api, runChain, openRevert, notify, log, readPilot, isAncestor,
      now: () => Date.now(), stopFileExists: () => fs.existsSync(STOP) });
  } catch (e) { failed = e; log('ERREUR ' + e.stack); notify('error', 'Porte de fusion : erreur interne : ' + e.message, ['porte-fusion', 'erreur-interne']); }
  finally {
    fs.writeFileSync(STATE, JSON.stringify(state, null, 2));
    try { fs.unlinkSync(LOCK); } catch (_) {}
    await sentry.checkIn({ slug: 'porte-fusion', status: failed ? 'error' : 'ok', checkInId: ci.checkInId, durationSec: (Date.now() - t0) / 1000 });
  }
  const open = Object.values(state.candidates || {}).filter((c) => !['refused', 'confirmed'].includes(c.status));
  log('FIN ' + (state.stopped ? 'ARRETEE (' + state.stopped.reason + ') ' : '') + open.length + ' candidate(s) en cours : '
    + open.map((c) => c.branch + '=' + c.status).join(', '));
  if (failed) process.exitCode = 1;
}

async function dryRun(policy) {
  for (const repo of policy.repos) {
    const baseSha = git(repo.path, ['rev-parse', 'origin/' + repo.base]);
    log(repo.name + ' : base origin/' + repo.base + ' ' + baseSha.slice(0, 8) + ' ; marqueur de gouvernance '
      + (git(repo.path, ['show', 'origin/' + repo.base + ':' + repo.governanceMarker.file]).includes(repo.governanceMarker.text) ? 'PRESENT' : 'ABSENT (fusion en attente)'));
    for (const c of await gate.discover(repo, { git, api, readPilot, log })) {
      if (isAncestor(repo.path, c.sha, baseSha)) { log('deja dans ' + repo.base + ' : ' + c.branch); continue; }
      const source = repo.sources.find((s) => s.type === c.source);
      const mb = git(repo.path, ['merge-base', baseSha, c.sha]);
      const ev = gate.evaluateDiff({ numstat: gate.parseNumstat(git(repo.path, ['diff', '--numstat', mb, c.sha])),
        status: gate.parseNameStatus(git(repo.path, ['diff', '--name-status', mb, c.sha])),
        addedLines: gate.parseAddedLines(git(repo.path, ['diff', '--unified=0', mb, c.sha])) }, repo, source);
      const reasons = [...gate.proofReasons(c, repo, { git }, source), ...ev.reasons];
      log(c.branch + ' ' + c.sha.slice(0, 8) + ' [' + c.source + '] code ' + ev.stats.codeLines + ' lignes / ' + ev.stats.codeFiles + ' fichiers : '
        + (reasons.length ? 'REFUSERAIT : ' + reasons.join(' ; ') : 'passerait aux regles 3-6, puis chaine complete, PR, CI'));
    }
  }
}

// Exit explicitly once the work and the Sentry sends are done: a lingering
// handle (a keep-alive socket, a child's pipe) otherwise kept the process
// alive for hours, so the job stayed "running" and skipped its 30 min passes.
if (require.main === module) {
  main().catch((e) => { log('ERREUR ' + e.stack); process.exitCode = 1; try { fs.unlinkSync(LOCK); } catch (_) {} })
    .then(() => Promise.allSettled(pendingSends))
    .then(() => process.exit(process.exitCode || 0));
}
module.exports = { runChain, changedPaths };
