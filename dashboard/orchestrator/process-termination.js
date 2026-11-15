'use strict';
// A process 'close' event proves only the parent exited. It cannot certify a
// Windows descendant tree. Only a containment owner (e.g. an OS Job object)
// may return complete-tree proof. Missing evidence deliberately parks handoff.
const { randomUUID } = require('crypto');
const { readProof } = require('./windows-job');
const leases = new WeakMap();
function trackProcess(task, proc, job = null) {
  const attemptId = job ? job.attemptId : randomUUID();
  task.processAttemptId = attemptId;
  task.terminationEvidence = { proven: false, attemptId, reason: 'process-tree-unverified', checkedAt: Date.now() };
  const lease = { attemptId, pid: Number.isInteger(proc.pid) ? proc.pid : null, closed: false, inflight: null };
  leases.set(task, lease);
  proc.once('close', () => {
    lease.closed = true;
    if (job && leases.get(task) === lease) {
      const e = readProof(job, lease.pid);
      if (e && e.terminated === true && e.scope === 'process-tree' && e.method === 'windows-job-object') {
        task.terminationEvidence = { proven: true, attemptId, checkedAt: Date.now(),
          reason: 'complete-tree-terminated', scope: e.scope, method: e.method };
      }
    }
  });
}
async function ensureTerminated(task, { verify, stop, now = Date.now, timeoutMs = 10000 } = {}) {
  if (!task) return { proven: false, reason: 'task-not-found', checkedAt: now() };
  const prior = task.terminationEvidence;
  if (prior && prior.proven === true && typeof prior.attemptId === 'string' && /^[a-f0-9-]{36}$/.test(prior.attemptId) && prior.attemptId === task.processAttemptId
    && prior.scope === 'process-tree' && prior.method === 'windows-job-object') return prior;
  const lease = leases.get(task);
  let expired = false;
  const record = (proven, reason, extras = {}) => {
    if (expired) return { proven: false, reason: 'tree-verification-timeout', checkedAt: now() };
    if (lease && leases.get(task) !== lease) return { proven: false, reason: 'attempt-replaced', checkedAt: now() };
    return (task.terminationEvidence = { proven, reason, attemptId: task.processAttemptId || null, checkedAt: now(), ...extras });
  };
  if (!lease) return record(false, 'process-ownership-lost');
  if (lease.inflight) return lease.inflight;
  const work = Promise.resolve().then(async () => {
    try {
      if (!lease.closed && stop) await stop();
      if (typeof verify !== 'function') return record(false, 'complete-tree-verifier-unavailable');
      const e = await verify({ taskId: task.id, attemptId: lease.attemptId, pid: lease.pid, parentClosed: lease.closed });
      if (e && e.attemptId === lease.attemptId && e.terminated === true
        && e.scope === 'process-tree' && e.method === 'windows-job-object') {
        return record(true, 'complete-tree-terminated', { scope: e.scope, method: e.method });
      }
      return record(false, 'incomplete-tree-proof');
    } catch (_) { return record(false, 'tree-verification-failed'); }
  });
  let timer;
  lease.inflight = Promise.race([work, new Promise(resolve => {
    timer = setTimeout(() => { const result = record(false, 'tree-verification-timeout'); expired = true; resolve(result); }, Math.max(10, Math.min(15000, timeoutMs)));
  })]).finally(() => { clearTimeout(timer); lease.inflight = null; });
  return lease.inflight;
}
module.exports = { trackProcess, ensureTerminated };
