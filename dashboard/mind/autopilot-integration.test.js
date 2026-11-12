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

function setup({ planVerdicts = ['FAIL', 'PASS'], codeVerdicts = ['FAIL', 'PASS'], tamper = false, escape = false, def = {}, id = 'default', protect = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sym-autopilot-e2e-'));
  const repo = path.join(root, 'demo');
  fs.mkdirSync(repo);
  gitc(repo, 'init', '-q');
  fs.writeFileSync(path.join(repo, 'index.js'), 'function run() { return true; }\n// TODO: add coverage\nmodule.exports = { run };\n');
  // A repository check that passes only once a repair created fixed.flag,
  // and a heavy ignored folder shared with worktrees through a junction.
  fs.writeFileSync(path.join(repo, 'check.js'), "process.exit(require('fs').existsSync('fixed.flag') ? 0 : 1);\n");
  fs.writeFileSync(path.join(repo, '.gitignore'), 'deps/\n');
  fs.mkdirSync(path.join(repo, 'deps'));
  fs.writeFileSync(path.join(repo, 'deps', 'lib.txt'), 'shared');
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
        if (escape) fs.writeFileSync(path.join(repo, 'escaped.js'), '1;\n');
        rec.sawDeps = fs.existsSync(path.join(opts.cwd, 'deps', 'lib.txt'));
        if (protect) { fs.mkdirSync(path.join(opts.cwd, 'secrets'), { recursive: true }); fs.writeFileSync(path.join(opts.cwd, 'secrets', 'key.txt'), 'x'); }
        out = claudeJson('implemented');
      } else if (/adversarial CODE review/.test(prompt)) {
        rec.stage = 'code-review';
        if (tamper) fs.writeFileSync(path.join(opts.cwd, 'sneaky.js'), '1;\n');
        out = 'VERDICT: ' + cv.shift() + '\ntests run'; err = 'tokens used\n2,000\n';
      } else if (/corrective implementer/.test(prompt)) {
        rec.stage = 'repair';
        fs.appendFileSync(path.join(opts.cwd, 'index.test.js'), "// assert run() === true\n");
        fs.writeFileSync(path.join(opts.cwd, 'fixed.flag'), '1');
        rec.sawDeps = fs.existsSync(path.join(opts.cwd, 'deps', 'lib.txt'));
        out = claudeJson('repaired');
      }
      setImmediate(() => { proc.stdout.emit('data', Buffer.from(out)); if (err) proc.stderr.emit('data', Buffer.from(err)); proc.emit('close', 0); });
    } };
    proc.stdout = new EventEmitter(); proc.stderr = new EventEmitter(); proc.kill = () => {};
    return proc;
  };
  const pilot = new MindAutopilot({ repoRoot: root, orchestrator: orch,
    getUiContext: () => ({ activeRepo: 'demo', activeSpace: '_global' }),
    getRepoPath: () => repo, getRepos: () => ({ demo: repo }), autoTimer: false, id, def });
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
      assert.equal(yolo, false, sp.stage + ' must never get skip-permissions/bypass');
      if (sp.stage === 'implement' || sp.stage === 'repair') {
        assert.equal(sp.args[sp.args.indexOf('--permission-mode') + 1], 'acceptEdits', sp.stage + ' edits confined to cwd');
        assert.ok(sp.args.some(a => /Bash\(git push:\*\)/.test(a)), 'push denied');
      }
    }
    const disc = f.spawns[0];
    assert.ok(disc.args.includes('--disallowedTools') && disc.args.includes('Edit') && disc.args.includes('Write'));
    assert.ok(disc.args.includes('--output-format') && disc.args.includes('json'));
    const pr = f.spawns[1];
    assert.equal(pr.args[pr.args.indexOf('--sandbox') + 1], 'read-only');
    const cr = f.spawns[5];
    assert.equal(cr.args[cr.args.indexOf('--sandbox') + 1], 'read-only');
    assert.match(disc.prompt, /^TARGET REPOSITORY: /, 'compact context: no Mind/skills/ledger preamble, repo pinned first');
    // Every stage pins its own directory and neutralises "work in the active repo" instructions.
    for (const sp of f.spawns) {
      assert.match(sp.prompt, /TARGET REPOSITORY: /, sp.stage + ' prompt pins the repository');
      assert.match(sp.prompt, /IGNORE those instructions/, sp.stage + ' prompt overrides repo-redirect instructions');
      if (sp.stage === 'code-review' || sp.stage === 'repair') assert.ok(sp.prompt.includes(sp.cwd), sp.stage + ' pins the worktree path');
      if (sp.stage === 'discover' || sp.stage === 'plan-review') assert.ok(sp.prompt.includes(f.repo), sp.stage + ' pins the repo path');
    }

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
    assert.equal(s.budget.byProvider.claude.measuredTokens, 4 * (550 + 9000), 'cache reads are charged');
    assert.equal(s.budget.byProvider.claude.cacheReadTokens, 4 * 9000);
    assert.equal(s.budget.byProvider.codex.measuredTokens, 1500 * 2 + 2000 * 2);
    // Once the daily discovery quota is spent the pilot reports quota and launches nothing.
    assert.equal(s.today.discoveries, 2);
    const { LIMITS } = require('./autopilot-budget');
    while (f.pilot.state.discoveryTimes.length < LIMITS.dailyDiscoveries) f.pilot.state.discoveryTimes.push(Date.now());
    f.pilot.state.nextAt = 0;
    assert.equal(f.pilot.snapshot().status, 'quota');
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

