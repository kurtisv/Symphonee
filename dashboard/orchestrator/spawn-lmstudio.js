'use strict';
// Direct LM Studio worker (lmstudio-qwen-small / lmstudio-qwen-review).
// One HTTP call to the loopback OpenAI-compatible endpoint, no CLI process, no
// cloud credential anywhere in the path. Exactly one attempt: any failure
// (LM Studio down, load failure, context overflow, timeout, empty output)
// marks the task failed with failover=true so the router sends it to cloud.
// Mixed into Orchestrator.prototype.

const http = require('http');
const { STATE } = require('./state');
const {
  getLocalProvider, localFirstConfig, isLoopbackUrl, estimateTokens, requiredContextTokens,
  inlineReferencedFiles, ensureLoaded,
} = require('./local-providers');

const SYSTEM_PROMPT = 'You are a precise assistant running locally. Answer the task directly and concisely. ' +
  'If file contents are provided between FILE markers, base your answer only on them.';

function postJson(url, body, { timeoutMs, signal } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const data = JSON.stringify(body);
    const req = http.request({
      hostname: u.hostname, port: u.port || 80, path: u.pathname, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
      timeout: timeoutMs, signal,
    }, (res) => {
      let buf = '';
      res.on('data', c => { buf += c; });
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) return reject(new Error(`LM Studio HTTP ${res.statusCode}: ${buf.slice(0, 200)}`));
        try { resolve(JSON.parse(buf)); } catch (_) { reject(new Error('LM Studio returned invalid JSON')); }
      });
    });
    req.on('timeout', () => req.destroy(new Error(`local timeout after ${timeoutMs}ms`)));
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

// Map a local failure to the provider-health error vocabulary; every local
// failure is failover-eligible regardless of type.
function localFailure(reason) {
  const r = String(reason || '');
  const errorType = /timeout/i.test(r) ? 'TIMEOUT'
    : /ECONNREFUSED|ECONNRESET|unreachable|socket|network/i.test(r) ? 'NETWORK_ERROR'
    : /context|ram-guard|load failed|not installed|HTTP 5\d\d/i.test(r) ? 'PROVIDER_ERROR'
    : 'TASK_ERROR';
  // Failures caused by the task (too big, needs repo content) say nothing about
  // the provider's health: no cooldown, the next small task can still go local.
  const noCooldown = /context-exceeds-local|local-cannot-read-repo/.test(r);
  return {
    message: r, errorType, local: true, failover: true, recoverable: true, retryable: false, noCooldown,
    transient: false, permanent: false, failoverReason: `local failure: ${r.slice(0, 120)}`, timestamp: Date.now(),
  };
}

