'use strict';
// Spaces out and merges Mind incremental updates.
//
// Every knowledge event (a memory, a lesson, a saved result) and every file change used to start a full incremental
// update 3 s later. Each update reads and rewrites a graph of hundreds of MB, so a burst of events froze the server
// again and again. This throttle merges every trigger received while an update is waiting or running into ONE later
// run, and keeps at least `minGapMs` between the end of one run and the start of the next.
//
// Triggers: an array of changed file paths (file watcher) or an object { knowledgeEvent, reasons, nodeIds }.

function createUpdateThrottle({ run, minGapMs = 10 * 60 * 1000, firstDelayMs = 3000, now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout, onError = () => {} }) {
  let lastEnd = 0, timer = null, running = false;
  let q = { files: new Set(), knowledge: false, reasons: new Set(), nodeIds: new Set(), extra: {} };

  const empty = () => !q.files.size && !q.knowledge;
  const take = () => {
    const out = q.knowledge
      ? { ...q.extra, knowledgeEvent: true, reasons: [...q.reasons], nodeIds: [...q.nodeIds], ...(q.files.size ? { changedFiles: [...q.files] } : {}) }
      : [...q.files];
    q = { files: new Set(), knowledge: false, reasons: new Set(), nodeIds: new Set(), extra: {} };
    return out;
  };

  function schedule() {
    if (timer || running || empty()) return;
    const wait = Math.max(firstDelayMs, lastEnd + minGapMs - now());
    timer = setTimer(async () => {
      timer = null; running = true;
      const trigger = take();
      try { await run(trigger); } catch (e) { onError(e); }
      finally { running = false; lastEnd = now(); schedule(); }
    }, wait);
    if (timer && typeof timer.unref === 'function') timer.unref();
  }

  function trigger(t) {
    if (Array.isArray(t)) t.forEach((f) => q.files.add(String(f)));
    else if (t && typeof t === 'object') {
      if (t.knowledgeEvent) q.knowledge = true;
      (t.reasons || []).forEach((r) => q.reasons.add(r));
      (t.nodeIds || []).forEach((n) => q.nodeIds.add(n));
      if (Array.isArray(t.changedFiles)) t.changedFiles.forEach((f) => q.files.add(String(f)));
      const { knowledgeEvent, reasons, nodeIds, changedFiles, ...rest } = t; Object.assign(q.extra, rest);
    } else q.knowledge = true; // unknown trigger shape: still worth one update
    schedule();
    return { queued: true, running, nextInMs: timer ? Math.max(0, lastEnd + minGapMs - now()) : 0 };
  }

  return { trigger, flushNow: () => { if (timer) { clearTimer(timer); timer = null; } return timer === null && !running && !empty() ? (async () => { running = true; try { await run(take()); } finally { running = false; lastEnd = now(); } })() : Promise.resolve(); }, _state: () => ({ running, queued: !empty(), lastEnd }) };
}

module.exports = { createUpdateThrottle };
