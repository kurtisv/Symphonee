'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { MindAutopilot, parsePlan, verdict } = require('./autopilot');

const goodPlan = { decision: 'TASK', title: 'Repair reproducible failure',
  objective: 'Fix an existing failing unit test with a minimal change',
  acceptance: ['Run the identified test and confirm it passes'] };

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'symphonee-autopilot-'));
  const repo = path.join(root, 'demo');
  fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
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
    assert.throws(() => f.pilot.configure({ enabled: true, goal: '' }), /objective/);
    assert.equal(f.tasks.size, 0);
  } finally { f.cleanup(); }
});
test('read-only discovery flows to independent Codex plan review', async () => {
  const f = fixture();
  try {
    f.pilot.configure({ enabled: true, goal: 'Improve verified code quality' });
    assert.equal(f.pilot.state.active.stage, 'discover');
    assert.equal(f.tasks.size, 1);
    let t = f.tasks.get(f.pilot.state.active.taskId);
    assert.equal(t.opts.cli, 'claude');
    assert.equal(t.opts.autoPermit, false);
    t.state = 'completed'; t.result = JSON.stringify(goodPlan);
    await f.pilot.tick();
    assert.equal(f.pilot.state.active.stage, 'plan-review');
    t = f.tasks.get(f.pilot.state.active.taskId);
    assert.equal(t.opts.cli, 'codex');
    assert.equal(t.opts.autoPermit, false);
    assert.match(t.opts.prompt, /adversarial PLAN review/);
  } finally { f.cleanup(); }
});
test('no justified task backs off instead of repeatedly invoking Claude', async () => {
  const f = fixture();
  try {
    f.pilot.configure({ enabled: true, goal: 'Find only justified issues' });
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
    f.pilot.configure({ enabled: true, goal: 'Improve tests' });
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
