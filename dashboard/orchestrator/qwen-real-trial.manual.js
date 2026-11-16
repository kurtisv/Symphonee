'use strict';
// MANUAL trial of the local Qwen developer on a REAL repository task, in an isolated worktree.
//   node qwen-real-trial.manual.js <repoPath> <relative/file/to/test> <verify cmd...>
// Real: LM Studio (Qwen3.5-4B), real git worktree, real orchestrator task. No cloud call.
// It never touches the repository's checkout: the status of the main checkout is compared before and after.
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), cp = require('node:child_process'), crypto = require('node:crypto');
const { Orchestrator } = require('../orchestrator');

const [repoPath, target, ...verifyCmd] = process.argv.slice(2);
if (!repoPath || !target || !verifyCmd.length) { process.stderr.write('usage: <repoPath> <file> <verify command...>\n'); process.exit(2); }
const git = (cwd, ...a) => cp.execFileSync('git', a, { cwd, encoding: 'utf8', windowsHide: true }).trim();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const stamp = () => new Date().toISOString().replace(/[-:T]/g, '').slice(0, 12);

(async () => {
  const before = { status: git(repoPath, 'status', '--porcelain'), head: git(repoPath, 'rev-parse', 'HEAD'), branch: git(repoPath, 'branch', '--show-current') };
  const orch = new Orchestrator({ terminals: new Map(), broadcast: () => {}, workspaceDir: fs.mkdtempSync(path.join(os.tmpdir(), 'sym-trial-ws-')), getConfig: () => ({ QwenRepo: { enabled: true }, AiApiKeys: {} }) });
  orch.saveTaskToMind = null;
  const sessionFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sym-trial-sess-')), 'session.json');
  const events = [];
  const base = before.head;
  const t0 = Date.now();
  const task = orch.spawnQwenInWorktree({ repoPath, branch: 'qwen-trial/' + stamp() + '-' + crypto.randomBytes(2).toString('hex'), startPoint: base,
    task: { title: 'Add a unit test for ' + target, objective: 'The module ' + target + ' has no test. Write a node:test unit test file next to it (named ' + target.replace(/\.js$/, '.test.js') + ') that checks its exported behaviour with a few small, concrete inputs (read the module first and assert only what the code really does). Do not modify ' + target + '. Use only node:test and node:assert/strict.', files: [target] },
    verify: [{ name: 'unit-test', cmd: verifyCmd, timeoutMs: 120000 }], protectedPatterns: ['^secrets/', '(^|/)\\.env', '(^|/)package(-lock)?\\.json$', '^\\.github/'], skipDirs: [],
    memoryText: '', sessionFile, deadlineAt: Date.now() + 25 * 60000, from: 'qwen-real-trial', onEvent: (k, m) => events.push([Math.round((Date.now() - t0) / 1000), k, String(m).slice(0, 200)]) });
  while (['running', 'pending', 'queued'].includes(task.state)) await sleep(1000);
  const after = { status: git(repoPath, 'status', '--porcelain'), head: git(repoPath, 'rev-parse', 'HEAD'), branch: git(repoPath, 'branch', '--show-current') };
  const wt = task.worktree.path;
  const changed = git(wt, 'status', '--porcelain');
  const diff = git(wt, 'diff', '--no-color', '--stat');
  const files = changed.split('\n').filter(Boolean).map((l) => l.slice(3));
  const contents = Object.fromEntries(files.slice(0, 3).map((f) => [f, fs.readFileSync(path.join(wt, f), 'utf8').slice(0, 4000)]));
  const session = JSON.parse(fs.readFileSync(sessionFile, 'utf8'));
  const out = { state: task.state, error: task.error || null, result: task.result || null, seconds: Math.round((Date.now() - t0) / 1000), worktree: wt, branch: task.worktree.branch,
    mainCheckoutUnchanged: before.status === after.status && before.head === after.head && before.branch === after.branch, mainBranch: after.branch, mainHead: after.head.slice(0, 10),
    changedFiles: files, diffStat: diff, execution: task.execution, turns: session.turns, switches: session.switches, plan: session.plan, notes: session.notes, strategies: session.strategies, usage: session.usage, runs: session.runs.map((r) => ({ ok: r.ok, checks: r.results.map((x) => [x.name, x.ok, x.ms]) })),
    events: session.events.slice(-30), log: session.log, timeline: events.slice(-40), contents };
  process.stdout.write(JSON.stringify(out, null, 1) + '\n');
  process.exit(0);
})().catch((e) => { process.stderr.write(String(e.stack || e) + '\n'); process.exit(1); });
