'use strict';
const { STATE } = require('./state');
const { runQwenDocker } = require('./qwen-docker-adapter');

module.exports = {
  spawnQwenDocker({ prompt, cwd, files, editable, from, taskId, space }) {
    if (this.getConfig()?.QwenDocker?.enabled !== true) throw new Error('Qwen3 Docker agent is disabled');
    if (!cwd || !Array.isArray(files) || !Array.isArray(editable)) throw new Error('Explicit workspace and file selection are required');
    const task = this._createTask({ id: taskId, type: 'local', cli: 'qwen3-4b-docker', model: 'qwen3-4b-instruct-2507', prompt, from, space, timeout: 240000 });
    task.state = STATE.RUNNING;
    task.startedAt = Date.now();
    task.execution = { locality: 'local', backend: 'docker-lmstudio', noAutomaticApply: true, noCloudFallback: true };
    const abort = new AbortController();
    task._abortController = abort;
    task.execution.cleanup = 'pending';
    task._timer = setTimeout(() => abort.abort(), task.timeout);
    this._broadcastTaskUpdate(task);
    (async () => {
      let cleanupError = false;
      try {
        const result = await runQwenDocker({ root: cwd, files, editable, prompt, signal: abort.signal });
        if (task.state !== STATE.RUNNING) return;
        task.result = result.diff;
        task.execution.test = result.test;
        task.execution.changedFiles = result.changes.map(c => c.path);
        task.execution.agentDurationMs = result.agentDurationMs;
        task.execution.tools = result.tools;
        task.state = STATE.COMPLETED;
      } catch (error) {
        cleanupError = /Docker cleanup/i.test(String(error.message || error));
        if (task.state !== STATE.RUNNING) return;
        task.state = STATE.FAILED;
        task.error = String(error.message || error).slice(0, 1000);
      } finally {
        clearTimeout(task._timer);
        task._timer = null;
        task._abortController = null;
        task.execution.cleanup = cleanupError ? 'unverified' : 'verified-or-not-created';
        task.completedAt = Date.now();
        this._persistResult(task);
        this._broadcastTaskUpdate(task);
      }
    })();
    return task;
  },
};
