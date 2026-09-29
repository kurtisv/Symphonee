'use strict';
// Local (on-machine) providers for LOCAL-FIRST routing.
//
// Locality is declared here, explicitly, per provider id. Nothing is ever
// inferred from a name: `qwen` is Qwen Code against DashScope (cloud) and
// stays cloud; only the ids below run against the LM Studio server on
// 127.0.0.1. Anything not listed is cloud.
//
//   lmstudio-qwen-small  direct LM Studio call, Qwen2.5-Coder 1.5B. Simple,
//                        repetitive, low-risk text work (summary, extract,
//                        classify, rephrase, compress).
//   lmstudio-qwen-review direct LM Studio call, Qwen2.5-Coder 7B. Read-only
//                        analysis / review of content that fits its context.
//   codex-oss-local      Codex CLI in --oss mode against LM Studio (1.5B).
//                        Small agentic work: 1-2 file edits, a shell command,
//                        a targeted test run.
//
// Local providers get ONE attempt. Any failure (timeout, context overflow,
// LM Studio down, unusable output, tool error) fails over to cloud at once.

const http = require('http');
const os = require('os');
const fs = require('fs');
const path = require('path');

const LMSTUDIO_BASE_URL = process.env.LMSTUDIO_URL || 'http://127.0.0.1:1234';

const LOCAL_PROVIDERS = Object.freeze({
  'lmstudio-qwen-small': Object.freeze({
    id: 'lmstudio-qwen-small', kind: 'lmstudio-direct', backend: 'lmstudio',
    model: 'qwen2.5-coder-1.5b-instruct', label: 'Qwen 1.5B (Local - LM Studio)',
    contextTokens: 32768, promptOverheadTokens: 400, outputReserveTokens: 2048,
    // Approx. resident size once loaded at 32k context (Q8_0 weights + KV cache).
    loadRamMB: 3000, large: false, taskClasses: ['simple'],
    timeoutMs: 3 * 60 * 1000,
  }),
  'lmstudio-qwen-review': Object.freeze({
    id: 'lmstudio-qwen-review', kind: 'lmstudio-direct', backend: 'lmstudio',
    model: 'qwen/qwen2.5-coder-7b', label: 'Qwen 7B (Local - LM Studio, read-only)',
    contextTokens: 32768, promptOverheadTokens: 400, outputReserveTokens: 3072,
    loadRamMB: 7000, large: true, taskClasses: ['readonly-review'],
    timeoutMs: 6 * 60 * 1000,
  }),
  'codex-oss-local': Object.freeze({
    id: 'codex-oss-local', kind: 'codex-oss', backend: 'lmstudio',
    model: 'qwen2.5-coder-1.5b-instruct', label: 'Codex OSS (Local - LM Studio)',
    // Codex's own system prompt + tool schemas measured at ~12-20k tokens;
    // plus the Mind/skills/ledger hints spawnHeadless prepends.
    contextTokens: 32768, promptOverheadTokens: 20000, outputReserveTokens: 4096,
    // Not auto-routed by default. Measured 2026-09-28: with Qwen 1.5B it spent
    // 273s and replied "DONE" without editing the file, i.e. it would burn 4-5
    // minutes before failing over. Set LocalFirst.enableCodexOssSmallEdit=true to
    // route small edits here again (e.g. with a stronger local model).
    loadRamMB: 3000, large: false, taskClasses: [], optInTaskClasses: ['small-edit'],
    timeoutMs: 15 * 60 * 1000,
  }),
  // Claude Code pointed at LM Studio's Anthropic-compatible endpoint. Local,
  // but never auto-routed (its ~20k-token system prompt leaves the 1.5B almost
  // no room); only used when explicitly requested.
  'claude-local': Object.freeze({
    id: 'claude-local', kind: 'claude-local', backend: 'lmstudio',
    model: 'qwen2.5-coder-1.5b-instruct', label: 'Claude Code (Local - LM Studio)',
    contextTokens: 32768, promptOverheadTokens: 20000, outputReserveTokens: 4096,
    loadRamMB: 3000, large: false, taskClasses: [],
    timeoutMs: 15 * 60 * 1000,
  }),
});

