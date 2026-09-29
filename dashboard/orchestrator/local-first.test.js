'use strict';
// LOCAL-FIRST routing: deterministic tests (no network, no real CLI, no LM Studio).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const { ProviderHealthManager } = require('./provider-health');
const { TaskRouter } = require('./task-router');
const { LocalHealth, isLocalProvider, providerLocality, CLOUD_ENV_KEYS } = require('./local-providers');
const { maxRetriesFor, MAX_RETRIES } = require('./reliability');
const { RoutingTelemetry, ROUTES } = require('./routing-telemetry');
const { STATE } = require('./state');

// ── fixtures ────────────────────────────────────────────────────────────────
const LMS_MODELS = (overrides = {}) => ({ data: [
  { id: 'qwen2.5-coder-1.5b-instruct', type: 'llm', state: 'loaded', max_context_length: 32768, loaded_context_length: 32768, ...(overrides.small || {}) },
  { id: 'qwen/qwen2.5-coder-7b', type: 'llm', state: 'not-loaded', max_context_length: 32768, ...(overrides.big || {}) },
] });
const up = (overrides) => async (url) => { if (url.endsWith('/api/v0/models')) return LMS_MODELS(overrides); throw new Error('unexpected ' + url); };
const down = async () => { throw Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:1234'), { code: 'ECONNREFUSED' }); };

const CLOUD = ['claude', 'codex', 'gemini-api', 'gemini', 'copilot'];
// Codex OSS small edits are opt-in since the real 1.5B run (273s, "DONE", no edit).
const OPT_IN = { LocalFirst: { enableCodexOssSmallEdit: true } };
async function makeRouter({ lmstudio = up(), freeMemMB = 12000, config = {} } = {}) {
  const cfg = { OrchestrateCliList: CLOUD, ...config };
  const localHealth = new LocalHealth({ getConfig: () => cfg, fetchJson: lmstudio, freeMemMB: () => freeMemMB });
  await localHealth.refresh({ force: true });
  const availability = Object.fromEntries(CLOUD.map(id => [id, { available: true }]));
  const health = new ProviderHealthManager({ getConfig: () => cfg, availability, localHealth });
  return { router: new TaskRouter({ health, getConfig: () => cfg }), health, localHealth, cfg };
}

function tmpDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'sy-localfirst-')); }

// A real Orchestrator with process spawning replaced by a scripted fake.
function makeOrch({ cfg = {}, script = {}, lmstudio = up(), post } = {}) {
  const { Orchestrator } = require('../orchestrator');
  const config = { OrchestrateCliList: CLOUD, AiApiKeys: { OPENAI_API_KEY: 'sk-cloud-openai', ANTHROPIC_API_KEY: 'sk-ant-cloud' }, ...cfg };
  const orch = new Orchestrator({ terminals: new Map(), broadcast: () => {}, workspaceDir: tmpDir(), getConfig: () => config });
  orch.localHealth.fetchJson = lmstudio; orch.localHealth.freeMemMB = () => 12000;
  orch._pretrust = () => {};
  orch.lmstudioEnsureLoaded = async () => {};
  orch.spawns = [];
  orch._spawnImpl = (command, args, opts) => {
    const cli = args.includes('--oss') ? 'codex-oss-local' : command.replace(/\.cmd$/, '');
    orch.spawns.push({ cli, command, args, env: opts.env });
    const outcome = (script[cli] || []).shift() || { code: 0, stdout: `${cli} ok` };
    const proc = new EventEmitter();
    proc.stdin = { write() {}, end() {} };
    proc.stdout = new EventEmitter(); proc.stderr = new EventEmitter();
    proc.kill = () => {};
    setImmediate(() => {
      if (outcome.stdout) proc.stdout.emit('data', Buffer.from(outcome.stdout));
      if (outcome.stderr) proc.stderr.emit('data', Buffer.from(outcome.stderr));
      proc.emit('close', outcome.code);
    });
    return proc;
  };
  if (post) orch.lmstudioPost = post;
  return orch;
}

// Mirror what routes.js does after an auto-routed spawn.
function markAuto(task, routing) {
  Object.assign(task, { requestedCli: 'auto', selectedProvider: routing.provider, selectedRole: routing.selectedRole, taskClass: routing.taskClass, routingHistory: [], _autoRouting: true, _automaticFallback: true, _escalationChain: routing.fallbackChain.slice(0, 3), _escalationPrompt: task._originalPrompt || task.prompt });
}
function waitDone(orch, id, ms = 3000) {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const iv = setInterval(() => {
      const t = orch.tasks.get(id);
      if (t && [STATE.COMPLETED, STATE.FAILED, STATE.TIMEOUT, STATE.NEEDS_ATTENTION].includes(t.state) && !t._proc) { clearInterval(iv); resolve(t); }
      else if (Date.now() - t0 > ms) { clearInterval(iv); reject(new Error('timeout waiting for task ' + (t && t.state))); }
    }, 10);
  });
}
async function autoSpawn(orch, prompt, hints = {}) {
  await orch.localHealth.refresh({ force: true });
  const routing = orch.taskRouter.selectProvider({ ...hints, prompt });
  const task = orch.spawnHeadless({ cli: routing.provider, prompt, cwd: os.tmpdir() });
  markAuto(task, routing);
  return { routing, done: await waitDone(orch, task.id) };
}

// ── 1-8, 11: routing decisions ──────────────────────────────────────────────
test('1. simple summary + healthy LM Studio -> local Qwen small', async () => {
  const { router } = await makeRouter();
  const r = router.selectProvider({ prompt: 'résume ce texte en trois phrases: Symphonee est un terminal IA.' });
  assert.equal(r.provider, 'lmstudio-qwen-small');
  assert.equal(r.locality, 'local');
  assert.equal(r.taskClass, 'simple');
  assert.ok(r.fallbackChain.length > 0 && r.fallbackChain.every(p => !isLocalProvider(p)), 'fallback chain is cloud only');
});

test('2. simple summary + LM Studio down -> cheap cloud', async () => {
  const { router } = await makeRouter({ lmstudio: down });
  const r = router.selectProvider({ prompt: 'summarize this paragraph' });
  assert.equal(r.locality, 'cloud');
  assert.equal(r.provider, 'gemini-api', 'cheapest capable cloud provider');
  assert.match(r.localSkipped['lmstudio-qwen-small'], /lmstudio-unreachable/);
});

test('3. small code edit -> Codex/Claude cloud directly by default; Codex OSS local only when opted in', async () => {
  const { router } = await makeRouter();
  for (const prompt of ['corrige cette faute dans dashboard/README.md', "lance ce test Jest et corrige l'erreur"]) {
    const c = router.selectProvider({ prompt });
    assert.equal(c.taskClass, 'small-edit');
    assert.equal(c.locality, 'cloud');
    assert.ok(['codex', 'claude'].includes(c.provider), `expected codex/claude, got ${c.provider}`);
    assert.match(c.localSkipped['codex-oss-local'], /opt-in: LocalFirst\.enableCodexOssSmallEdit/);
  }
  const { router: optIn } = await makeRouter({ config: OPT_IN });
  const r = optIn.selectProvider({ prompt: 'corrige cette faute dans dashboard/README.md' });
  assert.equal(r.taskClass, 'small-edit');
  assert.equal(r.provider, 'codex-oss-local');
  assert.ok(['codex', 'claude'].includes(r.fallbackChain[0]), `fallback should be codex/claude cloud, got ${r.fallbackChain[0]}`);
});

test('5. security review -> high-quality cloud directly', async () => {
  const { router } = await makeRouter();
  const r = router.selectProvider({ prompt: 'fais une security review complète du module auth' });
  assert.equal(r.taskClass, 'security');
  assert.equal(r.locality, 'cloud');
  assert.ok(['claude', 'codex'].includes(r.provider));
  assert.ok(!r.fallbackChain.some(isLocalProvider));
});

test('6. complex architecture -> cloud directly', async () => {
  const { router } = await makeRouter();
  const r = router.selectProvider({ prompt: "analyse l'architecture de l'orchestrateur et propose une migration" });
  assert.equal(r.taskClass, 'complex');
  assert.equal(r.locality, 'cloud');
  assert.ok(['claude', 'codex'].includes(r.provider));
});

test('7. normal read-only review -> local 7B review when healthy (and RAM guard respected)', async () => {
  const { router } = await makeRouter({ lmstudio: up({ small: { state: 'not-loaded', loaded_context_length: undefined } }) });
  const r = router.selectProvider({ prompt: 'review this function for readability: function add(a,b){return a+b}' });
  assert.equal(r.taskClass, 'readonly-review');
  assert.equal(r.provider, 'lmstudio-qwen-review');
  // Same task, but the 1.5B is resident: never stack the 7B on top of it.
  const { router: r2 } = await makeRouter();
  const r2sel = r2.selectProvider({ prompt: 'review this function for readability: function add(a,b){return a+b}' });
  assert.equal(r2sel.locality, 'cloud');
  assert.match(r2sel.localSkipped['lmstudio-qwen-review'], /ram-guard/);
});

test('8. context larger than local capacity -> no local launch at all', async () => {
  const { router } = await makeRouter();
  const huge = 'summarize this log: ' + 'x'.repeat(40000 * 4);
  const r = router.selectProvider({ prompt: huge });
  assert.equal(r.locality, 'cloud');
  assert.match(r.localSkipped['lmstudio-qwen-small'], /context-exceeds-local/);
  // And the direct worker itself refuses before calling the model.
  let calls = 0;
  const orch = makeOrch({ post: async () => { calls++; return { choices: [{ message: { content: 'x' } }] }; } });
  await orch.localHealth.refresh({ force: true });
  const task = orch.spawnLmStudio({ cli: 'lmstudio-qwen-small', prompt: huge, noFallback: true });
  const done = await waitDone(orch, task.id);
  assert.equal(done.state, STATE.FAILED);
  assert.match(done.error, /context-exceeds-local/);
  assert.equal(calls, 0, 'model must not be called');
  // Codex OSS has ~20k of its own overhead: a 15k-token prompt already does not fit.
  const mid = router.selectProvider({ prompt: 'corrige la faute dans ce fichier: ' + 'y'.repeat(15000 * 4) });
  assert.notEqual(mid.provider, 'codex-oss-local');
});

