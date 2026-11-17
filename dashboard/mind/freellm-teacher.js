'use strict';
// FreeLLM as an optional, free TEACHER for the Qwen developer (fictional fixtures only).
//
// It talks to a FreeLLMAPI instance running on THIS machine (OpenAI-compatible /v1/chat/completions).
// FreeLLMAPI forwards prompts to external free providers, so three hard rules apply:
//   1. Fictional fixtures only: callTeacher() refuses any scope other than 'fictional-fixture'
//      (never a real repository, never payroll or personal data).
//   2. The base URL must be loopback: the unified key is never sent to another host.
//   3. Inactive until configured: no key = disabled, the caller keeps using Claude.
// The answer is plain text; the caller still runs qwen-teaching.parseTeaching on it (no solution,
// exact fields) and the lesson stays TEACHING until the independent checks validate it.
//
// Config (first found wins): env SYMPHONEE_FREELLM_KEY / SYMPHONEE_FREELLM_URL / SYMPHONEE_FREELLM_MODEL,
// else <dataDir>/freellm.json { "apiKey": "...", "baseUrl": "http://127.0.0.1:3001/v1", "model": "auto" }.

const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_URL = 'http://127.0.0.1:3001/v1';
const DEFAULT_MODEL = 'auto';
const FIXTURE_SCOPE = 'fictional-fixture';
const MAX_PROMPT = 9000;
const MAX_ANSWER = 6000;

function isLoopbackUrl(u) {
  try {
    const x = new URL(u);
    return x.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(x.hostname);
  } catch (_) { return false; }
}

function loadConfig({ env = process.env, dataDir } = {}) {
  let file = {};
  if (dataDir) { try { file = JSON.parse(fs.readFileSync(path.join(dataDir, 'freellm.json'), 'utf8')) || {}; } catch (_) { file = {}; } }
  const apiKey = String(env.SYMPHONEE_FREELLM_KEY || file.apiKey || '').trim();
  const baseUrl = String(env.SYMPHONEE_FREELLM_URL || file.baseUrl || DEFAULT_URL).replace(/\/+$/, '');
  const model = String(env.SYMPHONEE_FREELLM_MODEL || file.model || DEFAULT_MODEL).trim() || DEFAULT_MODEL;
  if (!apiKey) return { enabled: false, reason: 'no key configured' };
  if (!isLoopbackUrl(baseUrl)) return { enabled: false, reason: 'base URL must be loopback (http://127.0.0.1 or localhost)' };
  return { enabled: true, apiKey, baseUrl, model };
}

// Returns { ok:true, text, model, usage:{inputTokens,outputTokens} } or { ok:false, error }.
async function callTeacher({ config, prompt, scope, timeoutMs = 120000, fetchFn = globalThis.fetch, signal = null }) {
  if (scope !== FIXTURE_SCOPE) return { ok: false, error: 'refused: FreeLLM is only for fictional fixtures' };
  if (!config || !config.enabled) return { ok: false, error: 'disabled: ' + ((config && config.reason) || 'not configured') };
  if (typeof fetchFn !== 'function') return { ok: false, error: 'no fetch available' };
  if (signal && signal.aborted) return { ok: false, error: 'cancelled' };
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  if (signal) signal.addEventListener('abort', () => ctl.abort(), { once: true });
  try {
    const res = await fetchFn(config.baseUrl + '/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + config.apiKey },
      body: JSON.stringify({ model: config.model, temperature: 0.2, max_tokens: 1200, messages: [{ role: 'user', content: String(prompt || '').slice(0, MAX_PROMPT) }] }),
      signal: ctl.signal,
    });
    if (!res.ok) return { ok: false, error: 'FreeLLM HTTP ' + res.status };
    const j = await res.json();
    const text = j && j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content;
    if (typeof text !== 'string' || !text.trim()) return { ok: false, error: 'FreeLLM returned no text' };
    const u = j.usage || {};
    return { ok: true, text: text.slice(0, MAX_ANSWER), model: String(j.model || config.model),
      usage: Number.isFinite(u.prompt_tokens) && Number.isFinite(u.completion_tokens) ? { inputTokens: u.prompt_tokens, outputTokens: u.completion_tokens } : null };
  } catch (e) {
    return { ok: false, error: e && e.name === 'AbortError' ? 'FreeLLM timeout' : 'FreeLLM unreachable' };
  } finally { clearTimeout(timer); }
}

module.exports = { loadConfig, callTeacher, isLoopbackUrl, FIXTURE_SCOPE, DEFAULT_URL, DEFAULT_MODEL };

// ---- Bridge: lets the autopilot treat a FreeLLM call like an orchestrator task ------------------------------
// The autopilot polls orchestrator.getTask(id); ids that start with "freellm-" are answered here, everything else is
// delegated untouched to the real orchestrator.
const crypto = require('node:crypto');
const PREFIX = 'freellm-';

function createTaskBridge({ getConfig, callTeacherFn = callTeacher, fetchFn, timeoutMs = 240000 }) {
  const tasks = new Map();
  const ready = () => !!(getConfig() || {}).enabled;
  function spawn({ prompt, scope }) {
    const id = PREFIX + crypto.randomUUID();
    const task = { id, cli: 'freellm', state: 'running', result: '', error: null, usage: null, model: null, startedAt: Date.now(), freellm: true };
    tasks.set(id, task);
    const ac = new AbortController();
    const ctl = { aborted: false, abort() { this.aborted = true; ac.abort(); } };
    task._ctl = ctl;
    Promise.resolve().then(() => callTeacherFn({ config: getConfig(), prompt, scope, timeoutMs, fetchFn, signal: ac.signal })).then((r) => {
      if (ctl.aborted) return;
      if (r && r.ok) { task.state = 'completed'; task.result = r.text; task.usage = r.usage; task.model = r.model; }
      else { task.state = 'failed'; task.error = (r && r.error) || 'FreeLLM failed'; }
    }).catch((e) => { if (!ctl.aborted) { task.state = 'failed'; task.error = 'FreeLLM error'; } });
    return { id };
  }
  const view = (t) => (t ? { id: t.id, cli: t.cli, state: t.state, result: t.result, error: t.error, usage: t.usage, model: t.model, freellm: true } : null);
  function wrap(orch) {
    if (!orch || typeof orch !== 'object') return orch;
    const own = {
      getTask: (id) => (typeof id === 'string' && id.startsWith(PREFIX) ? view(tasks.get(id)) : orch.getTask(id)),
      cancelTask: (id) => {
        if (typeof id === 'string' && id.startsWith(PREFIX)) { const t = tasks.get(id); if (t && t.state === 'running') { t._ctl.abort(); t.state = 'cancelled'; } return true; }
        return orch.cancelTask(id);
      },
      ensureTaskProcessTerminated: async (id) => (typeof id === 'string' && id.startsWith(PREFIX) ? { terminated: true, virtual: true } : orch.ensureTaskProcessTerminated?.(id)),
    };
    return new Proxy(orch, { get(target, prop) {
      if (Object.hasOwn(own, prop)) return own[prop];
      const v = Reflect.get(target, prop, target);
      return typeof v === 'function' ? v.bind(target) : v;
    } });
  }
  return { ready, spawn, wrap, _tasks: tasks };
}

module.exports.createTaskBridge = createTaskBridge;
module.exports.PREFIX = PREFIX;
