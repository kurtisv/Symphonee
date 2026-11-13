'use strict';
// Shared API-token resolver for the Node helper scripts. The Symphonee server
// gates mutating requests (POST/PUT/DELETE/PATCH) behind a per-boot token, so
// these scripts must present it. Resolves the token the same way scripts/
// _ApiInit.ps1 does for the PowerShell helpers:
//   1. $env:SYMPHONEE_TOKEN  -- set when Symphonee spawns the shell (usual case)
//   2. config/runtime.json   -- for scripts run manually outside a spawned shell
// Reads (GET) are unaffected; an empty token just attaches nothing, so the
// server's kill switch / disabled-enforcement modes keep working.
const fs = require('fs');
const path = require('path');

// config/runtime.json is rewritten at every boot, so it wins: an inherited
// SYMPHONEE_TOKEN goes stale after a restart (403 TOKEN_REQUIRED) in shells
// that outlive it. The environment is the fallback when the file is absent.
function apiToken() {
  try {
    const runtimePath = path.join(__dirname, '..', 'config', 'runtime.json');
    const t = JSON.parse(fs.readFileSync(runtimePath, 'utf8')).token;
    if (t) return t;
  } catch (_) {}
  return process.env.SYMPHONEE_TOKEN || '';
}

// Header object to merge into a request's headers ({} when no token is found).
function authHeaders() {
  const t = apiToken();
  return t ? { 'X-Symphonee-Token': t } : {};
}

module.exports = { apiToken, authHeaders };