test('11. explicit user preference for Claude / Codex is always respected', async () => {
  const { router } = await makeRouter();
  assert.equal(router.selectProvider({ prompt: 'résume ce texte', preferredProvider: 'claude' }).provider, 'claude');
  const { router: r2 } = await makeRouter({ config: { PreferredProvider: 'codex' } });
  assert.equal(r2.selectProvider({ prompt: 'compresse ce contexte' }).provider, 'codex');
});

// ── 4, 9, 10, 12: execution, guards, telemetry ──────────────────────────────
test('4. Codex OSS local fails once -> cloud immediately, no local retries', async () => {
  assert.equal(maxRetriesFor('codex-oss-local'), 0);
  assert.equal(maxRetriesFor('lmstudio-qwen-small'), 0);
  assert.equal(maxRetriesFor('codex'), MAX_RETRIES, 'cloud keeps its retry policy');
  // A transient-looking local error ("timed out") would be retried for cloud; not for local.
  const orch = makeOrch({ cfg: OPT_IN, script: { 'codex-oss-local': [{ code: 1, stderr: 'stream error: request timed out' }] } });
  const { routing, done } = await autoSpawn(orch, 'corrige cette faute dans README.md');
  assert.equal(routing.provider, 'codex-oss-local');
  assert.equal(done.state, STATE.COMPLETED);
  const localRuns = orch.spawns.filter(s => s.cli === 'codex-oss-local').length;
  assert.equal(localRuns, 1, 'exactly one local attempt');
  assert.ok(!isLocalProvider(done.cli), `finished on cloud, got ${done.cli}`);
  assert.equal(done.failedOverFrom.provider, 'codex-oss-local');
  assert.equal(orch.spawns.length, 2, 'local once, cloud once');
});

test('9. local providers never receive a cloud API key; argv pinned to LM Studio', async () => {
  process.env.OPENAI_API_KEY = 'sk-from-process-env';
  try {
    const orch = makeOrch();
    await orch.localHealth.refresh({ force: true });
    const t = orch.spawnHeadless({ cli: 'codex-oss-local', prompt: 'fix typo', cwd: os.tmpdir() });
    await waitDone(orch, t.id);
    const local = orch.spawns.find(s => s.cli === 'codex-oss-local');
    for (const k of CLOUD_ENV_KEYS) assert.equal(local.env[k], undefined, `${k} leaked into local env`);
    assert.ok(local.args.includes('--oss') && local.args[local.args.indexOf('--local-provider') + 1] === 'lmstudio');
    assert.equal(t.execution.locality, 'local');
    assert.ok(t.execution.cloudEnvStripped.includes('OPENAI_API_KEY'));
    // Isolated CODEX_HOME: never the user's ~/.codex (which holds the ChatGPT login).
    assert.ok(local.env.CODEX_HOME && local.env.CODEX_HOME.startsWith(orch.workspaceDir), 'CODEX_HOME isolated under the workspace');
    assert.ok(!fs.existsSync(path.join(local.env.CODEX_HOME, 'auth.json')), 'no ChatGPT/OpenAI auth in isolated home');
    const codexCfg = fs.readFileSync(path.join(local.env.CODEX_HOME, 'config.toml'), 'utf8');
    assert.match(codexCfg, /\[analytics\]\s*\nenabled = false/);
    assert.match(codexCfg, /check_for_update_on_startup = false/);
    // Credentials appearing in the isolated home => refuse to start (fail closed).
    fs.writeFileSync(path.join(local.env.CODEX_HOME, 'auth.json'), '{}');
    assert.throws(() => orch.spawnHeadless({ cli: 'codex-oss-local', prompt: 'x', cwd: os.tmpdir() }), /auth\.json present/);
    fs.unlinkSync(path.join(local.env.CODEX_HOME, 'auth.json'));
    // Control: the cloud Codex path still gets its key.
    const c = orch.spawnHeadless({ cli: 'codex', prompt: 'x', cwd: os.tmpdir() });
    await waitDone(orch, c.id);
    assert.equal(orch.spawns.find(s => s.cli === 'codex').env.OPENAI_API_KEY, 'sk-cloud-openai');
    // Old alias resolves to the local provider, never to cloud Codex.
    const a = orch.spawnHeadless({ cli: 'codex-oss', prompt: 'x', cwd: os.tmpdir() });
    assert.equal(a.cli, 'codex-oss-local');
    // Direct LM Studio: loopback only, fail closed otherwise.
    const bad = makeOrch({ cfg: { LocalFirst: { baseUrl: 'https://api.openai.com' } } });
    assert.throws(() => bad.spawnLmStudio({ cli: 'lmstudio-qwen-small', prompt: 'x' }), /not loopback/);
    // Locality is explicit: DashScope-backed `qwen` is cloud.
    assert.equal(providerLocality('qwen'), 'cloud');
    assert.equal(providerLocality('lmstudio-qwen-small'), 'local');
  } finally { delete process.env.OPENAI_API_KEY; }
});

