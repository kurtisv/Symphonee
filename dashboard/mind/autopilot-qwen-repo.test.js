'use strict';
// End-to-end: the REAL autopilot and Orchestrator, real Git worktrees, FAKE Claude/Codex processes and a FAKE LM Studio (see qwen-repo-test-kit.js).
// Qwen is the first implementer for a small, located task; the usual gates still apply, and a stuck or paused Qwen never costs the work.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { setup, drive, sleep, gitc, DEF, CREATE_TEST } = require('./qwen-repo-test-kit');

test('Qwen is the first implementer of a small located task: no Claude implementation, no cloud call for it, every gate still applies', async () => {
  const f = setup({ qwenReplies: [CREATE_TEST, 'DONE added a regression test'] });
  try {
    const headBefore = gitc(f.repo, 'rev-parse', 'HEAD');
    f.pilot.configure({ enabled: true, goal: 'Improve test coverage', allowWorktreeWrites: true });
    await drive(f.pilot);
    const s = f.pilot.snapshot(); assert.equal(s.error, null, 'no error: ' + s.error);
    assert.deepEqual(f.spawns.map(x => x.stage), ['discover', 'plan-review', 'code-review'], 'Claude did not implement; Codex reviewed Qwen\'s change');
    const last = s.history[0];
    assert.equal(last.outcome, 'completed'); assert.equal(last.implementer, 'qwen'); assert.equal(last.repairs, 0);
    assert.deepEqual([last.qwen.stages, last.qwen.turns, last.qwen.calls, last.qwen.input, last.qwen.output], [1, 2, 2, 1000, 120]);
    assert.deepEqual(last.verified, ['check'], 'the repository\'s own check passed on the worktree (with the linked dependency folder)');
    assert.match(f.lm.prompts[0], /TASK: Add run\(\) regression test/); assert.match(f.lm.prompts[0], /Files the plan mentions: index\.js/);
    // isolation
    const wt = last.worktree.path; assert.notEqual(path.resolve(wt), path.resolve(f.repo));
    assert.ok(fs.existsSync(path.join(wt, 'index.test.js'))); assert.equal(fs.existsSync(path.join(f.repo, 'index.test.js')), false);
    assert.equal(gitc(f.repo, 'status', '--porcelain'), ''); assert.equal(gitc(f.repo, 'rev-parse', 'HEAD'), headBefore, 'nothing merged into the main checkout');
    assert.ok(last.commit, 'the reviewed change is committed on its own branch only');
    // cloud ledger: discovery, plan review and code review only; Qwen reserved nothing
    const calls = (f.pilot.state.budget && f.pilot.state.budget.ledger || f.pilot.state.ledger || []).map(x => x.stage).sort();
    assert.ok(!calls.includes('implement'), 'no cloud call was charged for the implementation: ' + calls.join());
  } finally { f.cleanup(); }
});

test('Qwen cannot read or write protected files through the host protocol', async () => {
  const f = setup({ qwenReplies: ['READ secrets/key.txt\nREAD index.js', CREATE_TEST, 'DONE ok'] });
  try {
    f.pilot.configure({ enabled: true, goal: 'g', allowWorktreeWrites: true }); await drive(f.pilot);
    assert.equal(f.pilot.snapshot().error, null);
    assert.doesNotMatch(f.lm.prompts[1], /TOP-SECRET/); assert.match(f.lm.prompts[1], /REFUSED: secrets\/key\.txt holds SECRETS and will NEVER be readable/); // wording of 2026-11-22 (two protection levels)
  } finally { f.cleanup(); }
});

test('a task that names no file, or when the feature is off, goes to Claude as before and says why', async () => {
  for (const [label, over] of [['no file named', { evidence: ['the helper has no coverage'] }], ['disabled in the config', { qwenEnabled: false }], ['pilot without the option', { def: { ...DEF, qwen: undefined } }]]) {
    const f = setup(over);
    try {
      f.pilot.configure({ enabled: true, goal: 'g', allowWorktreeWrites: true }); await drive(f.pilot);
      assert.equal(f.pilot.snapshot().error, null, label);
      assert.deepEqual(f.spawns.map(x => x.stage), ['discover', 'plan-review', 'implement', 'code-review'], label);
      assert.equal(f.lm.prompts.length, 0, label + ': Qwen was not called');
      const h = f.pilot.snapshot().history[0]; assert.equal(h.implementer === undefined || h.implementer === 'claude', true, label);
    } finally { f.cleanup(); }
  }
});

