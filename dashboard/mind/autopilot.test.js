'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { MindAutopilot, parsePlan, verdict, localTriage, WORK_CATEGORIES } = require('./autopilot');
const { LIMITS } = require('./autopilot-budget');
const completedToday = (at) => Array.from({ length: LIMITS.dailyCompletions }, () => ({ at, outcome: 'completed' }));

const goodPlan = { decision: 'TASK', category: 'correctness',
  title: 'Repair reproducible failure',
  objective: 'Fix an existing failing unit test with a minimal change',
  evidence: ['tests/feature.test.js fails with assertion on line 41'],
  acceptance: ['Run the identified test and confirm it passes'],
  baseline: null };

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'symphonee-autopilot-'));
  const repo = path.join(root, 'demo');
  fs.mkdirSync(repo, { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: repo });
  fs.writeFileSync(path.join(repo, 'index.js'), 'function run() { return true; }\n// TODO: add coverage\n');
  execFileSync('git', ['add', '.'], { cwd: repo });
  execFileSync('git', ['-c', 'user.name=Autopilot Test', '-c', 'user.email=autopilot@example.invalid',
    'commit', '-qm', 'Initialize test fixture'], { cwd: repo });
  const tasks = new Map();
  let counter = 0;
  const orch = {
    spawnHeadless(opts) {
      const t = { id: 'task-' + ++counter, state: 'running', result: null, opts };
      tasks.set(t.id, t);
      return t;
    },
    getTask(id) { return tasks.get(id) || null; },
    cancelTask(id) { const t = tasks.get(id); if (t) t.state = 'cancelled'; },
  };
  const pilot = new MindAutopilot({ repoRoot: root, orchestrator: orch,
    getUiContext: () => ({ activeRepo: 'demo', activeSpace: '_global' }),
    getRepoPath: () => repo, autoTimer: false });
  return { pilot, tasks, root, orch, cleanup() { pilot.close(); fs.rmSync(root, { recursive: true, force: true }); } };
}

test('planner JSON accepts only grounded structured TASK or NO_TASK', () => {
  assert.deepEqual(parsePlan(JSON.stringify(goodPlan)), goodPlan);
  assert.deepEqual(parsePlan('{"decision":"NO_TASK"}'), { decision: 'NO_TASK' });
  assert.equal(parsePlan('A task needs doing'), null);
  assert.equal(parsePlan('{"decision":"TASK","title":"x"}'), null);
});
test('autopilot recognizes quality, cleanup, performance and verification tasks', () => {
  assert.deepEqual(WORK_CATEGORIES, ['correctness', 'performance', 'quality', 'cleanup', 'testing']);
  for (const category of ['quality', 'cleanup', 'testing']) {
    const candidate = { ...goodPlan, category };
    assert.equal(parsePlan(JSON.stringify(candidate)).category, category);
  }
  const perf = { ...goodPlan, category: 'performance',
    title: 'Optimize the repository parser',
    objective: 'Reduce parser runtime with verified equivalent outputs',
    evidence: ['scripts/bench-parser.js reports 400ms per run under Node 22'],
    baseline: 'node scripts/bench-parser.js on Node 22: 400ms median across 30 runs' };
  assert.equal(parsePlan(JSON.stringify(perf)).baseline, perf.baseline);
  assert.equal(parsePlan(JSON.stringify({ ...perf, baseline: undefined })), null);
  assert.equal(parsePlan(JSON.stringify({ ...perf, baseline: 'faster' })), null);
  assert.equal(parsePlan(JSON.stringify({ ...goodPlan, category: 'unknown' })), null);
  assert.equal(parsePlan(JSON.stringify({ ...goodPlan, evidence: [] })), null);
  assert.equal(parsePlan(JSON.stringify({ ...goodPlan, evidence: ['vague'] })), null);
});

