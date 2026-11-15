'use strict';
// MANUAL, reversible installation of the local Qwen developer into a running Symphonee checkout.
//   node qwen-repo-install.manual.js status   <liveDir>
//   node qwen-repo-install.manual.js install  <liveDir>
//   node qwen-repo-install.manual.js rollback <liveDir>
// Copies only the runtime files this branch adds or changes (no tests, manual scripts, docs or data), after proving that
// each file it would overwrite is still exactly what origin/master has (nothing local is lost). Every overwritten file is
// backed up first; a manifest records what to undo. It also sets QwenRepo.enabled in config/config.json and
// `qwen: { enabled: true }` in the pilot definitions of .symphonee/mind-autopilots.json (schedules, goals, checks and the
// enabled flags are not touched). A running Symphonee keeps the old code until it is restarted; nothing starts by itself.
const fs = require('node:fs'), path = require('node:path'), cp = require('node:child_process');

const SRC = path.resolve(__dirname, '..', '..');
const [cmd, liveArg] = process.argv.slice(2);
if (!['status', 'install', 'rollback'].includes(cmd) || !liveArg) { process.stderr.write('usage: status|install|rollback <liveDir>\n'); process.exit(2); }
const LIVE = path.resolve(liveArg);
const git = (...a) => cp.execFileSync('git', a, { cwd: SRC, encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
const gitBuf = (...a) => cp.execFileSync('git', a, { cwd: SRC, windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
const BACKUPS = path.join(LIVE, '.symphonee', 'backups');
const NEVER = new Set(['dashboard/orchestrator/local-providers.js', 'dashboard/orchestrator/routes.js']); // the live copies carry other local work
const runtime = (f) => /^dashboard\/(mind|orchestrator)\/[^/]+\.js$|^dashboard\/orchestrator\.js$/.test(f) && !/\.(test|manual)\.js$/.test(f) && !/probe\.js$/.test(f) && !NEVER.has(f);

function latestManifest() {
  if (!fs.existsSync(BACKUPS)) return null;
  const dirs = fs.readdirSync(BACKUPS).filter((d) => d.startsWith('qwen-install-')).sort();
  for (const d of dirs.reverse()) { const m = path.join(BACKUPS, d, 'manifest.json'); if (fs.existsSync(m)) { const j = JSON.parse(fs.readFileSync(m, 'utf8')); if (!j.rolledBack) return { dir: path.join(BACKUPS, d), ...j }; } }
  return null;
}
const readJson = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
const writeJson = (f, o, indent) => fs.writeFileSync(f, JSON.stringify(o, null, indent) + '\n');
const indentOf = (f) => { const m = /^\{\r?\n( +)"/.exec(fs.readFileSync(f, 'utf8')); return m ? m[1].length : 2; };

if (cmd === 'status') {
  const m = latestManifest(); const cfg = readJson(path.join(LIVE, 'config', 'config.json'));
  const defs = readJson(path.join(LIVE, '.symphonee', 'mind-autopilots.json')).pilots;
  process.stdout.write(JSON.stringify({ installed: Boolean(m), manifest: m && { at: m.at, head: m.head, files: m.added.length + m.modified.length }, configQwenRepo: cfg.QwenRepo || null, pilots: Object.fromEntries(Object.entries(defs).map(([k, v]) => [k, { qwen: v.qwen || null, schedule: v.schedule || null }])) }, null, 1) + '\n');
  process.exit(0);
}

if (cmd === 'install') {
  if (latestManifest()) { process.stderr.write('Already installed; roll back first.\n'); process.exit(1); }
  git('fetch', '-q', 'origin');
  const head = git('rev-parse', 'HEAD').trim(), base = 'origin/master';
  if (git('status', '--porcelain').trim()) { process.stderr.write('The source checkout has uncommitted changes; commit first so that what is installed is what is on the branch.\n'); process.exit(1); }
  const changes = git('diff', '--name-status', base, 'HEAD').split('\n').filter(Boolean).map((l) => l.split('\t')).filter(([, f]) => runtime(f));
  const modified = changes.filter(([s]) => s === 'M').map(([, f]) => f), added = changes.filter(([s]) => s === 'A').map(([, f]) => f);
  const unsupported = changes.filter(([s]) => !['M', 'A'].includes(s));
  if (unsupported.length) { process.stderr.write('Unsupported change kinds: ' + JSON.stringify(unsupported) + '\n'); process.exit(1); }
  const problems = [];
  for (const f of modified) { const live = path.join(LIVE, f); if (!fs.existsSync(live)) problems.push('missing live: ' + f); else if (!gitBuf('show', base + ':' + f).equals(fs.readFileSync(live))) problems.push('live differs from origin/master (local work would be lost): ' + f); }
  for (const f of added) { const live = path.join(LIVE, f); if (fs.existsSync(live) && !gitBuf('show', 'HEAD:' + f).equals(fs.readFileSync(live))) problems.push('live already has a different file: ' + f); }
  if (problems.length) { process.stderr.write('Refused, nothing changed:\n- ' + problems.join('\n- ') + '\n'); process.exit(1); }
  const at = new Date().toISOString().replace(/[:.]/g, '-'), dir = path.join(BACKUPS, 'qwen-install-' + at);
  fs.mkdirSync(dir, { recursive: true });
  const manifest = { at, head, branch: git('branch', '--show-current').trim(), modified, added: added.filter((f) => !fs.existsSync(path.join(LIVE, f))), config: {}, pilots: {} };
  for (const f of modified) { const dst = path.join(dir, f); fs.mkdirSync(path.dirname(dst), { recursive: true }); fs.copyFileSync(path.join(LIVE, f), dst); }
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 1));
  for (const f of [...modified, ...added]) { const dst = path.join(LIVE, f); fs.mkdirSync(path.dirname(dst), { recursive: true }); fs.writeFileSync(dst, gitBuf('show', 'HEAD:' + f)); }
  // configuration: the feature flag and the pilots' opt-in; everything else is left as it is
  const cfgFile = path.join(LIVE, 'config', 'config.json'), cfg = readJson(cfgFile), ci = indentOf(cfgFile);
  manifest.config.QwenRepoBefore = 'QwenRepo' in cfg ? cfg.QwenRepo : null; cfg.QwenRepo = { ...(cfg.QwenRepo || {}), enabled: true }; writeJson(cfgFile, cfg, ci);
  const pf = path.join(LIVE, '.symphonee', 'mind-autopilots.json'), defs = readJson(pf), pi = indentOf(pf);
  for (const [id, def] of Object.entries(defs.pilots)) { manifest.pilots[id] = 'qwen' in def ? def.qwen : null; def.qwen = { ...(def.qwen || {}), enabled: true }; }
  writeJson(pf, defs, pi);
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 1));
  // the installed code must load
  const bad = [];
  for (const f of [...modified, ...added]) { const r = cp.spawnSync(process.execPath, ['--check', path.join(LIVE, f)], { encoding: 'utf8' }); if (r.status !== 0) bad.push(f + ': ' + r.stderr.slice(0, 200)); }
  const load = cp.spawnSync(process.execPath, ['-e', "require('./dashboard/mind/autopilot.js');require('./dashboard/orchestrator/spawn-qwen-repo.js');console.log('loads')"], { cwd: LIVE, encoding: 'utf8' });
  process.stdout.write(JSON.stringify({ installed: true, head, backup: dir, modified: modified.length, added: manifest.added.length, syntaxErrors: bad, loads: load.status === 0 ? load.stdout.trim() : load.stderr.slice(0, 300), restartRequired: true }, null, 1) + '\n');
  process.exit(bad.length || load.status !== 0 ? 1 : 0);
}

if (cmd === 'rollback') {
  const m = latestManifest(); if (!m) { process.stderr.write('Nothing to roll back.\n'); process.exit(1); }
  for (const f of m.modified) fs.copyFileSync(path.join(m.dir, f), path.join(LIVE, f));
  for (const f of m.added) fs.rmSync(path.join(LIVE, f), { force: true });
  const cfgFile = path.join(LIVE, 'config', 'config.json'), cfg = readJson(cfgFile);
  if (m.config.QwenRepoBefore === null) delete cfg.QwenRepo; else cfg.QwenRepo = m.config.QwenRepoBefore; writeJson(cfgFile, cfg, indentOf(cfgFile));
  const pf = path.join(LIVE, '.symphonee', 'mind-autopilots.json'), defs = readJson(pf);
  for (const [id, before] of Object.entries(m.pilots)) if (defs.pilots[id]) { if (before === null) delete defs.pilots[id].qwen; else defs.pilots[id].qwen = before; }
  writeJson(pf, defs, indentOf(pf));
  m.rolledBack = new Date().toISOString(); fs.writeFileSync(path.join(m.dir, 'manifest.json'), JSON.stringify({ at: m.at, head: m.head, branch: m.branch, modified: m.modified, added: m.added, config: m.config, pilots: m.pilots, rolledBack: m.rolledBack }, null, 1));
  process.stdout.write(JSON.stringify({ rolledBack: true, restored: m.modified.length, removed: m.added.length, restartRequired: true }, null, 1) + '\n');
}