// Old id kept working in configs (OrchestrateCliList) written before the rename.
const LOCAL_ALIASES = Object.freeze({ 'codex-oss': 'codex-oss-local' });

// Env vars that would let a "local" run reach a cloud model. Stripped from
// every local spawn so a local task provably cannot bill a cloud account.
const CLOUD_ENV_KEYS = Object.freeze([
  'OPENAI_API_KEY', 'OPENAI_BASE_URL', 'OPENAI_ORG_ID', 'OPENAI_ORGANIZATION', 'OPENAI_PROJECT', 'CODEX_API_KEY',
  'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL',
  'GEMINI_API_KEY', 'GOOGLE_API_KEY', 'GOOGLE_GENAI_API_KEY',
  'DASHSCOPE_API_KEY', 'XAI_API_KEY', 'AZURE_OPENAI_API_KEY', 'OPENROUTER_API_KEY',
  'OPENAI_API_BASE', 'AZURE_OPENAI_ENDPOINT', 'CLAUDE_CODE_OAUTH_TOKEN',
  // Claude Code cloud back-ends (Bedrock / Vertex) and their credentials.
  'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'ANTHROPIC_VERTEX_PROJECT_ID', 'CLOUD_ML_REGION',
  'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN', 'AWS_PROFILE', 'AWS_BEARER_TOKEN_BEDROCK',
  'GOOGLE_APPLICATION_CREDENTIALS',
  // Endpoint overrides that could point a "local" CLI somewhere else.
  'CODEX_OSS_BASE_URL', 'CODEX_OSS_PORT',
  // Proxies: a local run only talks to loopback, so it never needs one.
  'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy',
]);

function canonicalProviderId(id) { return LOCAL_ALIASES[id] || id; }
function isLocalProvider(id) { return Object.prototype.hasOwnProperty.call(LOCAL_PROVIDERS, canonicalProviderId(id)); }
function getLocalProvider(id) { return LOCAL_PROVIDERS[canonicalProviderId(id)] || null; }
function providerLocality(id) { return isLocalProvider(id) ? 'local' : 'cloud'; }
function isDirectLocal(id) { const p = getLocalProvider(id); return !!p && p.kind === 'lmstudio-direct'; }

function localFirstConfig(config = {}) {
  const lf = (config && config.LocalFirst) || {};
  return {
    enabled: lf.enabled !== false,
    baseUrl: lf.baseUrl || LMSTUDIO_BASE_URL,
    autoLoad: lf.autoLoad !== false,
    minFreeRamMB: Number(lf.minFreeRamMB) || 1024,
    timeouts: lf.timeouts || {},
    enableCodexOssSmallEdit: lf.enableCodexOssSmallEdit === true,
  };
}

// Task classes a local provider is auto-routed for under the current config.
function routedTaskClasses(providerId, config = {}) {
  const p = getLocalProvider(providerId);
  if (!p) return [];
  const extra = providerId === 'codex-oss-local' && localFirstConfig(config).enableCodexOssSmallEdit ? (p.optInTaskClasses || []) : [];
  return [...p.taskClasses, ...extra];
}

// ~3.5 chars/token is a conservative estimate for code+prose with Qwen's tokenizer.
function estimateTokens(text) { return Math.ceil(String(text || '').length / 3.5); }

function requiredContextTokens(providerId, promptTokens) {
  const p = getLocalProvider(providerId);
  if (!p) return promptTokens;
  return promptTokens + p.promptOverheadTokens + p.outputReserveTokens;
}

// Strip every cloud credential from a spawn env. Returns the list removed.
function stripCloudEnv(env) {
  const removed = [];
  for (const k of CLOUD_ENV_KEYS) {
    if (Object.prototype.hasOwnProperty.call(env, k)) { removed.push(k); delete env[k]; }
  }
  return removed;
}

// Fail-closed check that a codex-oss-local argv can only talk to LM Studio.
function assertCodexOssArgs(args) {
  const i = args.indexOf('--local-provider');
  if (!args.includes('--oss') || i < 0 || args[i + 1] !== 'lmstudio') {
    throw new Error('codex-oss-local refused to start: argv is not pinned to --oss --local-provider lmstudio (would risk OpenAI cloud usage)');
  }
}

