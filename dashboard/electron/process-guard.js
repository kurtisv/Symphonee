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
/**
 * Decide what to kill. Pure (testable).
 *  - Cannot enumerate our processes safely -> kill NOTHING (fail closed).
 *  - Stale instances of our exe (started before us) -> kill.
 *  - Port holders: a holder that is one of OUR exe's processes is only killed
 *    if it is stale (a fresher instance that just bound the port survives);
 *    any other program squatting the port is killed as before.
 */
function planKill({ portPids = [], electronProcs = null, myPid, myStartMs, exePath }) {
  if (!Array.isArray(electronProcs)) return [];
  const norm = (p) => String(p || '').toLowerCase();
  const stale = new Set(selectStaleElectron(electronProcs, { myPid, myStartMs, exePath }));
  const ours = new Set(electronProcs.filter(p => norm(p.exePath) === norm(exePath)).map(p => p.pid));
  const out = new Set(stale);
  for (const pid of portPids) {
    if (pid === myPid) continue;
    if (ours.has(pid) && !stale.has(pid)) continue;
    out.add(pid);
  }
  return [...out];
}

function killStaleProcesses(port) {
  if (process.platform !== 'win32') return false;
  const { execSync } = require('child_process');
  const myPid = process.pid;
  const myStartMs = Date.now() - process.uptime() * 1000;

  const portPids = [];
  try {
    const out = execSync(`netstat -ano | findstr :${port} | findstr LISTENING`, { encoding: 'utf8', timeout: 5000 });
    for (const line of out.trim().split('\n')) {
      const m = line.trim().match(/\s(\d+)$/);
      if (m) portPids.push(Number(m[1]));
    }
  } catch (_) { /* no listeners on port -- fine */ }

  let electronProcs = null;
  try { electronProcs = listElectronProcesses(path.basename(process.execPath), execSync); } catch (_) { electronProcs = null; }

  // Synchronous on purpose: callers are a second instance that is about to exit
  // (no window, no server) or startup before the server listens, so blocking
  // here cannot freeze anything the user sees; the relaunch must follow the kill.
  const targets = planKill({ portPids, electronProcs, myPid, myStartMs, exePath: process.execPath });
  return killAndVerify(targets, {
    kill: (pid) => execSync(`taskkill /F /PID ${pid}`, { encoding: 'utf8', timeout: 5000, stdio: 'pipe' }),
  });
}

/**
 * Kill each target separately and report success from VERIFICATION, not from
 * taskkill's exit code: taskkill exits non-zero as soon as one PID is already
 * gone, which is the normal case (Chromium children die with their main
 * process) and used to make every relaunch report "could not close".
 */
function killAndVerify(targets, { kill, isAlive = pidAlive, sleepMs = (ms) => { try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch (_) {} } } = {}) {
  if (!targets.length) return false;
  for (const pid of targets) { try { kill(pid); } catch (_) { /* already gone or access denied: verified below */ } }
  for (let i = 0; i < 10 && targets.some(isAlive); i++) sleepMs(200);
  const survivors = targets.filter(isAlive);
  if (survivors.length) { console.log('Could not stop process(es):', survivors.join(', ')); return false; }
  console.log('Stopped stale process(es):', targets.join(', '));
  return true;
}

function pidAlive(pid) {
  try { process.kill(Number(pid), 0); return true; } catch (e) { return e && e.code === 'EPERM'; }
}

/** Relaunch bookkeeping: how many automatic relaunches in a row (argv flag). */
const RELAUNCH_FLAG = '--sy-relaunch-count=';
function relaunchCount(argv = process.argv) {
  const a = argv.find(x => String(x).startsWith(RELAUNCH_FLAG));
  return a ? Number(a.slice(RELAUNCH_FLAG.length)) || 0 : 0;
}
function relaunchArgs(argv = process.argv) {
  const n = relaunchCount(argv);
  return [...argv.slice(1).filter(x => !String(x).startsWith(RELAUNCH_FLAG)), `${RELAUNCH_FLAG}${n + 1}`];
}
/** Relaunch only after a successful kill, and never more than twice in a row. */
function shouldRelaunch({ killed, count, max = 2 }) { return !!killed && count < max; }

module.exports = { killStaleProcesses, selectStaleElectron, listElectronProcesses, planKill, killAndVerify, pidAlive, relaunchCount, relaunchArgs, shouldRelaunch };
