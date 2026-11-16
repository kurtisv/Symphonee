'use strict';
// MANUAL, reversible installation of the local Qwen developer into a running Symphonee checkout.
//   node qwen-repo-install.manual.js status   <liveDir>
//   node qwen-repo-install.manual.js verify   <liveDir>            compare every installed runtime file with this branch (read-only)
//   node qwen-repo-install.manual.js install  <liveDir>            first installation
//   node qwen-repo-install.manual.js update   <liveDir> [--dry-run] incremental update of an existing installation
//   node qwen-repo-install.manual.js rollback <liveDir>            undo the latest installation or update (they stack)
// Copies only the runtime files this branch adds or changes (no tests, manual scripts, docs or data). It refuses to overwrite a file
// unless that file is still exactly what was installed before (or what origin/master has, on a first install): nothing local is lost.
// Every overwritten file is backed up first and each step has a manifest. `install` also sets QwenRepo.enabled in config/config.json and
// `qwen: { enabled: true }` in the pilot definitions of .symphonee/mind-autopilots.json; schedules, goals, checks, enabled flags, pilot state
// files, lessons and Mind data are never touched. A running Symphonee keeps the old code until it is restarted; nothing starts by itself.
const fs = require('node:fs'), path = require('node:path'), cp = require('node:child_process');

