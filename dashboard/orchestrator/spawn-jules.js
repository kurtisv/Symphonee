'use strict';
// Google Jules remote worker for Symphonee Orchestrator.
// Interacts with Google Jules REST API in the cloud without spawning local processes.
// Mixed into Orchestrator.prototype (runs with the instance as `this`).

const path = require('path');
const { STATE } = require('./state');
const { JulesClient, resolveJulesSource, formatJulesResult } = require('./jules-client');

module.exports = {
  /**
   * Spawn a remote Google Jules task via REST API.
   *
   * @param {Object} opts
   * @param {string} [opts.cli='jules']
   * @param {string} opts.prompt
   * @param {string} [opts.cwd]
   * @param {number} [opts.timeout]
   * @param {string} [opts.from]
   * @param {string} [opts.taskId]
   * @param {string} [opts.space]
   * @returns {Task}
   */
  spawnJules({ cli = 'jules', prompt, cwd, timeout, from, taskId, space } = {}) {
    const apiKey = process.env.JULES_API_KEY;
    if (!apiKey) {
      throw new Error('JULES_API_KEY environment variable is not set. Jules remote worker requires a valid API key in process.env.JULES_API_KEY.');
    }

    // Circuit breaker: check if jules is available
    if (this.circuitBreaker && !this.circuitBreaker.isAvailable('jules')) {
      throw new Error('CLI/Worker "jules" circuit breaker is OPEN (too many recent failures). Try again later.');
    }

    const task = this._createTask({
      id: taskId,
      type: 'remote',
      cli: 'jules',
      model: 'default',
      prompt,
      from: from || null,
      space: space || null,
      timeout,
    });

    task.state = STATE.RUNNING;
    task.startedAt = Date.now();
    task._isRemote = true;

    const resultFile = path.join(this.workspaceDir, 'results', `${task.id}.md`);
    task.resultFile = resultFile;

    const abortController = new AbortController();
    task._abortController = abortController;

    this.heartbeats.set(task.id, Date.now());
    this._broadcastTaskUpdate(task);

    // Timeout guard (if timeout > 0)
    if (task.timeout > 0) {
      task._timer = setTimeout(() => {
        if (task.state === STATE.RUNNING) {
          task.state = STATE.TIMEOUT;
          task.error = `Jules task timed out after ${task.timeout}ms`;
          task.completedAt = Date.now();
          try { abortController.abort(); } catch (_) {}
          this.heartbeats.delete(task.id);
          this._persistResult(task);
          this._broadcastTaskUpdate(task);
        }
      }, task.timeout);
    }

    // Run remote lifecycle in background
    (async () => {
      const client = (this.getJulesClient && this.getJulesClient()) || new JulesClient({ apiKey });
      const workingDir = cwd || (this.getConfig && this.getConfig().activeRepoPath) || process.cwd();

      try {
        this.broadcast({
          type: 'orchestrator-event',
          event: 'task-output',
          taskId: task.id,
          chunk: `[Jules] Resolving GitHub repository for working directory: ${workingDir}...\n`,
          timestamp: Date.now(),
        });

        const { owner, repo, source, branch } = await resolveJulesSource({ cwd: workingDir, client });

        if (abortController.signal.aborted || task.state === STATE.CANCELLED || task.state === STATE.TIMEOUT) return;

        const sourceDisplayName = (typeof source === 'object' ? (source.displayName || source.name) : source) || `${owner}/${repo}`;
        this.broadcast({
          type: 'orchestrator-event',
          event: 'task-output',
          taskId: task.id,
          chunk: `[Jules] Connected to source: ${sourceDisplayName} (${owner}/${repo}, branch: ${branch})\n[Jules] Creating session...\n`,
          timestamp: Date.now(),
        });

        const session = await client.createSession({
          prompt,
          source: (typeof source === 'object' ? (source.name || source.id) : source),
          startingBranch: branch,
          requirePlanApproval: false,
        });

        if (abortController.signal.aborted || task.state === STATE.CANCELLED || task.state === STATE.TIMEOUT) return;

        task.julesSessionId = session.name || session.id;
        const rawId = String(task.julesSessionId || '').replace(/^sessions\//, '');
        task.julesUrl = `https://jules.google.com/session/${rawId}`;

        this.broadcast({
          type: 'orchestrator-event',
          event: 'task-output',
          taskId: task.id,
          chunk: `[Jules] Session created: ${task.julesSessionId}\n[Jules] Web URL: ${task.julesUrl}\n[Jules] Initial state: ${session.state || 'QUEUED'}\n`,
          timestamp: Date.now(),
        });

        const seenActivities = new Set();
        const pollResult = await client.waitForCompletion(task.julesSessionId, {
          pollIntervalMs: 3000,
          timeoutMs: task.timeout || 0,
          signal: abortController.signal,
          onPoll: (currentSession, activities) => {
            this.heartbeats.set(task.id, Date.now());
            if (Array.isArray(activities)) {
              for (const act of activities) {
                const actKey = act.name || act.id || `${act.createTime}-${act.description || act.summary || ''}`;
                if (!seenActivities.has(actKey)) {
                  seenActivities.add(actKey);
                  const desc = act.description || act.summary || act.type || 'Progress update';
                  this.broadcast({
                    type: 'orchestrator-event',
                    event: 'task-output',
                    taskId: task.id,
                    chunk: `[Jules Activity] ${desc}\n`,
                    timestamp: Date.now(),
                  });
                }
              }
            }
          },
        });

        if (abortController.signal.aborted || task.state === STATE.CANCELLED || task.state === STATE.TIMEOUT) return;

        const { session: finalSession, activities: finalActivities, state: finalState } = pollResult;
        task.completedAt = Date.now();
        if (task._timer) clearTimeout(task._timer);

        const formatted = formatJulesResult({
          session: finalSession,
          activities: finalActivities,
          owner,
          repo,
          branch,
          julesUrl: task.julesUrl,
        });

        if (finalState === 'COMPLETED' || finalState === 'AWAITING_USER_FEEDBACK' || finalState === 'AWAITING_PLAN_APPROVAL') {
          task.state = STATE.COMPLETED;
          task.result = formatted;
          if (this.circuitBreaker) this.circuitBreaker.recordSuccess('jules');
        } else if (finalState === 'FAILED') {
          task.state = STATE.FAILED;
          task.error = finalSession?.error?.message || finalSession?.failureReason || 'Jules session failed';
          task.result = formatted;
          if (this.circuitBreaker) this.circuitBreaker.recordFailure('jules', task.error);
        } else {
          task.state = STATE.COMPLETED;
          task.result = formatted;
        }
      } catch (err) {
        if (task.state === STATE.CANCELLED || task.state === STATE.TIMEOUT) return;
        task.completedAt = Date.now();
        if (task._timer) clearTimeout(task._timer);
        task.state = STATE.FAILED;
        task.error = err.message || 'Error executing Jules remote session';
        task.result = `# Jules Execution Failed\n\n${task.error}`;
        if (this.circuitBreaker) this.circuitBreaker.recordFailure('jules', task.error);
      } finally {
        this.heartbeats.delete(task.id);
        this._persistResult(task);
        this._broadcastTaskUpdate(task);
      }
    })();

    return task;
  },
};
