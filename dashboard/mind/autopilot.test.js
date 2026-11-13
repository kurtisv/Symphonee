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
test('restart of an ACTIVE pilot resumes the interrupted stage automatically, at most twice', async () => {
  const f = fixture();
  try {
    f.pilot.configure({ enabled: true, goal: 'Improve tests', allowWorktreeWrites: true });
    const oldId = f.pilot.state.active.taskId;
    f.pilot.close();
    f.tasks.delete(oldId); // the process and its task died with the old server
    const boot = () => new MindAutopilot({ repoRoot: f.root, orchestrator: f.orch,
      getUiContext: () => ({ activeRepo: 'demo' }), getRepoPath: f.pilot.getRepoPath, autoTimer: false });
    let restarted = boot();
    let s = restarted.snapshot();
    assert.equal(s.enabled, true, 'configuration and activation survive the restart');
    assert.equal(s.goal, 'Improve tests');
    assert.equal(s.active.waitingStage, 'discover', 'the interrupted discovery is parked, not archived');
    assert.equal(s.active.parkReason, 'restart');
    assert.equal(s.history.length, 0);
    assert.equal(s.budget.calls, 1, 'interrupted call stays charged');
    await restarted.tick();
    assert.equal(f.tasks.size, 0, 'short cooldown first');
    restarted.state.nextAt = 0;
    await restarted.tick();
    assert.equal(f.tasks.size, 1, 'the discovery is launched again');
    assert.equal(restarted.snapshot().active.stage, 'discover');
    // A second and a third restart: the third archives as before.
    for (const n of [2, 3]) {
      const id = restarted.state.active.taskId; restarted.close(); f.tasks.delete(id);
      restarted = boot();
      if (n === 2) { assert.equal(restarted.snapshot().active.waitingStage, 'discover'); restarted.state.nextAt = 0; await restarted.tick(); }
    }
    s = restarted.snapshot();
    assert.equal(s.active, null, 'third restart: archived');
    assert.equal(s.history[0].outcome, 'interrupted');
    assert.match(s.history[0].error, /after two automatic resumes/);
    restarted.close();
  } finally { f.cleanup(); }
});
test('restart during implementation continues in the same worktree as a non-counted repair', async () => {
  const f = fixture();
  try {
    f.pilot.configure({ enabled: true, goal: 'Improve tests', allowWorktreeWrites: true });
    const a = f.pilot.state.active;
    a.stage = 'implement'; a.plan = goodPlan; a.baseSha = 'abc'; a.repairs = 0;
    a.worktree = { path: f.pilot.getRepoPath(), branch: 'mind-autopilot/x' };
    f.pilot.save(); f.pilot.close(); f.tasks.clear();
    const r = new MindAutopilot({ repoRoot: f.root, orchestrator: f.orch,
      getUiContext: () => ({ activeRepo: 'demo' }), getRepoPath: f.pilot.getRepoPath, autoTimer: false });
    const s = r.snapshot();
    assert.equal(s.active.waitingStage, 'repair');
    assert.equal(s.active.repairs, 0, 'a restart does not consume a repair');
    assert.match(r.state.active.review, /INTERRUPTED BY A SYMPHONEE RESTART/);
    assert.equal(r.state.active.worktree.branch, 'mind-autopilot/x', 'same worktree');
    r.close();
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
test('long plans are clipped, never thrown away; structure stays strict', () => {
  const long = { ...goodPlan, evidence: ['dashboard/lib/x.js: ' + 'branch detail '.repeat(60)],
    acceptance: ['node --test passes and asserts ' + 'case '.repeat(130)] };
  assert.ok(long.evidence[0].length > 800 && long.acceptance[0].length > 600);
  assert.equal(parsePlan(JSON.stringify(long)).evidence.length, 1);
  // The real plan lost on 2026-11-12 had a 190-char title.
  const p = parsePlan(JSON.stringify({ ...goodPlan, title: 'T'.repeat(190), objective: 'o'.repeat(2500),
    evidence: ['e'.repeat(1600), ...Array.from({ length: 9 }, (_, i) => 'file.js:' + i + ' detail here')], acceptance: ['a'.repeat(1200)] }));
  assert.equal(p.title.length, 180);
  assert.ok(p.title.endsWith('...'));
  assert.equal(p.objective.length, 2000);
  assert.equal(p.evidence.length, 8);
  assert.equal(p.evidence[0].length, 1500);
  assert.equal(p.acceptance[0].length, 1000);
  // Structure is still enforced.
  assert.equal(parsePlan(JSON.stringify({ ...goodPlan, evidence: ['short'] })), null, 'evidence item too short to be evidence');
  assert.equal(parsePlan(JSON.stringify({ ...goodPlan, acceptance: [] })), null);
  assert.equal(parsePlan(JSON.stringify({ ...goodPlan, category: 'refactor' })), null);
  assert.equal(parsePlan(JSON.stringify({ ...goodPlan, title: 'short' })), null);
});
test('an unparsable discovery answer is kept and Reprendre re-reads it without a new call', async () => {
  const f = fixture();
  try {
    f.pilot.configure({ enabled: true, goal: 'Improve tests', allowWorktreeWrites: true });
    const t = f.tasks.get(f.pilot.state.active.taskId);
    t.state = 'completed'; t.result = 'Here is my plan: ' + JSON.stringify({ ...goodPlan, decision: 'TASK', category: 'unknown-category' });
    await f.pilot.tick();
    let s = f.pilot.snapshot();
    assert.equal(s.status, 'interrupted');
    assert.match(s.error, /answer kept/);
    assert.equal(s.active.resumable, true);
    assert.throws(() => f.pilot.resume(), /still not a valid plan/, 'a still-invalid answer is not forced through');
    // Same answer shape that a later parser accepts: simulate by fixing the kept text.
    f.pilot.state.active.lastRaw = 'Here is my plan: ' + JSON.stringify(goodPlan);
    const calls = f.tasks.size;
    f.pilot.resume();
    s = f.pilot.snapshot();
    assert.equal(s.active.stage, 'plan-review', 'goes straight to the plan review');
    assert.equal(f.tasks.size, calls + 1, 'only the plan review was launched');
    assert.equal(f.tasks.get(s.active.taskId).opts.cli, 'codex');
    assert.equal(s.today.discoveries, 1, 'no discovery was paid again');
  } finally { f.cleanup(); }
});

// ── Night mode ──────────────────────────────────────────────────────────────
function nightFixture(def) {
  const f = fixture();
  f.pilot.applyDefinition({ profile: 'deep', ambition: 'big', schedule: { start: '22:00', end: '07:00' },
    sources: { files: ['TASKS.md'], sentry: true }, stepMinutes: 120,
    limits: { dailyCalls: 120, dailyTokenBudget: 100000000, dailyCompletions: 12, dailyDiscoveries: 30 }, ...def });
  f.pilot.fetchSentry = async () => 'Top issue: TypeError in OfflineQueue.flush (1,240 events)';
  return f;
}
const at = (h, m = 0) => new Date(2026, 10, 12, h, m).getTime();

test('night window: no new task outside 22:00-07:00, next start computed', async () => {
  const f = nightFixture();
  try {
    f.pilot.state = { ...f.pilot.state, enabled: true, goal: 'Night', repoName: 'demo', repoPath: f.pilot.getRepoPath(), consent: { worktreeWrites: true } };
    await f.pilot.tick(at(12, 0));
    assert.equal(f.tasks.size, 0, 'nothing at noon');
    assert.equal(f.pilot.state.nextAt, at(22, 0));
    await f.pilot.tick(at(23, 30));
    assert.equal(f.tasks.size, 1, 'starts inside the window');
    const t = [...f.tasks.values()][0];
    assert.match(t.opts.prompt, /MOST IMPACTFUL REAL problem/);
    assert.match(t.opts.prompt, /BACKLOG SOURCES[^\n]*TASKS\.md/);
    assert.match(t.opts.prompt, /PRODUCTION ERRORS from Sentry[\s\S]*OfflineQueue\.flush/);
    assert.match(t.opts.prompt, /Prefer the highest-impact task that can be completed and verified in one night/);
    assert.doesNotMatch(t.opts.prompt, /Prefer the smallest high-impact task/);
    assert.equal(t.opts.timeout, 120 * 60000, 'two-hour stages');
    const s = f.pilot.snapshot(at(23, 30));
    assert.equal(s.limits.dailyCalls, 120);
    assert.equal(s.limits.repairs, 2, 'profile values kept where not overridden');
    assert.equal(s.inWindow, true);
  } finally { f.cleanup(); }
});
test('window helpers: crossing midnight and invalid definitions', () => {
  const { MindAutopilot: _M } = require('./autopilot');
  const f = nightFixture();
  try {
    assert.equal(f.pilot.inWindow(at(2, 0)), true);
    assert.equal(f.pilot.inWindow(at(7, 0)), false);
    assert.equal(f.pilot.inWindow(at(21, 59)), false);
    assert.throws(() => f.pilot.applyDefinition({ schedule: { start: '25:00', end: '07:00' } }), /schedule needs/);
    assert.throws(() => f.pilot.applyDefinition({ limits: { dailyCalls: 9999 } }), /dailyCalls must be between/);
  } finally { f.cleanup(); }
});
test('a provider credit limit parks the task instead of halting, and continues in the same worktree', async () => {
  const f = nightFixture();
  try {
    f.pilot.state = { ...f.pilot.state, enabled: true, goal: 'Night', repoName: 'demo', repoPath: f.pilot.getRepoPath(), consent: { worktreeWrites: true } };
    await f.pilot.tick(at(23, 0));
    const t = [...f.tasks.values()][0];
    t.state = 'failed'; t.error = 'Claude api_error: You have reached your usage limit.';
    await f.pilot.tick(at(23, 1));
    let s = f.pilot.snapshot(at(23, 1));
    assert.equal(s.enabled, true, 'not halted');
    assert.equal(s.error, null);
    assert.equal(s.active.waitingStage, 'discover');
    assert.equal(s.active.parkReason, 'credit');
    assert.equal(f.pilot.state.nextAt, at(23, 1) + 3600000, 'retry in one hour inside the window');
    await f.pilot.tick(at(23, 30));
    assert.equal(f.tasks.size, 1, 'nothing before the retry time');
    await f.pilot.tick(at(23, 1) + 3600000);
    assert.equal(f.tasks.size, 2, 'retried after one hour');
    // Implementation hit by the limit: continue in the same worktree as a non-counted repair.
    f.pilot.state.active.stage = 'implement'; f.pilot.state.active.worktree = { path: f.pilot.getRepoPath() };
    f.pilot.state.active.plan = { title: 'x'.repeat(10) }; f.pilot.state.active.repairs = 0;
    f.pilot.parkForCredit(f.pilot.state.active, '429 Too Many Requests', at(6, 30));
    s = f.pilot.snapshot(at(6, 30));
    assert.equal(s.active.waitingStage, 'repair');
    assert.equal(s.active.repairs, 0, 'a credit pause does not consume a repair');
    assert.match(f.pilot.state.active.review, /INTERRUPTED BY A PROVIDER USAGE\/CREDIT LIMIT/);
    assert.equal(f.pilot.state.nextAt, at(22, 0), '07:30 is outside the window: retry at the next 22:00');
  } finally { f.cleanup(); }
});
test('an unusable Sentry summary is skipped, never passed as data', async () => {
  for (const text of ['Sentry Error Tracker -- gassaver\nNo projects found.', 'Sentry Error Tracker plugin is not configured.', null]) {
    const f = nightFixture();
    try {
      f.pilot.fetchSentry = async () => text;
      f.pilot.state = { ...f.pilot.state, enabled: true, goal: 'Night', repoName: 'demo', repoPath: f.pilot.getRepoPath(), consent: { worktreeWrites: true } };
      await f.pilot.tick(at(23, 0));
      const t = [...f.tasks.values()][0];
      assert.doesNotMatch(t.opts.prompt, /PRODUCTION ERRORS from Sentry/, String(text));
      assert.ok(f.pilot.state.events.some(e => e.kind === 'sentry'));
    } finally { f.cleanup(); }
  }
});
test('credit pause waits for the reset time the provider announces', () => {
  const { creditResetAt } = require('./autopilot');
  const msg = "Claude api_error: You've hit your 5-hour limit · resets 4:10am (America/Toronto): HTTP 429";
  assert.equal(creditResetAt(msg, at(0, 40)), at(4, 10));
  assert.equal(creditResetAt('resets 4pm', at(17, 0)), at(16, 0) + 86400000, 'past time today means tomorrow');
  assert.equal(creditResetAt('Rate limited, try again in 25 minutes', at(1, 0)), at(1, 25));
  assert.equal(creditResetAt('HTTP 429 Too Many Requests', at(1, 0)), null);
  const f = nightFixture();
  try {
    f.pilot.state.active = { stage: 'discover', plan: null, repairs: 0 };
    f.pilot.parkForCredit(f.pilot.state.active, msg, at(0, 40));
    assert.equal(f.pilot.state.nextAt, at(4, 12), 'one retry, right after the announced reset');
  } finally { f.cleanup(); }
});
test('every prompt tells the agents to read files as UTF-8', () => {
  const f = nightFixture();
  try {
    f.pilot.state.active = { plan: { title: 'x', objective: 'y' }, baseSha: 'abc', worktree: { path: '.' } };
    assert.match(f.pilot.reviewPrompt('code-review'), /Get-Content -Raw -Encoding UTF8/);
    assert.match(f.pilot.reviewPrompt('plan-review'), /YOUR reading artifact/);
  } finally { f.cleanup(); }
});

test('end of the window: the next stage of a running task waits for the next window', async () => {
  const f = nightFixture();
  try {
    f.pilot.state = { ...f.pilot.state, enabled: true, goal: 'Night', repoName: 'demo', repoPath: f.pilot.getRepoPath(), consent: { worktreeWrites: true } };
    await f.pilot.tick(at(6, 50));
    const t = [...f.tasks.values()][0];
    t.state = 'completed'; t.result = JSON.stringify(goodPlan);
    await f.pilot.tick(at(7, 10)); // discovery finished after 07:00
    const s = f.pilot.snapshot(at(7, 10));
    assert.equal(f.tasks.size, 1, 'no plan review launched outside the window');
    assert.equal(s.active.waitingStage, 'plan-review');
    assert.equal(s.active.parkReason, 'window');
    assert.equal(f.pilot.state.nextAt, at(22, 0));
    await f.pilot.tick(at(22, 1));
    assert.equal(f.tasks.size, 2, 'the plan review starts when the window opens');
    assert.equal(f.tasks.get(f.pilot.state.active.taskId).opts.cli, 'codex');
  } finally { f.cleanup(); }
});