// Does the prompt itself carry the material to work on (pasted code/text)?
function hasInlineContent(prompt) {
  const s = String(prompt || '');
  if (estimateTokens(s) >= 200 || /```/.test(s)) return true;
  const codeChars = (s.match(/[{}();=<>\[\]]/g) || []).length;
  return codeChars >= 4 || s.split('\n').length >= 4;
}

module.exports = {
  /**
   * Make an agentic local provider (codex-oss-local) ready BEFORE its CLI is
   * spawned: fresh LM Studio health, context fit, RAM guard, and an explicit
   * load at full context (a JIT load would use LM Studio's small default and
   * Codex's ~20k-token system prompt would overflow it).
   * @returns {Promise<{ok: boolean, reason?: string}>}
   */
  async prepareLocalProvider(cli, { requiredTokens = 0 } = {}) {
    const lp = getLocalProvider(cli);
    if (!lp) return { ok: true };
    if (!this.localHealth) return { ok: false, reason: 'no-local-health-source' };
    const cfg = localFirstConfig((this.getConfig && this.getConfig()) || {});
    await this.localHealth.refresh({ force: true });
    const elig = this.localHealth.eligibility(cli, { requiredTokens });
    if (!elig.ok) return { ok: false, reason: elig.reason };
    if (lp.kind !== 'lmstudio-direct' && !elig.loaded) {
      if (!cfg.autoLoad) return { ok: false, reason: `${lp.model} not loaded and LocalFirst.autoLoad is off` };
      try {
        await (this.lmstudioEnsureLoaded || ensureLoaded)(cli, { contextTokens: lp.contextTokens });
        await this.localHealth.refresh({ force: true });
      } catch (err) { return { ok: false, reason: err.message }; }
    }
    return { ok: true };
  },

  spawnLmStudio({ cli, prompt, cwd, timeout, from, taskId, space, requiresRepoContent = false } = {}) {
    const lp = getLocalProvider(cli);
    if (!lp || lp.kind !== 'lmstudio-direct') throw new Error(`spawnLmStudio: "${cli}" is not a direct LM Studio provider`);
    const cfg = localFirstConfig((this.getConfig && this.getConfig()) || {});
    // Fail closed: a non-loopback endpoint would not be "local".
    if (!isLoopbackUrl(cfg.baseUrl)) throw new Error(`Local provider ${cli} refused: LM Studio URL ${cfg.baseUrl} is not loopback`);
    const timeoutMs = Number(cfg.timeouts[cli]) || Number(timeout) || lp.timeoutMs;

    const task = this._createTask({ id: taskId, type: 'local', cli, model: lp.model, prompt, from: from || null, space: space || null, timeout: timeoutMs });
    task.state = STATE.RUNNING;
    task.startedAt = Date.now();
    task.execution = { locality: 'local', backend: 'lmstudio', endpoint: cfg.baseUrl, model: lp.model, provider: cli, cloudCredentialsPresent: false, attempts: 1 };
    this.heartbeats.set(task.id, Date.now());
    this._broadcastTaskUpdate(task);

    // cancelTask() aborts this, so a cancelled local call stops using the model.
    const abort = new AbortController();
    task._abortController = abort;
    const post = this.lmstudioPost || postJson;
    const health = this.localHealth;
    const load = this.lmstudioEnsureLoaded || ensureLoaded;

    (async () => {
      // Let the caller (routes.js) attach routing metadata / fallback chain first.
      await new Promise(r => setImmediate(r));
      try {
        const { prompt: fullPrompt, files } = inlineReferencedFiles(prompt, cwd);
        task.execution.inlinedFiles = files;
        if (requiresRepoContent && !files.length && !hasInlineContent(prompt)) {
          throw new Error('local-cannot-read-repo: task needs repo content that a tool-less local model cannot open (no readable file named, nothing inline)');
        }
        const promptTokens = estimateTokens(SYSTEM_PROMPT) + estimateTokens(fullPrompt);
        task.estimatedPromptTokens = promptTokens;
        const needed = requiredContextTokens(cli, promptTokens);
        if (health) {
          await health.refresh({ force: true });
          const elig = health.eligibility(cli, { requiredTokens: needed });
          if (!elig.ok) throw new Error(elig.reason);
          if (!elig.loaded && cfg.autoLoad) {
            this.broadcast({ type: 'orchestrator-event', event: 'task-output', taskId: task.id, chunk: `[local] loading ${lp.model} with ${lp.contextTokens} ctx...\n`, timestamp: Date.now() });
            await load(cli, { contextTokens: lp.contextTokens });
            task.execution.loadedByRouter = true;
          }
        }
        this.broadcast({ type: 'orchestrator-event', event: 'task-output', taskId: task.id, chunk: `[local] ${cli} -> ${cfg.baseUrl} (${lp.model}), ~${promptTokens} prompt tokens\n`, timestamp: Date.now() });
        const resp = await post(`${cfg.baseUrl}/v1/chat/completions`, {
          model: lp.model,
          messages: [{ role: 'system', content: SYSTEM_PROMPT }, { role: 'user', content: fullPrompt }],
          temperature: 0.2, max_tokens: lp.outputReserveTokens, stream: false,
        }, { timeoutMs, signal: abort.signal });
        if (task.state === STATE.CANCELLED) return;
        const choice = resp && resp.choices && resp.choices[0];
        const text = String(choice && choice.message && choice.message.content || '').trim();
        if (!text) throw new Error('unusable local output: empty completion');
        // A cut-off answer is not a usable answer: let cloud do it properly.
        if (choice.finish_reason === 'length') throw new Error('unusable local output: completion truncated (finish_reason=length)');
        task.state = STATE.COMPLETED;
        task.result = text;
        task.usage = { inputTokens: resp.usage && resp.usage.prompt_tokens, outputTokens: resp.usage && resp.usage.completion_tokens };
        task.execution.servedModel = resp.model || lp.model;
        task.execution.finishReason = choice.finish_reason || null;
      } catch (err) {
        if (task.state === STATE.CANCELLED) return;
        task.state = STATE.FAILED;
        task.error = `local ${cli} failed: ${err.message}`;
        task.errorClassification = localFailure(err.message);
      } finally {
        if (task.state !== STATE.CANCELLED) {
          task.completedAt = Date.now();
          this.heartbeats.delete(task.id);
          this._persistResult(task);
          this._broadcastTaskUpdate(task);
        }
      }
    })();

    return task;
  },
};

// Non-enumerable so Object.assign(Orchestrator.prototype, ...) does not pick it up.
Object.defineProperty(module.exports, '_internal', { value: { postJson, localFailure, SYSTEM_PROMPT }, enumerable: false });
