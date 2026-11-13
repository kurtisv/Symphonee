'use strict';
// Shared API-token resolver for the Node helper scripts. The Symphonee server
// gates mutating requests (POST/PUT/DELETE/PATCH) behind a per-boot token, so
// these scripts must present it. Same rule as scripts/_ApiInit.ps1:
//   1. config/runtime.json, but ONLY when the Symphonee process that wrote it is
//      still running: its pid is alive AND that process started just before the
//      file's startedAt (so a pid reused by another program does not count).
//      The file is rewritten at every boot, so it beats an environment token
//      inherited before a restart;
//   2. otherwise $env:SYMPHONEE_TOKEN (the server passes it to its workers).
// A runtime.json left by a Symphonee that no longer runs (for example an old one
// in another checkout, where workers often run) is ignored: trusting it sent a
// stale token and every call was refused with 403.
// Reads (GET) are unaffected; an empty token just attaches nothing.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

// The writer starts at most 10 minutes before writing the file, and not after
// it (2 s of slack for clock rounding).
const MAX_BEFORE_MS = 10 * 60000;
const SLACK_MS = 2000;

// Start time (ms) of a live process, or null when it does not run. Cached per pid.
const startCache = new Map();
function processStart(pid) {
  if (startCache.has(pid)) return startCache.get(pid);
  let t = null;
  try {
    const out = process.platform === 'win32'
      ? execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
        "$p = Get-Process -Id " + pid + " -ErrorAction SilentlyContinue; if ($p) { $p.StartTime.ToUniversalTime().ToString('o') }"],
      { encoding: 'utf8', timeout: 8000, windowsHide: true })
      : execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8', timeout: 5000 });
    const ms = Date.parse(String(out).trim());
    t = Number.isFinite(ms) ? ms : null;
  } catch (_) { t = null; }
  startCache.set(pid, t);
  return t;
}

// True when the process `pid` plausibly wrote a file stamped `startedAt`.
function writerRunning(pid, startedAt, startOf = processStart) {
  const written = Date.parse(startedAt);
  if (!Number.isInteger(pid) || pid <= 0 || !Number.isFinite(written)) return false;
  const started = startOf(pid);
  if (started == null) return false;
  return started <= written + SLACK_MS && written - started <= MAX_BEFORE_MS;
}

// Pure resolver, injectable for tests.
function resolveToken({ runtimePath, env = process.env, isWriterRunning = writerRunning } = {}) {
  try {
    const rt = JSON.parse(fs.readFileSync(runtimePath, 'utf8'));
    if (rt && rt.token && isWriterRunning(Number(rt.pid), rt.startedAt)) return rt.token;
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

module.exports = { apiToken, authHeaders, resolveToken, writerRunning };
