'use strict';
// Reliable restart. app.relaunch() only starts the new instance once the old
// process has fully exited; on Windows the exit can hang (open terminals), so
// the old instance stayed alive without its server and the new one never came
// (seen twice on 2026-11-13). Instead, a small detached helper waits for the
// old process, force-stops it if it is still there, then starts the new one.
const { spawn, execFileSync } = require('child_process');

// Creation time of a process as Windows recorded it (ms), or null.
function osCreationMs(pid) {
  try {
    const v = Number(execFileSync('powershell.exe', ['-NoProfile', '-Command', '([DateTimeOffset](Get-Process -Id ' + Number(pid) + ' -ErrorAction Stop).StartTime).ToUnixTimeMilliseconds()'], { encoding: 'utf8', windowsHide: true, timeout: 15000 }).trim());
    return Number.isFinite(v) ? v : null;
  } catch (_) { return null; }
}

// Source of the helper (run with ELECTRON_RUN_AS_NODE). Pure: testable.
// Identity of the old process = pid + creation time read when the helper
// starts (the old process is certainly alive then): a reused pid is never killed.
function helperSource({ pid, birthMs, execPath, args, cwd, waitMs = 8000 }) {
  return [
    "const cp = require('child_process');",
    'const pid = ' + JSON.stringify(pid) + ';',
    "const created = () => { try { const v = Number(cp.execFileSync('powershell.exe', ['-NoProfile', '-Command', '([DateTimeOffset](Get-Process -Id ' + pid + ' -ErrorAction Stop).StartTime).ToUnixTimeMilliseconds()'], { encoding: 'utf8', windowsHide: true }).trim()); return Number.isFinite(v) ? v : null; } catch (_) { return null; } };",
    // Creation time given by the old process itself BEFORE it exits (never read after: the pid could be reused).
    'const birth = ' + JSON.stringify(Number.isFinite(birthMs) ? birthMs : null) + ';',
    'const match = (c) => Math.abs(c - birth) < 2000;',
    'const alive = () => { try { process.kill(pid, 0); return true; } catch (_) { return false; } };',
    // Unknown identity (lookup failed) counts as STILL THERE: never start a second instance on a guess.
    'const same = () => { if (!alive()) return false; const c = created(); return c === null || birth === null || match(c); };',
    "const sure = () => { if (birth === null || !alive()) return false; const c = created(); return c !== null && match(c); };",
    'const start = () => {',
    '  const env = Object.assign({}, process.env); delete env.ELECTRON_RUN_AS_NODE;',
    '  cp.spawn(' + JSON.stringify(execPath) + ', ' + JSON.stringify(args) + ', { cwd: ' + JSON.stringify(cwd) + ', env, detached: true, stdio: "ignore" }).unref();',
    '};',
    'let waited = 0;',
    'const tick = () => {',
    '  if (!same()) return start();',
    '  if (waited >= ' + JSON.stringify(waitMs) + ') {',
    // Only the main process (not /T: this helper may still count as its child).
    "    if (sure()) { try { cp.execFileSync('taskkill', ['/PID', String(pid), '/F'], { stdio: 'ignore' }); } catch (_) {} }",
    // Start only once the old process is really gone (it holds the single-instance lock).
    '    let n = 0; const after = () => { if (!same()) return setTimeout(start, 1000); if (++n < 40) setTimeout(after, 500); };',
    '    return setTimeout(after, 500);',
    '  }',
    '  waited += 500; setTimeout(tick, 500);',
    '};',
    'setTimeout(tick, 500);',
  ].join('\n');
}

function hardRestart(app, { delayMs = 200, waitMs = 8000 } = {}) {
  // Read from Windows by the old process itself before the helper exists (null: unknown,
  // then the helper never force-stops and only waits for the old process to exit).
  const src = helperSource({ pid: process.pid, birthMs: osCreationMs(process.pid), execPath: process.execPath, args: process.argv.slice(1), cwd: process.cwd(), waitMs });
  const fallback = () => { try { app.relaunch(); } catch (_) {} app.exit(0); };
  setTimeout(() => {
    let child;
    try {
      child = spawn(process.execPath, ['-e', src], { env: Object.assign({}, process.env, { ELECTRON_RUN_AS_NODE: '1' }), detached: true, stdio: 'ignore', windowsHide: true });
    } catch (_) { return fallback(); }
    // Exit only once the helper is really running; a launch error uses the old way.
    child.once('error', fallback);
    child.once('spawn', () => { child.unref(); app.exit(0); });
  }, delayMs);
}
module.exports = { hardRestart, helperSource, osCreationMs };
