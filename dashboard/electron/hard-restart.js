'use strict';
// Reliable restart. app.relaunch() only starts the new instance once the old
// process has fully exited; on Windows the exit can hang (open terminals), so
// the old instance stayed alive without its server and the new one never came
// (seen twice on 2026-11-13). Instead, a small detached helper waits for the
// old process, force-stops it if it is still there, then starts the new one.
const { spawn } = require('child_process');

// Source of the helper (run with ELECTRON_RUN_AS_NODE). Pure: testable.
function helperSource({ pid, execPath, args, cwd, waitMs = 8000 }) {
  return [
    "const cp = require('child_process');",
    'const pid = ' + JSON.stringify(pid) + ';',
    'const alive = () => { try { process.kill(pid, 0); return true; } catch (_) { return false; } };',
    'const start = () => {',
    '  const env = Object.assign({}, process.env); delete env.ELECTRON_RUN_AS_NODE;',
    '  cp.spawn(' + JSON.stringify(execPath) + ', ' + JSON.stringify(args) + ', { cwd: ' + JSON.stringify(cwd) + ', env, detached: true, stdio: "ignore" }).unref();',
    '};',
    'let waited = 0;',
    'const tick = () => {',
    '  if (!alive()) return start();',
    '  if (waited >= ' + JSON.stringify(waitMs) + ') {',
    // Only the main process (not /T: this helper may still count as its child).
    "    try { cp.execFileSync('taskkill', ['/PID', String(pid), '/F'], { stdio: 'ignore' }); } catch (_) {}",
    // Start only once the old process is really gone (it holds the single-instance lock).
    '    let n = 0; const after = () => { if (!alive()) return setTimeout(start, 1000); if (++n < 20) setTimeout(after, 500); };',
    '    return setTimeout(after, 500);',
    '  }',
    '  waited += 500; setTimeout(tick, 500);',
    '};',
    'setTimeout(tick, 500);',
  ].join('\n');
}

function hardRestart(app, { delayMs = 200, waitMs = 8000 } = {}) {
  const src = helperSource({ pid: process.pid, execPath: process.execPath, args: process.argv.slice(1), cwd: process.cwd(), waitMs });
  setTimeout(() => {
    try {
      spawn(process.execPath, ['-e', src], { env: Object.assign({}, process.env, { ELECTRON_RUN_AS_NODE: '1' }), detached: true, stdio: 'ignore', windowsHide: true }).unref();
    } catch (_) {
      try { app.relaunch(); } catch (__) {} // helper impossible: the old way
    }
    app.exit(0);
  }, delayMs);
}
module.exports = { hardRestart, helperSource };