test('10. telemetry distinguishes LOCAL_DIRECT / LOCAL_CODEX / CLOUD_DIRECT / LOCAL_TO_CLOUD_FAILOVER', async () => {
  let directCalls = 0;
  const orch = makeOrch({
    cfg: OPT_IN,
    post: async (url, body) => { directCalls++; assert.match(url, /^http:\/\/127\.0\.0\.1:1234\//); return { model: body.model, choices: [{ message: { content: 'résumé local' }, finish_reason: 'stop' }], usage: { prompt_tokens: 50, completion_tokens: 10 } }; },
    script: { 'codex-oss-local': [{ code: 0, stdout: 'edited' }, { code: 1, stderr: 'tool call failed' }] },
  });
  // The successful codex-oss-local run really changes the repo (fingerprint moves).
  let treeVersion = 0;
  orch._gitTreeFingerprint = () => `tree-${treeVersion++}`;
  const a = await autoSpawn(orch, 'résume ce texte: Symphonee route les tâches.');
  assert.equal(a.done.state, STATE.COMPLETED); assert.equal(a.done.cli, 'lmstudio-qwen-small'); assert.equal(directCalls, 1);
  const b = await autoSpawn(orch, 'corrige cette faute dans README.md');
  assert.equal(b.done.cli, 'codex-oss-local');
  const c = await autoSpawn(orch, "analyse l'architecture complète de l'orchestrateur");
  assert.ok(!isLocalProvider(c.done.cli));
  const d = await autoSpawn(orch, 'corrige cette faute dans index.js');
  assert.ok(!isLocalProvider(d.done.cli));
  const s = orch.routingTelemetry.summary();
  assert.equal(s.counts.LOCAL_DIRECT, 1);
  assert.equal(s.counts.LOCAL_CODEX, 1);
  assert.equal(s.counts.CLOUD_DIRECT, 1);
  assert.equal(s.counts.LOCAL_TO_CLOUD_FAILOVER, 1);
  assert.equal(s.total, 4);
  assert.equal(a.done.routeCategory, ROUTES.LOCAL_DIRECT);
  assert.equal(d.done.routeCategory, ROUTES.LOCAL_TO_CLOUD_FAILOVER);
  const rec = s.recent.find(r => r.route === ROUTES.LOCAL_TO_CLOUD_FAILOVER);
  assert.equal(rec.firstProvider, 'codex-oss-local'); assert.ok(rec.failoverReason); assert.equal(rec.cloudUsed, true);
  assert.equal(s.recent.find(r => r.route === ROUTES.LOCAL_DIRECT).cloudUsed, false);
  // Persisted: a new telemetry instance on the same file sees the same counts.
  const reloaded = new RoutingTelemetry({ file: orch.routingTelemetry.file });
  assert.equal(reloaded.summary().total, 4);
  assert.match(s.line, /4 tasks -> 1 local direct, 1 Codex OSS local, 1 cloud direct, 1 local->cloud failover/);
});

test('12. failover never loops between providers', async () => {
  const orch = makeOrch({ script: {
    'codex-oss-local': [{ code: 1, stderr: 'boom' }, { code: 1, stderr: 'boom' }],
    codex: [{ code: 1, stderr: 'quota exceeded' }, { code: 1, stderr: 'quota exceeded' }],
    claude: [{ code: 1, stderr: 'quota exceeded' }, { code: 1, stderr: 'quota exceeded' }],
  } });
  await orch.localHealth.refresh({ force: true });
  const task = orch.spawnHeadless({ cli: 'codex-oss-local', prompt: 'corrige la faute', cwd: os.tmpdir() });
  // Hostile chain: duplicates, the failing provider itself, and a local model.
  Object.assign(task, { selectedProvider: 'codex-oss-local', routingHistory: [], _autoRouting: true, _automaticFallback: true, _escalationChain: ['codex', 'codex-oss-local', 'codex', 'lmstudio-qwen-small', 'claude', 'codex', 'claude'], _escalationPrompt: 'corrige la faute' });
  const done = await waitDone(orch, task.id);
  assert.equal(done.state, STATE.FAILED, 'terminates once every distinct provider failed');
  assert.deepEqual(orch.spawns.map(s => s.cli), ['codex-oss-local', 'codex', 'claude'], 'each provider exactly once, no local re-entry');
  assert.equal(orch.routingTelemetry.summary().counts.LOCAL_TO_CLOUD_FAILOVER, 1);
});

// ── extra: model-router + HTTP route ─────────────────────────────────────────
test('13. model-router: quick-summary recommends local only when LM Studio is live', async () => {
  const modelRouter = require('../model-router');
  const cfgPath = path.join(tmpDir(), 'config.json');
  fs.writeFileSync(cfgPath, JSON.stringify({ OrchestrateCliList: ['claude', 'codex', 'gemini'] }));
  const { localHealth } = await makeRouter();
  assert.equal(modelRouter.recommend({ intent: 'quick-summary', configPath: cfgPath, localHealth }).cli, 'lmstudio-qwen-small');
  assert.equal(modelRouter.recommend({ intent: 'small-edit', configPath: cfgPath, localHealth }).cli, 'codex', 'small edits go to cloud by default');
  const optInPath = path.join(tmpDir(), 'config.json');
  fs.writeFileSync(optInPath, JSON.stringify({ OrchestrateCliList: ['claude', 'codex', 'gemini'], ...OPT_IN }));
  assert.equal(modelRouter.recommend({ intent: 'small-edit', configPath: optInPath, localHealth }).cli, 'codex-oss-local');
  const { localHealth: downHealth } = await makeRouter({ lmstudio: down });
  assert.equal(modelRouter.recommend({ intent: 'quick-summary', configPath: cfgPath, localHealth: downHealth }).cli, 'claude');
  assert.equal(modelRouter.recommend({ intent: 'quick-summary', configPath: cfgPath }).cli, 'claude', 'no live health => no local pick');
  assert.equal(modelRouter.recommend({ intent: 'quick-summary', configPath: cfgPath, localHealth, contextTokens: 60000 }).cli, 'claude', 'too big for local ctx');
  assert.equal(modelRouter.recommend({ intent: 'deep-code', configPath: cfgPath, localHealth }).cli, 'claude');
});

test('14. HTTP spawn: LM Studio drops between routing and launch -> cloud, counted as failover', async () => {
  const { registerOrchestratorRoutes } = require('./routes');
  const repoRoot = tmpDir();
  fs.mkdirSync(path.join(repoRoot, 'config'), { recursive: true });
  fs.writeFileSync(path.join(repoRoot, 'config', 'config.json'), JSON.stringify({ Permissions: { mode: 'bypass', deny: [], ask: [], allow: [] } }));
  let probes = 0;
  const flaky = async (url) => (++probes === 1 ? up({ small: { state: 'not-loaded', loaded_context_length: undefined } })(url) : down());
  const orch = makeOrch({ cfg: OPT_IN, lmstudio: flaky });
  const routes = {};
  registerOrchestratorRoutes((m, p, h) => { routes[`${m} ${p}`] = h; }, (res, data, code) => { res.payload = data; res.code = code || 200; }, orch, {
    getConfig: orch.getConfig, broadcast: () => {}, getUiContext: () => ({}), repoRoot,
  });
  const body = JSON.stringify({ cli: 'auto', prompt: 'corrige cette faute dans README.md', cwd: os.tmpdir(), autoPermit: true });
  const req = { on(ev, cb) { if (ev === 'data') cb(Buffer.from(body)); if (ev === 'end') cb(); return req; } };
  const res = {};
  await routes['POST /api/orchestrator/spawn'](req, res);
  assert.equal(res.code, 200, JSON.stringify(res.payload));
  assert.equal(res.payload.failedOverFrom.provider, 'codex-oss-local');
  assert.match(res.payload.failedOverFrom.reason, /lmstudio-unreachable/);
  assert.equal(res.payload.routingLocality, 'cloud');
  assert.equal(orch.spawns.filter(s => s.cli === 'codex-oss-local').length, 0, 'no doomed local launch');
  const done = await waitDone(orch, res.payload.id);
  assert.equal(done.state, STATE.COMPLETED);
  assert.equal(orch.routingTelemetry.summary().counts.LOCAL_TO_CLOUD_FAILOVER, 1);
});

test('15. Codex OSS says DONE but changed nothing -> unusable output, failover to cloud', async () => {
  // Reproduces the real run: codex-oss-local + Qwen 1.5B replied DONE after 273s, file untouched.
  const orch = makeOrch({ cfg: OPT_IN, script: { 'codex-oss-local': [{ code: 0, stdout: 'DONE' }, { code: 0, stdout: 'DONE' }] } });
  let tree = 'tree-v1';
  orch._gitTreeFingerprint = () => tree;
  await orch.localHealth.refresh({ force: true });
  const routing = orch.taskRouter.selectProvider({ prompt: 'corrige cette faute dans hello.txt' });
  assert.equal(routing.provider, 'codex-oss-local');
  const t1 = orch.spawnHeadless({ cli: routing.provider, prompt: 'corrige cette faute dans hello.txt', cwd: os.tmpdir(), expectsRepoChanges: true });
  markAuto(t1, routing);
  const d1 = await waitDone(orch, t1.id);
  assert.ok(!isLocalProvider(d1.cli), 'finished on cloud');
  assert.equal(d1.failedOverFrom.provider, 'codex-oss-local');
  assert.match(d1.failedOverFrom.reason, /repository is unchanged/);
  assert.equal(t1.execution.changeCheck, 'failed-no-changes');
  // Same task where the agent really edited the tree: counted as LOCAL_CODEX.
  orch._spawnImplOrig = orch._spawnImpl;
  orch._spawnImpl = (...a) => { const p = orch._spawnImplOrig(...a); p.once('close', () => {}); tree = 'tree-v2'; return p; };
  const t2 = orch.spawnHeadless({ cli: 'codex-oss-local', prompt: 'corrige cette faute dans hello.txt', cwd: os.tmpdir(), expectsRepoChanges: true });
  markAuto(t2, routing);
  const d2 = await waitDone(orch, t2.id);
  assert.equal(d2.cli, 'codex-oss-local');
  assert.equal(d2.routeCategory, ROUTES.LOCAL_CODEX);
  assert.equal(t2.execution.changeCheck, 'passed');
});

// ── Round 2: regressions found by the Claude + Codex reviews ─────────────────
const { classifyTask } = require('./task-roles');
const { gitTreeFingerprint } = require('./local-providers');

function httpSpawn(orch, body) {
  const { registerOrchestratorRoutes } = require('./routes');
  const repoRoot = tmpDir();
  fs.mkdirSync(path.join(repoRoot, 'config'), { recursive: true });
  fs.writeFileSync(path.join(repoRoot, 'config', 'config.json'), JSON.stringify({ Permissions: { mode: 'bypass', deny: [], ask: [], allow: [] } }));
  const routes = {};
  registerOrchestratorRoutes((m, p, h) => { routes[`${m} ${p}`] = h; }, (res, data, code) => { res.payload = data; res.code = code || 200; }, orch, {
    getConfig: orch.getConfig, broadcast: () => {}, getUiContext: () => ({}), repoRoot,
  });
  const raw = JSON.stringify({ cwd: os.tmpdir(), autoPermit: true, ...body });
  const req = { on(ev, cb) { if (ev === 'data') cb(Buffer.from(raw)); if (ev === 'end') cb(); return req; } };
  const res = {};
  return routes['POST /api/orchestrator/spawn'](req, res).then(() => res);
}

test('16. cancelling a local task never starts a cloud task (BLOCKER from review)', async () => {
  let release;
  const orch = makeOrch({ post: () => new Promise((resolve) => { release = resolve; }) });
  await orch.localHealth.refresh({ force: true });
  const routing = orch.taskRouter.selectProvider({ prompt: 'résume ce texte: bonjour le monde' });
  assert.equal(routing.provider, 'lmstudio-qwen-small');
  const task = orch.spawnHeadless({ cli: routing.provider, prompt: 'résume ce texte: bonjour le monde' });
  markAuto(task, routing);
  await new Promise(r => setTimeout(r, 20));
  assert.deepEqual(orch.cancelTask(task.id), { ok: true });
  if (release) release({ choices: [{ message: { content: 'late answer' }, finish_reason: 'stop' }] });
  await new Promise(r => setTimeout(r, 30));
  assert.equal(orch.spawns.length, 0, 'no CLI (cloud) spawned after cancel');
  const t = orch.tasks.get(task.id);
  assert.equal(t.cli, 'lmstudio-qwen-small');
  assert.equal(t.state, STATE.CANCELLED);
});

test('17. FR/EN classification: instruction verb vs payload, writes, security vocabulary, word boundaries', () => {
  const cases = [
    ['Classe ces tickets : bug critique, security issue, crash en production', 'simple'],
    ['classe ces éléments', 'simple'], ['résume ce fichier', 'simple'], ['extrais ces 20 valeurs', 'simple'],
    ['compresse ce contexte', 'simple'], ['traduis ce paragraphe en anglais', 'simple'],
    ['explique ce code', 'readonly-review'], ['Décris ce que fait foo.js', 'readonly-review'],
    ['corrige cette faute', 'small-edit'], ["lance Jest et corrige l'erreur", 'small-edit'],
    ['Rewrite the payment module in src/pay.js to use the new Stripe API', 'small-edit'],
    ['Extrais la fonction parseConfig de server.js dans un nouveau fichier', 'small-edit'],
    ['Update the README with the new options', 'small-edit'], ['Mets à jour le README', 'small-edit'],
    ['Bump the version in package.json to 2.0.0', 'small-edit'], ['Summarize this stack trace and fix the bug', 'small-edit'],
    ['Please translate the docs folder into Spanish and commit', 'small-edit'], ['Add a unit test for parseConfig', 'small-edit'],
    ['Delete the unused import in foo.js', 'complex'], ["analyse l'architecture de l'orchestrateur", 'complex'],
    ['investigue ce bug complexe en production', 'complex'], ['Refactor the whole orchestrator into TypeScript', 'complex'],
    ['Fix the race condition that corrupts data', 'complex'], ['Design a new sharding strategy', 'complex'],
    ['fais une security review', 'security'], ['fais une revue de sécurité complète', 'security'],
    ['Review this PR diff for token leakage and SSRF', 'security'], ['Review the password hashing in login.js', 'security'],
    ['Look for SSRF in fetchUrl()', 'security'], ['Is the JWT signature verification correct in auth.js?', 'security'],
    ['Vérifie si ce code a une fuite de mots de passe', 'security'], ['Summarize security vulnerabilities in auth.js', 'security'],
    ['Summarize the AUTHORS file', 'simple'],
  ];
  for (const [prompt, want] of cases) assert.equal(classifyTask({ prompt }).taskClass, want, prompt);
});

test('18. a local provider in cooldown is skipped; task-caused failures do not cool it down', async () => {
  const { router, health } = await makeRouter();
  health.recordOutcome('lmstudio-qwen-small', { ok: false, error: 'TIMEOUT' });
  const r = router.selectProvider({ prompt: 'résume ce texte: abc' });
  assert.equal(r.locality, 'cloud');
  assert.match(r.localSkipped['lmstudio-qwen-small'], /cooling down/);
  const { router: r2, health: h2 } = await makeRouter();
  h2.recordOutcome('lmstudio-qwen-small', { ok: false, error: 'TASK_ERROR', cooldown: false });
  assert.equal(r2.selectProvider({ prompt: 'résume ce texte: abc' }).provider, 'lmstudio-qwen-small');
});

test('19. codex-oss-local that cannot even launch fails over to cloud (no HTTP 400, no orphan task)', async () => {
  // Codex's lmstudio provider only targets :1234 -> a :1235 endpoint makes the spawn refuse.
  const orch = makeOrch({ cfg: { LocalFirst: { enableCodexOssSmallEdit: true, baseUrl: 'http://127.0.0.1:1235' } } });
  orch.localHealth.fetchJson = up();
  const res = await httpSpawn(orch, { cli: 'auto', prompt: 'corrige cette faute dans README.md' });
  assert.equal(res.code, 200, JSON.stringify(res.payload));
  assert.equal(res.payload.failedOverFrom.provider, 'codex-oss-local');
  assert.match(res.payload.failedOverFrom.reason, /only targets :1234/);
  assert.ok(!isLocalProvider(res.payload.cli));
  assert.equal([...orch.tasks.values()].filter(t => t.state === STATE.PENDING).length, 0, 'no orphan PENDING task');
  const done = await waitDone(orch, res.payload.id);
  assert.equal(done.state, STATE.COMPLETED);
  assert.equal(orch.routingTelemetry.summary().counts.LOCAL_TO_CLOUD_FAILOVER, 1);
});

test('20. claude-local: isolated config dir, no Bedrock/Vertex/AWS/proxy env, loopback enforced', async () => {
  const saved = { AWS_ACCESS_KEY_ID: process.env.AWS_ACCESS_KEY_ID, CLAUDE_CODE_USE_BEDROCK: process.env.CLAUDE_CODE_USE_BEDROCK, HTTPS_PROXY: process.env.HTTPS_PROXY, CODEX_OSS_BASE_URL: process.env.CODEX_OSS_BASE_URL };
  Object.assign(process.env, { AWS_ACCESS_KEY_ID: 'AKIA-TEST', CLAUDE_CODE_USE_BEDROCK: '1', HTTPS_PROXY: 'http://proxy.example:8080', CODEX_OSS_BASE_URL: 'https://example.com/v1' });
  try {
    const orch = makeOrch();
    await orch.localHealth.refresh({ force: true });
    const t = orch.spawnHeadless({ cli: 'claude-local', prompt: 'x', cwd: os.tmpdir() });
    await waitDone(orch, t.id);
    const env = orch.spawns.find(s => s.cli === 'claude').env;
    for (const k of ['AWS_ACCESS_KEY_ID', 'CLAUDE_CODE_USE_BEDROCK', 'HTTPS_PROXY', 'ANTHROPIC_API_KEY', 'CODEX_OSS_BASE_URL']) assert.equal(env[k], undefined, k);
    assert.equal(env.ANTHROPIC_BASE_URL, 'http://127.0.0.1:1234');
    assert.equal(env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC, '1');
    assert.ok(env.CLAUDE_CONFIG_DIR.startsWith(orch.workspaceDir));
    const c = orch.spawnHeadless({ cli: 'codex-oss-local', prompt: 'x', cwd: os.tmpdir() });
    await waitDone(orch, c.id);
    assert.equal(orch.spawns.find(s => s.cli === 'codex-oss-local').env.CODEX_OSS_BASE_URL, undefined);
    const bad = makeOrch({ cfg: { LocalFirst: { baseUrl: 'https://api.anthropic.com' } } });
    const before = bad.tasks.size;
    assert.throws(() => bad.spawnHeadless({ cli: 'claude-local', prompt: 'x', cwd: os.tmpdir() }), /not loopback/);
    assert.equal(bad.tasks.size, before, 'refused launch leaves no task behind');
  } finally {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
});

test('21. explicit local spawn (not auto) still fails over to cloud', async () => {
  const orch = makeOrch({ post: async () => { throw Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:1234'), { code: 'ECONNREFUSED' }); } });
  await orch.localHealth.refresh({ force: true });
  const res = await httpSpawn(orch, { cli: 'lmstudio-qwen-small', prompt: 'résume ce texte: abc' });
  assert.equal(res.code, 200, JSON.stringify(res.payload));
  assert.equal(res.payload.requestedCli, 'lmstudio-qwen-small');
  assert.ok(res.payload.fallbackChain.length > 0 && res.payload.fallbackChain.every(p => !isLocalProvider(p)));
  const done = await waitDone(orch, res.payload.id);
  assert.ok(!isLocalProvider(done.cli), `ended on cloud, got ${done.cli}`);
  assert.equal(done.state, STATE.COMPLETED);
});

test('22. direct local refuses blind reviews and truncated answers (-> cloud), accepts inline code', async () => {
  let calls = 0;
  const orch = makeOrch({ post: async () => { calls++; return { choices: [{ message: { content: 'partial…' }, finish_reason: 'length' }] }; } });
  await orch.localHealth.refresh({ force: true });
  const blind = orch.spawnLmStudio({ cli: 'lmstudio-qwen-small', prompt: 'Why does the app crash on startup?', requiresRepoContent: true, noFallback: true });
  const b = await waitDone(orch, blind.id);
  assert.equal(b.state, STATE.FAILED); assert.match(b.error, /local-cannot-read-repo/); assert.equal(calls, 0);
  assert.equal(b.errorClassification.noCooldown, true);
  const inline = orch.spawnLmStudio({ cli: 'lmstudio-qwen-small', prompt: 'review: function add(a,b){return a+b}', requiresRepoContent: true, noFallback: true });
  const i = await waitDone(orch, inline.id);
  assert.equal(calls, 1, 'inline code is enough to run locally');
  assert.equal(i.state, STATE.FAILED); assert.match(i.error, /truncated/);
});

test('23. false-success guard on a real git repo: pre-existing dirt, new file, deletion, non-git', async () => {
  const { spawnSync } = require('child_process');
  const repo = tmpDir();
  const git = (...a) => spawnSync('git', a, { cwd: repo, encoding: 'utf8' });
  git('init', '-q'); git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'init');
  fs.writeFileSync(path.join(repo, 'a.txt'), 'one\n'); git('add', '.'); git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'a');
  fs.writeFileSync(path.join(repo, 'a.txt'), 'user edit already there\n'); // pre-existing user change
  const before = gitTreeFingerprint(repo);
  assert.ok(before);
  assert.equal(gitTreeFingerprint(repo), before, 'agent did nothing: same fingerprint despite pre-existing dirt');
  fs.writeFileSync(path.join(repo, 'a.txt'), 'user edit already there\nplus agent line\n');
  assert.notEqual(gitTreeFingerprint(repo), before, 'further edit to an already-dirty file is detected');
  const s2 = gitTreeFingerprint(repo);
  fs.writeFileSync(path.join(repo, 'new.txt'), 'new\n');
  assert.notEqual(gitTreeFingerprint(repo), s2, 'new untracked file detected');
  const s3 = gitTreeFingerprint(repo);
  fs.unlinkSync(path.join(repo, 'new.txt')); fs.unlinkSync(path.join(repo, 'a.txt'));
  assert.notEqual(gitTreeFingerprint(repo), s3, 'deletion detected');
  assert.equal(gitTreeFingerprint(tmpDir()), null, 'not a git repo');
  // Non-git write task: success cannot be verified -> failure -> cloud.
  const orch = makeOrch({ cfg: OPT_IN, script: { 'codex-oss-local': [{ code: 0, stdout: 'DONE' }] } });
  orch._gitTreeFingerprint = () => null;
  await orch.localHealth.refresh({ force: true });
  const routing = orch.taskRouter.selectProvider({ prompt: 'corrige cette faute dans hello.txt' });
  const t = orch.spawnHeadless({ cli: 'codex-oss-local', prompt: 'corrige cette faute dans hello.txt', cwd: tmpDir(), expectsRepoChanges: true });
  markAuto(t, routing);
  const d = await waitDone(orch, t.id);
  assert.ok(!isLocalProvider(d.cli));
  assert.equal(t.execution.changeCheck, 'failed-unverifiable');
});

test('24. a process that emits error then close fails over exactly once', async () => {
  const orch = makeOrch();
  await orch.localHealth.refresh({ force: true });
  const orig = orch._spawnImpl;
  orch._spawnImpl = (command, args, opts) => {
    if (!args.includes('--oss')) return orig(command, args, opts);
    orch.spawns.push({ cli: 'codex-oss-local', args, env: opts.env });
    const p = new EventEmitter(); p.stdin = { write() {}, end() {} }; p.stdout = new EventEmitter(); p.stderr = new EventEmitter(); p.kill = () => {};
    setImmediate(() => { p.emit('error', new Error('spawn EPIPE')); p.emit('close', 1); });
    return p;
  };
  const t = orch.spawnHeadless({ cli: 'codex-oss-local', prompt: 'corrige la faute', cwd: os.tmpdir() });
  Object.assign(t, { selectedProvider: 'codex-oss-local', routingHistory: [], _autoRouting: true, _automaticFallback: true, _escalationChain: ['codex', 'claude'], _escalationPrompt: 'corrige la faute' });
  await waitDone(orch, t.id);
  await new Promise(r => setTimeout(r, 30));
  assert.deepEqual(orch.spawns.map(s => s.cli), ['codex-oss-local', 'codex'], 'one failover, not two');
});

test('25. refilled escalation chain respects OrchestrateCliList and MaxFallbackAttempts', async () => {
  const orch = makeOrch({ cfg: { OrchestrateCliList: ['codex', 'claude'], MaxFallbackAttempts: 1 }, script: {
    'codex-oss-local': [{ code: 1, stderr: 'boom' }], codex: [{ code: 1, stderr: 'quota exceeded' }], claude: [{ code: 1, stderr: 'quota exceeded' }],
  } });
  await orch.localHealth.refresh({ force: true });
  const t = orch.spawnHeadless({ cli: 'codex-oss-local', prompt: 'corrige la faute', cwd: os.tmpdir() });
  Object.assign(t, { selectedProvider: 'codex-oss-local', routingHistory: [], _autoRouting: true, _automaticFallback: true, _escalationChain: [], _escalationPrompt: 'corrige la faute' });
  const d = await waitDone(orch, t.id);
  assert.equal(d.state, STATE.FAILED);
  const clis = orch.spawns.map(s => s.cli);
  assert.equal(clis[0], 'codex-oss-local');
  assert.equal(clis.length, 2, `exactly MaxFallbackAttempts(1) cloud attempt, got ${clis.join(',')}`);
  assert.ok(clis.slice(1).every(c => ['codex', 'claude'].includes(c)), `only enabled CLIs, got ${clis.join(',')}`);
});

test('26. cancelling or timing out a local agent kills its whole process tree', async () => {
  const orch = makeOrch();
  const killed = [];
  orch._killTreeImpl = (pid) => killed.push(pid);
  orch._spawnImpl = (command, args, opts) => {
    const p = new EventEmitter(); p.pid = 4242; p.stdin = { write() {}, end() {} }; p.stdout = new EventEmitter(); p.stderr = new EventEmitter();
    p.kill = () => { throw new Error('plain kill must not be used for local agents'); };
    return p;
  };
  await orch.localHealth.refresh({ force: true });
  const t = orch.spawnHeadless({ cli: 'codex-oss-local', prompt: 'x', cwd: os.tmpdir() });
  assert.ok(t._escalationChain && t._escalationChain.length, 'has a cloud chain (so a failover WOULD be possible)');
  assert.deepEqual(orch.cancelTask(t.id), { ok: true });
  assert.deepEqual(killed, [4242]);
  await new Promise(r => setTimeout(r, 20));
  assert.equal(orch.tasks.get(t.id).state, STATE.CANCELLED, 'cancel did not turn into a cloud task');
  // Timeout path: tree kill, then exactly one failover to cloud.
  const o2 = makeOrch({ cfg: { LocalFirst: { timeouts: { 'codex-oss-local': 30 } } } });
  const killed2 = [];
  o2._killTreeImpl = (pid) => killed2.push(pid);
  const cloudSpawn = o2._spawnImpl;
  o2._spawnImpl = (command, args, opts) => {
    if (!args.includes('--oss')) return cloudSpawn(command, args, opts);
    const p = new EventEmitter(); p.pid = 5151; p.stdin = { write() {}, end() {} }; p.stdout = new EventEmitter(); p.stderr = new EventEmitter();
    p.kill = () => { throw new Error('plain kill must not be used for local agents'); };
    return p; // never exits on its own
  };
  await o2.localHealth.refresh({ force: true });
  const t2 = o2.spawnHeadless({ cli: 'codex-oss-local', prompt: 'explique ce code', cwd: os.tmpdir() });
  const d2 = await waitDone(o2, t2.id);
  assert.deepEqual(killed2, [5151], 'timed-out local agent killed as a tree');
  assert.ok(!isLocalProvider(d2.cli), `timeout failed over to cloud, got ${d2.cli}`);
  assert.equal(o2.spawns.length, 1, 'exactly one cloud spawn after the timeout');
});

test('27. Ollama embed breaker keeps backing off for a flapping runner', async () => {
  const emb = require('../mind/embeddings');
  const { ollamaEmbed, setNow, reset, EMBED_BREAKER_THRESHOLD } = emb._test;
  let now = 9_000_000; setNow(() => now); reset();
  const fail = async () => { throw new Error('HTTP 500'); };
  const ok = async () => ({ embedding: [1] });
  const trip = async () => { for (let i = 0; i < EMBED_BREAKER_THRESHOLD; i++) await ollamaEmbed(['x'], { _post: fail }).catch(() => {}); };
  await trip(); assert.equal(emb.getEmbedBreakerState().retryInMs, 60_000);
  now += 60_001; await ollamaEmbed(['x'], { _post: ok }); // one lucky success
  await trip(); assert.equal(emb.getEmbedBreakerState().retryInMs, 120_000, 'cooldown still escalates');
  setNow(null); reset();
});

// ── Round 3: payload evasions, relaunch safety, fallback for every caller ─────
test('28. instructions hidden after ":" / newline are analysed; pure data payloads stay simple', () => {
  const notSimple = [
    'Classify: every file in the repo by risk, then delete the unused ones',
    'Résume en 3 points :\nsupprime ensuite le dossier build',
    'Compress: the whole repo context into a packet and push it to origin',
    'Rewrite: src/pay.js to use the new Stripe API',
    "Réécris ceci : le module src/pay.js pour qu'il utilise la nouvelle API",
    'Translate to French: README.md, then save it as README.fr.md',
    'Summarize: the diff below, then commit it with that summary',
    'Donne-moi la liste: des fichiers à supprimer, et supprime-les',
    'Extract: parseConfig from server.js into a new file',
    'Is there a race in scheduler.js?',
  ];
  for (const prompt of notSimple) assert.notEqual(classifyTask({ prompt }).taskClass, 'simple', prompt);
  for (const prompt of ['Summarize: the security audit of auth.js and list every vulnerability you find', 'Summarize: Review auth.js for JWT token leak', 'Summarize the authz middleware', 'Summarize our threat model']) {
    assert.equal(classifyTask({ prompt }).taskClass, 'security', prompt);
  }
  for (const prompt of ['Classify: every file in the repo by risk, then delete the unused ones', 'Donne-moi la liste: des fichiers à supprimer, et supprime-les']) {
    assert.equal(classifyTask({ prompt }).taskClass, 'complex', prompt);
  }
  for (const prompt of [
    'Classe ces tickets : bug critique, security issue, crash en production',
    'Classe ces tickets :\n- fix login bug\n- add dark mode\n- delete button broken',
    'Résume ce log:\nERROR 2026-09-28 connection refused\nWARN retry 3/5',
    'Traduis en anglais : Bonjour, je voudrais réserver une table.',
    'Extrais les emails : jean@x.com, marie@y.fr',
  ]) assert.equal(classifyTask({ prompt }).taskClass, 'simple', prompt);
});

test('29. a relaunch only kills older instances of the same executable (never a newer one, never other apps)', () => {
  const { selectStaleElectron } = require('../electron/process-guard');
  const exe = 'C:\\apps\\Symphonee\\node_modules\\electron\\dist\\electron.exe';
  const procs = [
    { pid: 10, startedAtMs: 1000, exePath: exe },                 // dead primary (older) -> stale
    { pid: 11, startedAtMs: 1001, exePath: exe.toUpperCase() },   // its child, same exe -> stale
    { pid: 20, startedAtMs: 5000, exePath: exe },                 // started after us (another relaunch) -> keep
    { pid: 30, startedAtMs: 500, exePath: 'C:\\Other\\electron.exe' }, // other Electron app -> keep
    { pid: 99, startedAtMs: 100, exePath: exe },                  // ourselves -> keep
    { pid: 40, startedAtMs: NaN, exePath: exe },                  // unknown start -> keep
  ];
  assert.deepEqual(selectStaleElectron(procs, { myPid: 99, myStartMs: 3000, exePath: exe }).sort(), [10, 11]);
});

test('30. local runs from any caller get the cloud safety net; read-only local questions need no diff', async () => {
  // A caller that bypasses /spawn (followup, graph run, dependency queue...).
  const orch = makeOrch({ post: async () => { throw Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:1234'), { code: 'ECONNREFUSED' }); } });
  await orch.localHealth.refresh({ force: true });
  const t = orch.spawnHeadless({ cli: 'lmstudio-qwen-small', prompt: 'résume ce texte: abc' });
  const d = await waitDone(orch, t.id);
  assert.ok(!isLocalProvider(d.cli), `failed over to cloud, got ${d.cli}`);
  assert.equal(d.state, STATE.COMPLETED);
  // noFallback keeps it local-only.
  const t2 = orch.spawnHeadless({ cli: 'lmstudio-qwen-small', prompt: 'résume ce texte: abc', noFallback: true });
  assert.equal((await waitDone(orch, t2.id)).state, STATE.FAILED);
  // Read-only question to codex-oss-local, outside git: must not be failed for "no diff".
  const o2 = makeOrch({ script: { 'codex-oss-local': [{ code: 0, stdout: 'It parses the config.' }] } });
  o2._gitTreeFingerprint = () => null;
  await o2.localHealth.refresh({ force: true });
  const q = o2.spawnHeadless({ cli: 'codex-oss-local', prompt: 'explique ce code', cwd: tmpDir() });
  const qd = await waitDone(o2, q.id);
  assert.equal(qd.cli, 'codex-oss-local'); assert.equal(qd.state, STATE.COMPLETED);
  assert.equal(q.execution.changeCheck, undefined, 'no write expected, no change check');
});

test('31. circuit-open local launch fails over via HTTP, and the fallback CLI goes through the permission gate', async () => {
  const orch = makeOrch({ cfg: OPT_IN });
  for (let i = 0; i < 3; i++) orch.circuitBreaker.recordFailure('codex-oss-local', 'timed out');
  const ok = await httpSpawn(orch, { cli: 'auto', prompt: 'corrige cette faute dans README.md' });
  assert.equal(ok.code, 200, JSON.stringify(ok.payload));
  assert.match(ok.payload.failedOverFrom.reason, /circuit breaker is OPEN/);
  assert.equal(orch.spawns.filter(s => s.cli === 'codex-oss-local').length, 0);
  // Same, but every cloud spawn is denied: the fallback must be gated (403), not run silently.
  const { registerOrchestratorRoutes } = require('./routes');
  const o2 = makeOrch({ cfg: OPT_IN });
  for (let i = 0; i < 3; i++) o2.circuitBreaker.recordFailure('codex-oss-local', 'timed out');
  const repoRoot = tmpDir();
  fs.mkdirSync(path.join(repoRoot, 'config'), { recursive: true });
  fs.writeFileSync(path.join(repoRoot, 'config', 'config.json'), JSON.stringify({ Permissions: { mode: 'bypass', deny: ['cli:claude:spawn', 'cli:codex:spawn', 'cli:gemini:spawn', 'cli:copilot:spawn', 'cli:gemini-api:spawn'], ask: [], allow: [] } }));
  const routes = {};
  let status = null;
  registerOrchestratorRoutes((m, p, h) => { routes[`${m} ${p}`] = h; }, (res, data, code) => { res.payload = data; status = code || 200; }, o2, { getConfig: o2.getConfig, broadcast: () => {}, getUiContext: () => ({}), repoRoot });
  const raw = JSON.stringify({ cli: 'auto', prompt: 'corrige cette faute dans README.md', cwd: os.tmpdir(), autoPermit: true });
  const req = { on(ev, cb) { if (ev === 'data') cb(Buffer.from(raw)); if (ev === 'end') cb(); return req; } };
  const res = { writeHead(code) { status = code; return this; }, end() {} };
  await routes['POST /api/orchestrator/spawn'](req, res);
  assert.equal(status, 403, 'fallback cloud CLI was checked by the permission gate');
  assert.equal(o2.spawns.length, 0, 'nothing spawned');
});

test('32. explicit local request with no usable cloud provider still runs locally (no crash)', async () => {
  const orch = makeOrch({ cfg: { OrchestrateCliList: ['nonexistent-cli'] }, post: async () => { throw new Error('connect ECONNREFUSED 127.0.0.1:1234'); } });
  await orch.localHealth.refresh({ force: true });
  const res = await httpSpawn(orch, { cli: 'lmstudio-qwen-small', prompt: 'résume ce texte: abc' });
  assert.equal(res.code, 200, JSON.stringify(res.payload));
  const d = await waitDone(orch, res.payload.id);
  assert.equal(d.state, STATE.FAILED, 'no cloud to fail over to: reported as failed, not hidden');
  assert.equal(orch.spawns.length, 0);
});

test('33. routed read-only review with nothing to read never calls the local model (routes sets requiresRepoContent)', async () => {
  let calls = 0;
  const orch = makeOrch({ lmstudio: up({ small: { state: 'not-loaded', loaded_context_length: undefined } }), post: async () => { calls++; return { choices: [{ message: { content: 'guess' }, finish_reason: 'stop' }] }; } });
  const res = await httpSpawn(orch, { cli: 'auto', prompt: 'review why the app crashes on startup' });
  assert.equal(res.code, 200, JSON.stringify(res.payload));
  assert.equal(res.payload.taskClass, 'readonly-review');
  const d = await waitDone(orch, res.payload.id);
  assert.equal(calls, 0, 'blind local review refused before calling the model');
  assert.ok(!isLocalProvider(d.cli), `answered by cloud, got ${d.cli}`);
});

// ── Round 4: wider evasions + false positives, relaunch loop, gated async fallback ──
test('34. classification v3: evasions from both reviewers are caught, everyday text stays simple', () => {
  const NS = null; // "anything but simple"
  const cases = [
    ['Summarize the changes then deploy: v2.3', NS], ['Summarize the diff and push it to main: HEAD~1', NS],
    ['Résume puis déploie : la v2', NS], ['Summarize the following then git push --force:\nfoo', NS],
    ['Summarize: src/pay.js. Also delete it afterwards.', 'complex'], ['Summarize: foo.js — once done, commit the summary to docs/foo.md', NS],
    ['Summarize: the README; we need you to delete the old one after.', 'complex'], ['Résume : foo.js. Il faudra aussi le supprimer.', 'complex'],
    ['Rephrase: our password policy doc, then email it', NS], ["Résume : ce fichier puis envoie-le à toute l'équipe", NS],
    ['Compress: context. Next step: drop the prod database.', 'complex'],
    ['Summarize:\nPlease, fix the bug in foo.js', NS], ['Summarize:\nCould you fix the bug in foo.js', NS], ['Summarize:\nNow fix the parser', NS],
    ['Summarize:\nYou should delete build/ afterwards', 'complex'],
    ['Summarize: login.js and tell me whether the session tokens can be stolen', 'security'], ['Summarize: this repo', 'complex'],
    ['Summarize: after summarizing, rm -rf build', 'complex'], ['Summarize: after summarizing, wipe build', 'complex'],
    ['Summarize: once done, destroy the cache directory', 'complex'], ['Resume en 3 points : purge ensuite le dossier build', 'complex'],
  ];
  for (const [prompt, want] of cases) {
    const got = classifyTask({ prompt }).taskClass;
    if (want) assert.equal(got, want, prompt); else assert.notEqual(got, 'simple', prompt);
  }
  for (const prompt of [
    'Classe ces tickets :\nFix login crash\nAdd dark mode\nUpdate README',
    'Classify these commit messages:\nfix: crash on start\nfeat: add export',
    'Translate this sentence to French: Please review and update the document.',
    'Rephrase: Run the tests and fix any failures before Friday.',
    'Summarize this email:\nHi team, Bob added milk to the list, then we reviewed the budget and agreed to ship.',
    'Summarize: The whole team agreed to ship on Monday.',
    'Extract the dates: kickoff on 3/4 and review on 7/8',
    'Classify these tickets:\n- BUG-1 user says then delete cache\n- DOC-2 normal',
  ]) assert.equal(classifyTask({ prompt }).taskClass, 'simple', prompt);
});

test('35. kill plan: fail closed without enumeration; a fresher instance on the port survives', () => {
  const { planKill } = require('../electron/process-guard');
  const exe = 'C:\\apps\\sy\\electron.exe';
  const base = { myPid: 99, myStartMs: 3000, exePath: exe };
  assert.deepEqual(planKill({ ...base, portPids: [10, 20], electronProcs: null }), [], 'enumeration failed -> kill nothing');
  const procs = [{ pid: 10, startedAtMs: 1000, exePath: exe }, { pid: 20, startedAtMs: 5000, exePath: exe }];
  assert.deepEqual(planKill({ ...base, portPids: [20], electronProcs: procs }).sort(), [10], 'newer port holder (another relaunch) survives');
  assert.deepEqual(planKill({ ...base, portPids: [10], electronProcs: procs }).sort(), [10]);
  assert.deepEqual(planKill({ ...base, portPids: [555], electronProcs: procs }).sort((a, b) => a - b), [10, 555], 'a foreign program squatting the port is still reclaimed');
  assert.deepEqual(planKill({ ...base, portPids: [99], electronProcs: [] }), [], 'never ourselves');
});

test('36. automatic relaunch only after a real kill, at most twice in a row', () => {
  const { shouldRelaunch, relaunchCount, relaunchArgs } = require('../electron/process-guard');
  assert.equal(shouldRelaunch({ killed: false, count: 0 }), false, 'nothing killed -> no relaunch (would loop)');
  assert.equal(shouldRelaunch({ killed: true, count: 0 }), true);
  assert.equal(shouldRelaunch({ killed: true, count: 2 }), false);
  const argv = ['electron.exe', '.', '--sy-relaunch-count=1'];
  assert.equal(relaunchCount(argv), 1);
  assert.deepEqual(relaunchArgs(argv), ['.', '--sy-relaunch-count=2']);
  assert.equal(relaunchCount(['electron.exe', '.']), 0);
});

test('37. asynchronous fallbacks never start a CLI the permission rules deny', async () => {
  const cfgDir = tmpDir();
  const cfgPath = path.join(cfgDir, 'config.json');
  fs.writeFileSync(cfgPath, JSON.stringify({ Permissions: { mode: 'edit', deny: ['cli:claude:spawn'], ask: [], allow: [] } }));
  const orch = makeOrch({ script: { 'codex-oss-local': [{ code: 1, stderr: 'boom' }] } });
  orch.permissionsConfigPath = cfgPath;
  const events = [];
  orch.broadcast = (e) => events.push(e);
  await orch.localHealth.refresh({ force: true });
  const t = orch.spawnHeadless({ cli: 'codex-oss-local', prompt: 'corrige la faute', cwd: os.tmpdir() });
  Object.assign(t, { selectedProvider: 'codex-oss-local', routingHistory: [], _autoRouting: true, _automaticFallback: true, _escalationChain: ['claude', 'codex'], _escalationPrompt: 'corrige la faute' });
  const d = await waitDone(orch, t.id);
  assert.deepEqual(orch.spawns.map(s => s.cli), ['codex-oss-local', 'codex'], 'denied claude skipped, allowed codex used');
  assert.equal(d.cli, 'codex');
  assert.ok(events.some(e => e.event === 'fallback-blocked' && e.to === 'claude'));
  // Review mode denies every cli spawn: no fallback at all.
  fs.writeFileSync(cfgPath, JSON.stringify({ Permissions: { mode: 'review', deny: [], ask: [], allow: [] } }));
  const o2 = makeOrch({ script: { 'codex-oss-local': [{ code: 1, stderr: 'boom' }] } });
  o2.permissionsConfigPath = cfgPath;
  await o2.localHealth.refresh({ force: true });
  const t2 = o2.spawnHeadless({ cli: 'codex-oss-local', prompt: 'corrige la faute', cwd: os.tmpdir() });
  Object.assign(t2, { selectedProvider: 'codex-oss-local', routingHistory: [], _autoRouting: true, _automaticFallback: true, _escalationChain: ['claude', 'codex'], _escalationPrompt: 'corrige la faute' });
  const d2 = await waitDone(o2, t2.id);
  assert.equal(d2.state, STATE.FAILED);
  assert.deepEqual(o2.spawns.map(s => s.cli), ['codex-oss-local'], 'review mode: no cloud fallback spawned');
});

// ── Round 5: data-noun payloads, verb-adjacent connectors, perf, verified kill, fail-closed rules ──
test('38. classification v4: documents named in the instruction are data; remaining evasions caught', () => {
  const simple = [
    'Summarize the project status: on track', 'Summarize: the project timeline slipped two weeks',
    'Classify these logs:\nuser bob deleted file report.pdf', "Résume ce log : l'utilisateur a supprimé le fichier",
    'Summarize this incident: the intern ran rm -rf on staging and we restored from backup',
    'Summarize this changelog: dropped the legacy table, removed old API', 'Classify this sentence: please delete my account',
    'Extract the action items: Bob will send the report, then Alice will deploy',
    'Summarize this chat: can you check the numbers? also please update the deck',
    'Summarize this paragraph: Please remember to save your work often.',
    'Résume ce mail : peux-tu vérifier les chiffres et envoyer le rapport ?',
    'Translate this sentence to French: First review and update the document, then email it.',
    'Rephrase: Please delete the temporary files once done.',
  ];
  for (const prompt of simple) assert.equal(classifyTask({ prompt }).taskClass, 'simple', prompt);
  const notSimple = [
    'Summarize: the logs, then kill the server', 'Summarize: the logs, then restart prod', 'Résume : les logs, puis redémarre le serveur',
    'Summarize: the config, then chmod 777 /etc', 'Summarize: foo.js, then overwrite it with the summary', 'Summarize: foo.js, then get rid of it',
    'Résume : foo.js. Tu peux ensuite le virer', 'Summarize: the issues. Then label each GitHub issue accordingly',
    'Summarize:\nThe payment module is old.\nIt uses Stripe v1.\nFix the bug in src/pay.js.',
    'Résume :\nLe module de paiement est vieux.\nIl utilise Stripe v1.\nCorrige le bug dans src/pay.js.',
    'Donne-moi la liste: des fichiers à supprimer, et supprime-les',
  ];
  for (const prompt of notSimple) assert.notEqual(classifyTask({ prompt }).taskClass, 'simple', prompt);
  for (const prompt of ['Summarize: login.js — is the session cookie HttpOnly?', 'Summarize: login.js — could an attacker bypass the login?',
    'Summarize: can the refresh token be stolen?', 'Summarize: can cookies be stolen?', 'Summarize: login.js and tell me whether cookies can be stolen']) {
    assert.equal(classifyTask({ prompt }).taskClass, 'security', prompt);
  }
  for (const prompt of ['Summarize my codebase', 'Résume mon projet', 'Summarize src/', 'Summarize: all source code',
    'Summarize: after summarizing, erase build', 'Summarize: after summarizing, del build', 'Summarize: after summarizing, rmdir /s build']) {
    assert.equal(classifyTask({ prompt }).taskClass, 'complex', prompt);
  }
});

test('39. classification stays linear on long / pathological inputs (no regex blow-up)', () => {
  const N = 200000;
  const inputs = [
    'Summarize: after summarizing, rm -' + 'w'.repeat(N), 'Summarize: ' + 'a'.repeat(N), 'Summarize: ' + 'then '.repeat(N / 5),
    'Summarize: then ' + 'x, '.repeat(N / 3), 'Résume : ' + 'é'.repeat(N), 'Summarize: drop ' + 'the '.repeat(N / 4),
    'Summarize this ' + 'big '.repeat(N / 4) + 'email: hi', 'Summarize: cookie ' + 'x '.repeat(N / 2), 'Summarize:\n' + 'line\n'.repeat(N / 5),
    'Summarize: ' + 'a/'.repeat(N / 2), 'x '.repeat(N / 2) + 'y.js',
  ];
  for (const prompt of inputs) {
    const t0 = Date.now();
    classifyTask({ prompt });
    const ms = Date.now() - t0;
    assert.ok(ms < 1000, `${ms}ms for ${JSON.stringify(prompt.slice(0, 40))}...`);
  }
  const { inlineReferencedFiles } = require('./local-providers');
  const t0 = Date.now(); inlineReferencedFiles('x ' + 'w'.repeat(N), os.tmpdir());
  assert.ok(Date.now() - t0 < 1000);
});

test('40. stale-process kill is judged by verification, not by taskkill exit code', () => {
  const { killAndVerify } = require('../electron/process-guard');
  const alive = new Set([10, 11]);
  // PID 11 is a child that already died with its parent: taskkill fails for it.
  const kill = (pid) => { if (pid === 11) { alive.delete(11); throw new Error('ERROR: process not found (exit 128)'); } alive.delete(pid); };
  alive.delete(11);
  assert.equal(killAndVerify([10, 11], { kill, isAlive: (p) => alive.has(p), sleepMs: () => {} }), true);
  const stubborn = new Set([20]);
  assert.equal(killAndVerify([20], { kill: () => { throw new Error('Access is denied'); }, isAlive: (p) => stubborn.has(p), sleepMs: () => {} }), false);
  assert.equal(killAndVerify([], { kill: () => {}, isAlive: () => false, sleepMs: () => {} }), false, 'nothing to kill -> not "killed"');
});

test('41. fallback permission: corrupt rules fail closed, missing rules keep defaults, deny wins', () => {
  const { _fallbackPermission: fp } = require('./escalation');
  const dir = tmpDir();
  const p = path.join(dir, 'config.json');
  assert.equal(fp(path.join(dir, 'missing.json'), 'claude', false), 'ask', 'missing config: app-wide defaults (edit mode)');
  fs.writeFileSync(p, '{ "Permissions": { "mode": "bypass", ');
  assert.equal(fp(p, 'claude', false), 'deny', 'truncated / corrupt JSON');
  fs.writeFileSync(p, JSON.stringify({ Permissions: 'bypass' }));
  assert.equal(fp(p, 'claude', false), 'deny', 'Permissions of the wrong type');
  fs.writeFileSync(p, JSON.stringify({ Permissions: { mode: 'bypass', deny: ['cli:claude:spawn'], ask: [], allow: [] } }));
  assert.equal(fp(p, 'claude', false), 'deny');
  assert.equal(fp(p, 'codex', false), 'allow');
  // End to end: a corrupt config blocks the asynchronous fallback.
  fs.writeFileSync(p, '{not json');
  const orch = makeOrch({ script: { 'codex-oss-local': [{ code: 1, stderr: 'boom' }] } });
  orch.permissionsConfigPath = p;
  return orch.localHealth.refresh({ force: true }).then(async () => {
    const t = orch.spawnHeadless({ cli: 'codex-oss-local', prompt: 'corrige la faute', cwd: os.tmpdir() });
    Object.assign(t, { selectedProvider: 'codex-oss-local', routingHistory: [], _autoRouting: true, _automaticFallback: true, _escalationChain: ['claude', 'codex'], _escalationPrompt: 'corrige la faute' });
    const d = await waitDone(orch, t.id);
    assert.equal(d.state, STATE.FAILED);
    assert.deepEqual(orch.spawns.map(s => s.cli), ['codex-oss-local'], 'no cloud spawn with unreadable permission rules');
  });
});

// ── Round 6: orders after a named document, instruction-level "and <verb>", strict rules, real wait ──
test('42. an order placed after a named document is not data; the document body still is', () => {
  const notSimple = [
    'Summarize this ticket: login crashes on submit. Then fix it in auth.js',
    'Summarize this ticket:\nLogin crashes on submit.\nFix it in src/auth.js please',
    'Résume ce log : erreur 500 sur /api. Puis corrige le bug dans server.js',
    'Résume ce ticket :\nLe login plante.\nCorrige-le dans auth.js',
    'Summarize this stack trace:\nTypeError at foo.js:12\n\nThen fix foo.js',
    'Summarize the following PR and merge it:\n+ foo',
    'Classify these tickets and close the duplicates:\n- A\n- B',
    'Résume ce log et supprime-le : erreur 500',
    'Summarize this report and share it with the team: Revenue is up.',
    'Summarize this paragraph and post it to Slack: release notes',
    'Classify this ticket and assign it to Bob: auth bypass possible',
  ];
  for (const prompt of notSimple) assert.notEqual(classifyTask({ prompt }).taskClass, 'simple', prompt);
  assert.equal(classifyTask({ prompt: 'Summarize these logs:\nERROR disk full\nWARN retry\nAlso delete the old log files' }).taskClass, 'complex');
  assert.equal(classifyTask({ prompt: 'Summarize this issue:\nUsers report XSS in the comment form. Please patch comments.js' }).taskClass, 'security');
  assert.equal(classifyTask({ prompt: 'Summarize this email: is our password reset flow vulnerable?' }).taskClass, 'security');
  assert.equal(classifyTask({ prompt: 'Is this email a phishing attempt? From: bank@x.co' }).taskClass, 'security');
  for (const prompt of [
    'Summarize this chat: can you check the numbers? also please update the deck',
    'Summarize this paragraph: Please remember to save your work often.',
    'Classify this sentence: please delete my account',
    'Classe ces tickets :\nFix login crash\nAdd dark mode\nUpdate README',
    'Summarize this email:\nHi team,\nThe release slipped.\nThanks, Bob',
    'Summarize this report: SQL injection found in login.js last quarter, fixed since',
    'Summarize and translate: bonjour tout le monde',
  ]) assert.equal(classifyTask({ prompt }).taskClass, 'simple', prompt);
});

test('43. fallback rules: any malformed Permissions field denies (no silent normalisation)', () => {
  const { _fallbackPermission: fp } = require('./escalation');
  const p = path.join(tmpDir(), 'config.json');
  const bad = [
    { mode: 'bypass', deny: 'cli:claude:spawn' }, { mode: 'bypass', deny: null }, { mode: 'weird' },
    { mode: 'bypass', deny: [1] }, { mode: 'bypass', allow: 'cli:*' }, { mode: 'bypass', ask: {} },
  ];
  for (const perm of bad) { fs.writeFileSync(p, JSON.stringify({ Permissions: perm })); assert.equal(fp(p, 'claude', false), 'deny', JSON.stringify(perm)); }
  fs.writeFileSync(p, JSON.stringify({ Permissions: { mode: 'bypass' } }));
  assert.equal(fp(p, 'claude', false), 'allow', 'well-formed config keeps its meaning');
  fs.writeFileSync(p, JSON.stringify({ OtherSetting: true }));
  assert.equal(fp(p, 'claude', false), 'ask', 'no Permissions block: app defaults');
});

test('44. stale-process verification really waits (~2s) before declaring a survivor', () => {
  const { killAndVerify } = require('../electron/process-guard');
  const t0 = Date.now();
  assert.equal(killAndVerify([424242], { kill: () => {}, isAlive: () => true }), false);
  const waited = Date.now() - t0;
  assert.ok(waited >= 1500, `waited only ${waited}ms`);
  // A process that exits slowly (e.g. stuck in a GPU driver after /F) is still seen as killed.
  let calls = 0;
  assert.equal(killAndVerify([7], { kill: () => {}, isAlive: () => ++calls < 5 }), true);
});

// ── Round 7: orders at the end of a named document (one line, sign-offs, pronouns) ──
test('45. end-of-document orders are caught; ordinary e-mail / README endings stay text', () => {
  const cases = [
    ['Summarize this ticket: login crashes on Safari. Then fix the bug.', null],
    ['Résume ce ticket : le login plante sur Safari. Puis corrige le bug.', null],
    ['Summarize this log: disk full on /var. Then delete the old logs.', 'complex'],
    ['Résume ce log : disque plein. Ensuite supprime les vieux logs.', 'complex'],
    ['Summarize this issue:\nLogin crashes.\nFix it in auth.js.\n\nThanks!', null],
    ['Summarize this ticket:\nLogin crashes on Safari.\nThen fix it in auth.js.\n-- sent from my phone', null],
    ['Summarize this email: our admin password leaked in a screenshot, rotate it', 'security'],
    ['Résume ce mail : notre mot de passe admin a fuité, change-le', 'security'],
    ['Summarize this ticket: Auth bypass possible. Fix it', 'security'],
    ['Summarize this ticket: Auth bypass possible. Then fix it', 'security'],
    ['Résume ce ticket : bypass auth possible. Corrige-le', 'security'],
    ['Summarize this ticket: Auth bypass possible. Delete it', 'security'],
    ['Summarize these logs:\nERROR disk full\nWARN retry\nAlso delete the old log files', 'complex'],
  ];
  for (const [prompt, want] of cases) {
    const got = classifyTask({ prompt }).taskClass;
    if (want) assert.equal(got, want, prompt); else assert.notEqual(got, 'simple', prompt);
  }
  for (const prompt of [
    'Summarize this email:\nHi Bob,\nThe Q3 numbers are in.\nPlease review the attached draft.',
    'Résume ce mail :\nBonjour,\nLes chiffres sont arrivés.\nMerci de vérifier le document joint.',
    'Summarize this chat:\nA: hi\nB: can you send me the report?',
    'Summarize this README:\n# Install\nRun npm install then npm start',
    'Summarize this document:\nStep 1. Open the app.\nStep 2. Delete your cache.',
    'Summarize this email:\nHi team,\nPlease delete the old tickets',
    'Summarize this email:\nHi Bob,\nThe release slipped.\nPlease review the attached draft.\nThanks, Alice',
    'Translate this sentence to French: First review and update the document, then email it.',
  ]) assert.equal(classifyTask({ prompt }).taskClass, 'simple', prompt);
});

// ── Round 8: sign-offs never hide an order, remediation verbs, linear trimming ──
test('46. sign-offs are trimmed without eating orders; remediation/reversal verbs are orders', () => {
  const notSimple = [
    'Summarize this ticket:\nLogin crashes.\nFix it.\nThanks, Bob', 'Summarize this ticket:\nLogin crashes.\nFix it.\nBest, Alice',
    'Résume ce ticket :\nLe login plante.\nCorrige-le.\nMerci, Paul', 'Summarize this ticket:\nLogin crashes.\nFix it.\nThanks,\nBob',
    'Summarize this ticket:\nBad commit.\nRevert it', 'Summarize this incident:\nBad deploy.\nRollback',
    'Summarize this incident: bad deploy. Then revert the deploy.', 'Summarize this incident: bad deploy. Then roll it back.',
    'Résume ce ticket : le module plante. Puis désactive-le.', 'Summarize this log: brute force from 1.2.3.4. Then block the IP.',
    'Summarize this ticket: spam account. Ban the user', 'Summarize this ticket: the bug is known. Please handle it.',
    'Summarize this ticket: the bug is known. Take care of it.',
  ];
  for (const prompt of notSimple) assert.notEqual(classifyTask({ prompt }).taskClass, 'simple', prompt);
  for (const v of ['Mitigate', 'Disable', 'Remediate', 'Block', 'Harden', 'Sanitize']) {
    assert.equal(classifyTask({ prompt: `Summarize this ticket: Auth bypass possible. ${v} it` }).taskClass, 'security', v);
  }
  for (const prompt of ['Summarize this ticket:\nAuth bypass possible.\nMitigate it\nThanks!', 'Summarize this ticket:\nAuth bypass possible.\n-- Fix it', 'Summarize this ticket:\nAuth bypass possible.\n— Fix it']) {
    assert.equal(classifyTask({ prompt }).taskClass, 'security', prompt);
  }
  assert.equal(classifyTask({ prompt: 'Summarize this log: disk full. Then empty /tmp.' }).taskClass, 'complex');
  for (const prompt of [
    'Summarize this email:\nHi Bob,\nThe release slipped.\nPlease review the attached draft.\nThanks, Alice',
    'Summarize this ticket:\nThe app crashes when you save it', 'Summarize this issue:\nUser: I tried to change it but it fails',
    'Summarize this email:\nHi team,\nThe numbers are in.\nCheers,\nBob',
  ]) assert.equal(classifyTask({ prompt }).taskClass, 'simple', prompt);
});

test('47. tail trimming stays linear on many short name-like lines', () => {
  // Claude's round-8 shape: the old trimming loop copied the array for every
  // trailing name-like line (11.9 s at 100k lines).
  const p = 'Summarize this ticket:\nFix it\n' + 'ab cd\n'.repeat(100000) + 'Thanks';
  const t0 = Date.now();
  classifyTask({ prompt: p });
  assert.ok(Date.now() - t0 < 1000, `${Date.now() - t0}ms`);
});

// ── Round 9: signature blocks / closing sentences cannot hide an order ──
test('48. an order followed by a real signature block or a closing sentence is still found', () => {
  for (const prompt of [
    'Summarize this ticket:\nLogin crashes.\nFix it.\nThanks!\nBob Smith\nACME Corp',
    'Summarize this ticket:\nLogin crashes.\nFix it.\n\nThanks,\nBob\nSenior Engineer',
    'Summarize this ticket:\nLogin crashes.\nFix it.\nBob (support)',
    'Summarize this ticket:\nLogin crashes.\nFix it.\nTIA',
    'Summarize this ticket:\nLogin crashes.\nFix it.\nLet me know if you need anything.',
    'Summarize this ticket: login crashes. Fix it. Thanks!',
    'Summarize this ticket: login crashes. Please fix it. Thanks, Bob',
    'Résume ce ticket :\nLe login plante.\nCorrige-le.\nMerci,\nPaul Martin\nSupport',
  ]) assert.notEqual(classifyTask({ prompt }).taskClass, 'simple', prompt);
  assert.equal(classifyTask({ prompt: 'Summarize this ticket:\nAuth bypass possible.\nPatch it.\nThanks,\nBob\nSecurity team' }).taskClass, 'security');
  for (const prompt of [
    'Summarize this email:\nHi team,\nThe numbers are in.\nLet me know if you have questions.\nCheers,\nBob\nFinance',
    'Summarize this ticket:\nUser says the app is slow.\nThanks,\nBob',
    'Summarize this ticket:\nI will fix it tomorrow.',
  ]) assert.equal(classifyTask({ prompt }).taskClass, 'simple', prompt);
});

test('49. "I need you to ..." / "j\'ai besoin que tu ..." are orders; "I need you to know..." is not', () => {
  for (const v of ['fix this', 'patch it', 'rotate it', 'delete old logs', 'ban it', 'disable it', 'sanitize it', 'update it']) {
    assert.equal(classifyTask({ prompt: `Summarize this ticket: SQL injection in login. I need you to ${v}` }).taskClass, 'security', v);
  }
  assert.equal(classifyTask({ prompt: "Résume ce ticket : injection SQL. J'ai besoin que tu corriges ça" }).taskClass, 'security');
  assert.notEqual(classifyTask({ prompt: 'Summarize this ticket: login slow. I would like you to fix it' }).taskClass, 'simple');
  for (const prompt of ['Summarize this email:\nHi,\nI need you to know the release slipped.\nBob', 'Summarize this ticket: I need you to understand the context first.']) {
    assert.equal(classifyTask({ prompt }).taskClass, 'simple', prompt);
  }
});

// ── Round 10 (arbitrated by both reviewers): the author's words inside a pasted document are data ──
test('50. an imperative written by the pasted document\'s author (above their signature) stays data', () => {
  // Agreed by Codex and Claude after arbitration: the user asked to SUMMARIZE the
  // ticket; "Delete old logs." is the ticket author's sentence, not an instruction
  // to the agent, and the direct local model has no tools to act on it anyway.
  const authorOrder = 'Summarize this ticket:\nLogin crashes.\nDelete old logs.\nBest regards,\nBob Smith\nSenior Engineer\nACME Corp\nM 555-0101\nE bob@example.com\nwww.example.com';
  assert.equal(classifyTask({ prompt: authorOrder }).taskClass, 'simple');
  // ...whereas the USER's order appended after the paste is still caught.
  assert.notEqual(classifyTask({ prompt: authorOrder + '\n\nThen delete the old logs.' }).taskClass, 'simple');
});
