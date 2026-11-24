'use strict';
// Decision of 2026-11-24: an owner decision suspends ONE task, never the pilot. Real Orchestrator, real Git worktrees, fake Claude/Codex processes.
// Scenario: task A asks the owner and is set aside; task B starts by itself and finishes; the owner answers A from Mind Autopilot; A resumes
// at the same stage in the same worktree and passes. Also: refusal, double answer, restart, lost decisions file, branch change, file conflicts, policy.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const { execFileSync } = require('child_process');
const { MindAutopilot } = require('./autopilot');
const owner = require('./autopilot-owner');
const decisions = require('../decisions/decisions');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const gitc = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
const planJson = (title, file) => JSON.stringify({ decision: 'TASK', category: 'testing', title, objective: 'Add a regression test for ' + file,
  evidence: [file + ':1 has no test'], acceptance: ['node --test passes'] });
const ASK = (cat, q) => 'Stopped.\n' + owner.MARKER + ' ' + JSON.stringify({ category: cat, question: q, consequences: 'Allowed: the package is added. Refused: the test stays without it.' });

function setup({ askOn = 'implement', category = 'dependency', def = {}, secondPlanFile = 'other.js', refuseThenNoChange = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sym-owner-'));
  const repo = path.join(root, 'demo');
  fs.mkdirSync(repo);
  gitc(repo, 'init', '-q'); gitc(repo, 'config', 'user.name', 'T'); gitc(repo, 'config', 'user.email', 't@example.invalid');
  fs.writeFileSync(path.join(repo, 'index.js'), 'module.exports = 1;\n');
  fs.writeFileSync(path.join(repo, 'other.js'), 'module.exports = 2;\n');
  gitc(repo, 'add', '.'); gitc(repo, 'commit', '-qm', 'init');
  const { Orchestrator } = require('../orchestrator');
  const config = { Permissions: { mode: 'bypass' }, AiApiKeys: {} };
  const orch = new Orchestrator({ terminals: new Map(), broadcast: () => {}, workspaceDir: fs.mkdtempSync(path.join(os.tmpdir(), 'sym-owner-ws-')), getConfig: () => config });
  orch._pretrust = () => {}; orch.saveTaskToMind = null;
  const spawns = []; let discoveries = 0;
  orch._spawnImpl = (command, args, opts) => {
    const proc = new EventEmitter();
    let prompt = '';
    proc.stdin = { write(s) { prompt += s; }, end() {
      const rec = { cwd: opts.cwd, prompt }; spawns.push(rec);
      const cj = (result) => JSON.stringify({ type: 'result', is_error: false, result, usage: { input_tokens: 10, output_tokens: 5 } });
      const taskA = /Add a regression test for index\.js/.test(prompt);
      rec.task = taskA ? 'A' : /Add a regression test for other\.js|Add a regression test for index2/.test(prompt) ? 'B' : null;
      let out = '';
      if (/READ-ONLY independent work discovery/.test(prompt)) {
        rec.stage = 'discover'; discoveries++;
        out = cj(discoveries === 1 ? planJson('Task A: test index.js', 'index.js') : planJson('Task B: test ' + secondPlanFile, secondPlanFile));
      } else if (/adversarial PLAN review/.test(prompt)) { rec.stage = 'plan-review'; out = 'VERDICT: PASS\nok'; }
      else if (/Claude implementer in ISOLATED/.test(prompt)) {
        rec.stage = 'implement';
        if (rec.task === 'A') { fs.writeFileSync(path.join(opts.cwd, 'index.test.js'), "require('./index');\n"); out = cj(askOn === 'implement' ? ASK(category, 'May I add the dev dependency left-pad for this test?') : 'implemented'); }
        else { fs.writeFileSync(path.join(opts.cwd, path.basename(secondPlanFile, '.js') + '.test.js'), "require('./" + secondPlanFile + "');\n"); out = cj('implemented'); }
      } else if (/adversarial CODE review/.test(prompt)) { rec.stage = 'code-review'; out = 'VERDICT: PASS\ntests run'; }
      else if (/corrective implementer/.test(prompt)) {
        rec.stage = 'repair';
        rec.sawDecision = /OWNER DECISION dec_[0-9a-f]{8} for exactly this request/.test(prompt);
        rec.sawRefusal = /The owner did NOT authorize it/.test(prompt);
        if (rec.sawRefusal && refuseThenNoChange) out = cj('NO_CHANGE: refused by the owner');
        else { fs.appendFileSync(path.join(opts.cwd, 'index.test.js'), '// with the owner answer\n'); out = cj('repaired'); }
      }
      setImmediate(() => { proc.stdout.emit('data', Buffer.from(out)); proc.emit('close', 0); });
    } };
    proc.stdout = new EventEmitter(); proc.stderr = new EventEmitter(); proc.kill = () => {};
    return proc;
  };
  const make = () => {
    const p = new MindAutopilot({ repoRoot: root, orchestrator: orch, getUiContext: () => ({ activeRepo: 'demo', activeSpace: '_global' }),
      getRepoPath: () => repo, getRepos: () => ({ demo: repo }), autoTimer: false, id: 'default', def: { limits: { dailyCompletions: 9, dailyDiscoveries: 9 }, ...def } });
    p.readUsage = () => { const now = Date.now(); const r = { readAt: now, source: 'fixture', windows: [{ name: '5 h', usedPct: 0, resetsAt: now + 3600000 }] }; return { claude: r, codex: r }; };
    return p;
  };
  const pilot = make();
  return { root, repo, orch, pilot, spawns, make,
    store: () => decisions.sharedStore(root),
    cleanup(p = pilot) { try { p.close(); } catch (_) {} for (const t of orch.tasks.values()) { clearTimeout(t._timer); clearInterval(t._pollInterval); } try { gitc(repo, 'worktree', 'prune'); } catch (_) {} fs.rmSync(root, { recursive: true, force: true }); } };
}
async function drive(pilot, until, max = 120) {
  for (let i = 0; i < max && !until(); i++) { await sleep(20); pilot.state.nextAt = 0; await pilot.tick(); if (pilot.state.error) throw new Error('pilot error: ' + pilot.state.error); }
}
const stages = (f, task) => f.spawns.filter((x) => x.task === task).map((x) => x.stage);

test('A asks the owner and is set aside, B starts by itself and finishes, the owner answers A from Mind Autopilot, A resumes and passes', async () => {
  const f = setup();
  try {
    f.pilot.configure({ enabled: true, goal: 'tests', allowWorktreeWrites: true });
    await drive(f.pilot, () => (f.pilot.state.suspended || []).length === 1);
    const e = f.pilot.state.suspended[0];
    assert.equal(f.pilot.state.enabled, true, 'the pilot stays enabled'); assert.equal(f.pilot.state.error, null);
    assert.equal(e.stage, 'implement'); assert.equal(e.request.category, 'dependency');
    assert.ok(e.worktree && fs.existsSync(path.join(e.worktree.path, 'index.test.js')), 'A keeps its worktree and its work');
    assert.equal(e.active.repairs, 0, 'waiting for the owner is not a repair');
    assert.equal(f.pilot.state.history.length, 0, 'A is neither archived nor failed');
    const d = f.store().get(e.decisionId);
    assert.equal(d.status, 'pending'); assert.equal(d.meta.pilot, 'default'); assert.equal(d.meta.suspendedId, e.id); assert.match(d.title, /left-pad/);
    assert.deepEqual(d.options.map((o) => o.id), ['allow', 'refuse']);
    const view = f.pilot.snapshot();
    assert.equal(view.suspended.length, 1); assert.equal(view.suspended[0].task, 'Task A: test index.js');

    // B runs while A waits, in its own worktree.
    await drive(f.pilot, () => f.pilot.state.history.some((h) => h.outcome === 'completed' && /Task B/.test(h.title)));
    const hb = f.pilot.state.history.find((h) => /Task B/.test(h.title));
    assert.equal(hb.outcome, 'completed'); assert.notEqual(hb.worktree.path, e.worktree.path);
    assert.equal(f.pilot.state.suspended.length, 1, 'A still waits');
    assert.equal(f.store().get(e.decisionId).status, 'pending');

    // The owner answers A (exactly once).
    const r = f.pilot.answerOwner({ suspendedId: e.id, decisionId: e.decisionId, choice: 'allow', text: 'ok, dev dependency only' }, 'ui');
    assert.equal(r.ok, true);
    const again = f.pilot.answerOwner({ suspendedId: e.id, decisionId: e.decisionId, choice: 'refuse' }, 'phone');
    assert.equal(again.ok, false); assert.equal(again.code, 'ALREADY_ANSWERED', 'a second answer is refused');
    assert.equal(f.store().get(e.decisionId).answer.choice, 'allow');

    await drive(f.pilot, () => f.pilot.state.history.some((h) => /Task A/.test(h.title)));
    const ha = f.pilot.state.history.find((h) => /Task A/.test(h.title));
    assert.equal(ha.outcome, 'completed', 'A passes after the answer');
    assert.equal(ha.worktree.path, e.worktree.path, 'A resumed in the SAME worktree');
    assert.deepEqual(stages(f, 'A'), ['plan-review', 'implement', 'repair', 'code-review'], 'no stage replayed: discover/plan-review/implement are not paid again');
    const rep = f.spawns.find((x) => x.task === 'A' && x.stage === 'repair');
    assert.ok(rep.sawDecision, 'the answer reached A'); assert.match(rep.prompt, /dev dependency only/);
    assert.equal(f.spawns.filter((x) => x.task === 'B' && /OWNER DECISION/.test(x.prompt)).length, 0, 'the answer never reached B');
    assert.equal(f.pilot.state.suspended.length, 0);
    assert.equal(f.pilot.state.suspendedLog[0].status, 'resumed');
    assert.equal(ha.repairs, 0, 'the owner wait used no repair');
  } finally { f.cleanup(); }
});

test('refusal: never worked around; the agent finds no allowed way, the task ends as refused and the pilot goes on', async () => {
  const f = setup({ refuseThenNoChange: true });
  try {
    f.pilot.configure({ enabled: true, goal: 'tests', allowWorktreeWrites: true });
    await drive(f.pilot, () => (f.pilot.state.suspended || []).length === 1);
    const e = f.pilot.state.suspended[0];
    assert.equal(f.pilot.answerOwner({ suspendedId: e.id, decisionId: e.decisionId, choice: 'refuse' }).ok, true);
    await drive(f.pilot, () => f.pilot.state.history.some((h) => /Task A/.test(h.title)));
    const ha = f.pilot.state.history.find((h) => /Task A/.test(h.title));
    assert.equal(ha.outcome, 'owner-refused');
    assert.ok(f.spawns.find((x) => x.task === 'A' && x.stage === 'repair').sawRefusal);
    assert.equal(f.pilot.state.enabled, true); assert.equal(f.pilot.state.error, null);
  } finally { f.cleanup(); }
});

test('restart while A waits: the waiting task, its question and the answer survive; A resumes after the restart', async () => {
  const f = setup();
  let p2 = null;
  try {
    f.pilot.configure({ enabled: true, goal: 'tests', allowWorktreeWrites: true });
    await drive(f.pilot, () => (f.pilot.state.suspended || []).length === 1);
    const e = f.pilot.state.suspended[0];
    f.pilot.close();
    // The decisions file is on disk: a fresh store (another process) reads the pending question.
    const disk = decisions.createStore({ file: path.join(f.root, '.symphonee', 'decisions.json') });
    assert.equal(disk.get(e.decisionId).status, 'pending');
    p2 = f.make();
    assert.equal(p2.state.suspended.length, 1, 'the waiting task survives the restart');
    assert.equal(p2.state.active === null || !!p2.state.active, true);
    assert.equal(p2.answerOwner({ suspendedId: e.id, decisionId: e.decisionId, choice: 'allow' }).ok, true);
    assert.equal(decisions.createStore({ file: path.join(f.root, '.symphonee', 'decisions.json') }).get(e.decisionId).status, 'answered', 'the answer is on disk');
    p2.state.active = null; // B is not part of this test
    await drive(p2, () => p2.state.history.some((h) => /Task A/.test(h.title)));
    assert.equal(p2.state.history.find((h) => /Task A/.test(h.title)).outcome, 'completed');
  } finally { f.cleanup(p2 || f.pilot); }
});

test('lost decisions file (lost connection, deleted file): the question is asked again, never resumed without an answer', async () => {
  const f = setup();
  try {
    f.pilot.configure({ enabled: true, goal: 'tests', allowWorktreeWrites: true });
    await drive(f.pilot, () => (f.pilot.state.suspended || []).length === 1);
    const e = f.pilot.state.suspended[0], first = e.decisionId;
    f.pilot._decisions = decisions.createStore({ file: null }); // an empty store: the question is gone
    f.pilot.state.active = null;
    f.pilot.state.nextAt = 0; await f.pilot.tick();
    assert.notEqual(e.decisionId, first, 'a new question was created');
    assert.equal(f.pilot.state.suspended.length, 1);
    assert.equal(f.pilot._decisions.get(e.decisionId).status, 'pending');
    assert.equal(f.pilot.answerOwner({ suspendedId: e.id, decisionId: first, choice: 'allow' }).code, 'STALE', 'an answer to the lost question is refused');
  } finally { f.cleanup(); }
});

test('branch or content changed while A waited: A does not resume, a new question is asked; "archiver" retires it, keeping the worktree', async () => {
  const f = setup();
  try {
    f.pilot.configure({ enabled: true, goal: 'tests', allowWorktreeWrites: true });
    await drive(f.pilot, () => (f.pilot.state.suspended || []).length === 1);
    const e = f.pilot.state.suspended[0];
    gitc(e.worktree.path, 'checkout', '-q', '-b', 'someone-else');
    f.pilot.answerOwner({ suspendedId: e.id, decisionId: e.decisionId, choice: 'allow' });
    f.pilot.state.active = null; f.pilot.state.nextAt = 0; await f.pilot.tick();
    assert.ok(!f.pilot.state.active || f.pilot.state.active.stage === 'discover', 'A is not resumed on a changed branch (the pilot may start other work)');
    assert.ok(f.pilot.state.suspended.includes(e), 'A still waits');
    f.pilot.state.active = null;
    assert.equal(e.kind, 'conflict'); assert.match(e.problems.join(' '), /branche/);
    const c = f.pilot.decisionStore().get(e.decisionId);
    assert.deepEqual(c.options.map((o) => o.id), ['resume', 'abandon']);
    f.pilot.answerOwner({ suspendedId: e.id, decisionId: e.decisionId, choice: 'abandon' });
    f.pilot.state.nextAt = 0; await f.pilot.tick();
    const h = f.pilot.state.history.find((x) => /Task A/.test(x.title));
    assert.equal(h.outcome, 'abandoned-by-owner'); assert.ok(fs.existsSync(e.worktree.path), 'worktree kept');
  } finally { f.cleanup(); }
});

test('resource conflict: a task that touches the files of a waiting task is queued, not started, while another task can run', async () => {
  const f = setup({ secondPlanFile: 'index.js' });
  try {
    f.pilot.configure({ enabled: true, goal: 'tests', allowWorktreeWrites: true });
    await drive(f.pilot, () => (f.pilot.state.suspended || []).length === 1);
    await drive(f.pilot, () => f.pilot.state.history.some((h) => h.outcome === 'deferred-conflict'), 40);
    assert.ok(f.pilot.state.history.some((h) => h.outcome === 'deferred-conflict'));
    assert.ok((f.pilot.state.queue || []).some((q) => /index\.js/.test(q.plan.title)), 'kept in the queue for later');
    assert.equal(f.pilot.pickQueuedFree(true), -1, 'not picked while A holds index.js');
    assert.equal(f.spawns.filter((x) => x.stage === 'implement').length, 1, 'only A was implemented');
  } finally { f.cleanup(); }
});

test('policy: a low-risk category set to automatic is answered by the policy (recorded); sensitive categories always ask', async () => {
  const f = setup({ def: { decisionPolicy: { dependency: 'auto', 'delete-data': 'auto', secrets: 'auto' } } });
  try {
    assert.deepEqual(f.pilot.def.decisionPolicy, { dependency: 'auto' }, 'delete-data and secrets can never be automatic');
    f.pilot.configure({ enabled: true, goal: 'tests', allowWorktreeWrites: true });
    await drive(f.pilot, () => f.pilot.state.history.some((h) => /Task A/.test(h.title)));
    assert.equal(f.pilot.state.history.find((h) => /Task A/.test(h.title)).outcome, 'completed');
    assert.equal((f.pilot.state.suspended || []).length, 0, 'never suspended');
    const d = f.pilot.decisionStore().list().recent.find((x) => /left-pad/.test(x.title));
    assert.equal(d.answer.by, 'policy'); assert.equal(d.answer.choice, 'allow');
  } finally { f.cleanup(); }
  assert.equal(owner.decide({ dependency: 'auto' }, { category: 'dependency', question: 'add a package that reads the .env file', consequences: '' }), 'ask', 'a sensitive question is never automatic');
  assert.equal(owner.decide({ pleinsens: 'auto' }, { category: 'pleinsens', question: 'x', consequences: '' }), 'ask');
});

test('a text without the Autoriser button never authorizes ("Non" typed alone is not an accord)', async () => {
  const f = setup();
  try {
    f.pilot.configure({ enabled: true, goal: 'tests', allowWorktreeWrites: true });
    await drive(f.pilot, () => (f.pilot.state.suspended || []).length === 1);
    const e = f.pilot.state.suspended[0];
    assert.equal(f.pilot.answerOwner({ suspendedId: e.id, decisionId: e.decisionId, text: 'Non' }).ok, true);
    await drive(f.pilot, () => f.spawns.some((x) => x.task === 'A' && x.stage === 'repair'));
    const rep = f.spawns.find((x) => x.task === 'A' && x.stage === 'repair');
    assert.ok(rep.sawRefusal, 'treated as not authorized'); assert.match(rep.prompt, /NOT AUTHORIZED/); assert.match(rep.prompt, /the owner wrote: "Non"/);
    assert.equal(f.pilot.state.suspendedLog[0].status, 'refused');
  } finally { f.cleanup(); }
});

test('the owner decision reaches the later reviewers too (code review prompt), and a lost write is never reported as recorded', async () => {
  const f = setup();
  try {
    f.pilot.configure({ enabled: true, goal: 'tests', allowWorktreeWrites: true });
    await drive(f.pilot, () => (f.pilot.state.suspended || []).length === 1);
    const e = f.pilot.state.suspended[0];
    const store = f.pilot.decisionStore();
    const blocked = path.join(f.root, '.symphonee', 'decisions.json');
    fs.rmSync(blocked, { force: true }); fs.mkdirSync(blocked); // the file cannot be written (a folder is in the way)
    const r = f.pilot.answerOwner({ suspendedId: e.id, decisionId: e.decisionId, choice: 'allow' });
    assert.equal(r.ok, false); assert.equal(r.code, 'NOT_SAVED'); assert.equal(store.get(e.decisionId).status, 'pending', 'nothing recorded');
    fs.rmSync(blocked, { recursive: true, force: true });
    assert.equal(f.pilot.answerOwner({ suspendedId: e.id, decisionId: e.decisionId, choice: 'allow' }).ok, true);
    await drive(f.pilot, () => f.pilot.state.history.some((h) => /Task A/.test(h.title)));
    const cr = f.spawns.filter((x) => x.task === 'A' && x.stage === 'code-review').pop();
    assert.match(cr.prompt, /OWNER DECISIONS FOR THIS TASK/); assert.match(cr.prompt, /AUTHORIZED/);
  } finally { f.cleanup(); }
});

test('an authorization is bound to its operation: the same task asking for ANOTHER operation gets a new question', () => {
  const k1 = owner.operationKey({ category: 'dependency', question: 'Add left-pad?' });
  assert.equal(k1, owner.operationKey({ category: 'dependency', question: '  add LEFT-PAD? ' }));
  assert.notEqual(k1, owner.operationKey({ category: 'dependency', question: 'Add lodash?' }));
  assert.notEqual(k1, owner.operationKey({ category: 'config', question: 'Add left-pad?' }));
  assert.equal(owner.parseRequest('no marker'), null);
  assert.equal(owner.parseRequest(owner.MARKER + ' {"category":"weird","question":"q"}').category, 'other', 'an unknown category is "other" (always asks)');
});