const SRC = path.resolve(__dirname, '..', '..');
const [cmd, liveArg, ...flags] = process.argv.slice(2);
if (!['status', 'verify', 'install', 'update', 'rollback'].includes(cmd) || !liveArg) { process.stderr.write('usage: status|verify|install|update [--dry-run]|rollback <liveDir>\n'); process.exit(2); }
const DRY = flags.includes('--dry-run');
const LIVE = path.resolve(liveArg);
const git = (...a) => cp.execFileSync('git', a, { cwd: SRC, encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
const gitBuf = (...a) => cp.execFileSync('git', a, { cwd: SRC, windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
const BACKUPS = path.join(LIVE, '.symphonee', 'backups');
const NEVER = new Set(['dashboard/orchestrator/local-providers.js', 'dashboard/orchestrator/routes.js']); // the live copies carry other local work
const runtime = (f) => /^dashboard\/(mind|orchestrator)\/[^/]+\.js$|^dashboard\/orchestrator\.js$/.test(f) && !/\.(test|manual)\.js$/.test(f) && !/probe\.js$/.test(f) && !/test-kit\.js$/.test(f) && !NEVER.has(f);
const readJson = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
const writeJson = (f, o, indent) => fs.writeFileSync(f, JSON.stringify(o, null, indent) + '\n');
const indentOf = (f) => { const m = /^\{\r?\n( +)"/.exec(fs.readFileSync(f, 'utf8')); return m ? m[1].length : 2; };
const out = (o) => process.stdout.write(JSON.stringify(o, null, 1) + '\n');

// All manifests of this installation, oldest first, with the ones already rolled back marked.
function manifests() {
  if (!fs.existsSync(BACKUPS)) return [];
  const list = [];
  for (const d of fs.readdirSync(BACKUPS).filter((x) => /^qwen-(install|update)-/.test(x))) {
    const m = path.join(BACKUPS, d, 'manifest.json'); if (!fs.existsSync(m)) continue;
    const j = readJson(m); list.push({ dir: path.join(BACKUPS, d), type: j.type || 'install', ...j });
  }
  return list.sort((a, b) => String(a.at).localeCompare(String(b.at)));
}
const active = () => manifests().filter((m) => !m.rolledBack);
const saveManifest = (m) => { const { dir, ...rest } = m; fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(rest, null, 1)); };

function target() { // the runtime files this branch adds or changes relative to master
  // Relative to the common ancestor: files that master gained after this branch last merged it are not "deletions" of this branch.
  const base = git('merge-base', 'origin/master', 'HEAD').trim();
  const changes = git('diff', '--name-status', base, 'HEAD').split('\n').filter(Boolean).map((l) => l.split('\t')).filter(([, f]) => runtime(f));
  const bad = changes.filter(([s]) => !['M', 'A'].includes(s)); if (bad.length) throw new Error('Unsupported change kinds: ' + JSON.stringify(bad));
  return { base, files: changes.map(([s, f]) => ({ status: s, file: f })) };
}
// What the live copy of a file must be for it to be safe to overwrite: what we installed last, else master's version.
function expectedLive(f, status, chain) {
  const last = [...chain].reverse().find((m) => [...(m.modified || []), ...(m.added || [])].includes(f));
  if (last) return { buf: gitBuf('show', last.head + ':' + f), why: 'installed at ' + last.head.slice(0, 10) };
  if (status === 'M') return { buf: gitBuf('show', 'origin/master:' + f), why: 'origin/master' };
  return { buf: null, why: 'absent' };
}
function classify(chain) {
  const { files } = target(), rows = [];
  for (const { status, file } of files) {
    const livePath = path.join(LIVE, file), exists = fs.existsSync(livePath), want = gitBuf('show', 'HEAD:' + file);
    if (exists && fs.readFileSync(livePath).equals(want)) { rows.push({ file, state: 'identical' }); continue; }
    const exp = expectedLive(file, status, chain);
    if (!exists) { rows.push({ file, state: exp.buf === null || status === 'A' ? 'add' : 'missing-live' }); continue; }
    rows.push({ file, state: exp.buf && fs.readFileSync(livePath).equals(exp.buf) ? 'update' : 'CONFLICT', expected: exp.why });
  }
  return rows;
}
function checkLoads(files) {
  const bad = [];
  for (const f of files) { const r = cp.spawnSync(process.execPath, ['--check', path.join(LIVE, f)], { encoding: 'utf8' }); if (r.status !== 0) bad.push(f + ': ' + r.stderr.slice(0, 200)); }
  const load = cp.spawnSync(process.execPath, ['-e', "require('./dashboard/mind/autopilot.js');require('./dashboard/orchestrator/spawn-qwen-repo.js');console.log('loads')"], { cwd: LIVE, encoding: 'utf8' });
  return { syntaxErrors: bad, loads: load.status === 0 ? load.stdout.trim() : load.stderr.slice(0, 300), ok: !bad.length && load.status === 0 };
}

if (cmd === 'status') {
  const cfg = readJson(path.join(LIVE, 'config', 'config.json')), defs = readJson(path.join(LIVE, '.symphonee', 'mind-autopilots.json')).pilots;
  out({ steps: manifests().map((m) => ({ type: m.type, at: m.at, head: m.head && m.head.slice(0, 10), files: (m.modified || []).length + (m.added || []).length, rolledBack: m.rolledBack || null })),
    configQwenRepo: cfg.QwenRepo || null, pilots: Object.fromEntries(Object.entries(defs).map(([k, v]) => [k, { qwen: v.qwen || null, schedule: v.schedule || null }])) });
  process.exit(0);
}

if (cmd === 'verify') {
  const rows = classify(active()), head = git('rev-parse', 'HEAD').trim();
  const tally = rows.reduce((a, r) => { a[r.state] = (a[r.state] || 0) + 1; return a; }, {});
  out({ branchHead: head, files: rows.length, tally, differing: rows.filter((r) => r.state !== 'identical') });
  process.exit(rows.every((r) => r.state === 'identical') ? 0 : 1);
}

if (cmd === 'install') {
  if (active().length) { process.stderr.write('Already installed; use update, or roll back first.\n'); process.exit(1); }
  git('fetch', '-q', 'origin');
  if (git('status', '--porcelain').trim()) { process.stderr.write('The source checkout has uncommitted changes; commit first so that what is installed is what is on the branch.\n'); process.exit(1); }
  const rows = classify([]), head = git('rev-parse', 'HEAD').trim();
  const problems = rows.filter((r) => ['CONFLICT', 'missing-live'].includes(r.state)).map((r) => r.state + ': ' + r.file + (r.expected ? ' (live is not ' + r.expected + ')' : ''));
  if (problems.length) { process.stderr.write('Refused, nothing changed:\n- ' + problems.join('\n- ') + '\n'); process.exit(1); }
  const todo = rows.filter((r) => ['add', 'update'].includes(r.state)), modified = todo.filter((r) => r.state === 'update').map((r) => r.file), added = todo.filter((r) => r.state === 'add').map((r) => r.file);
  const at = new Date().toISOString().replace(/[:.]/g, '-'), dir = path.join(BACKUPS, 'qwen-install-' + at); fs.mkdirSync(dir, { recursive: true });
  const m = { type: 'install', at, head, branch: git('branch', '--show-current').trim(), modified, added, config: {}, pilots: {} };
  for (const f of modified) { const dst = path.join(dir, f); fs.mkdirSync(path.dirname(dst), { recursive: true }); fs.copyFileSync(path.join(LIVE, f), dst); }
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(m, null, 1));
  for (const f of [...modified, ...added]) { const dst = path.join(LIVE, f); fs.mkdirSync(path.dirname(dst), { recursive: true }); fs.writeFileSync(dst, gitBuf('show', 'HEAD:' + f)); }
  const cfgFile = path.join(LIVE, 'config', 'config.json'), cfg = readJson(cfgFile), ci = indentOf(cfgFile);
  m.config.QwenRepoBefore = 'QwenRepo' in cfg ? cfg.QwenRepo : null; cfg.QwenRepo = { ...(cfg.QwenRepo || {}), enabled: true }; writeJson(cfgFile, cfg, ci);
  const pf = path.join(LIVE, '.symphonee', 'mind-autopilots.json'), defs = readJson(pf), pi = indentOf(pf);
  for (const [id, def] of Object.entries(defs.pilots)) { m.pilots[id] = 'qwen' in def ? def.qwen : null; def.qwen = { ...(def.qwen || {}), enabled: true }; }
  writeJson(pf, defs, pi);
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(m, null, 1));
  const chk = checkLoads([...modified, ...added]);
  out({ installed: true, head, backup: dir, modified: modified.length, added: added.length, ...chk, restartRequired: true });
  process.exit(chk.ok ? 0 : 1);
}

if (cmd === 'update') {
  const chain = active();
  if (!chain.length) { process.stderr.write('No installation to update; use install.\n'); process.exit(1); }
  git('fetch', '-q', 'origin');
  if (git('status', '--porcelain').trim()) { process.stderr.write('The source checkout has uncommitted changes; commit first.\n'); process.exit(1); }
  const rows = classify(chain), head = git('rev-parse', 'HEAD').trim();
  const conflicts = rows.filter((r) => ['CONFLICT', 'missing-live'].includes(r.state));
  const todo = rows.filter((r) => ['add', 'update'].includes(r.state));
  const plan = { branchHead: head, previousHead: chain[chain.length - 1].head, identical: rows.filter((r) => r.state === 'identical').length, willUpdate: todo.filter((r) => r.state === 'update').map((r) => r.file), willAdd: todo.filter((r) => r.state === 'add').map((r) => r.file), conflicts };
  if (conflicts.length) { process.stderr.write('Refused, nothing changed: a live file was modified since it was installed.\n'); out(plan); process.exit(1); }
  if (DRY || !todo.length) { out({ ...plan, dryRun: DRY, nothingToDo: !todo.length }); process.exit(0); }
  const at = new Date().toISOString().replace(/[:.]/g, '-'), dir = path.join(BACKUPS, 'qwen-update-' + at); fs.mkdirSync(dir, { recursive: true });
  const m = { type: 'update', at, head, branch: git('branch', '--show-current').trim(), modified: plan.willUpdate, added: plan.willAdd, previousHead: plan.previousHead };
  for (const f of plan.willUpdate) { const dst = path.join(dir, f); fs.mkdirSync(path.dirname(dst), { recursive: true }); fs.copyFileSync(path.join(LIVE, f), dst); }
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(m, null, 1));
  for (const f of [...plan.willUpdate, ...plan.willAdd]) { const dst = path.join(LIVE, f); fs.mkdirSync(path.dirname(dst), { recursive: true }); fs.writeFileSync(dst, gitBuf('show', 'HEAD:' + f)); }
  const chk = checkLoads([...plan.willUpdate, ...plan.willAdd]);
  out({ ...plan, updated: true, backup: dir, ...chk, restartRequired: true });
  process.exit(chk.ok ? 0 : 1);
}

if (cmd === 'rollback') {
  const chain = active(); if (!chain.length) { process.stderr.write('Nothing to roll back.\n'); process.exit(1); }
  const m = chain[chain.length - 1];
  for (const f of m.modified || []) fs.copyFileSync(path.join(m.dir, f), path.join(LIVE, f));
  for (const f of m.added || []) fs.rmSync(path.join(LIVE, f), { force: true });
  if (m.type === 'install') {
    const cfgFile = path.join(LIVE, 'config', 'config.json'), cfg = readJson(cfgFile);
    if (m.config.QwenRepoBefore === null) delete cfg.QwenRepo; else cfg.QwenRepo = m.config.QwenRepoBefore; writeJson(cfgFile, cfg, indentOf(cfgFile));
    const pf = path.join(LIVE, '.symphonee', 'mind-autopilots.json'), defs = readJson(pf);
    for (const [id, before] of Object.entries(m.pilots)) if (defs.pilots[id]) { if (before === null) delete defs.pilots[id].qwen; else defs.pilots[id].qwen = before; }
    writeJson(pf, defs, indentOf(pf));
  }
  m.rolledBack = new Date().toISOString(); saveManifest(m);
  out({ rolledBack: m.type, restored: (m.modified || []).length, removed: (m.added || []).length, remainingSteps: active().length, restartRequired: true });
}