test('too many files or a protected file in the plan: not admissible', async () => {
  const f = setup({ evidence: ['index.js, check.js and secrets/key.txt are involved'] });
  try {
    f.pilot.configure({ enabled: true, goal: 'g', allowWorktreeWrites: true }); await drive(f.pilot);
    assert.deepEqual(f.spawns.map(x => x.stage), ['discover', 'plan-review', 'implement', 'code-review']);
    assert.ok(f.pilot.state.events.some(e => /Qwen not used for implement: protected file named: secrets\/key\.txt/.test(e.msg)));
  } finally { f.cleanup(); }
});

test('Qwen stuck after a partial change: Claude takes over in the SAME worktree, not counted as a repair, and the observation is kept', async () => {
  const f = setup({ def: { ...DEF, qwen: { enabled: true, maxCoaching: 0 } }, qwenReplies: [CREATE_TEST.replace('\nRUN', ''), 'STUCK I do not know how to proceed', 'STUCK still not', 'STUCK I do not know how to proceed'] }); // a first give-up is refused twice
  try {
    f.pilot.configure({ enabled: true, goal: 'g', allowWorktreeWrites: true }); await drive(f.pilot);
    const s = f.pilot.snapshot(); assert.equal(s.error, null, String(s.error));
    assert.deepEqual(f.spawns.map(x => x.stage), ['discover', 'plan-review', 'repair', 'code-review']);
    const rep = f.spawns.find(x => x.stage === 'repair');
    assert.match(rep.prompt, /A local developer \(Qwen\) started this task in this worktree and could not finish it: The model declared itself stuck/);
    const h = s.history[0]; assert.equal(h.outcome, 'completed'); assert.equal(h.implementer, 'claude-after-qwen'); assert.equal(h.repairs, 0, 'a hand-back is not a counted repair');
    assert.equal(h.qwen.handoffs.length, 1); assert.equal(path.resolve(rep.cwd), path.resolve(h.worktree.path), 'the same worktree');
    assert.match(fs.readFileSync(path.join(f.root, '.symphonee', 'lecons.json'), 'utf8'), /Qwen\) a ete bloque/);
  } finally { f.cleanup(); }
});

test('Qwen stuck with no change: Claude implements from scratch and the empty worktree is kept', async () => {
  const f = setup({ def: { ...DEF, qwen: { enabled: true, maxCoaching: 0 } }, qwenReplies: ['STUCK nothing I can do'] });
  try {
    f.pilot.configure({ enabled: true, goal: 'g', allowWorktreeWrites: true }); await drive(f.pilot);
    assert.equal(f.pilot.snapshot().error, null);
    assert.deepEqual(f.spawns.map(x => x.stage), ['discover', 'plan-review', 'implement', 'code-review']);
    const h = f.pilot.snapshot().history[0]; assert.equal(h.implementer, 'claude-after-qwen'); assert.equal(h.abandonedWorktrees.length, 1); assert.ok(fs.existsSync(h.abandonedWorktrees[0]));
  } finally { f.cleanup(); }
});

test('an unavailable model pauses the stage with the progress saved; the next tick resumes in the same worktree and finishes', async () => {
  const f = setup({ qwenReplies: [CREATE_TEST.replace('\nRUN', ''), 'RUN', 'DONE ok'] });
  try {
    f.pilot.configure({ enabled: true, goal: 'g', allowWorktreeWrites: true });
    let wt = null;
    for (let i = 0; i < 1500 && f.pilot.state.active; i++) {
      await sleep(25); await f.pilot.tick();
      const a = f.pilot.state.active;
      if (a && a.worktree && a.stage === 'implement' && !wt) wt = a.worktree.path;
      // deterministic: LM Studio goes away only once Qwen's first turn is served AND its file exists
      if (wt && !f.lm.down && f.lm.prompts.length >= 1 && fs.existsSync(path.join(wt, 'index.test.js'))) f.lm.down = true;
      if (a && a.parkReason === 'qwen-paused') break;
    }
    const a = f.pilot.state.active;
    assert.equal(a.parkReason, 'qwen-paused', 'paused, not failed'); assert.equal(a.waitingStage, 'implement'); assert.ok(fs.existsSync(path.join(wt, 'index.test.js')), 'the work done so far is kept');
    f.lm.down = false; f.pilot.state.nextAt = 0;
    await drive(f.pilot);
    const s = f.pilot.snapshot(); assert.equal(s.error, null, String(s.error));
    const h = s.history[0]; assert.equal(h.outcome, 'completed'); assert.equal(h.implementer, 'qwen'); assert.equal(path.resolve(h.worktree.path), path.resolve(wt), 'resumed in the same worktree');
    assert.equal(h.qwen.stages, 2, 'the paused stage and the resumed stage are both accounted for');
    assert.match(f.lm.prompts.at(-1), /Files you changed|FILES YOU CHANGED: index\.test\.js/, 'its own progress was restored from the session file');
  } finally { f.cleanup(); }
});
