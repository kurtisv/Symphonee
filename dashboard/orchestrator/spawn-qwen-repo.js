'use strict';
// Qwen as a developer on a real repository: orchestrator side.
//
// It reuses the existing worktree isolation (one git worktree per task, never the real
// checkout) and runs the text-protocol worker of qwen-repo-worker.js against it. The task
// it returns looks like any other implementer task to the autopilot, which then applies
// its usual gates: main checkout untouched, protected paths, the repository's own checks,
// Codex review. The model has no shell and no direct file access; the host executes a
// short list of actions (see qwen-repo-worker.js).
//
// This path is separate from spawnQwenDocker, which stays locked: that worker is judged by
// the restricted fixture checker, which proves nothing for a real repository. Here the
// independent verification is the repository's own command list, run by the host, plus the
// autopilot's Codex review. Disabled unless the Symphonee config says QwenRepo.enabled.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { STATE } = require('./state');
const { PROFILES } = require('./qwen-docker-adapter');
const { runRepoWorker } = require('./qwen-repo-worker');

const DEFAULT_MODEL = 'qwen/qwen3.5-4b';
// Text-protocol profiles for the repository developer. The 9B (decision of 2026-11-22) uses the same
// text protocol and prompt size as the 4B; it is selected with config QwenRepo.model.
const REPO_PROFILES = Object.freeze({
  'qwen/qwen3.5-4b': PROFILES['qwen/qwen3.5-4b'],
  'qwen/qwen3.5-9b': Object.freeze({ mode: 'text', minContext: 8192, wallSeconds: 360, reasoningEffort: 'none', maxToolCalls: 0 }),
});

function addWorktree(repoPath, worktreePath, branch, startPoint) {
  if (startPoint && !/^[A-Za-z0-9][A-Za-z0-9._/^-]*$/.test(String(startPoint))) throw new Error('invalid startPoint');
  const r = spawnSync('git', ['worktree', 'add', worktreePath, '-b', branch, ...(startPoint ? [String(startPoint)] : [])], { cwd: repoPath, timeout: 20000, encoding: 'utf8', windowsHide: true, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
  if (r.error || r.status !== 0) throw new Error('Failed to create worktree: ' + (r.stderr || r.stdout || (r.error && r.error.message) || 'git worktree add failed').trim());
}

module.exports = {
  isQwenRepoEnabled() { return this.getConfig && this.getConfig()?.QwenRepo?.enabled === true; },

  // existingWorktree: continue in the worktree of an earlier Qwen stage (resume or repair).
  spawnQwenInWorktree({ repoPath, branch, startPoint, existingWorktree = null, task, verify, protectedPatterns, skipDirs, model = null, memoryText = '', sessionFile, deadlineAt, from, space, taskId, timeout, onEvent, onWorktree, dependencies }) { // `dependencies`: injection point for tests (fetch, freemem, sleep), never set by the autopilot
    if (!this.isQwenRepoEnabled()) throw new Error('Qwen repository developer is disabled (QwenRepo.enabled)');
    model = model || (this.getConfig && this.getConfig()?.QwenRepo?.model) || DEFAULT_MODEL;
    const profile = REPO_PROFILES[model];
    if (!profile || profile.mode !== 'text') throw new Error('Unsupported Qwen developer model: ' + model);
    if (!repoPath || !task || typeof task.title !== 'string' || typeof task.objective !== 'string') throw new Error('repoPath and a task are required');
    const id = taskId || this._id();
    let wt;
    if (existingWorktree) {
      if (!existingWorktree.path || !fs.existsSync(existingWorktree.path)) throw new Error('The worktree to continue in no longer exists');
      wt = { path: existingWorktree.path, branch: existingWorktree.branch, repoPath };
    } else {
      const branchName = branch || `orch/${id}`;
      const worktreePath = path.join(repoPath, '..', `.worktree-${id}`);
      addWorktree(repoPath, worktreePath, branchName, startPoint);
      wt = { path: worktreePath, branch: branchName, repoPath };
    }
    if (typeof onWorktree === 'function') onWorktree(wt); // e.g. link dependency folders before the first verification
    const base = startPoint || spawnSync('git', ['rev-parse', 'HEAD'], { cwd: wt.path, encoding: 'utf8', windowsHide: true }).stdout.trim();
    const t = this._createTask({ id, type: 'local', cli: 'qwen3-4b-local', model, prompt: task.title + '\n' + task.objective, from, space, timeout: timeout || 3600000 });
    t.state = STATE.RUNNING; t.startedAt = Date.now(); t.worktree = wt;
    t.execution = { locality: 'local', backend: 'lmstudio-text-repo-worker', noAutomaticApply: true, noCloudFallback: true, scope: 'real-repository' };
    const abort = new AbortController(); t._abortController = abort;
    this._broadcastTaskUpdate(t);
    (async () => {
      try {
        const out = await runRepoWorker({ worktree: wt.path, base, task, verify, protectedPatterns, skipDirs, model, profile, signal: abort.signal, deadlineAt, sessionFile, memoryText, onEvent, dependencies });
        if (t.state !== STATE.RUNNING) return;
        Object.assign(t.execution, { changedFiles: out.changed, turns: out.turns, switches: out.switches, agentUsage: { input_tokens: out.usage.input, output_tokens: out.usage.output, total_tokens: out.usage.input + out.usage.output, calls: out.usage.calls },
          notes: out.notes, plan: out.plan, strategies: out.strategies, events: out.events.slice(-20), log: out.log.slice(-40), verified: out.verified ? out.verified.results.map((r) => r.name) : null });
        if (out.state === 'completed') { t.state = STATE.COMPLETED; t.result = 'Qwen (local developer) finished after ' + out.turns + ' turn(s), ' + out.switches + ' strategy switch(es). ' + out.summary + ' Files: ' + out.changed.join(', '); }
        else { t.state = STATE.FAILED; t.error = (out.state === 'blocked' ? 'QWEN_BLOCKED: ' : 'QWEN_INTERRUPTED: ') + out.summary; t.execution.handoff = out.state === 'blocked'; t.execution.resumable = out.state === 'interrupted'; }
      } catch (e) {
        if (t.state !== STATE.RUNNING) return;
        t.state = STATE.FAILED; t.error = 'QWEN_INTERRUPTED: ' + String(e.message || e).slice(0, 400); t.execution.resumable = true;
      } finally {
        t._abortController = null; t.completedAt = Date.now(); this._persistResult(t); this._broadcastTaskUpdate(t);
      }
    })();
    return t;
  },
};
