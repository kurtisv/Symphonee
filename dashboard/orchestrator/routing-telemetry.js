'use strict';
// Routing telemetry: what Symphonee ACTUALLY used, per task.
//
// Every finished task lands in exactly one route bucket:
//   LOCAL_DIRECT             completed on a direct LM Studio provider
//   LOCAL_CODEX              completed on codex-oss-local (Codex + LM Studio)
//   CLOUD_DIRECT             started on a cloud provider
//   LOCAL_TO_CLOUD_FAILOVER  started local, finished (or ended) on cloud
// plus LOCAL_FAILED for a local attempt that had no cloud fallback.
//
// Records are appended to <workspace>/routing-telemetry.jsonl so a summary
// survives restarts ("73 tasks -> 49 local, 8 Codex OSS, 14 cloud, 2 failover").

const fs = require('fs');
const path = require('path');
const { isLocalProvider, getLocalProvider } = require('./local-providers');

const ROUTES = Object.freeze({
  LOCAL_DIRECT: 'LOCAL_DIRECT', LOCAL_CODEX: 'LOCAL_CODEX', CLOUD_DIRECT: 'CLOUD_DIRECT',
  LOCAL_TO_CLOUD_FAILOVER: 'LOCAL_TO_CLOUD_FAILOVER', LOCAL_FAILED: 'LOCAL_FAILED',
});

function classifyRoute(attempts) {
  const list = (attempts || []).filter(a => a && a.provider);
  if (!list.length) return null;
  const first = list[0].provider;
  const last = list[list.length - 1];
  if (!isLocalProvider(first)) return ROUTES.CLOUD_DIRECT;
  if (list.some(a => !isLocalProvider(a.provider))) return ROUTES.LOCAL_TO_CLOUD_FAILOVER;
  if (last.outcome !== 'success') return ROUTES.LOCAL_FAILED;
  // Direct LM Studio call vs. a local agentic CLI (codex-oss-local, claude-local).
  return getLocalProvider(last.provider).kind === 'lmstudio-direct' ? ROUTES.LOCAL_DIRECT : ROUTES.LOCAL_CODEX;
}

class RoutingTelemetry {
  constructor({ file = null, now = () => Date.now() } = {}) {
    this.file = file; this.now = now;
    this.records = [];
    if (file) {
      try {
        for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
          if (!line.trim()) continue;
          try { this.records.push(JSON.parse(line)); } catch (_) {}
        }
      } catch (_) {}
    }
  }

  /** Record one finished task. `task.routingHistory` holds every attempt in order. */
  recordTask(task) {
    if (!task || task._telemetryRecorded) return null;
    const attempts = (task.routingHistory && task.routingHistory.length)
      ? task.routingHistory
      : [{ provider: task.selectedProvider || task.cli, outcome: task.state === 'completed' ? 'success' : task.state, startedAt: task.startedAt, endedAt: task.completedAt }];
    const route = classifyRoute(attempts);
    if (!route) return null;
    const first = attempts[0];
    const last = attempts[attempts.length - 1];
    const failover = attempts.find((a, i) => i > 0 && !isLocalProvider(a.provider) && isLocalProvider(attempts[i - 1].provider));
    const rec = {
      at: new Date(this.now()).toISOString(), taskId: task.id, route,
      provider: last.provider, firstProvider: first.provider,
      model: task.model || null, role: task.selectedRole || null, taskClass: task.taskClass || null,
      reason: Array.isArray(task.routingReason) ? task.routingReason.slice(0, 4) : task.routingReason || null,
      ok: last.outcome === 'success',
      durationMs: (task.completedAt && (task._firstStartedAt || task.startedAt)) ? task.completedAt - (task._firstStartedAt || task.startedAt) : null,
      failoverReason: failover ? (attempts[attempts.indexOf(failover) - 1].errorClassification || 'local failure') : null,
      retries: Number(task._retryAttempt || 0),
      attempts: attempts.map(a => ({ provider: a.provider, locality: isLocalProvider(a.provider) ? 'local' : 'cloud', outcome: a.outcome, error: a.errorClassification || null })),
      estimatedPromptTokens: task.estimatedPromptTokens || null,
      locality: isLocalProvider(last.provider) ? 'local' : 'cloud',
      cloudUsed: attempts.some(a => !isLocalProvider(a.provider)),
    };
    task._telemetryRecorded = true;
    task.routeCategory = route;
    this.records.push(rec);
    if (this.file) {
      try { fs.mkdirSync(path.dirname(this.file), { recursive: true }); fs.appendFileSync(this.file, JSON.stringify(rec) + '\n'); } catch (_) {}
    }
    return rec;
  }

  summary({ since } = {}) {
    const from = since ? Date.parse(since) : 0;
    const recs = this.records.filter(r => !from || Date.parse(r.at) >= from);
    const counts = Object.fromEntries(Object.values(ROUTES).map(k => [k, 0]));
    const byProvider = {};
    for (const r of recs) {
      counts[r.route] = (counts[r.route] || 0) + 1;
      byProvider[r.provider] = (byProvider[r.provider] || 0) + 1;
    }
    const local = counts.LOCAL_DIRECT + counts.LOCAL_CODEX;
    return {
      total: recs.length, counts, byProvider,
      localCompleted: local, cloudTasks: counts.CLOUD_DIRECT + counts.LOCAL_TO_CLOUD_FAILOVER,
      line: `${recs.length} tasks -> ${counts.LOCAL_DIRECT} local direct, ${counts.LOCAL_CODEX} Codex OSS local, ${counts.CLOUD_DIRECT} cloud direct, ${counts.LOCAL_TO_CLOUD_FAILOVER} local->cloud failover` + (counts.LOCAL_FAILED ? `, ${counts.LOCAL_FAILED} local failed (no fallback)` : ''),
      recent: recs.slice(-20),
    };
  }
}

module.exports = { ROUTES, classifyRoute, RoutingTelemetry };
