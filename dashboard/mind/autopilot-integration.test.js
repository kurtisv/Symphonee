'use strict';
// End-to-end Mind autopilot loop against the REAL Orchestrator, real Git
// worktrees and FAKE Claude/Codex processes (no network, no paid tokens).
// The fake CLIs are scripted by stage; their argv is recorded so the test can
// prove the permission flags each stage really receives.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const { execFileSync } = require('child_process');
const { MindAutopilot } = require('./autopilot');

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const gitc = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

const plan = (title) => JSON.stringify({ decision: 'TASK', category: 'testing', title,
  objective: 'Add a regression test for the run() helper return value',
  evidence: ['index.js:2 carries a TODO asking for coverage of run()'],
  acceptance: ['node --test passes with the new test'] });

function setup({ planVerdicts = ['FAIL', 'PASS'], codeVerdicts = ['FAIL', 'PASS'], tamper = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sym-autopilot-e2e-'));
  const repo = path.join(root, 'demo');
  fs.mkdirSync(repo);
  gitc(repo, 'init', '-q');
  fs.writeFileSync(path.join(repo, 'index.js'), 'function run() { return true; }\n// TODO: add coverage\nmodule.exports = { run };\n');
  gitc(repo, 'add', '.');
  gitc(repo, '-c', 'user.name=T', '-c', 'user.email=t@example.invalid', 'commit', '-qm', 'init');

  const { Orchestrator } = require('../orchestrator');
  // Global permission mode "bypass": read-only stages must NOT inherit it.
  const config = { Permissions: { mode: 'bypass' }, AiApiKeys: {} };
  const orch = new Orchestrator({ terminals: new Map(), broadcast: () => {},
    workspaceDir: fs.mkdtempSync(path.join(os.tmpdir(), 'sym-autopilot-ws-')), getConfig: () => config });
  orch._pretrust = () => {};
  orch.saveTaskToMind = null;
  const spawns = [];
  const pv = [...planVerdicts], cv = [...codeVerdicts];
  orch._spawnImpl = (command, args, opts) => {
    const proc = new EventEmitter();
    let prompt = '';
    proc.stdin = { write(s) { prompt += s; }, end() {
      const cli = String(command).replace(/["']/g, '').replace(/\.cmd$/, '').split(/[\\/]/).pop();
      const rec = { cli, args: [...args], cwd: opts.cwd, prompt };
      spawns.push(rec);
      let out = '', err = '';
      const claudeJson = (result) => JSON.stringify({ type: 'result', is_error: false, result,
        usage: { input_tokens: 400, cache_creation_input_tokens: 100, cache_read_input_tokens: 9000, output_tokens: 50 } });
      if (/READ-ONLY independent work discovery/.test(prompt)) {
        rec.stage = 'discover';
        out = claudeJson(/previous plan was REJECTED/.test(prompt) ? plan('Add run() regression test (revised)') : plan('Add run() regression test'));
      } else if (/adversarial PLAN review/.test(prompt)) {
        rec.stage = 'plan-review'; out = 'VERDICT: ' + pv.shift() + '\nfindings'; err = 'tokens used\n1,500\n';
      } else if (/Claude implementer in ISOLATED/.test(prompt)) {
        rec.stage = 'implement';
        fs.writeFileSync(path.join(opts.cwd, 'index.test.js'), "require('./index');\n");
        out = claudeJson('implemented');
      } else if (/adversarial CODE review/.test(prompt)) {
        rec.stage = 'code-review';
        if (tamper) fs.writeFileSync(path.join(opts.cwd, 'sneaky.js'), '1;\n');
        out = 'VERDICT: ' + cv.shift() + '\ntests run'; err = 'tokens used\n2,000\n';
      } else if (/corrective implementer/.test(prompt)) {
        rec.stage = 'repair';
        fs.appendFileSync(path.join(opts.cwd, 'index.test.js'), "// assert run() === true\n");
        out = claudeJson('repaired');
      }
      setImmediate(() => { proc.stdout.emit('data', Buffer.from(out)); if (err) proc.stderr.emit('data', Buffer.from(err)); proc.emit('close', 0); });
    } };
    proc.stdout = new EventEmitter(); proc.stderr = new EventEmitter(); proc.kill = () => {};
    return proc;
  };
  const pilot = new MindAutopilot({ repoRoot: root, orchestrator: orch,
    getUiContext: () => ({ activeRepo: 'demo', activeSpace: '_global' }),
    getRepoPath: () => repo, getRepos: () => ({ demo: repo }), autoTimer: false });
  return { root, repo, orch, pilot, spawns,
    cleanup() { pilot.close(); try { gitc(repo, 'worktree', 'prune'); } catch (_) {} fs.rmSync(root, { recursive: true, force: true }); } };
}

async function drive(pilot, maxTicks = 60) {
  for (let i = 0; i < maxTicks && pilot.state.enabled && pilot.state.active; i++) {
    await sleep(25);
    await pilot.tick();
  }
}

test('full loop: plan rejected then revised, code rejected then repaired, worktree kept, limits respected', async () => {
  const f = setup();
  try {
    const headBefore = gitc(f.repo, 'rev-parse', 'HEAD');
    f.pilot.configure({ enabled: true, goal: 'Improve test coverage', allowWorktreeWrites: true });
    await drive(f.pilot);
    const s = f.pilot.snapshot();
    assert.equal(s.error, null, 'no error: ' + s.error);
    assert.deepEqual(f.spawns.map(x => x.stage),
      ['discover', 'plan-review', 'discover', 'plan-review', 'implement', 'code-review', 'repair', 'code-review']);
    const last = s.history[0];
    assert.equal(last.outcome, 'completed');
    assert.equal(last.title, 'Add run() regression test (revised)');
    assert.equal(last.planRevisions, 1);
    assert.equal(last.repairs, 1);

    // Permission flags per stage, despite the global bypass mode.
    for (const sp of f.spawns) {
      const yolo = sp.args.includes('--dangerously-skip-permissions') || sp.args.includes('--dangerously-bypass-approvals-and-sandbox');
      if (sp.stage === 'implement' || sp.stage === 'repair') assert.equal(yolo, true, sp.stage + ' is elevated');
      else assert.equal(yolo, false, sp.stage + ' must not be elevated');
    }
    const disc = f.spawns[0];
    assert.ok(disc.args.includes('--disallowedTools') && disc.args.includes('Edit') && disc.args.includes('Write'));
    assert.ok(disc.args.includes('--output-format') && disc.args.includes('json'));
    const pr = f.spawns[1];
    assert.equal(pr.args[pr.args.indexOf('--sandbox') + 1], 'read-only');
    const cr = f.spawns[5];
    assert.equal(cr.args[cr.args.indexOf('--sandbox') + 1], 'workspace-write');
    assert.match(disc.prompt, /^READ-ONLY/, 'compact context: no Mind/skills/ledger preamble');

    // Isolation: work happened in a separate worktree; main checkout untouched.
    const wt = last.worktree.path;
    assert.notEqual(path.resolve(wt), path.resolve(f.repo));
    assert.ok(fs.existsSync(path.join(wt, 'index.test.js')), 'worktree retained for human review');
    assert.equal(fs.existsSync(path.join(f.repo, 'index.test.js')), false);
    assert.equal(gitc(f.repo, 'rev-parse', 'HEAD'), headBefore);
    assert.equal(gitc(f.repo, 'status', '--porcelain'), '');
    assert.match(last.worktree.branch, /^mind-autopilot\//);
    assert.ok(f.spawns.filter(x => x.stage === 'implement' || x.stage === 'repair').every(x => path.resolve(x.cwd) === path.resolve(wt)));

    // Budget: 8 metered calls, separated by provider, exact because every CLI reported usage.
    assert.equal(s.budget.calls, 8);
    assert.equal(s.budget.byProvider.claude.calls, 4);
    assert.equal(s.budget.byProvider.codex.calls, 4);
    assert.equal(s.budget.unmeteredCalls, 0);
    assert.equal(s.budget.tokenUsageExact, true);
    assert.equal(s.budget.byProvider.claude.measuredTokens, 4 * 550);
    assert.equal(s.budget.byProvider.claude.cacheReadTokens, 4 * 9000);
    assert.equal(s.budget.byProvider.codex.measuredTokens, 1500 * 2 + 2000 * 2);
    // Both daily discoveries are spent: the pilot now reports quota and does not start a third.
    assert.equal(s.today.discoveries, 2);
    assert.equal(s.status, 'quota');
    f.pilot.state.nextAt = 0;
    await f.pilot.tick();
    assert.equal(f.spawns.length, 8, 'no further launch once the discovery quota is spent');
  } finally { f.cleanup(); }
});

test('a reviewer that edits the worktree voids the review and halts', async () => {
  const f = setup({ planVerdicts: ['PASS'], codeVerdicts: ['PASS'], tamper: true });
  try {
    f.pilot.configure({ enabled: true, goal: 'Improve test coverage', allowWorktreeWrites: true });
    await drive(f.pilot);
    const s = f.pilot.snapshot();
    assert.equal(s.enabled, false);
    assert.match(s.error, /modified the worktree/);
    assert.equal(s.status, 'interrupted');
    assert.equal(s.history.filter(h => h.outcome === 'completed').length, 0);
  } finally { f.cleanup(); }
});

test('plan rejected twice stops the task after one revision', async () => {
  const f = setup({ planVerdicts: ['FAIL', 'FAIL'] });
  try {
    f.pilot.configure({ enabled: true, goal: 'Improve test coverage', allowWorktreeWrites: true });
    await drive(f.pilot);
    const s = f.pilot.snapshot();
    assert.deepEqual(f.spawns.map(x => x.stage), ['discover', 'plan-review', 'discover', 'plan-review']);
    assert.match(s.error, /Plan rejected after the allowed revision/);
    assert.equal(s.history[0].outcome, 'plan-rejected');
    assert.equal(f.spawns.some(x => x.stage === 'implement'), false, 'no implementation without an approved plan');
  } finally { f.cleanup(); }
});
