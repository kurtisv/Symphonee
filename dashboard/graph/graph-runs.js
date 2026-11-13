/**
 * Symphonee -- Graph Runs
 *
 * Durable multi-step workflow engine. Lets you define a graph of nodes,
 * each with typed inputs and outputs, that flow state through the run.
 * Runs persist to disk so a multi-hour investigation survives app
 * restarts, circuit-breaker trips, and laptop sleeps.
 *
 * One-shot spawns (/api/orchestrator/spawn) are unchanged and do not
 * use this engine.
 *
 * Scope for v1:
 *   - Node types: worker, approval, branch
 *   - Storage: per-run JSON snapshot + append-only events WAL
 *   - Reducer: deep-merge (state writes merge into existing state)
 *   - NOT in v1: parallel/reduce, MCP tool nodes, crash-mid-node replay
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const EventEmitter = require('events');
const { deepMerge, renderTemplate, evalSafe, unreachableFrom, apiRequest, sleep, validRunSchedule, windowState } = require('./graph-runs-util');
// Optional Sentry reporting for runs created with notify:true (never throws).
let sentry = null;
try { sentry = require('../automation/sentry-report'); } catch (_) {}

const STATES = ['pending', 'running', 'awaiting_approval', 'completed', 'failed', 'cancelled', 'paused'];

function isTransientNetError(e) {
  const code = e && (e.code || '');
  return ['ECONNRESET', 'ECONNREFUSED', 'EPIPE', 'ETIMEDOUT', 'ECONNABORTED'].includes(code)
    || /socket hang up|ECONNRESET/i.test(String(e && e.message));
}

class GraphRunsEngine extends EventEmitter {
  constructor({ repoRoot, apiHost = '127.0.0.1', apiPort = 3800, injectToTerminal = null }) {
    super();
    this.repoRoot = repoRoot;
    this.apiHost = apiHost;
    this.apiPort = apiPort;
    this.injectToTerminal = injectToTerminal;
    this.runsDir = path.join(repoRoot, '.symphonee', 'graph-runs');
    this.walPath = path.join(this.runsDir, 'events.jsonl');
    this.runs = new Map(); // runId -> run object (in memory + persisted)
    this.approvalWaiters = new Map(); // `${runId}:${nodeId}` -> resolver
    this.windowTimers = new Map(); // runId -> timer waiting for the run's next work window
    this.windowStateFn = windowState; // replaceable in tests
    this._ensureDir();
    this._loadPersisted();
  }

  _ensureDir() {
    fs.mkdirSync(this.runsDir, { recursive: true });
  }

  _loadPersisted() {
    let entries = [];
    try { entries = fs.readdirSync(this.runsDir); } catch (_) { return; }
    const toResume = [];
    for (const f of entries) {
      if (!f.endsWith('.json')) continue;
      try {
        const run = JSON.parse(fs.readFileSync(path.join(this.runsDir, f), 'utf8'));
        // Runs that were mid-flight (running) or mid-approval when the app
        // stopped need their in-memory state rebuilt. The on-disk approval
        // waiter is gone, so we reset those nodes to pending and re-enter the
        // scheduler — it will recreate the waiter, the modal will surface
        // again, and Approve / Reject will work as expected.
        // 'pending' also covers a run that was waiting for its work window.
        const needsResume = run.status === 'running' || run.status === 'awaiting_approval' || run.status === 'pending';
        if (needsResume) run.status = 'pending';
        for (const n of run.nodes) {
          if (n.status === 'running' || n.status === 'awaiting_approval') n.status = 'pending';
        }
        this.runs.set(run.id, run);
        if (needsResume) toResume.push(run.id);
      } catch (_) {}
    }
    // Kick the scheduler for any resumed run. Defer so constructor finishes.
    for (const id of toResume) {
      setImmediate(() => this._executeNextBatch(id).catch(err => this._failRun(id, err.message)));
    }
  }

  _persist(run) {
    const file = path.join(this.runsDir, `${run.id}.json`);
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(run, null, 2), 'utf8');
    fs.renameSync(tmp, file);
  }

  _wal(event) {
    try {
      fs.appendFileSync(this.walPath, JSON.stringify({ ts: Date.now(), ...event }) + '\n', 'utf8');
    } catch (_) {}
  }

  _newId() {
    return 'gr_' + crypto.randomBytes(6).toString('hex');
  }

  _newNodeRunId() {
    return 'n_' + crypto.randomBytes(4).toString('hex');
  }

  // ── Public API ────────────────────────────────────────────────────────
  async createRun({ name, nodes, state = {}, from = 'user', originTermId = null, schedule = null, notify = false }) {
    const runSchedule = validRunSchedule(schedule || undefined); // throws on an invalid window
    if (!Array.isArray(nodes) || !nodes.length) throw new Error('nodes array required');
    const id = this._newId();
    const now = Date.now();
    const run = {
      id,
      name: name || 'Unnamed graph run',
      status: 'pending',
      createdAt: now,
      updatedAt: now,
      from,
      originTermId,
      state,
      schedule: runSchedule,
      notify: !!notify,
      nodes: nodes.map(n => ({
        ...n,
        status: 'pending',
        attempts: 0,
        startedAt: null,
        endedAt: null,
        output: null,
        error: null,
      })),
      events: [],
    };
    this.runs.set(id, run);
    this._wal({ kind: 'run_created', runId: id, name: run.name });
    this._persist(run);
    this.emit('run-created', run);
    // Kick off execution async
    setImmediate(() => this._executeNextBatch(id).catch(err => {
      this._failRun(id, err.message);
    }));
    return run;
  }

  listRuns() {
    return Array.from(this.runs.values()).map(r => ({
      id: r.id,
      name: r.name,
      status: r.status,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
      nodeCount: r.nodes.length,
      completedNodes: r.nodes.filter(n => n.status === 'completed').length,
    })).sort((a, b) => b.createdAt - a.createdAt);
  }

  getRun(id) { return this.runs.get(id); }

  listPendingApprovals() {
    const out = [];
    for (const run of this.runs.values()) {
      for (const node of run.nodes) {
        if (node.status === 'awaiting_approval') {
          out.push({
            runId: run.id,
            runName: run.name,
            nodeId: node.id,
            title: node.title || `Approve node ${node.id}`,
            requestedAt: node.startedAt,
            state: run.state,
          });
        }
      }
    }
    return out.sort((a, b) => a.requestedAt - b.requestedAt);
  }

  pauseRun(id) {
    const run = this.runs.get(id);
    if (!run) throw new Error('no such run');
    if (!['running', 'pending', 'awaiting_approval'].includes(run.status)) return run;
    run.status = 'paused';
    run.updatedAt = Date.now();
    this._wal({ kind: 'paused', runId: id });
    this._persist(run);
    return run;
  }

  // Re-run a FAILED node. With taskId, the node adopts that orchestrator task
  // (typically the one it had spawned, which finished after the engine lost
  // track of it) instead of spawning a new worker.
  async retryNode(runId, nodeId, { taskId } = {}) {
    const run = this.runs.get(runId);
    if (!run) throw new Error('no such run');
    if (['cancelled', 'completed'].includes(run.status)) throw new Error('run is ' + run.status);
    const node = run.nodes.find(n => n.id === nodeId);
    if (!node) throw new Error('no such node');
    if (node.status !== 'failed') throw new Error('node is ' + node.status + ', not failed');
    if (taskId !== undefined && !/^[A-Za-z0-9_-]{4,64}$/.test(String(taskId))) throw new Error('invalid taskId');
    node.status = 'pending'; node.error = null; node.endedAt = null;
    if (taskId) node.adoptTaskId = String(taskId);
    run.status = 'pending'; delete run.error;
    run.updatedAt = Date.now();
    this._wal({ kind: 'node_retried', runId, nodeId, adoptTaskId: node.adoptTaskId || null });
    this._persist(run);
    setImmediate(() => this._executeNextBatch(runId).catch(err => { this._failRun(runId, err.message); }));
    return run;
  }

  async resumeRun(id) {
    const run = this.runs.get(id);
    if (!run) throw new Error('no such run');
    if (run.status !== 'paused') return run;
    run.status = 'pending';
    run.updatedAt = Date.now();
    this._wal({ kind: 'resumed', runId: id });
    this._persist(run);
    setImmediate(() => this._executeNextBatch(id).catch(err => {
      this._failRun(id, err.message);
    }));
    return run;
  }

  cancelRun(id) {
    const run = this.runs.get(id);
    if (!run) throw new Error('no such run');
    if (['completed', 'failed', 'cancelled'].includes(run.status)) return run;
    run.status = 'cancelled';
    run.updatedAt = Date.now();
    delete run.waitingWindow;
    const wt = this.windowTimers.get(id); if (wt) { clearTimeout(wt); this.windowTimers.delete(id); }
    for (const n of run.nodes) if (n.status === 'pending' || n.status === 'awaiting_approval') n.status = 'cancelled';
    // Unblock any waiting approval
    for (const n of run.nodes) {
      const key = `${id}:${n.id}`;
      if (this.approvalWaiters.has(key)) {
        this.approvalWaiters.get(key)({ approved: false, note: 'run cancelled' });
        this.approvalWaiters.delete(key);
      }
    }
    this._wal({ kind: 'cancelled', runId: id });
    this._persist(run);
    return run;
  }

  approveNode(id, nodeId, { approved, note } = { approved: true }) {
    const run = this.runs.get(id);
    if (!run) throw new Error('no such run');
    const node = run.nodes.find(n => n.id === nodeId);
    if (!node) throw new Error('no such node');
    if (node.status !== 'awaiting_approval') throw new Error(`node is ${node.status}, not awaiting_approval`);
    const key = `${id}:${nodeId}`;
    const resolver = this.approvalWaiters.get(key);
    if (resolver) {
      this.approvalWaiters.delete(key);
      resolver({ approved: !!approved, note: note || '' });
    }
    return { ok: true };
  }

  updateState(id, patch) {
    const run = this.runs.get(id);
    if (!run) throw new Error('no such run');
    run.state = deepMerge(run.state, patch);
    run.updatedAt = Date.now();
    this._wal({ kind: 'state_interrupt', runId: id, patch });
    this._persist(run);
    return run.state;
  }

  // ── Scheduler ─────────────────────────────────────────────────────────
  async _executeNextBatch(runId) {
    const run = this.runs.get(runId);
    if (!run) return;
    if (['paused', 'cancelled', 'completed', 'failed'].includes(run.status)) return;

    run.status = 'running';
    run.updatedAt = Date.now();

    while (true) {
      // Re-check status each iteration (external pause/cancel can happen)
      if (['paused', 'cancelled'].includes(run.status)) break;

      // First, cancel any skipped nodes whose dependencies are already
      // terminal. This unblocks merge nodes downstream.
      let cancelledSomething = false;
      for (const n of run.nodes) {
        if (n.status === 'pending' && this._isSkipped(run, n) && this._areDepsComplete(run, n)) {
          n.status = 'cancelled';
          n.endedAt = Date.now();
          cancelledSomething = true;
        }
      }
      if (cancelledSomething) this._persist(run);

      let ready = run.nodes.filter(n => n.status === 'pending' && this._areDepsComplete(run, n) && !this._isSkipped(run, n));
      if (!ready.length) break;
      if (run.schedule) {
        // Work window: a node starts only inside [start, end) and only if it
        // has its minimum time (minWindowMs) before hardEnd. After two window
        // stops a node may start with less time (it is then no longer stopped).
        const w = this.windowStateFn(run.schedule);
        ready = ready.filter(n => w.canStart && (w.msToHardEnd >= (Number(n.minWindowMs) || 0) || (n.windowStops || 0) >= 2));
        if (!ready.length) { this._waitForWindow(run, w); break; }
        if (run.waitingWindow) { delete run.waitingWindow; this._wal({ kind: 'window_opened', runId }); }
      }
      // Execute ready nodes sequentially for v1 (parallel is phase 2)
      for (const node of ready) {
        if (['paused', 'cancelled'].includes(run.status)) break;
        await this._executeNode(run, node);
        this._persist(run);
      }
    }

    // Terminal state decision
    if (!['paused', 'cancelled'].includes(run.status) && !run.waitingWindow) {
      const unfinished = run.nodes.find(n => n.status === 'pending' || n.status === 'running' || n.status === 'awaiting_approval');
      if (!unfinished) {
        const anyFailed = run.nodes.some(n => n.status === 'failed');
        run.status = anyFailed ? 'failed' : 'completed';
        run.updatedAt = Date.now();
        this._wal({ kind: 'run_ended', runId, status: run.status });
        this._deliverResult(run);
        this._notify(run, run.status === 'failed' ? 'error' : 'info', 'Graph run ' + run.status + ' : ' + run.name,
          { etat: run.status }, ['graph-run', run.id, 'ended']);
      }
    }
    this._persist(run);
    this.emit('run-updated', run);
  }

  // Inject a one-line summary into the terminal that started this run,
  // so the supervisor agent knows to pick up where it left off. Mirrors
  // the orchestrator's OrchestrateResultDelivery=inject pattern.
  _deliverResult(run) {
    if (!this.injectToTerminal || !run.originTermId) return;
    const ran = run.nodes.filter(n => n.status === 'completed').length;
    const cancelled = run.nodes.filter(n => n.status === 'cancelled').length;
    const failed = run.nodes.filter(n => n.status === 'failed').length;
    const duration = Math.round((run.updatedAt - run.createdAt) / 1000);

    let detail;
    if (failed > 0) {
      // Lead with the failure. The supervisor needs to know what broke,
      // what was tried, and what the next action should be.
      const failedNode = run.nodes.find(n => n.status === 'failed');
      const err = (failedNode.error || '').replace(/\s+/g, ' ').slice(0, 500);
      detail = `FAILED node '${failedNode.id}' (${failedNode.type}): ${err}. Inspect: ./scripts/Get-GraphRun.ps1 -Id ${run.id}. If the cause is a token/rate/quota limit, retry with a different CLI via the model router.`;
    } else {
      const lastCompleted = [...run.nodes].reverse().find(n => n.status === 'completed');
      detail = lastCompleted && lastCompleted.output && lastCompleted.output.result
        ? 'last: ' + String(lastCompleted.output.result).replace(/\s+/g, ' ').substring(0, 400)
        : '(no result)';
    }
    const line = `[GRAPH RUN ${run.id}] ${run.status} - ${run.name} | ${ran} done, ${cancelled} skipped, ${failed} failed | ${duration}s | ${detail}`;
    // Submit reliably across Claude Code, Codex, Gemini, Copilot, Grok TUIs.
    // A single write of `text + \r` or `text + \r\n` is interpreted as a
    // newline INSIDE the input field by many TUIs, not as Enter. Real human
    // typing is two events: text, then (after a beat) Enter. We emulate that:
    //   1. settle delay
    //   2. write the line text
    //   3. delay
    //   4. write a bare \r as a separate event (acts as Enter)
    try {
      setTimeout(() => {
        try {
          this.injectToTerminal(run.originTermId, line);
          setTimeout(() => {
            try { this.injectToTerminal(run.originTermId, '\r'); } catch (_) {}
          }, 120);
        } catch (_) {}
      }, 250);
    } catch (_) {}
  }

  // Park the run until its next window opens. A pending run is resumed at
  // boot, so this survives restarts: the run simply re-checks its window.
  _waitForWindow(run, w) {
    const first = !run.waitingWindow;
    run.status = 'pending';
    run.waitingWindow = { until: w.nextStart, since: run.waitingWindow ? run.waitingWindow.since : Date.now() };
    run.updatedAt = Date.now();
    if (first) {
      this._wal({ kind: 'window_wait', runId: run.id, until: w.nextStart });
      this._notify(run, 'info', 'Graph run en attente de sa fenetre ' + run.schedule.start + '-' + run.schedule.end
        + ', reprise le ' + new Date(w.nextStart).toLocaleString(), { reprise: new Date(w.nextStart).toISOString() }, ['graph-run', run.id, 'window-wait']);
    }
    const old = this.windowTimers.get(run.id);
    if (old) clearTimeout(old);
    // Re-check at least every 6 h (sleep, clock changes); waking early only re-parks.
    const delay = Math.max(1000, Math.min(w.nextStart - Date.now() + 1000, 6 * 3600000));
    const t = setTimeout(() => {
      this.windowTimers.delete(run.id);
      this._executeNextBatch(run.id).catch(err => this._failRun(run.id, err.message));
    }, delay);
    if (t.unref) t.unref();
    this.windowTimers.set(run.id, t);
  }

  _notify(run, level, message, extra = {}, fingerprint) {
    if (!run.notify || !sentry) return;
    sentry.event({ message, level, loop: 'graph-run', fingerprint,
      tags: { run: run.id, nom: String(run.name || '').slice(0, 120) }, extra }).catch(() => {});
  }

  _areDepsComplete(run, node) {
    const deps = node.dependsOn || [];
    for (const depId of deps) {
      const dep = run.nodes.find(n => n.id === depId);
      if (!dep) return false;
      if (!['completed', 'cancelled'].includes(dep.status)) return false;
    }
    return true;
  }

  _isSkipped(run, node) {
    const skipList = (run.state._skipNodes || []);
    return skipList.includes(node.id);
  }

  async _executeNode(run, node) {
    node.status = 'running';
    node.startedAt = Date.now();
    node.attempts += 1;
    this._wal({ kind: 'node_started', runId: run.id, nodeId: node.id, type: node.type });
    run.updatedAt = Date.now();

    try {
      let output;
      if (node.type === 'worker') {
        output = await this._runWorkerNode(run, node);
      } else if (node.type === 'approval') {
        output = await this._runApprovalNode(run, node);
      } else if (node.type === 'branch') {
        output = await this._runBranchNode(run, node);
      } else {
        throw new Error(`Unknown node type: ${node.type}`);
      }
      node.output = output;
      node.status = 'completed';
      node.endedAt = Date.now();
      // Merge node output into state under state.results[nodeId]
      if (output !== undefined) {
        run.state = deepMerge(run.state, { results: { [node.id]: output } });
      }
      this._wal({ kind: 'node_completed', runId: run.id, nodeId: node.id });
    } catch (err) {
      if (err && err.windowStop) {
        // Stopped at the window's hardEnd: not a failure. Back to pending; it
        // starts again from the beginning in the next window.
        node.status = 'pending'; node.error = null; node.startedAt = null;
        node.windowStops = (node.windowStops || 0) + 1; node.lastWindowStopAt = Date.now();
        this._wal({ kind: 'node_window_stopped', runId: run.id, nodeId: node.id, stops: node.windowStops });
        this._notify(run, 'warning', 'Etape ' + node.id + ' arretee en fin de fenetre (' + run.schedule.hardEnd + '), reprise a la prochaine fenetre',
          { noeud: node.id, arrets: node.windowStops }, ['graph-run', run.id, node.id, 'window-stop']);
        return;
      }
      node.error = err.message;
      node.status = 'failed';
      node.endedAt = Date.now();
      this._wal({ kind: 'node_failed', runId: run.id, nodeId: node.id, error: err.message });
      this._notify(run, 'error', 'Etape ' + node.id + ' en echec : ' + String(err.message).slice(0, 300),
        { noeud: node.id }, ['graph-run', run.id, node.id, 'failed']);
    }
  }

  async _runWorkerNode(run, node) {
    // Try declared cli/model first; on a retry-worthy failure, ask the router
    // for a different CLI and try again. Up to 3 attempts.
    const triedClis = [];
    let lastError = null;
    const maxAttempts = node.noFallback ? 1 : 3;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      let cli = node.cli;
      let model = node.model;
      if (!cli || (attempt > 0 && !node.noFallback)) {
        const rec = await this._routerRecommend({ intent: node.intent || 'deep-code', excludeClis: triedClis });
        if (rec && rec.cli) { cli = rec.cli; model = rec.model; }
        else if (!cli) throw new Error(`router returned no cli; last error: ${lastError}`);
      }
      if (!cli) cli = 'claude';
      if (triedClis.includes(cli)) break;
      triedClis.push(cli);

      const prompt = renderTemplate(node.prompt || '', { state: run.state });
      const body = { cli, model, prompt, cwd: node.cwd, from: `graph-run:${run.id}`,
        effort: node.effort, autoPermit: !!node.autoPermit,
        // Optional per-node time limit (ms). Without it a cloud worker is cut
        // at the task store default (15 min), too short for long steps.
        ...(Number(node.timeoutMs) > 0 ? { workerTimeoutMs: Number(node.timeoutMs) } : {}) };
      // Adopt a task that already ran for this node (retryNode with taskId):
      // its finished work is collected instead of being paid for again.
      const adopted = attempt === 0 && node.adoptTaskId ? node.adoptTaskId : null;
      if (adopted) delete node.adoptTaskId;
      const spawnRes = adopted ? { id: adopted }
        : await apiRequest(this.apiHost, this.apiPort, 'POST', '/api/orchestrator/spawn', body).catch(e => ({ __error: e }));
      if (spawnRes && spawnRes.__error) {
        lastError = `spawn ${cli} failed: ${spawnRes.__error.message || spawnRes.__error}`;
        if (!this._shouldRetryOnAnotherModel(lastError)) throw new Error(lastError);
        continue;
      }
      if (!spawnRes || !spawnRes.id) {
        throw new Error(`spawn ${cli} refused: ${JSON.stringify(spawnRes)}`);
      }
      const taskId = spawnRes.id;
      node.taskId = taskId; // kept so a failed node can adopt its task later
      this._persist(run);
      let taskFailed = false;
      let netErrors = 0;
      while (true) {
        await sleep(1500);
        if (['paused', 'cancelled'].includes(run.status)) throw new Error('run paused/cancelled');
        if (run.schedule && (node.windowStops || 0) < 2 && !this.windowStateFn(run.schedule).inHard) {
          await apiRequest(this.apiHost, this.apiPort, 'POST', '/api/orchestrator/cancel', { taskId }).catch(() => {});
          throw Object.assign(new Error('stopped at the work window hard end ' + run.schedule.hardEnd), { windowStop: true });
        }
        let task;
        try {
          task = await apiRequest(this.apiHost, this.apiPort, 'GET', `/api/orchestrator/task?id=${taskId}`);
          netErrors = 0;
        } catch (e) {
          // A dropped local connection is not a worker failure: poll again
          // (about one minute of consecutive errors before giving up).
          if (isTransientNetError(e) && ++netErrors <= 40) continue;
          throw e;
        }
        if (!task) { lastError = `task ${taskId} disappeared on ${cli}`; taskFailed = true; break; }
        if (task.state === 'completed') return { taskId, cli, model, result: task.result, attempts: attempt + 1, triedClis };
        if (['failed', 'cancelled', 'timeout'].includes(task.state)) {
          const detail = (task.error || task.result || '').toString().replace(/\s+/g, ' ').slice(0, 600);
          lastError = `worker ${task.state} on ${cli}: ${detail}`;
          taskFailed = true;
          break;
        }
      }
      if (!taskFailed) break;
      if (!this._shouldRetryOnAnotherModel(lastError)) throw new Error(lastError);
      // loop; router will pick a different cli
    }
    throw new Error(lastError || 'worker exhausted retries');
  }

  _shouldRetryOnAnotherModel(errMsg) {
    if (!errMsg) return false;
    const s = String(errMsg).toLowerCase();
    return [
      'token limit', 'token quota', 'rate limit', 'rate-limit', '429',
      'quota exceeded', 'usage limit', 'reached your', 'context length', 'max tokens',
      'circuit breaker', 'insufficient_quota', 'overloaded', 'server is busy',
      'authentication', 'unauthorized', 'invalid api key', 'auth error',
    ].some(k => s.includes(k));
  }

  async _routerRecommend({ intent, excludeClis = [] }) {
    try {
      const rec = await apiRequest(this.apiHost, this.apiPort, 'POST', '/api/models/recommend', { intent });
      if (rec && rec.cli && !excludeClis.includes(rec.cli)) return rec;
      const cat = await apiRequest(this.apiHost, this.apiPort, 'GET', '/api/models/catalog');
      if (cat && cat.catalog) {
        for (const [cli, def] of Object.entries(cat.catalog)) {
          if (excludeClis.includes(cli)) continue;
          for (const meta of Object.values(def.models || {})) {
            if (meta.available) return { cli, model: meta.id, reasoning: 'fallback from catalog' };
          }
        }
      }
    } catch (_) {}
    return null;
  }

  async _runApprovalNode(run, node) {
    node.status = 'awaiting_approval';
    run.status = 'awaiting_approval';
    this._persist(run);
    this._wal({ kind: 'approval_requested', runId: run.id, nodeId: node.id, title: node.title });
    const key = `${run.id}:${node.id}`;
    return new Promise((resolve, reject) => {
      this.approvalWaiters.set(key, (outcome) => {
        run.status = 'running';
        if (outcome.approved) resolve(outcome);
        else reject(new Error(`rejected: ${outcome.note || 'no reason given'}`));
      });
    });
  }

  async _runBranchNode(run, node) {
    const expr = node.expr || 'false';
    let result;
    try {
      result = !!evalSafe(expr, run.state);
    } catch (e) {
      throw new Error(`branch expression failed: ${e.message}`);
    }
    // thenNext + elseNext are node ids; the branch not taken gets skipped.
    // Only propagate the skip forward to descendants whose EVERY dependency
    // is already skipped — merge nodes with an alternate reachable parent
    // must still run.
    const skipTarget = result ? node.elseNext : node.thenNext;
    if (skipTarget) {
      const existing = Array.isArray(run.state._skipNodes) ? run.state._skipNodes : [];
      const toSkip = unreachableFrom(run.nodes, skipTarget, existing);
      run.state = deepMerge(run.state, { _skipNodes: toSkip });
    }
    return { taken: result ? 'then' : 'else' };
  }

  _failRun(id, message) {
    const run = this.runs.get(id);
    if (!run) return;
    run.status = 'failed';
    run.updatedAt = Date.now();
    run.error = message;
    this._wal({ kind: 'run_errored', runId: id, error: message });
    this._persist(run);
  }
}


module.exports = { GraphRunsEngine, STATES, deepMerge, renderTemplate };