// ── LM Studio health ───────────────────────────────────────────────────────
function httpGetJson(url, timeoutMs) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { timeout: timeoutMs }, (res) => {
      let buf = '';
      res.on('data', c => { buf += c; });
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) return reject(new Error(`HTTP ${res.statusCode}`));
        try { resolve(JSON.parse(buf)); } catch (e) { reject(new Error('bad json')); }
      });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
  });
}

class LocalHealth {
  constructor({ getConfig = () => ({}), fetchJson = httpGetJson, now = () => Date.now(), freeMemMB = () => Math.round(os.freemem() / 1048576), ttlMs = 15000 } = {}) {
    this.getConfig = getConfig; this.fetchJson = fetchJson; this.now = now; this.freeMemMB = freeMemMB; this.ttlMs = ttlMs;
    this.snapshot = { checkedAt: 0, reachable: false, serverUp: false, latencyMs: null, models: [], error: 'not checked yet' };
    this._inflight = null;
  }

  async refresh({ force = false } = {}) {
    if (!force && this.snapshot.checkedAt && this.now() - this.snapshot.checkedAt < this.ttlMs) return this.snapshot;
    if (this._inflight) return this._inflight;
    const { baseUrl } = localFirstConfig(this.getConfig());
    const t0 = this.now();
    this._inflight = (async () => {
      try {
        let models;
        try {
          // LM Studio's native REST API reports load state + context length.
          const data = await this.fetchJson(`${baseUrl}/api/v0/models`, 2500);
          models = (data.data || []).map(m => ({
            id: m.id, type: m.type, state: m.state,
            maxContextLength: m.max_context_length || null,
            loadedContextLength: m.loaded_context_length || null,
          }));
        } catch (_) {
          const data = await this.fetchJson(`${baseUrl}/v1/models`, 2500);
          models = (data.data || []).map(m => ({ id: m.id, type: 'llm', state: 'unknown', maxContextLength: null, loadedContextLength: null }));
        }
        this.snapshot = { checkedAt: this.now(), reachable: true, serverUp: true, latencyMs: this.now() - t0, models, error: null, baseUrl };
      } catch (err) {
        this.snapshot = { checkedAt: this.now(), reachable: false, serverUp: false, latencyMs: null, models: [], error: err.message, baseUrl };
      } finally {
        this._inflight = null;
      }
      return this.snapshot;
    })();
    return this._inflight;
  }

  /**
   * Can this local provider take a task needing `requiredTokens` of context?
   * Pure function of the last snapshot (router is synchronous). Unknown ==
   * unavailable: we fail closed to cloud rather than guess.
   */
  eligibility(providerId, { requiredTokens = 0 } = {}) {
    const p = getLocalProvider(providerId);
    if (!p) return { ok: false, reason: 'not-a-local-provider' };
    const cfg = localFirstConfig(this.getConfig());
    if (!cfg.enabled) return { ok: false, reason: 'local-first-disabled' };
    if (!isLoopbackUrl(cfg.baseUrl)) return { ok: false, reason: `lmstudio-url-not-loopback: ${cfg.baseUrl}` };
    const s = this.snapshot;
    if (!s.checkedAt) return { ok: false, reason: 'lmstudio-not-checked' };
    if (!s.reachable) return { ok: false, reason: `lmstudio-unreachable: ${s.error || 'no response'}` };
    const m = s.models.find(x => x.id === p.model);
    if (!m) return { ok: false, reason: `model-not-installed: ${p.model}` };
    const loaded = m.state === 'loaded';
    const ctx = loaded && m.loadedContextLength ? m.loadedContextLength : Math.min(p.contextTokens, m.maxContextLength || p.contextTokens);
    if (requiredTokens > ctx) return { ok: false, reason: `context-exceeds-local: need ~${requiredTokens} tokens, ${p.model} has ${ctx}`, contextTokens: ctx };
    if (!loaded) {
      const otherLlmLoaded = s.models.some(x => x.state === 'loaded' && x.type !== 'embeddings' && x.id !== p.model);
      // Never stack a large model on top of another loaded LLM.
      if (p.large && otherLlmLoaded) return { ok: false, reason: `ram-guard: ${p.model} not loaded and another LLM is resident` };
      const free = this.freeMemMB();
      if (free < p.loadRamMB + cfg.minFreeRamMB) return { ok: false, reason: `ram-guard: ${free} MB free < ${p.loadRamMB + cfg.minFreeRamMB} MB needed to load ${p.model}` };
    }
    return { ok: true, loaded, contextTokens: ctx, model: p.model, latencyMs: s.latencyMs };
  }

