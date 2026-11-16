'use strict';
// Shared kit for the Qwen-on-a-real-repository tests: a real git repository, the REAL Orchestrator and autopilot, FAKE Claude/Codex
// processes and a FAKE LM Studio. No network, no paid token.
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
  // The tests must not depend on how much memory the machine has while 600 other tests run in parallel.
  const realSpawn = orch.spawnQwenInWorktree.bind(orch); orch.spawnQwenInWorktree = (o) => realSpawn({ ...o, dependencies: { freemem: () => 8 * 1024 ** 3, sleep: async () => {} } });
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
  const make = () => new MindAutopilot({ repoRoot: root, orchestrator: orch, getUiContext: () => ({ activeRepo: 'demo', activeSpace: '_global' }), getRepoPath: () => repo, getRepos: () => ({ demo: repo }), autoTimer: false, id: 'default', def });
  const pilot = make();
  return { root, repo, orch, pilot, spawns, lm, reopen: make, cleanup() { globalThis.fetch = realFetch; pilot.close(); try { gitc(repo, 'worktree', 'prune'); } catch (_) {} fs.rmSync(root, { recursive: true, force: true }); } };
}
async function drive(pilot, maxTicks = 1500) { for (let i = 0; i < maxTicks && pilot.state.enabled && pilot.state.active; i++) { await sleep(25); await pilot.tick(); } }
const CREATE_TEST = "READ index.js\nCREATE index.test.js\n<<<<<<< CONTENT\nrequire('./index');\n>>>>>>> END\nRUN";

module.exports = { setup, drive, sleep, gitc, plan, DEF, CREATE_TEST };
