'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { STATE } = require('./state');
const { runQwenDocker, PROFILES } = require('./qwen-docker-adapter');
const { runQwenText } = require('./qwen-text-developer');
const { verifyReconstructedFixture, assessReconstructedFixture, QWEN_DEVELOPER_FIXTURE } = require('./qwen-supervision');
// Real projects stay locked: the restricted verifier interprets only a small
// pure JavaScript subset and proves nothing about a native module. This is
// deliberately not a user-configurable switch.
const INDEPENDENT_ASSERTIONS_VERIFIED = false;

// A fictional fixture: a temporary Git repository without any remote.
function assertFixtureRoot(root) {
  const tmp = fs.realpathSync(os.tmpdir());
  const real = fs.realpathSync(root);
  const rel = path.relative(tmp, real);
  if (!rel || rel === '..' || rel.startsWith('..' + path.sep) || path.isAbsolute(rel)) throw new Error('Qwen fixture must be a temporary repository');
  const git = (...args) => execFileSync('git', ['-C', real, ...args], { encoding: 'utf8', windowsHide: true, timeout: 10000 }).trim();
  if (path.resolve(git('rev-parse', '--show-toplevel')) !== path.resolve(real) || git('remote')) throw new Error('Qwen fixture must be a standalone repository without remotes');
  return real;
}

function runTask(orch, task, { prompt, cwd, files, editable, assertions, model, temperature }, verify) {
  const abort = new AbortController();
  task._abortController = abort;
  task.execution.cleanup = 'pending';
  task._timer = setTimeout(() => abort.abort(), task.timeout);
  orch._broadcastTaskUpdate(task);
  (async () => {
    let cleanupError = false;
    try {
      const profile = PROFILES[model || 'qwen3-4b-instruct-2507'];
      const result = profile.mode === 'text'
        ? await runQwenText({ root: cwd, files, editable, assertions, prompt, signal: abort.signal, model, profile, ...(temperature !== undefined ? { temperature } : {}) })
        : await runQwenDocker({ root: cwd, files, editable, assertions, prompt, signal: abort.signal, ...(model ? { model } : {}) });
      if (task.state !== STATE.RUNNING) return;
      task.result = result.diff;
      Object.assign(task.execution, { test: result.test, changedFiles: result.changes.map(c => c.path), agentDurationMs: result.agentDurationMs,
        baseCommit: result.baseCommit, tools: result.tools, agentUsage: result.agentUsage || null });
      const technical = await verify(result);
      if (abort.signal.aborted || task.state !== STATE.RUNNING) return;
      task.execution.independentAssertions = technical;
      if (technical.baseCommit !== result.baseCommit || technical.passed !== true || technical.executed !== technical.expected) {
        task.state = STATE.FAILED;
        task.error = 'Independent assertions did not pass: ' + (technical.errors || []).join(' | ').slice(0, 900);
      } else task.state = STATE.COMPLETED;
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
      orch._persistResult(task);
      orch._broadcastTaskUpdate(task);
    }
  })();
  return task;
}

function newTask(orch, { taskId, prompt, from, space, model = 'qwen3-4b-instruct-2507' }) {
  // Docker setup and teardown on top of the model's own wall-time limit.
  const timeout = (PROFILES[model].wallSeconds + (PROFILES[model].mode === 'text' ? 30 : 90)) * 1000;
  const task = orch._createTask({ id: taskId, type: 'local', cli: 'qwen3-4b-docker', model, prompt, from, space, timeout });
  task.state = STATE.RUNNING;
  task.startedAt = Date.now();
  task.execution = { locality: 'local', backend: PROFILES[model].mode === 'text' ? 'lmstudio-text-only' : 'docker-lmstudio', noAutomaticApply: true, noCloudFallback: true };
  return task;
}

module.exports = {
  spawnQwenDocker({ prompt, cwd, files, editable, assertions, from, taskId, space }) {
    if (this.getConfig()?.QwenDocker?.enabled !== true) throw new Error('Qwen3 Docker agent is disabled');
    if (!INDEPENDENT_ASSERTIONS_VERIFIED) throw new Error('Qwen3 Docker agent is blocked: independent assertion integrity is not verified');
    if (!cwd || !Array.isArray(files) || !Array.isArray(editable)) throw new Error('Explicit workspace and file selection are required');
    const task = newTask(this, { taskId, prompt, from, space });
    return runTask(this, task, { prompt, cwd, files, editable, assertions }, async (result) => {
      const technical = await verifyReconstructedFixture(cwd, files, editable, result.diff, assertions);
      return { ...technical, passed: technical.executed === technical.expected, errors: [] };
    });
  },
  // Fictional fixtures only: never reachable from a route or a configuration.
  // A failed assertion leaves the task FAILED with the diff and observations.
  spawnQwenFixture({ prompt, cwd, files, editable, assertions, from, taskId, space, model = 'qwen3-4b-instruct-2507', temperature }, capability) {
    if (capability !== QWEN_DEVELOPER_FIXTURE) throw new Error('Untrusted Qwen fixture request');
    if (!Object.hasOwn(PROFILES, model)) throw new Error('Unsupported Qwen developer model');
    if (!cwd || !Array.isArray(files) || !Array.isArray(editable)) throw new Error('Explicit workspace and file selection are required');
    const root = assertFixtureRoot(cwd);
    const task = newTask(this, { taskId, prompt, from, space, model });
    task.execution.scope = 'fictional-fixture';
    return runTask(this, task, { prompt, cwd: root, files, editable, assertions, model, temperature },
      (result) => assessReconstructedFixture(root, files, editable, result.diff, assertions));
  },
};