test('an implementer that writes into the main checkout is caught and halts', async () => {
  const f = setup({ planVerdicts: ['PASS'], escape: true });
  try {
    f.pilot.configure({ enabled: true, goal: 'Improve test coverage', allowWorktreeWrites: true });
    await drive(f.pilot);
    const s = f.pilot.snapshot();
    assert.equal(s.enabled, false);
    assert.match(s.error, /main checkout changed during implement/);
    assert.equal(f.spawns.some(x => x.stage === 'code-review'), false);
  } finally { f.cleanup(); }
});

// ── Deep profile (second loop) ──────────────────────────────────────────────
const DEEP = { profile: 'deep', label: 'Deep demo', verify: [{ name: 'check', cmd: ['node', 'check.js'], timeoutMs: 20000 }],
  linkDirs: ['deps'], protectedPaths: ['^secrets/', 'pleinsens'], governance: 'Classify risk R1/R2/R3; never propose R3. Record the lot file before coding.' };

test('deep loop: failed local verification repairs without a Codex call, two repairs allowed, junction removed', async () => {
  const f = setup({ planVerdicts: ['PASS'], codeVerdicts: ['FAIL', 'PASS'], def: DEEP, id: 'deep-demo' });
  try {
    f.pilot.configure({ enabled: true, goal: 'Improve correctness in depth', allowWorktreeWrites: true });
    await drive(f.pilot, 400);
    const s = f.pilot.snapshot();
    assert.equal(s.error, null, 'no error: ' + s.error);
    // implement -> verify FAILS -> repair (no review paid) -> verify passes -> review FAIL -> repair 2 -> verify -> review PASS
    assert.deepEqual(f.spawns.map(x => x.stage), ['discover', 'plan-review', 'implement', 'repair', 'code-review', 'repair', 'code-review']);
    const done = s.history[0];
    assert.equal(done.outcome, 'completed');
    assert.equal(done.repairs, 2, 'the deep profile allows two repairs');
    assert.deepEqual(done.verified, ['check']);
    assert.equal(s.profile, 'deep');
    assert.equal(s.limits.repairs, 2);
    assert.ok(s.pipeline.includes('verify'));
    // The first repair was triggered by Symphonee's own check, not by a reviewer.
    assert.match(f.spawns[3].prompt, /LOCAL VERIFICATION FAILED/);
    assert.match(f.spawns[3].prompt, /Check "check" failed/);
    // Deep prompts and protected paths reach every stage that needs them.
    assert.match(f.spawns[0].prompt, /Consider at least three distinct candidates/);
    assert.match(f.spawns[0].prompt, /PROTECTED PATHS/);
    assert.match(f.spawns[4].prompt, /Deep review\./);
    // Repository governance reaches every stage; the plan verdict reaches the implementer.
    for (const i of [0, 1, 2, 4]) assert.match(f.spawns[i].prompt, /REPOSITORY GOVERNANCE[\s\S]*never propose R3/, f.spawns[i].stage);
    assert.match(f.spawns[2].prompt, /INDEPENDENT CODEX PLAN REVIEW of this exact plan \(verdict PASS/);
    assert.match(f.spawns[2].prompt, /VERDICT: PASS\nfindings/, 'the reviewer text itself is passed on');
    assert.match(f.spawns[3].prompt, /INDEPENDENT CODEX PLAN REVIEW/, 'repair keeps the approved design context');
    assert.match(f.spawns[1].prompt, /CONDITIONS:/, 'plan review may pass with binding conditions');
    assert.match(f.spawns[4].prompt, /FAIL the change if any condition is not met/, 'code review checks the plan conditions');
    assert.match(f.spawns[4].prompt, /INDEPENDENT CODEX PLAN REVIEW/);
    assert.match(f.spawns[4].prompt, /They PASSED on the current worktree/);
    // Shared folder: linked right after the worktree is created (the fake CLI runs
    // synchronously inside the spawn, so it is observed at the repair stage),
    // gone afterwards, original intact.
    assert.equal(f.spawns[3].sawDeps, true);
    assert.equal(fs.existsSync(path.join(done.worktree.path, 'deps')), false, 'junction removed from the kept worktree');
    assert.equal(fs.readFileSync(path.join(f.repo, 'deps', 'lib.txt'), 'utf8'), 'shared');
    assert.equal(gitc(f.repo, 'status', '--porcelain'), '');
    // 7 launches, state kept in its own file.
    assert.equal(s.budget.calls, 7);
    assert.ok(fs.existsSync(path.join(f.root, '.symphonee', 'mind-autopilot-deep-demo.json')));
    assert.equal(fs.existsSync(path.join(f.root, '.symphonee', 'mind-autopilot.json')), false);
  } finally { f.cleanup(); }
});

test('deep loop: a change under a protected path halts before any review', async () => {
  const f = setup({ planVerdicts: ['PASS'], def: DEEP, id: 'deep-demo', protect: true });
  try {
    f.pilot.configure({ enabled: true, goal: 'Improve correctness in depth', allowWorktreeWrites: true });
    await drive(f.pilot, 200);
    const s = f.pilot.snapshot();
    assert.equal(s.enabled, false);
    assert.match(s.error, /Protected path modified during implement: secrets\/key\.txt/);
    assert.equal(f.spawns.some(x => x.stage === 'code-review'), false);
    assert.equal(fs.existsSync(path.join(s.active.worktree.path, 'deps')), false, 'junction removed on halt');
  } finally { f.cleanup(); }
});

test('deep loop: verification that keeps failing stops after the allowed repairs', async () => {
  const def = { ...DEEP, verify: [{ name: 'never', cmd: ['node', '-e', 'process.exit(3)'], timeoutMs: 20000 }] };
  const f = setup({ planVerdicts: ['PASS'], def, id: 'deep-demo' });
  try {
    f.pilot.configure({ enabled: true, goal: 'Improve correctness in depth', allowWorktreeWrites: true });
    await drive(f.pilot, 400);
    const s = f.pilot.snapshot();
    assert.match(s.error, /Local verification still failing after max repairs: never/);
    assert.deepEqual(f.spawns.map(x => x.stage), ['discover', 'plan-review', 'implement', 'repair', 'repair']);
    assert.equal(f.spawns.some(x => x.stage === 'code-review'), false, 'no Codex review is paid for code that does not pass its own checks');
  } finally { f.cleanup(); }
});

test('only one pilot runs a task at a time', async () => {
  const f = setup({ planVerdicts: ['PASS'], codeVerdicts: ['PASS'] });
  try {
    const second = new MindAutopilot({ repoRoot: f.root, orchestrator: f.orch, id: 'second', def: {},
      getUiContext: () => ({ activeRepo: 'demo' }), getRepoPath: () => f.repo, getRepos: () => ({ demo: f.repo }), autoTimer: false,
      peers: () => [f.pilot, second] });
    f.pilot.peers = () => [f.pilot, second];
    f.pilot.configure({ enabled: true, goal: 'Improve test coverage', allowWorktreeWrites: true });
    assert.equal(f.pilot.state.active.stage, 'discover');
    second.configure({ enabled: true, goal: 'Second loop', allowWorktreeWrites: true });
    await second.tick();
    assert.equal(second.state.active, null, 'second pilot waits while the first runs a task');
    assert.equal(f.spawns.length, 1);
    await drive(f.pilot, 200);
    assert.equal(f.pilot.snapshot().history[0].outcome, 'completed');
    await second.tick();
    assert.equal(second.state.active.stage, 'discover', 'second pilot starts once the first is idle');
    second.stop(); second.close();
  } finally { f.cleanup(); }
});

test('deep loop without check commands still passes through the diff-lint gate', async () => {
  const def = { profile: 'deep', label: 'No commands', protectedPaths: ['^secrets/'] };
  const f = setup({ planVerdicts: ['PASS'], codeVerdicts: ['PASS'], def, id: 'deep-nocmd' });
  try {
    f.pilot.configure({ enabled: true, goal: 'Improve correctness in depth', allowWorktreeWrites: true });
    await drive(f.pilot, 300);
    const s = f.pilot.snapshot();
    assert.equal(s.error, null, 'no error: ' + s.error);
    assert.ok(s.pipeline.includes('verify'));
    assert.equal(s.history[0].outcome, 'completed');
    assert.ok(s.events.some(e => /Local verification PASSED: diff lint/.test(e.msg)), 'the gate ran');
  } finally { f.cleanup(); }
});

test('deep loop: an interrupted task resumes from its kept worktree without new discovery or implementation', async () => {
  const f = setup({ planVerdicts: ['PASS'], codeVerdicts: ['PASS'], def: DEEP, id: 'deep-demo' });
  try {
    f.pilot.configure({ enabled: true, goal: 'Improve correctness in depth', allowWorktreeWrites: true });
    // implement -> verify fails (no fixed.flag) -> repair: stop as soon as the repair is dispatched.
    // The fake repair finishes almost at once, so stop as soon as it has been launched.
    for (let i = 0; i < 400 && !f.spawns.some(x => x.stage === 'repair'); i++) { await sleep(25); await f.pilot.tick(); }
    f.pilot.stop();
    assert.ok(['repair', 'verify'].includes(f.pilot.state.active.stage), 'stopped after the implementation: ' + f.pilot.state.active.stage);
    assert.equal(f.pilot.snapshot().status, 'interrupted');
    const wt = f.pilot.state.active.worktree.path;
    assert.equal(fs.existsSync(path.join(wt, 'deps')), false, 'junction removed on stop');
    const before = f.spawns.length;
    f.pilot.resume();
    assert.equal(f.pilot.snapshot().active.stage, 'verify');
    await drive(f.pilot, 400);
    const s = f.pilot.snapshot();
    assert.equal(s.error, null, 'no error: ' + s.error);
    assert.equal(s.history[0].outcome, 'completed');
    assert.equal(s.history[0].repairs, 1, 'repair counter kept across the resume');
    assert.deepEqual(f.spawns.slice(before).map(x => x.stage), ['code-review'], 'only the review is paid after the resume');
    assert.equal(f.spawns.filter(x => x.stage === 'discover' || x.stage === 'implement').length, 2);
    // The reviewer is told the local checks passed and that a sandbox cache error is not a defect.
    assert.match(f.spawns.at(-1).prompt, /NOT a reason to FAIL/);
    assert.match(f.spawns.at(-1).prompt, /They PASSED on the current worktree \(check \d+s\)/);
    assert.ok(s.events.some(e => /Resumed from the kept worktree/.test(e.msg)));
    assert.throws(() => f.pilot.resume(), /No interrupted implementation to resume|already running/);
  } finally { f.cleanup(); }
});
