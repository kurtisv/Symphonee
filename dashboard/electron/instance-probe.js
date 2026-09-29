'use strict';
// Decides whether the Symphonee instance holding the single-instance lock is
// alive before a second launch is allowed to kill it. Extracted from
// electron-main.js so it is testable without Electron.
//
// Verdicts:
//   'alive' -- the server answered HTTP.
//   'slow'  -- the port accepts connections / requests time out. The instance
//              is busy (e.g. the machine is swapping), NOT dead. Never kill.
//   'dead'  -- every probe got ECONNREFUSED (nothing listening). Safe to kill.
const http = require('http');

function probeOnce({ host, port, timeoutMs, get = http.get }) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (v) => { if (!settled) { settled = true; resolve(v); } };
    let req;
    try {
      req = get(`http://${host}:${port}/api/ui/context`, { timeout: timeoutMs }, (res) => {
        res.resume();
        done('alive');
      });
    } catch (_) { return done('refused'); }
    req.on('error', (err) => done(err && err.code === 'ECONNREFUSED' ? 'refused' : 'slow'));
    req.on('timeout', () => { try { req.destroy(); } catch (_) {} done('slow'); });
  });
}

// 'dead' must survive a full startup window: the lock holder may still be on
// its splash screen with the server not listening yet (instant ECONNREFUSED),
// and a 'dead' verdict kills every Symphonee process. So refusals are only
// believed once they persisted for deadConfirmMs.
async function probeExistingInstance({ host, port, attempts = 3, timeoutMs = 5000, gapMs = 1500, deadConfirmMs = 45000, confirmGapMs = 5000, get, sleep, now } = {}) {
  const wait = sleep || ((ms) => new Promise(r => setTimeout(r, ms)));
  const clock = now || (() => Date.now());
  const start = clock();
  let sawSlow = false;
  for (let i = 0; i < attempts; i++) {
    const r = await probeOnce({ host, port, timeoutMs, get });
    if (r === 'alive') return 'alive';
    if (r === 'slow') sawSlow = true;
    if (i < attempts - 1) await wait(gapMs);
  }
  if (sawSlow) return 'slow';
  while (clock() - start < deadConfirmMs) {
    await wait(confirmGapMs);
    const r = await probeOnce({ host, port, timeoutMs, get });
    if (r === 'alive') return 'alive';
    if (r === 'slow') return 'slow';
  }
  return 'dead';
}

module.exports = { probeExistingInstance, probeOnce };
