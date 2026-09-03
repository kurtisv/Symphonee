'use strict';

const http = require('http');
const { URL } = require('url');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const STATES = Object.freeze({ UNKNOWN: 'UNKNOWN', STARTING: 'STARTING', READY: 'READY', DEGRADED: 'DEGRADED', UNAVAILABLE: 'UNAVAILABLE' });
const OLLAMA_BASE = process.env.OLLAMA_URL || 'http://localhost:11434';
const MAX_ATTEMPTS = 5;
const BACKOFF_MS = [150, 300, 600, 1000, 1500];
const RETRY_COOLDOWN_MS = 10_000;

function findBinary() {
  if (process.env.OLLAMA_BIN && fs.existsSync(process.env.OLLAMA_BIN)) return process.env.OLLAMA_BIN;
  const candidates = process.platform === 'win32'
    ? [path.join(os.homedir(), 'AppData', 'Local', 'Programs', 'Ollama', 'ollama.exe'), 'C:\\Program Files\\Ollama\\ollama.exe']
    : ['/usr/local/bin/ollama', '/usr/bin/ollama'];
  return candidates.find(p => { try { return fs.existsSync(p); } catch (_) { return false; } }) || null;
}

function probeEndpoint(timeoutMs = 800) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (value) => { if (!settled) { settled = true; resolve(value); } };
    try {
      const u = new URL(OLLAMA_BASE + '/api/tags');
      const req = http.request({ hostname: u.hostname, port: u.port || 80, path: u.pathname, method: 'GET' }, (res) => {
        res.resume();
        res.on('end', () => done(res.statusCode === 200));
      });
      req.on('error', () => done(false));
      req.setTimeout(timeoutMs, () => { req.destroy(); done(false); });
      req.end();
    } catch (_) { done(false); }
  });
}

function createOllamaHealth({ probe = probeEndpoint, start = defaultStart, sleep = ms => new Promise(r => setTimeout(r, ms)), now = () => Date.now(), onChange } = {}) {
  let state = STATES.UNKNOWN;
  let lastError = null;
  let checkedAt = 0;
  let retryAt = 0;
  let startupPromise = null;
  const listeners = new Set();

  function setState(next, error = null) {
    if (state === next && lastError === error) return;
    state = next; lastError = error; checkedAt = now();
    try { onChange && onChange({ state, checkedAt, error: lastError }); } catch (_) {}
    for (const listener of listeners) { try { listener({ state, checkedAt, error: lastError }); } catch (_) {} }
  }

  async function check() {
    const ready = await probe();
    if (ready) { retryAt = 0; setState(STATES.READY); }
    return ready;
  }

  async function ensureReady({ installPath = findBinary() } = {}) {
    if (await check()) return { ok: true, state };
    if (!installPath) { setState(STATES.UNAVAILABLE, 'not-installed'); return { ok: false, state, error: lastError }; }
    if (startupPromise) return startupPromise;
    if (state === STATES.UNAVAILABLE && now() < retryAt) return { ok: false, state, error: lastError };
    startupPromise = (async () => {
      setState(STATES.STARTING);
      let started = false;
      try { started = await start(installPath); } catch (e) { lastError = e.message; }
      if (!started) {
        retryAt = now() + RETRY_COOLDOWN_MS;
        setState(STATES.UNAVAILABLE, lastError || 'startup-failed');
        return { ok: false, state, error: lastError };
      }
      for (let i = 0; i < MAX_ATTEMPTS; i++) {
        if (await check()) return { ok: true, state };
        if (i < MAX_ATTEMPTS - 1) await sleep(BACKOFF_MS[i]);
      }
      retryAt = now() + RETRY_COOLDOWN_MS;
      setState(STATES.DEGRADED, 'endpoint-not-ready');
      return { ok: false, state, error: lastError };
    })().finally(() => { startupPromise = null; });
    return startupPromise;
  }

  function status() { return { state, checkedAt, error: lastError, starting: !!startupPromise }; }
  function subscribe(listener) { if (typeof listener !== 'function') return () => {}; listeners.add(listener); return () => listeners.delete(listener); }
  return { ensureReady, check, status, subscribe, STATES };
}

function defaultStart(installPath) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (value) => { if (!settled) { settled = true; resolve(value); } };
    try {
      const child = spawn(installPath, ['serve'], { detached: true, stdio: 'ignore', windowsHide: true });
      child.once('error', () => done(false));
      child.once('spawn', () => { child.unref(); done(true); });
    } catch (_) { done(false); }
  });
}

const singleton = createOllamaHealth();
module.exports = { STATES, createOllamaHealth, findBinary, probeEndpoint, health: singleton, ensureReady: singleton.ensureReady, getStatus: singleton.status };
