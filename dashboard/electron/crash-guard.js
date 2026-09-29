'use strict';
// Crash visibility + renderer self-heal for the Electron main process.
// Before this, Symphonee died with no trace (no minidump, no log line), so a
// "closes by itself" report could not be diagnosed. Everything here is
// best-effort and must never throw into the main process.
const fs = require('fs');
const path = require('path');
const os = require('os');

function makeLogger(logFile) {
  return function log(kind, details = {}) {
    try {
      const line = JSON.stringify({
        at: new Date().toISOString(), kind, pid: process.pid,
        freeMemMB: Math.round(os.freemem() / 1048576),
        rssMB: Math.round(process.memoryUsage().rss / 1048576),
        ...details,
      });
      fs.mkdirSync(path.dirname(logFile), { recursive: true });
      // Keep the log bounded: rotate once it passes 1 MB.
      try { if (fs.statSync(logFile).size > 1048576) fs.renameSync(logFile, logFile + '.1'); } catch (_) {}
      fs.appendFileSync(logFile, line + '\n');
    } catch (_) {}
  };
}

// Reload a crashed renderer instead of leaving a dead window, but give up
// after too many crashes in a short window so a crash loop cannot spin.
function shouldReload(history, now, { max = 3, windowMs = 5 * 60 * 1000 } = {}) {
  const recent = history.filter(t => now - t < windowMs);
  history.length = 0; history.push(...recent);
  if (recent.length >= max) return false;
  history.push(now);
  return true;
}

function installCrashGuard({ app, crashReporter, getWin }) {
  const logFile = path.join(app.getPath('userData'), 'crash-log.jsonl');
  const log = makeLogger(logFile);
  try { crashReporter && crashReporter.start({ uploadToServer: false, compress: true }); } catch (_) {}

  const reloads = [];
  app.on('render-process-gone', (_e, contents, details) => {
    log('render-process-gone', { reason: details && details.reason, exitCode: details && details.exitCode });
    const win = getWin();
    if (!win || win.isDestroyed() || contents !== win.webContents) return;
    if (details && details.reason === 'clean-exit') return;
    if (shouldReload(reloads, Date.now())) {
      setTimeout(() => { try { if (!win.isDestroyed()) win.webContents.reload(); } catch (_) {} }, 1000);
    }
  });
  app.on('child-process-gone', (_e, details) => {
    log('child-process-gone', { type: details && details.type, reason: details && details.reason, exitCode: details && details.exitCode });
  });
  // Monitor only: observing must not change Electron's own uncaught-exception
  // handling (its error dialog), just record it.
  process.on('uncaughtExceptionMonitor', (err) => log('uncaughtException', { message: err && err.message, stack: err && String(err.stack).slice(0, 2000) }));
  process.on('unhandledRejection', (err) => log('unhandledRejection', { message: err && err.message, stack: err && String(err.stack || err).slice(0, 2000) }));
  app.on('before-quit', () => log('before-quit'));
  process.on('exit', (code) => log('exit', { code }));
  log('start', { version: app.getVersion && app.getVersion() });
  return { log, logFile };
}

module.exports = { installCrashGuard, makeLogger, shouldReload };
