'use strict';
// Stale-instance + port reclamation for the Electron main process (Windows only).
// Kills any process holding the app port or any other Electron instance of this
// exe, so a relaunch can bind cleanly. Extracted from electron-main.js.
const path = require('path');

/**
 * Pick the Electron processes that are safe to treat as stale: same executable
 * as us, not us, and started BEFORE this process. A process started after us
 * (e.g. an instance another relaunch just started) is never stale.
 * @param {Array<{pid:number, startedAtMs:number, exePath:string}>} procs
 */
function selectStaleElectron(procs, { myPid, myStartMs, exePath }) {
  const norm = (p) => String(p || '').toLowerCase();
  return procs
    .filter(p => p.pid !== myPid && norm(p.exePath) === norm(exePath) && Number.isFinite(p.startedAtMs) && p.startedAtMs < myStartMs)
    .map(p => p.pid);
}

function listElectronProcesses(exeName, execSync) {
  const ps = `Get-CimInstance Win32_Process -Filter \\"Name='${exeName}'\\" | ForEach-Object { '{0}|{1}|{2}' -f $_.ProcessId, ([DateTimeOffset]$_.CreationDate).ToUnixTimeMilliseconds(), $_.ExecutablePath }`;
  const out = execSync(`powershell -NoProfile -NonInteractive -Command "${ps}"`, { encoding: 'utf8', timeout: 15000, windowsHide: true });
  return out.split(/\r?\n/).map(l => l.trim()).filter(Boolean).map(l => {
    const [pid, startedAtMs, exePath] = l.split('|');
    return { pid: Number(pid), startedAtMs: Number(startedAtMs), exePath };
  });
}

/**
 * Kill anything holding port 3800 and/or stale Electron instances of this exe.
 * Returns true if something was killed.
 */
function killStaleProcesses(port) {
  if (process.platform !== 'win32') return false;
  const { execSync } = require('child_process');
  const myPid = process.pid;
  const myStartMs = Date.now() - process.uptime() * 1000;
  const pidsToKill = new Set();

  // Strategy 1: find PIDs holding port 3800 via netstat
  try {
    const out = execSync(`netstat -ano | findstr :${port} | findstr LISTENING`, { encoding: 'utf8', timeout: 5000 });
    for (const line of out.trim().split('\n')) {
      const m = line.trim().match(/\s(\d+)$/);
      if (m && Number(m[1]) !== myPid) pidsToKill.add(m[1]);
    }
  } catch (_) { /* no listeners on port -- fine */ }

  // Strategy 2: other instances of THIS executable that were already running
  // when we started. Previously every electron.exe was killed -- including an
  // instance a parallel relaunch had just started, and other Electron apps.
  try {
    const exeName = path.basename(process.execPath);
    for (const pid of selectStaleElectron(listElectronProcesses(exeName, execSync), { myPid, myStartMs, exePath: process.execPath })) {
      pidsToKill.add(String(pid));
    }
  } catch (_) { /* cannot enumerate safely -> kill nothing by name */ }

  if (pidsToKill.size) {
    try {
      execSync(`taskkill /F ${[...pidsToKill].map(p => '/PID ' + p).join(' ')}`, { encoding: 'utf8', timeout: 5000 });
      console.log('Killed stale process(es):', [...pidsToKill].join(', '));
      return true;
    } catch (_) {}
  }
  return false;
}

module.exports = { killStaleProcesses, selectStaleElectron, listElectronProcesses };
