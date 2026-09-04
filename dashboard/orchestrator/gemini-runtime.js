'use strict';

const fs = require('fs');
const path = require('path');
const childProcess = require('child_process');

const RUNTIME_INCOMPATIBLE = 'RUNTIME_INCOMPATIBLE';

function pathKey(env) {
  return Object.keys(env || {}).find((key) => key.toLowerCase() === 'path') || 'PATH';
}

function buildGeminiEnv(baseEnv = process.env, nodeExecPath = process.execPath) {
  const env = { ...(baseEnv || {}) };
  const key = pathKey(env);
  const existing = Object.keys(env)
    .filter((k) => k.toLowerCase() === 'path')
    .map((k) => env[k])
    .filter(Boolean)
    .join(path.delimiter);
  const nodeDir = nodeExecPath ? path.dirname(nodeExecPath) : '';
  const entries = existing.split(path.delimiter).filter(Boolean);
  if (nodeDir && !entries.some((entry) => entry.toLowerCase() === nodeDir.toLowerCase())) {
    entries.unshift(nodeDir);
  }
  for (const k of Object.keys(env)) {
    if (k.toLowerCase() === 'path' && k !== key) delete env[k];
  }
  env[key] = entries.join(path.delimiter);
  return env;
}

function resolveGeminiCommand({ cwd = process.cwd(), env = process.env, detect = null } = {}) {
  const bin = process.platform === 'win32' ? 'gemini.cmd' : 'gemini';
  const local = path.join(cwd, 'node_modules', '.bin', bin);
  try {
    if (fs.existsSync(local)) return { command: local, path: local, source: 'local-project' };
  } catch (_) {}
  if (typeof detect === 'function') return detect('gemini', { cwd, env });
  return { command: bin, path: '', source: 'path' };
}

function classifyProbe(output, code, error) {
  const text = String(output || '') + ' ' + String(error && error.message || error || '');
  if (/not found|not recognized|cannot find|enoent/i.test(text)) return 'NOT_INSTALLED';
  if (/requires? node|unsupported engine|node\.js version|minimum.*node|node version.*(20|21|22)|ebadengine/i.test(text)) return RUNTIME_INCOMPATIBLE;
  if (/auth|login|api key|unauthori[sz]ed|credential/i.test(text)) return 'AUTH_REQUIRED';
  if (code === 0) return 'READY';
  return 'STARTUP_ERROR';
}

function probeGemini({ cwd = process.cwd(), env = process.env, command, timeoutMs = 4000, spawnFn = childProcess.spawn, detect } = {}) {
  const resolved = command ? { command, path: command, source: 'explicit' } : resolveGeminiCommand({ cwd, env, detect });
  if (!resolved || !resolved.command || (resolved.path === '' && resolved.source !== 'path')) {
    return Promise.resolve({ state: 'NOT_INSTALLED', reason: 'NOT_INSTALLED', command: null });
  }
  return new Promise((resolve) => {
    let settled = false;
    let output = '';
    const finish = (result) => { if (!settled) { settled = true; resolve({ ...result, command: resolved.command }); } };
    let proc;
    try {
      proc = spawnFn(resolved.command, ['--version'], {
        cwd, env: buildGeminiEnv(env), stdio: ['ignore', 'pipe', 'pipe'],
        shell: process.platform === 'win32',
      });
      proc.stdout && proc.stdout.on('data', (chunk) => { output += chunk.toString(); });
      proc.stderr && proc.stderr.on('data', (chunk) => { output += chunk.toString(); });
      proc.once('error', (error) => finish({ state: 'UNAVAILABLE', reason: classifyProbe(output, null, error), details: output || error.message }));
      proc.once('close', (code) => {
        const reason = classifyProbe(output, code);
        finish({ state: reason === 'READY' ? 'READY' : 'UNAVAILABLE', reason, details: output.trim() });
      });
    } catch (error) {
      finish({ state: 'UNAVAILABLE', reason: classifyProbe(output, null, error), details: error.message });
      return;
    }
    setTimeout(() => {
      if (settled) return;
      try { proc.kill(); } catch (_) {}
      finish({ state: 'UNAVAILABLE', reason: 'STARTUP_TIMEOUT', details: output.trim() || 'Gemini --version timed out' });
    }, timeoutMs);
  });
}

function probeGeminiSync({ cwd = process.cwd(), env = process.env, command, timeoutMs = 4000, execFileSyncFn = childProcess.execFileSync } = {}) {
  const resolved = command ? { command, path: command } : resolveGeminiCommand({ cwd, env });
  if (!resolved || (!resolved.command && !resolved.path)) return { state: 'UNAVAILABLE', reason: 'NOT_INSTALLED', command: null };
  const executable = resolved.path || resolved.command;
  try {
    const output = execFileSyncFn(executable, ['--version'], {
      cwd, env: buildGeminiEnv(env), encoding: 'utf8', timeout: timeoutMs,
      shell: process.platform === 'win32', stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { state: 'READY', reason: 'READY', details: String(output || '').trim(), command: executable };
  } catch (error) {
    const details = String(error && (error.stderr || error.stdout || error.message) || error);
    const reason = error && error.code === 'ETIMEDOUT' ? 'STARTUP_TIMEOUT' : classifyProbe(details, error && error.status, error);
    return { state: 'UNAVAILABLE', reason, details, command: executable };
  }
}

module.exports = { buildGeminiEnv, resolveGeminiCommand, probeGemini, probeGeminiSync, classifyProbe, RUNTIME_INCOMPATIBLE };