  publicStatus() {
    const s = this.snapshot;
    return {
      ...s,
      providers: Object.fromEntries(Object.keys(LOCAL_PROVIDERS).map(id => [id, { model: LOCAL_PROVIDERS[id].model, kind: LOCAL_PROVIDERS[id].kind, ...this.eligibility(id) }])),
    };
  }
}

// Load a model with an explicit context length (LM Studio's JIT load would use
// its default, often far below the ~20k tokens Codex needs). --ttl lets LM
// Studio unload it when idle so it does not sit in RAM all evening.
function lmsLoadArgs(providerId, { contextTokens, ttlSec = 900 } = {}) {
  const p = getLocalProvider(providerId);
  if (!p) throw new Error(`not a local provider: ${providerId}`);
  return ['load', p.model, '--context-length', String(contextTokens || p.contextTokens), '--ttl', String(ttlSec), '-y'];
}
function ensureLoaded(providerId, { lmsCmd = 'lms', execFile = require('child_process').execFile, contextTokens, ttlSec } = {}) {
  const args = lmsLoadArgs(providerId, { contextTokens, ttlSec });
  return new Promise((resolve, reject) => {
    execFile(lmsCmd, args, { timeout: 180000, windowsHide: true }, (err, stdout, stderr) => {
      if (err) return reject(new Error(`lms load failed: ${String(stderr || err.message).trim().slice(0, 300)}`));
      resolve(String(stdout || '').trim());
    });
  });
}

// Isolated CODEX_HOME for codex-oss-local. Measured: `codex exec --oss` run
// with the user's ~/.codex still opened a TLS connection to chatgpt.com
// (analytics / remote config using the ChatGPT login in auth.json) even though
// inference went to LM Studio. A dedicated home has no auth.json, so no OpenAI
// credential exists for the process at all, and analytics / feedback / update
// checks are switched off. Fails closed if credentials ever appear there.
const CODEX_OSS_BASE_CONFIG = [
  '# Managed by Symphonee (orchestrator/local-providers.js). Rewritten on every',
  '# codex-oss-local spawn. Isolated home: no OpenAI / ChatGPT credentials.',
  'model_provider = "lmstudio"',
  'check_for_update_on_startup = false',
  '',
  '[analytics]',
  'enabled = false',
  '',
  '[feedback]',
  'enabled = false',
  '',
];
function prepareCodexOssHome(workspaceDir, cwd) {
  const home = path.join(workspaceDir, 'codex-oss-home');
  fs.mkdirSync(home, { recursive: true });
  for (const f of ['auth.json', '.credentials.json']) {
    if (fs.existsSync(path.join(home, f))) throw new Error(`codex-oss-local refused to start: ${f} present in isolated CODEX_HOME ${home}`);
  }
  const trustFile = path.join(home, 'symphonee-trusted.json');
  let trusted = [];
  try { trusted = JSON.parse(fs.readFileSync(trustFile, 'utf8')); } catch (_) {}
  if (cwd && !trusted.includes(cwd)) trusted.push(cwd);
  trusted = trusted.slice(-200);
  fs.writeFileSync(trustFile, JSON.stringify(trusted, null, 1));
  const projects = trusted.map(p => `[projects.'${p}']\ntrust_level = "trusted"\n`).join('\n');
  fs.writeFileSync(path.join(home, 'config.toml'), CODEX_OSS_BASE_CONFIG.join('\n') + '\n' + projects, 'utf8');
  return home;
}

