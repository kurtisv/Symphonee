'use strict';
// FreeLLM plugin core: guard for what may be sent, a generic chat call, and a process manager.
// FreeLLMAPI runs on THIS machine but forwards prompts to external free providers, so:
//   - chat() only accepts scope 'public' or 'fictional-fixture' and refuses text that looks like a secret or personal/payroll data;
//   - the base URL must be loopback (the unified key never leaves the machine);
//   - the manager starts/stops only the FreeLLM process it launched itself.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const teacher = require('../../../mind/freellm-teacher');

const SCOPES = Object.freeze(['public', 'fictional-fixture']);
const MAX_PROMPT = 12000;
const MAX_OUT = 4000;

// Anything that looks like a credential or personal data is refused BEFORE any network call.
const SECRET_RES = [
  /\b(ghp|gho|ghs|github_pat|glpat|sk-ant|sk-or|xox[abp]|nvapi|csk)[-_][A-Za-z0-9_\-]{12,}/,
  /\bsk-[A-Za-z0-9]{20,}/, /\bAKIA[0-9A-Z]{12,}/, /\bAIza[0-9A-Za-z_\-]{20,}/, /\bAQ\.[A-Za-z0-9_\-]{30,}/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/, /\bBearer\s+[A-Za-z0-9._\-]{20,}/, /\b[0-9a-f]{40,}\b/i,
];
const SENSITIVE_RES = [
  /\b(mot de passe|password|passwd|secret|token|api[-_ ]?key)\s*[:=]/i,
  /\b(paie|talon de paie|bulletin de paie|salaire|payroll|salary)\b/i,
  /\b(NAS|num[eé]ro d['’ ]assurance sociale|IBAN|carte de cr[eé]dit)\b/,
  /\b\d{3}[ -]\d{3}[ -]\d{3}\b/, /\b(?:\d[ -]?){13,19}\b/,
];

function guardPrompt(text) {
  const t = String(text || '');
  if (SECRET_RES.some((re) => re.test(t))) return { ok: false, reason: 'refused: the text looks like it contains a secret or key' };
  if (SENSITIVE_RES.some((re) => re.test(t))) return { ok: false, reason: 'refused: the text looks like it contains personal, payroll or credential data' };
  return { ok: true };
}

async function chat({ config, prompt, scope, model, timeoutMs = 120000, fetchFn = globalThis.fetch }) {
  if (!SCOPES.includes(scope)) return { ok: false, error: "refused: scope must be 'public' or 'fictional-fixture'" };
  if (!config || !config.enabled) return { ok: false, error: 'disabled: ' + ((config && config.reason) || 'not configured') };
  const g = guardPrompt(prompt);
  if (!g.ok) return { ok: false, error: g.reason };
  if (typeof fetchFn !== 'function') return { ok: false, error: 'no fetch available' };
  const ctl = new AbortController(); const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetchFn(config.baseUrl + '/chat/completions', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + config.apiKey },
      body: JSON.stringify({ model: String(model || config.model), temperature: 0.3, max_tokens: MAX_OUT, messages: [{ role: 'user', content: String(prompt || '').slice(0, MAX_PROMPT) }] }),
      signal: ctl.signal,
    });
    if (!res.ok) return { ok: false, error: 'FreeLLM HTTP ' + res.status };
    const j = await res.json(); const c = j && j.choices && j.choices[0];
    if (c && c.finish_reason === 'length') return { ok: false, error: 'FreeLLM answer cut by the token limit' };
    const text = c && c.message && c.message.content;
    if (typeof text !== 'string' || !text.trim()) return { ok: false, error: 'FreeLLM returned no text' };
    return { ok: true, text: text.slice(0, 12000), model: String(j.model || config.model), usage: j.usage || null };
  } catch (e) { return { ok: false, error: e && e.name === 'AbortError' ? 'FreeLLM timeout' : 'FreeLLM unreachable' }; }
  finally { clearTimeout(timer); }
}

function findInstallDir({ env = process.env, repoRoot, exists = fs.existsSync } = {}) {
  const cands = [env.SYMPHONEE_FREELLM_DIR, repoRoot && path.resolve(repoRoot, '..', 'freellm'), path.join(os.homedir(), 'source', 'freellm'), path.join(os.homedir(), 'freellm')].filter(Boolean);
  return cands.find((d) => exists(path.join(d, 'server', 'dist', 'index.js'))) || null;
}

function createManager({ installDir, port = 3001, fetchFn = globalThis.fetch, spawnFn = spawn, getConfig = () => ({ enabled: false }), log = () => {} }) {
  let child = null;
  async function probe() {
    try { const r = await fetchFn(`http://127.0.0.1:${port}/api/auth/status`, { signal: AbortSignal.timeout(2500) }); return r.status > 0 && r.status < 500; }
    catch (_) { return false; }
  }
  async function status() {
    const cfg = getConfig() || {};
    return { installed: !!installDir, running: await probe(), managed: !!child, configured: !!cfg.enabled, port, url: `http://127.0.0.1:${port}/`, model: cfg.model || null };
  }
  async function start() {
    if (!installDir) return { ok: false, error: 'FreeLLMAPI is not installed (build server/dist first)' };
    if (await probe()) return { ok: true, already: true };
    if (child) return { ok: true, already: true };
    child = spawnFn(process.execPath, ['dist/index.js'], { cwd: path.join(installDir, 'server'), windowsHide: true, stdio: 'ignore', env: Object.assign({}, process.env, { NODE_ENV: 'production' }) });
    const mine = child;
    mine.on('error', (e) => { log('freellm failed to start: ' + e.message); if (child === mine) child = null; });
    mine.on('exit', (c) => { log('freellm exited (' + c + ')'); if (child === mine) child = null; });
    for (let i = 0; i < 20; i++) { await new Promise((r) => setTimeout(r, 1000)); if (await probe()) return { ok: true, started: true }; if (child !== mine) break; }
    return { ok: false, error: 'FreeLLMAPI did not answer in time' };
  }
  function stop() {
    if (!child) return { ok: true, note: 'nothing started by Symphonee to stop' };
    const mine = child; child = null;
    try { mine.kill(); } catch (_) {}
    return { ok: true };
  }
  return { status, start, stop, probe };
}

module.exports = { guardPrompt, chat, findInstallDir, createManager, SCOPES, loadConfig: teacher.loadConfig };
