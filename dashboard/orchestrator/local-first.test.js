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
  const task = orch.spawnLmStudio({ cli: 'lmstudio-qwen-small', prompt: huge });
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
