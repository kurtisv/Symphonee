'use strict';
// End-to-end: the REAL autopilot and Orchestrator, real Git worktrees, FAKE Claude/Codex processes and a FAKE
// LM Studio (no network, no paid token). Qwen is the first implementer for a small, located task; the usual
// gates (main checkout untouched, protected paths, the repository's own checks, Codex review) still apply, and
// a stuck or paused Qwen never costs the work.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const { execFileSync } = require('child_process');
const { MindAutopilot } = require('./autopilot');
delete process.env.NODE_TEST_CONTEXT; // the repository checks below run `node check.js` themselves

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const gitc = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
const plan = (evidence) => JSON.stringify({ decision: 'TASK', category: 'testing', title: 'Add run() regression test', objective: 'Add a regression test for the run() helper return value', evidence, acceptance: ['check passes'] });
const DEF = { profile: 'standard', label: 'Qwen demo', verify: [{ name: 'check', cmd: ['node', 'check.js'], timeoutMs: 20000 }], linkDirs: ['deps'], protectedPaths: ['^secrets/'], qwen: { enabled: true } };

function setup({ qwenReplies = [], evidence = ['index.js:2 carries a TODO asking for coverage of run()'], def = DEF, qwenEnabled = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sym-autopilot-qwen-'));
  const repo = path.join(root, 'demo'); fs.mkdirSync(repo);
  gitc(repo, 'init', '-q'); gitc(repo, 'config', 'user.name', 'T'); gitc(repo, 'config', 'user.email', 't@example.invalid');
  fs.writeFileSync(path.join(repo, 'index.js'), 'function run() { return true; }\n// TODO: add coverage\nmodule.exports = { run };\n');
  fs.mkdirSync(path.join(repo, 'secrets')); fs.writeFileSync(path.join(repo, 'secrets', 'key.txt'), 'TOP-SECRET\n');
  // The check needs the new test AND the linked dependency folder: it proves both the work and the junction.
  fs.writeFileSync(path.join(repo, 'check.js'), "const fs=require('fs');process.exit(fs.existsSync('index.test.js')&&fs.existsSync('deps/lib.txt')?0:1);\n");
  fs.writeFileSync(path.join(repo, '.gitignore'), 'deps/\n'); fs.mkdirSync(path.join(repo, 'deps')); fs.writeFileSync(path.join(repo, 'deps', 'lib.txt'), 'shared');
  gitc(repo, 'add', '.'); gitc(repo, '-c', 'user.name=T', '-c', 'user.email=t@example.invalid', 'commit', '-qm', 'init');

  const { Orchestrator } = require('../orchestrator');
  const config = { Permissions: { mode: 'edit' }, AiApiKeys: {}, ...(qwenEnabled ? { QwenRepo: { enabled: true } } : {}) };
  const orch = new Orchestrator({ terminals: new Map(), broadcast: () => {}, workspaceDir: fs.mkdtempSync(path.join(os.tmpdir(), 'sym-autopilot-ws-')), getConfig: () => config });
  orch._pretrust = () => {}; orch.saveTaskToMind = null;
  const spawns = [];
  orch._spawnImpl = (command, args, opts) => {
    const proc = new EventEmitter(); let prompt = '';
    proc.stdin = { write(s) { prompt += s; }, end() {
      const rec = { args: [...args], cwd: opts.cwd, prompt }; spawns.push(rec); let out = '', err = '';
      const claudeJson = (result) => JSON.stringify({ type: 'result', is_error: false, result, usage: { input_tokens: 400, cache_creation_input_tokens: 100, cache_read_input_tokens: 9000, output_tokens: 50 } });
      if (/READ-ONLY independent work discovery/.test(prompt)) { rec.stage = 'discover'; out = claudeJson(plan(evidence)); }
      else if (/adversarial PLAN review/.test(prompt)) { rec.stage = 'plan-review'; out = 'VERDICT: PASS\nfine'; err = 'tokens used\n1,500\n'; }
      else if (/Claude implementer in ISOLATED/.test(prompt)) { rec.stage = 'implement'; fs.writeFileSync(path.join(opts.cwd, 'index.test.js'), "require('./index');\n"); out = claudeJson('implemented'); }
      else if (/adversarial CODE review/.test(prompt)) { rec.stage = 'code-review'; out = 'VERDICT: PASS\nok'; err = 'tokens used\n2,000\n'; }
      else if (/corrective implementer/.test(prompt)) { rec.stage = 'repair'; fs.writeFileSync(path.join(opts.cwd, 'index.test.js'), "require('./index');\n"); out = claudeJson('repaired'); }
      setImmediate(() => { proc.stdout.emit('data', Buffer.from(out)); if (err) proc.stderr.emit('data', Buffer.from(err)); proc.emit('close', 0); });
    } };
    proc.stdout = new EventEmitter(); proc.stderr = new EventEmitter(); proc.kill = () => {};
    return proc;
  };
  const lm = { prompts: [], replies: [...qwenReplies], down: false };
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    if (!String(url).startsWith('http://127.0.0.1:1234')) throw new Error('unexpected network call: ' + url);
    if (lm.down) throw new Error('ECONNREFUSED');
    if (String(url).endsWith('/api/v0/models')) return { ok: true, json: async () => ({ data: [{ id: 'qwen/qwen3.5-4b', state: 'loaded', loaded_context_length: 8192 }] }) };
    lm.prompts.push(JSON.parse(init.body).messages[0].content);
    const r = lm.replies.shift(); if (r === undefined) throw new Error('no scripted Qwen reply left');
    return { ok: true, json: async () => ({ choices: [{ message: { content: r } }], usage: { prompt_tokens: 500, completion_tokens: 60 } }) };
  };
  const pilot = new MindAutopilot({ repoRoot: root, orchestrator: orch, getUiContext: () => ({ activeRepo: 'demo', activeSpace: '_global' }), getRepoPath: () => repo, getRepos: () => ({ demo: repo }), autoTimer: false, id: 'default', def });
  return { root, repo, orch, pilot, spawns, lm, cleanup() { globalThis.fetch = realFetch; pilot.close(); try { gitc(repo, 'worktree', 'prune'); } catch (_) {} fs.rmSync(root, { recursive: true, force: true }); } };
}
async function drive(pilot, maxTicks = 1500) { for (let i = 0; i < maxTicks && pilot.state.enabled && pilot.state.active; i++) { await sleep(25); await pilot.tick(); } }
const CREATE_TEST = "READ index.js\nCREATE index.test.js\n<<<<<<< CONTENT\nrequire('./index');\n>>>>>>> END\nRUN";

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
    assert.doesNotMatch(f.lm.prompts[1], /TOP-SECRET/); assert.match(f.lm.prompts[1], /REFUSED: Path refused: protected/);
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
  const f = setup({ qwenReplies: [CREATE_TEST.replace('\nRUN', ''), 'STUCK I do not know how to proceed'] });
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
  const f = setup({ qwenReplies: ['STUCK nothing I can do'] });
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
