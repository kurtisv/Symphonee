'use strict';

// Only direct local-answer requests are counted here. No prompt or answer is
// retained or broadcast. Other Brain and orchestrator work is not covered.
function createLocalActivity({ broadcast, now = () => Date.now() } = {}) {
  let count = 0, startedAt = null, updatedAt = now();
  const snapshot = () => ({ activeCount: count, startedAt, updatedAt, scope: 'direct-local-ask' });
  const notify = () => { try { if (broadcast) broadcast({ type: 'symphonee-local-activity', payload: snapshot() }); } catch (_) {} };
  return {
    snapshot,
    begin() {
      const at = now();
      if (count === 0) startedAt = at;
      count++; updatedAt = at; notify();
      let ended = false;
      return () => {
        if (ended) return;
        ended = true; count--; updatedAt = now();
        if (count === 0) startedAt = null;
        notify();
      };
    },
  };
}

module.exports = { createLocalActivity };
