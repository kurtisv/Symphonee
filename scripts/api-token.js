'use strict';
// Shared API-token resolver for the Node helper scripts. The Symphonee server
// gates mutating requests (POST/PUT/DELETE/PATCH) behind a per-boot token, so
// these scripts must present it. Same rule as scripts/_ApiInit.ps1:
//   1. config/runtime.json, but ONLY when the Symphonee process that wrote it is
//      still running (its pid is alive): the file is rewritten at every boot,
//      so it beats an environment token inherited before a restart;
//   2. otherwise $env:SYMPHONEE_TOKEN.
// A runtime.json left by a Symphonee that is no longer running (for example an
// old one in another checkout, where workers often run) is ignored: trusting it
// sent a stale token and every call was refused with 403.
// Reads (GET) are unaffected; an empty token just attaches nothing.
const fs = require('fs');
const path = require('path');

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

// Pure resolver, injectable for tests.
function resolveToken({ runtimePath, env = process.env, isAlive = pidAlive } = {}) {
  try {
    const rt = JSON.parse(fs.readFileSync(runtimePath, 'utf8'));
    const pid = Number(rt && rt.pid);
    if (rt && rt.token && Number.isInteger(pid) && pid > 0 && isAlive(pid)) return rt.token;
  } catch (_) {}
  return env.SYMPHONEE_TOKEN || '';
}

function apiToken() {
  return resolveToken({ runtimePath: path.join(__dirname, '..', 'config', 'runtime.json') });
}

// Header object to merge into a request's headers ({} when no token is found).
function authHeaders() {
  const t = apiToken();
  return t ? { 'X-Symphonee-Token': t } : {};
}

module.exports = { apiToken, authHeaders, resolveToken };