test('review verdict must be an explicit first line', () => {
  assert.equal(verdict('VERDICT: PASS\nTests: passed'), 'PASS');
  assert.equal(verdict('VERDICT: FAIL\nMissing tests'), 'FAIL');
  assert.equal(verdict('I think it looks good\nVERDICT: PASS'), null);
  assert.equal(verdict('VERDICT: MAYBE'), null);
});
test('autopilot is disabled by default and requires a local Git repo and goal', () => {
  const f = fixture();
  try {
    assert.equal(f.pilot.snapshot().enabled, false);
    assert.throws(() => f.pilot.configure({ enabled: true, goal: '', allowWorktreeWrites: true }), /objective/);
    assert.equal(f.tasks.size, 0);
  } finally { f.cleanup(); }
});
test('read-only discovery flows to independent Codex plan review', async () => {
  const f = fixture();
  try {
    f.pilot.configure({ enabled: true, goal: 'Improve verified code quality', allowWorktreeWrites: true });
    assert.equal(f.pilot.state.active.stage, 'discover');
    assert.equal(f.tasks.size, 1);
    let t = f.tasks.get(f.pilot.state.active.taskId);
    assert.deepEqual(f.pilot.snapshot().categories, WORK_CATEGORIES);
    assert.match(t.opts.prompt, /Performance: optimize only demonstrated bottlenecks/);
    assert.match(t.opts.prompt, /Cleanup: remove duplicated, dead or obsolete code/);
    assert.match(t.opts.prompt, /baseline.*benchmark command/);
    assert.equal(t.opts.cli, 'claude');
    assert.equal(t.opts.autoPermit, false);
    assert.equal(t.opts.readOnly, true);
    assert.equal(t.opts.usageJson, true);
    assert.equal(t.opts.noRetry, true);
    assert.equal(t.opts.noFallback, true);
    assert.equal(t.opts.compactContext, true);
    assert.deepEqual(f.pilot.state.active.localSignals.files, ['index.js']);
    assert.equal(f.pilot.snapshot().budget.calls, 1);
    assert.equal(f.pilot.snapshot().budget.unmeteredCalls, 1);
    assert.equal(f.pilot.snapshot().limits.dailyCompletions, LIMITS.dailyCompletions);
    t.state = 'completed'; t.result = JSON.stringify(goodPlan);
    await f.pilot.tick();
    assert.equal(f.pilot.state.active.stage, 'plan-review');
    t = f.tasks.get(f.pilot.state.active.taskId);
    assert.equal(t.opts.cli, 'codex');
    assert.equal(t.opts.autoPermit, false);
    assert.equal(f.pilot.snapshot().budget.calls, 2);
    assert.match(t.opts.prompt, /adversarial PLAN review/);
    assert.match(t.opts.prompt, /verify a reproducible baseline/);
  } finally { f.cleanup(); }
});
test('no justified task backs off instead of repeatedly invoking Claude', async () => {
  const f = fixture();
  try {
    f.pilot.configure({ enabled: true, goal: 'Find only justified issues', allowWorktreeWrites: true });
    const t = f.tasks.get(f.pilot.state.active.taskId);
    t.state = 'completed'; t.result = '{"decision":"NO_TASK"}';
    await f.pilot.tick();
    assert.equal(f.pilot.state.active, null);
    assert.equal(f.pilot.state.history.at(-1).outcome, 'no-task');
    await f.pilot.tick();
    assert.equal(f.tasks.size, 1);
  } finally { f.cleanup(); }
});
test('manual stop cancels active work and survives restart without resuming', async () => {
  const f = fixture();
  try {
    f.pilot.configure({ enabled: true, goal: 'Improve tests', allowWorktreeWrites: true });
    const id = f.pilot.state.active.taskId;
    f.pilot.stop();
    assert.equal(f.pilot.snapshot().enabled, false);
    assert.equal(f.tasks.get(id).state, 'cancelled');
    const restarted = new MindAutopilot({ repoRoot: f.root, orchestrator: f.orch,
      getUiContext: () => ({}), getRepoPath: () => '', autoTimer: false });
    assert.equal(restarted.snapshot().enabled, false);
    assert.match(restarted.snapshot().error, /Interrupted by restart/);
    restarted.close();
  } finally { f.cleanup(); }
});

test('adversarial code review checks benchmark gains and behavior preservation', () => {
  const f = fixture();
  try {
    f.pilot.state.active = { plan: { ...goodPlan, category: 'performance', baseline: 'node bench: 450 ms' },
      baseSha: 'deadbeef', worktree: { path: f.root }, repairs: 0 };
    const review = f.pilot.reviewPrompt('code-review');
    assert.match(review, /independently compare baseline vs changed code/);
    assert.match(review, /no public behavior, APIs, accessibility/);
    assert.match(review, /FAIL if there is no demonstrated improvement/);
  } finally { f.cleanup(); }
});
test('completed quality work preserves category and independent review evidence in history', () => {
  const f = fixture();
  try {
    f.pilot.state.active = { plan: { ...goodPlan, category: 'cleanup' },
      worktree: { path: '/tmp/isolated' } };
    f.pilot.complete('completed', 'VERDICT: PASS\nAll before/after tests passed.');
    assert.equal(f.pilot.state.history[0].category, 'cleanup');
    assert.match(f.pilot.state.history[0].reviewerEvidence, /before\/after tests passed/);
    assert.deepEqual(f.pilot.state.history[0].evidence, goodPlan.evidence);
  } finally { f.cleanup(); }
});