// Fingerprint of a git working tree (status + diff), or null outside a repo.
// Used to catch a local agent that says "done" without changing anything:
// measured with codex-oss-local + Qwen 1.5B, which replied DONE after 273s
// while the file it was asked to fix was untouched.
function gitTreeFingerprint(cwd, { spawnSync = require('child_process').spawnSync } = {}) {
  if (!cwd) return null;
  const run = (args) => spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 15000, windowsHide: true, maxBuffer: 32 * 1024 * 1024 });
  const inside = run(['rev-parse', '--is-inside-work-tree']);
  if (inside.status !== 0 || String(inside.stdout).trim() !== 'true') return null;
  const status = run(['status', '--porcelain', '--untracked-files=all']);
  const diff = run(['diff', 'HEAD']);
  if (status.status !== 0) return null;
  return require('crypto').createHash('sha1').update(String(status.stdout)).update('\0').update(String(diff.stdout || '')).digest('hex');
}

// Generic isolated config home for a local agent CLI (claude-local). Refuses
// to start if any credential file shows up in it.
function prepareIsolatedHome(workspaceDir, name, forbiddenFiles = []) {
  const home = path.join(workspaceDir, name);
  fs.mkdirSync(home, { recursive: true });
  for (const f of forbiddenFiles) {
    if (fs.existsSync(path.join(home, f))) throw new Error(`local agent refused to start: ${f} present in isolated home ${home}`);
  }
  return home;
}

// Stop a local agent and everything it spawned. On Windows the agent runs
// under cmd.exe (shell: true), so proc.kill() alone would orphan codex.exe.
function killProcessTree(proc, impl = null) {
  if (!proc) return;
  if (proc.pid && impl) return impl(proc.pid);
  if (proc.pid && process.platform === 'win32') {
    // Asynchronous: must not block the server event loop (spawnSync could hang
    // it for up to 10s on a slow taskkill).
    try {
      const k = require('child_process').spawn('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      k.on('error', () => { try { proc.kill('SIGTERM'); } catch (_) {} });
      return;
    } catch (_) { /* fall back to a plain kill */ }
  }
  try { proc.kill('SIGTERM'); } catch (_) {}
}

// Only a loopback LM Studio endpoint counts as local. Anything else fails closed.
function isLoopbackUrl(u) {
  try { const h = new URL(u).hostname; return h === '127.0.0.1' || h === 'localhost' || h === '::1' || h === '[::1]'; } catch (_) { return false; }
}

// Inline small text files a prompt names (e.g. "résume dashboard/foo.js") so a
// tool-less direct local model can actually see them. Only files inside cwd,
// text-ish, size-capped. Returns { prompt, files }.
function inlineReferencedFiles(prompt, cwd, { maxBytes = 60000, maxFiles = 4 } = {}) {
  if (!cwd || typeof prompt !== 'string') return { prompt, files: [] };
  const root = path.resolve(cwd);
  const candidates = prompt.match(/[\w@.~\\/-]+\.[A-Za-z0-9]{1,6}\b/g) || [];
  const files = [];
  let total = 0;
  for (const raw of [...new Set(candidates)]) {
    if (files.length >= maxFiles) break;
    const abs = path.resolve(root, raw);
    if (abs !== root && !abs.startsWith(root + path.sep)) continue;
    let st;
    try { st = fs.statSync(abs); } catch (_) { continue; }
    if (!st.isFile() || st.size > maxBytes || total + st.size > maxBytes) continue;
    let text;
    try { text = fs.readFileSync(abs, 'utf8'); } catch (_) { continue; }
    if (text.includes('\u0000')) continue;
    total += st.size;
    files.push({ path: path.relative(root, abs), text });
  }
  if (!files.length) return { prompt, files };
  const blocks = files.map(f => `--- FILE: ${f.path} ---\n${f.text}\n--- END FILE ---`).join('\n\n');
  return { prompt: `${prompt}\n\n${blocks}`, files: files.map(f => f.path) };
}

module.exports = {
  LMSTUDIO_BASE_URL, LOCAL_PROVIDERS, LOCAL_ALIASES, CLOUD_ENV_KEYS,
  canonicalProviderId, isLocalProvider, getLocalProvider, providerLocality, isDirectLocal,
  localFirstConfig, estimateTokens, requiredContextTokens, stripCloudEnv, assertCodexOssArgs,
  routedTaskClasses, prepareIsolatedHome, killProcessTree, LocalHealth, ensureLoaded, lmsLoadArgs, isLoopbackUrl, prepareCodexOssHome, gitTreeFingerprint, inlineReferencedFiles, httpGetJson,
};