test('two completed tasks block additional discoveries until the next local day', async () => {
  const f = fixture();
  try {
    const today = new Date().toISOString();
    f.pilot.state.history.push(...completedToday(today));
    f.pilot.configure({ enabled: true, goal: 'Improve code, no more than two daily tasks', allowWorktreeWrites: true });
    assert.equal(f.tasks.size, 0);
    assert.equal(f.pilot.snapshot().limits.dailyCompletions, LIMITS.dailyCompletions);
  } finally { f.cleanup(); }
});
test('completed provider usage is visible in the autopilot budget', async () => {
  const f = fixture();
  try {
    f.pilot.configure({ enabled: true, goal: 'Measure token usage', allowWorktreeWrites: true });
    const t = f.tasks.get(f.pilot.state.active.taskId);
    t.state = 'completed'; t.usage = { inputTokens: 900, outputTokens: 100 };
    t.result = '{"decision":"NO_TASK"}';
    await f.pilot.tick();
    assert.equal(f.pilot.snapshot().budget.measuredTokens, 1000);
    assert.equal(f.pilot.snapshot().budget.unmeteredCalls, 0);
    assert.equal(f.pilot.snapshot().budget.byProvider.claude.calls, 1);
  } finally { f.cleanup(); }
});
test('budget exhaustion delays new tasks instead of silently ignoring the limit', async () => {
  const f = fixture();
  try {
    const now = Date.now();
    f.pilot.state.budgetCalls = Array.from({ length: Math.ceil(LIMITS.dailyTokenBudget / LIMITS.reservedTokensPerCall) }, (_, i) => ({
      ref: 'past-' + i, cli: 'claude', stage: 'discover', at: now,
      reservedTokens: LIMITS.reservedTokensPerCall, actualTokens: null,
    }));
    f.pilot.configure({ enabled: true, goal: 'Work without exceeding daily budget', allowWorktreeWrites: true });
    assert.equal(f.tasks.size, 0);
    assert.ok(f.pilot.snapshot().budget.chargedTokens >= LIMITS.dailyTokenBudget);
    assert.ok(f.pilot.snapshot().nextAt > now);
  } finally { f.cleanup(); }
});

test('enabling requires explicit consent for elevated worktree writes', () => {
  const f = fixture();
  try {
    assert.throws(() => f.pilot.configure({ enabled: true, goal: 'Improve tests' }), /Explicit consent/);
    assert.equal(f.tasks.size, 0);
    f.pilot.configure({ enabled: true, goal: 'Improve tests', allowWorktreeWrites: true });
    assert.equal(f.pilot.snapshot().consent.worktreeWrites, true);
    f.pilot.stop();
    // Consent is remembered for the same repository.
    f.pilot.acknowledge();
    f.pilot.configure({ enabled: true, goal: 'Improve tests' });
    assert.equal(f.pilot.snapshot().enabled, true);
  } finally { f.cleanup(); }
});
test('a folder without its own Git directory is refused', () => {
  const f = fixture();
  try {
    const plain = fs.mkdtempSync(path.join(os.tmpdir(), 'symphonee-nogit-'));
    f.pilot.getRepoPath = () => plain;
    assert.throws(() => f.pilot.configure({ enabled: true, goal: 'Improve tests', allowWorktreeWrites: true }), /not a Git work tree/);
    fs.rmSync(plain, { recursive: true, force: true });
  } finally { f.cleanup(); }
});
test('third task of the day is blocked and reported as quota', async () => {
  const f = fixture();
  try {
    const today = new Date().toISOString();
    f.pilot.state.history.push(...completedToday(today));
    f.pilot.configure({ enabled: true, goal: 'Improve tests', allowWorktreeWrites: true });
    await f.pilot.tick();
    assert.equal(f.tasks.size, 0);
    assert.equal(f.pilot.snapshot().today.completed, LIMITS.dailyCompletions);
    assert.equal(f.pilot.snapshot().status, 'quota');
  } finally { f.cleanup(); }
});
test('daily call quota blocks a launch even when measured tokens are tiny', async () => {
  const f = fixture();
  try {
    const now = Date.now();
    f.pilot.state.budgetCalls = Array.from({ length: LIMITS.dailyCalls }, (_, i) => ({ ref: 'c' + i, cli: i % 2 ? 'codex' : 'claude',
      stage: 'plan-review', at: now, reservedTokens: LIMITS.reservedTokensPerCall, actualTokens: 10, settled: true }));
    f.pilot.configure({ enabled: true, goal: 'Improve tests', allowWorktreeWrites: true });
    assert.equal(f.tasks.size, 0);
    const s = f.pilot.snapshot();
    assert.equal(s.budget.remainingCalls, 0);
    assert.equal(s.status, 'quota');
  } finally { f.cleanup(); }
});
test('mid-task budget exhaustion parks the stage until the next day without launching', async () => {
  const f = fixture();
  try {
    f.pilot.configure({ enabled: true, goal: 'Improve tests', allowWorktreeWrites: true });
    const t = f.tasks.get(f.pilot.state.active.taskId);
    const now = Date.now();
    for (let i = 0; i < Math.ceil(LIMITS.dailyTokenBudget / LIMITS.reservedTokensPerCall); i++) f.pilot.state.budgetCalls.push({ ref: 'x' + i, cli: 'codex', stage: 'x', at: now, reservedTokens: LIMITS.reservedTokensPerCall, actualTokens: null });
    t.state = 'completed'; t.result = JSON.stringify(goodPlan);
    await f.pilot.tick();
    assert.equal(f.tasks.size, 1, 'plan review was not launched');
    assert.equal(f.pilot.state.active.waitingStage, 'plan-review');
    assert.equal(f.pilot.snapshot().status, 'quota');
    await f.pilot.tick();
    assert.equal(f.tasks.size, 1, 'still parked on later ticks the same day');
  } finally { f.cleanup(); }
});
test('restart of an ACTIVE pilot archives the running stage without replay and the loop continues', async () => {
  const f = fixture();
  try {
    f.pilot.configure({ enabled: true, goal: 'Improve tests', allowWorktreeWrites: true });
    const oldId = f.pilot.state.active.taskId;
    f.pilot.close();
    f.tasks.delete(oldId); // the process and its task died with the old server
    const restarted = new MindAutopilot({ repoRoot: f.root, orchestrator: f.orch,
      getUiContext: () => ({ activeRepo: 'demo' }), getRepoPath: f.pilot.getRepoPath, autoTimer: false });
    let s = restarted.snapshot();
    assert.equal(s.enabled, true, 'configuration and activation survive the restart');
    assert.equal(s.goal, 'Improve tests');
    assert.equal(s.active, null);
    assert.equal(s.history[0].outcome, 'interrupted');
    assert.match(s.history[0].error, /restarted during stage discover/);
    assert.equal(s.budget.calls, 1, 'interrupted call stays charged');
    assert.equal(s.status, 'waiting', 'short cooldown before the next discovery');
    await restarted.tick();
    assert.equal(f.tasks.size, 0, 'no replay during the cooldown');
    restarted.state.nextAt = 0;
    await restarted.tick();
    assert.equal(f.tasks.size, 1, 'a fresh discovery starts after the cooldown');
    assert.match(f.tasks.values().next().value.opts.prompt, /"outcome":"interrupted"/, 'discovery knows the interrupted attempt');
    s = restarted.snapshot();
    assert.equal(s.today.discoveries, 2);
    restarted.close();
  } finally { f.cleanup(); }
});
test('restart while parked on quota keeps waiting instead of relaunching', async () => {
  const f = fixture();
  try {
    f.pilot.configure({ enabled: true, goal: 'Improve tests', allowWorktreeWrites: true });
    const t = f.tasks.get(f.pilot.state.active.taskId);
    const now = Date.now();
    for (let i = 0; i < Math.ceil(LIMITS.dailyTokenBudget / LIMITS.reservedTokensPerCall); i++) f.pilot.state.budgetCalls.push({ ref: 'q' + i, cli: 'codex', stage: 'x', at: now, reservedTokens: LIMITS.reservedTokensPerCall, actualTokens: null });
    t.state = 'completed'; t.result = JSON.stringify(goodPlan);
    await f.pilot.tick();
    assert.equal(f.pilot.state.active.waitingStage, 'plan-review');
    f.pilot.close();
    const restarted = new MindAutopilot({ repoRoot: f.root, orchestrator: f.orch,
      getUiContext: () => ({ activeRepo: 'demo' }), getRepoPath: f.pilot.getRepoPath, autoTimer: false });
    assert.equal(restarted.snapshot().enabled, true);
    assert.equal(restarted.snapshot().active.waitingStage, 'plan-review');
    await restarted.tick();
    assert.equal(f.tasks.size, 1, 'still parked: nothing launched');
    // Stopping a parked plan keeps it resumable (no process was running).
    restarted.stop();
    assert.equal(restarted.snapshot().status, 'disabled');
    restarted.close();
    const again = new MindAutopilot({ repoRoot: f.root, orchestrator: f.orch,
      getUiContext: () => ({ activeRepo: 'demo' }), getRepoPath: f.pilot.getRepoPath, autoTimer: false });
    assert.equal(again.snapshot().status, 'disabled', 'restart while stopped keeps the parked plan, not interrupted');
    again.configure({ enabled: true, goal: 'Improve tests' });
    assert.equal(again.snapshot().active.waitingStage, 'plan-review', 'reactivation resumes the approved plan');
    assert.equal(again.snapshot().active.plan.title, goodPlan.title);
    again.close();
  } finally { f.cleanup(); }
});
test('restart after a user stop keeps the pilot stopped and requires an explicit archive', async () => {
  const f = fixture();
  try {
    f.pilot.configure({ enabled: true, goal: 'Improve tests', allowWorktreeWrites: true });
    f.pilot.stop();
    f.pilot.close();
    const restarted = new MindAutopilot({ repoRoot: f.root, orchestrator: f.orch,
      getUiContext: () => ({ activeRepo: 'demo' }), getRepoPath: f.pilot.getRepoPath, autoTimer: false });
    assert.equal(restarted.snapshot().status, 'interrupted');
    assert.throws(() => restarted.configure({ enabled: true, goal: 'Improve tests' }), /acknowledgeInterrupted/);
    restarted.acknowledge();
    assert.equal(restarted.snapshot().history[0].outcome, 'interrupted');
    assert.equal(restarted.snapshot().status, 'disabled');
    restarted.close();
  } finally { f.cleanup(); }
});
test('daily counters use the local calendar day', () => {
  const { dayOf, startOfNextDay } = require('./autopilot-budget');
  const late = new Date(2026, 10, 11, 23, 30).getTime();
  assert.equal(dayOf(late), '2026-11-11');
  assert.equal(dayOf(startOfNextDay(late)), '2026-11-12');
  assert.equal(new Date(startOfNextDay(late)).getHours(), 0);
});
test('local triage: real markers only, and source files without a sibling test', () => {
  const f = fixture();
  try {
    const repo = f.pilot.getRepoPath();
    fs.writeFileSync(path.join(repo, 'pattern.js'), "const RE = /TODO|FIXME/;\nmodule.exports = RE;\n");
    fs.writeFileSync(path.join(repo, 'covered.js'), 'module.exports = 1;\n');
    fs.writeFileSync(path.join(repo, 'covered.test.js'), "require('./covered');\n");
    execFileSync('git', ['add', '.'], { cwd: repo });
    const s = localTriage(repo);
    assert.deepEqual(s.markers, ['index.js:2'], 'the TODO|FIXME regex literal is not a marker');
    assert.ok(s.untested.sample.includes('index.js'));
    assert.ok(s.untested.sample.includes('pattern.js'));
    assert.equal(s.untested.sample.includes('covered.js'), false, 'a file with a sibling test is not untested');
    assert.equal(s.untested.sample.includes('covered.test.js'), false, 'test files are not targets');
    assert.equal(s.untested.of, 3);
  } finally { f.cleanup(); }
});
test('detailed plans with long evidence are accepted; oversized items are still refused', () => {
  const long = { ...goodPlan, evidence: ['dashboard/lib/x.js: ' + 'branch detail '.repeat(60)],
    acceptance: ['node --test passes and asserts ' + 'case '.repeat(130)] };
  assert.ok(long.evidence[0].length > 800 && long.acceptance[0].length > 600);
  assert.equal(parsePlan(JSON.stringify(long)).evidence.length, 1);
  assert.equal(parsePlan(JSON.stringify({ ...goodPlan, evidence: ['x'.repeat(1501)] })), null);
  assert.equal(parsePlan(JSON.stringify({ ...goodPlan, acceptance: ['x'.repeat(1001)] })), null);
});
