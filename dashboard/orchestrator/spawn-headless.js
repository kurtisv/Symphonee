'use strict';
// Headless spawn (Tier 2) + PTY injection (Tier 1) + dispatch (Tier 1 + file mailbox).
// The core task-spawning surface. Mixed into Orchestrator.prototype.
// Extracted from orchestrator.js (behavior-preserving).

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { STATE } = require('./state');
const { HEADLESS_FLAGS, CLI_MODELS, CLI_CONFIG, ESCALATION_ORDER } = require('./cli-config');
const { classifyError, retryDelay, maxRetriesFor } = require('./reliability');
const { pretrustFolderForCli } = require('./pretrust');
const { MAX_HEADLESS_OUTPUT, RESULT_POLL_MS } = require('./constants');
const { resolveGeminiCommand, buildGeminiEnv, probeGeminiSync } = require('./gemini-runtime');
const { canonicalProviderId, isLocalProvider, isDirectLocal, getLocalProvider, localFirstConfig, stripCloudEnv, assertCodexOssArgs, prepareCodexOssHome, gitTreeFingerprint, isLoopbackUrl, prepareIsolatedHome, killProcessTree } = require('./local-providers');
module.exports = {
  // ── PTY Injection (Tier 1) ───────────────────────────────────────────────

  /**
   * Inject text directly into a terminal's stdin.
   * The target AI will process it as if the user typed it.
   *
   * @param {string} termId  — target terminal
   * @param {string} text    — text to inject (newline appended if missing)
   * @returns {{ ok: boolean, error?: string }}
   */
  inject(termId, text, opts) {
    opts = opts || {};
    const t = this.terminals.get(termId);
    if (!t) return { ok: false, error: `Terminal "${termId}" not found` };

    // Write the raw text without a trailing newline so interactive AI CLIs
    // (which treat the whole thing as a bracketed paste) land it in the
    // input buffer. Then send a SEPARATE carriage return after a short
    // delay so the CLI submits it as its own keystroke - a trailing \r
    // inside the same paste is treated as paste content, not submit.
    const clean = text.replace(/[\r\n]+$/, '');
    t.pty.write(clean);
    const submit = opts.autoSubmit !== false;
    if (submit) {
      setTimeout(function () { try { t.pty.write('\r'); } catch (_) {} }, 150);
    }

    this.broadcast({
      type: 'orchestrator-event',
      event: 'inject',
      termId,
      preview: text.substring(0, 200),
      timestamp: Date.now(),
    });

    return { ok: true };
  },

  // ── Headless Spawn (Tier 2) ──────────────────────────────────────────────

  /**
   * Spawn an AI CLI in headless/pipe mode for a one-shot task.
   * The prompt is sent via stdin and stdout is collected as the result.
   *
   * @param {Object} opts
   * @param {string} opts.cli       — 'claude' | 'gemini' | 'codex' | 'antigravity' | 'copilot' | 'grok' | 'qwen'
   * @param {string} opts.prompt    — the prompt to send
   * @param {string} [opts.cwd]     — working directory
   * @param {number} [opts.timeout] — ms before killing (default 5 min)
   * @param {string} [opts.from]    — termId of the requesting agent
   * @param {string} [opts.taskId]  — tie to existing task
   * @param {string} [opts.model]   — model override (e.g. 'opus', 'gpt-5.4', 'flash')
   * @param {string} [opts.effort]  — effort level (e.g. 'low', 'high', 'max')
   * @param {boolean} [opts.autoPermit] — auto-approve all permissions
   * @returns {Task}
   */
  spawnHeadless({ cli, prompt, cwd, timeout, from, taskId, model, effort, autoPermit, space, requiresRepoContent, expectsRepoChanges = false, _retryAttempt = 0 }) {
    cli = canonicalProviderId(cli);
    if (isDirectLocal(cli) && typeof this.spawnLmStudio === 'function') {
      return this.spawnLmStudio({ cli, prompt, cwd, timeout, from, taskId, space, requiresRepoContent });
    }
    const localSpec = getLocalProvider(cli);
    if (localSpec) {
      // Local agentic CLIs get a bounded run (no "run forever"): past it, the
      // task times out and fails over to cloud like any other local failure.
      const lf = localFirstConfig((this.getConfig && this.getConfig()) || {});
      timeout = Number(lf.timeouts[cli]) || Number(timeout) || localSpec.timeoutMs;
    }
    if (cli === 'gemini-api' && typeof this.spawnGeminiApi === 'function') {
      return this.spawnGeminiApi({ cli, prompt, cwd, timeout, from, taskId, model, space });
    }
    if (cli === 'jules' && typeof this.spawnJules === 'function') {
      return this.spawnJules({ cli, prompt, cwd, timeout, from, taskId, space });
    }
    if (CLI_CONFIG[cli] && CLI_CONFIG[cli].isRemote) {
      if (cli === 'gemini-api' && typeof this.spawnGeminiApi === 'function') {
        return this.spawnGeminiApi({ cli, prompt, cwd, timeout, from, taskId, model, space });
      }
      if (typeof this.spawnJules === 'function') {
        return this.spawnJules({ cli, prompt, cwd, timeout, from, taskId, space });
      }
    }
    const cfg = HEADLESS_FLAGS[cli];
    if (!cfg) throw new Error(`Unknown CLI: "${cli}". Use: ${Object.keys(HEADLESS_FLAGS).join(', ')}`);
    const originalPrompt = prompt;

    // Mind hint: prepend the metadata stamp + L0+L1 wake-up. Pass the
    // worker's own prompt to the hint so L1 becomes the BFS sub-graph
    // for THIS task instead of generic god-nodes. Skipped silently if
    // Mind is not available.
    if (typeof this.getMindHint === 'function' && _retryAttempt === 0) {
      try {
        // Pass the prompt as the question so L1 is task-aware. The hint
        // function accepts an opts object; legacy callers without args still work.
        const hint = (this.getMindHint.length >= 1)
          ? this.getMindHint({ question: typeof prompt === 'string' ? prompt : '' })
          : this.getMindHint();
        if (hint && typeof prompt === 'string' && !prompt.startsWith('[mind:')) {
          prompt = `${hint}\n\n${prompt}`;
        }
      } catch (_) {}
    }

    // Skills hint: prepend the procedural catalog so a dispatched worker follows
    // the same consistent procedures as every other CLI. Each skill's full body
    // is fetched on demand (GET /api/skills/item?id=<id>). Skipped if no skills.
    if (typeof this.getSkillsHint === 'function' && _retryAttempt === 0) {
      try {
        const sh = this.getSkillsHint();
        if (sh && typeof prompt === 'string' && !prompt.includes('[skills:')) {
          prompt = `${sh}\n\n${prompt}`;
        }
      } catch (_) {}
    }

    // Ledger hint: prepend a short "what just happened" digest from the action
    // ledger so the worker inherits the same recent-activity view the user has
    // (recent actions/changes + checkpoints it can revert to). Skipped if empty.
    if (typeof this.getLedgerHint === 'function' && _retryAttempt === 0) {
      try {
        const lh = this.getLedgerHint();
        if (lh && typeof prompt === 'string' && !prompt.includes('[recent activity:')) {
          prompt = `${lh}\n\n${prompt}`;
        }
      } catch (_) {}
    }

    // Circuit breaker: check if CLI is available
    if (!this.circuitBreaker.isAvailable(cli)) {
      throw new Error(`CLI "${cli}" circuit breaker is OPEN (too many recent failures). Try again later or use a different CLI.`);
    }

    let command = cfg.cmd;
    if (cli === 'gemini') {
      const detected = resolveGeminiCommand({ cwd: cwd || process.cwd(), env: process.env, detect: require('../lib/detect-cli').detectCli });
      if (!detected || !detected.path && detected.source !== 'path') {
        throw new Error('Gemini CLI is not installed (NOT_INSTALLED).');
      }
      command = detected.path || detected.command;
      const preflight = probeGeminiSync({ cwd: cwd || process.cwd(), env: process.env, command });
      if (preflight.state !== 'READY') {
        throw new Error(`Gemini CLI preflight failed (${preflight.reason}): ${String(preflight.details || '').substring(0, 300)}`);
      }
    } else if (!this._spawnImpl) { // test seam: an injected spawn skips the PATH probe
      try {
        const { execSync } = require('child_process');
        execSync(`where ${cfg.cmd} 2>nul || which ${cfg.cmd} 2>/dev/null`, { encoding: 'utf8', timeout: 3000 });
      } catch (_) {
        throw new Error(`CLI "${cli}" (${cfg.cmd}) is not installed. Install it first.`);
      }
    }

    const resolvedModel = model || (CLI_MODELS[cli] && CLI_MODELS[cli].defaultModel) || null;
    const task = this._createTask({
      id: taskId,
      type: 'headless',
      cli,
      model: resolvedModel,
      prompt,
      from: from || null,
      space: space || null,
      timeout: localSpec ? timeout : 0,  // Cloud: never timeout. Local: bounded (fails over).
    });
    task._originalPrompt = originalPrompt;
    task._firstStartedAt = task._firstStartedAt || Date.now();

    // Build final args based on how this CLI expects the prompt
    const finalArgs = [...cfg.args];

    // Inject model/effort/permission flags from CLI_MODELS intelligence
    const cliMeta = CLI_MODELS[cli];
    if (cliMeta) {
      // Guardrail: codex-oss is 1.5B-only on this machine (7B through Codex's own
      // system prompt measured unreliable -- 31.5 min timeout vs 1.5B's 6.5 min).
      // Reject a caller-supplied override outside cliMeta.models -- loud, not silent --
      // rather than let it override the baked-in -m default in HEADLESS_FLAGS.
      const modelOverrideAllowed = cli !== 'codex-oss-local' || !model || (cliMeta.models || []).includes(model);
      if (model && cliMeta.modelFlag && !modelOverrideAllowed) {
        const warning = `codex-oss is restricted to ${(cliMeta.models || []).join(', ')} on this machine ` +
          `(7B through Codex's own system prompt measured unreliable: 31.5 min timeout vs 1.5B's 6.5 min). ` +
          `Requested model "${model}" was ignored; falling back to ${cliMeta.defaultModel}. ` +
          `For 7B quality without Codex's overhead, use local-code (direct LM Studio) instead.`;
        console.warn(`[spawnHeadless] ${warning}`);
        this.broadcast({ type: 'orchestrator-event', event: 'model-override-rejected', cli, requestedModel: model, usedModel: cliMeta.defaultModel, reason: warning, timestamp: Date.now() });
      }
      if (model && cliMeta.modelFlag && modelOverrideAllowed) {
        finalArgs.unshift(cliMeta.modelFlag, model);
      }
      if (effort && cliMeta.effortFlag) {
        finalArgs.unshift(cliMeta.effortFlag, effort);
      }
      // Auto-permit resolves from two sources, in order:
      //   1. explicit autoPermit param on the spawn call
      //   2. the active permission mode (bypass always; trusted only in a worktree)
      // Folder-trust is handled separately by pretrustFolderForCli() below so
      // we don't have to enable full-yolo just to dodge the first-run trust
      // prompt.
      let modeYolo = false;
      try {
        // Read the active permission mode from the live config (getConfig is the
        // orchestrator's config accessor). Avoids a __dirname-relative config
        // path, which broke when this module moved into orchestrator/.
        const cfg = (this.getConfig && this.getConfig()) || {};
        const mode = (cfg.Permissions && cfg.Permissions.mode) || 'edit';
        const isWorktree = !!cwd && cwd.includes('worktree');
        if (mode === 'bypass') modeYolo = true;
        else if (mode === 'trusted' && isWorktree) modeYolo = true;
      } catch (_) {}
      const shouldYolo = autoPermit || modeYolo;
      if (shouldYolo && cliMeta.permissionFlag) {
        if (typeof cliMeta.autoPermission === 'boolean') {
          finalArgs.unshift(cliMeta.permissionFlag); // boolean flag like --yolo or Codex bypass
        } else {
          finalArgs.unshift(cliMeta.permissionFlag, cliMeta.autoPermission);
        }
      }
      // Inject behavioral guardrails for spawned Claude workers
      if (cliMeta.systemPromptFlag) {
        finalArgs.unshift(cliMeta.systemPromptFlag,
          'You are a worker agent. NEVER use sleep commands. NEVER poll with curl in a loop. ' +
          'Just do the task and output the result. Do not dispatch sub-tasks to other CLIs. ' +
          'Do not call orchestrator APIs. Focus only on the task in the prompt.');
      }
    }

    if (cfg.promptMode === 'flag') {
      // Prompt is the value of the last flag (e.g. gemini -p "prompt", copilot -p "prompt")
      finalArgs.push(prompt);
    } else if (cfg.promptMode === 'positional') {
      // Prompt is a trailing positional argument (e.g. grok --print "prompt")
      finalArgs.push(prompt);
    }
    // 'stdin' mode: prompt is written to proc.stdin below

    const useShell = cfg.shell !== undefined ? cfg.shell : true;
    // Inject API keys from config as environment variables (unlocks additional models)
    const spawnEnv = cli === 'gemini'
      ? { ...buildGeminiEnv(process.env), FORCE_COLOR: '0', NO_COLOR: '1' }
      : { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' };
    const aiKeys = this.getConfig().AiApiKeys || {};
    const CLI_ENV_KEYS = {
      claude:  ['ANTHROPIC_API_KEY'],
      gemini:  ['GEMINI_API_KEY'],
      codex:   ['OPENAI_API_KEY'],
      copilot: [],  // uses GitHub auth, not API keys
      antigravity: [], // uses local/cached Google authentication, not Gemini API keys
      grok:    ['XAI_API_KEY'],
      qwen:    ['DASHSCOPE_API_KEY', 'OPENAI_API_KEY'],
    };
    for (const envKey of (CLI_ENV_KEYS[cli] || [])) {
      if (aiKeys[envKey]) spawnEnv[envKey] = aiKeys[envKey];
    }
    // 'claude-local' points Claude Code at the local LM Studio server instead of the
    // cloud API. Fixed values (not user config) -- only set on the spawned child's env,
    // never on process.env itself, so Claude Cloud spawns are completely unaffected.
    // LOCAL guard: a local run must not be able to reach a cloud model. Strip
    // every cloud credential from the child env, pin the backend, and record
    // it on the task so "was this local?" is provable after the fact.
    if (localSpec) {
      try {
        const stripped = stripCloudEnv(spawnEnv);
        const lf = localFirstConfig((this.getConfig && this.getConfig()) || {});
        // Fail closed: a non-loopback "local" endpoint is not local.
        if (!isLoopbackUrl(lf.baseUrl)) throw new Error(`${cli} refused to start: LM Studio URL ${lf.baseUrl} is not loopback`);
        let codexHome = null;
        let claudeHome = null;
        if (cli === 'claude-local') {
          spawnEnv.ANTHROPIC_BASE_URL = lf.baseUrl;
          spawnEnv.ANTHROPIC_AUTH_TOKEN = 'lmstudio';
          spawnEnv.CLAUDE_CODE_ATTRIBUTION_HEADER = '0';
          // No telemetry / update / error-report traffic, and an isolated config
          // dir so the user's Claude OAuth login is not reachable from this run.
          spawnEnv.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = '1';
          spawnEnv.DISABLE_TELEMETRY = '1';
          spawnEnv.DISABLE_ERROR_REPORTING = '1';
          claudeHome = prepareIsolatedHome(this.workspaceDir, 'claude-local-home', ['.credentials.json', 'credentials.json']);
          spawnEnv.CLAUDE_CONFIG_DIR = claudeHome;
        }
        if (cli === 'codex-oss-local') {
          assertCodexOssArgs(finalArgs); // throws => fail closed
          // `--local-provider lmstudio` always talks to localhost:1234; a different
          // configured endpoint would make health checks and Codex disagree.
          if (new URL(lf.baseUrl).port !== '1234') throw new Error(`codex-oss-local refused to start: Codex's lmstudio provider only targets :1234, LocalFirst.baseUrl is ${lf.baseUrl}`);
          codexHome = prepareCodexOssHome(this.workspaceDir, cwd || process.cwd()); // throws if credentials found
          spawnEnv.CODEX_HOME = codexHome;
        }
        task.execution = { locality: 'local', backend: 'lmstudio', endpoint: lf.baseUrl, model: localSpec.model, provider: cli, cloudEnvStripped: stripped, cloudCredentialsPresent: false, codexHome, claudeHome, argv: finalArgs.filter(a => a !== prompt), attempts: 1 };
      } catch (err) {
        // Do not leave a PENDING orphan behind a refused local launch.
        this.tasks.delete(task.id);
        throw err;
      }
    } else {
      task.execution = { locality: 'cloud', provider: cli, model: resolvedModel };
    }

    // Pre-trust the working folder so first-time dispatches don't abort with
    // "this folder isn't trusted". This is independent of full bypass mode.
    try { (this._pretrust || pretrustFolderForCli)(cli, cwd || process.cwd()); } catch (_) {}

    // Local write task: remember the working tree so a "success" that changed
    // nothing can be treated as unusable output (-> cloud) instead of counted as done.
    let treeBefore = null;
    if (localSpec && expectsRepoChanges) {
      try { treeBefore = (this._gitTreeFingerprint || gitTreeFingerprint)(cwd || process.cwd()); } catch (_) { treeBefore = null; }
      // Outside a git repo nothing can prove the write happened: fail closed.
      task.execution.changeCheck = treeBefore ? 'armed' : 'unverifiable-not-a-git-repo';
    }

    const proc = (this._spawnImpl || spawn)(command, finalArgs, {
      cwd: cwd || process.cwd(),
      stdio: ['pipe', 'pipe', 'pipe'],
      env: spawnEnv,
      shell: useShell,
    });

    task._proc = proc;
    task.state = STATE.RUNNING;
    task.startedAt = Date.now();

    let stdout = '';
    let stderr = '';

    if (cfg.promptMode === 'stdin') {
      proc.stdin.write(prompt);
      proc.stdin.end();
    } else {
      // Prompt was passed as an argument; close stdin so the process doesn't hang
      proc.stdin.end();
    }

    proc.stdout.on('data', (chunk) => {
      const text = chunk.toString();
      if (stdout.length < MAX_HEADLESS_OUTPUT) {
        stdout += text;
      }
      // Heartbeat: track last activity
      this.heartbeats.set(task.id, Date.now());
      // Stream live output to frontend
      this.broadcast({
        type: 'orchestrator-event',
        event: 'task-output',
        taskId: task.id,
        chunk: text.substring(0, 4096),
        timestamp: Date.now(),
      });
    });

    proc.stderr.on('data', (chunk) => {
      stderr += chunk.toString().substring(0, 8192);
    });

    proc.on('close', (code) => {
      task._proc = null;
      if (task.state === STATE.CANCELLED || task.state === STATE.TIMEOUT) return;
      // 'error' already settled this attempt (and possibly failed it over).
      if (task._settled) return;
      task._settled = true;

      // A local run that "succeeds" with no output is unusable: fail it so it
      // goes to cloud instead of returning an empty answer.
      if (code === 0 && localSpec && !stdout.trim()) { code = -1; stderr = stderr || 'unusable local output: empty result'; }
      if (code === 0 && treeBefore) {
        let treeAfter = null;
        try { treeAfter = (this._gitTreeFingerprint || gitTreeFingerprint)(cwd || process.cwd()); } catch (_) {}
        if (treeAfter === treeBefore) {
          code = -1;
          stderr = 'unusable local output: write task reported success but the repository is unchanged';
          task.execution.changeCheck = 'failed-no-changes';
        } else {
          task.execution.changeCheck = 'passed';
        }
      } else if (code === 0 && localSpec && expectsRepoChanges && !treeBefore) {
        code = -1;
        stderr = 'unusable local output: write task outside a git repository cannot be verified';
        task.execution.changeCheck = 'failed-unverifiable';
      }
      if (code === 0) {
        task.state = STATE.COMPLETED;
        task.result = stdout.trim();
        this.circuitBreaker.recordSuccess(cli);
        this.heartbeats.delete(task.id);
      } else {
        const errText = stderr.trim() || stdout.trim() || '';
        const classified = classifyError(errText || `Process exited with code ${code}`, cli);
        if (localSpec) {
          // One local attempt, then cloud: every local failure is failover-eligible.
          Object.assign(classified, { local: true, failover: true, recoverable: true, retryable: false, failoverReason: `local failure: ${(errText || 'exit ' + code).slice(0, 120)}` });
        }

        // Save checkpoint for crash recovery (partial results)
        if (stdout.trim()) {
          this.checkpoints.set(task.id, {
            partial: stdout.trim().substring(0, 4096),
            attempt: _retryAttempt,
            cli,
            prompt: task.prompt,
            timestamp: Date.now(),
          });
        }

        // Circuit breaker: record failure
        const circuitOpened = this.circuitBreaker.recordFailure(cli, errText);
        if (circuitOpened) {
          this.broadcast({ type: 'orchestrator-event', event: 'circuit-open', cli, timestamp: Date.now() });
        }

        // Retry with exponential backoff if error is retryable (per-provider cap --
        // codex-oss gets 0 retries; everyone else keeps the global MAX_RETRIES).
        if (classified.retryable && _retryAttempt < maxRetriesFor(cli)) {
          const delay = retryDelay(_retryAttempt);
          task.state = STATE.PENDING;
          task._retryAttempt = _retryAttempt + 1;
          this.broadcast({ type: 'orchestrator-event', event: 'task-retry', taskId: task.id, attempt: _retryAttempt + 1, delay, timestamp: Date.now() });
          setTimeout(() => {
            try {
              // Re-spawn with checkpoint context
              const checkpoint = this.checkpoints.get(task.id);
              const enhancedPrompt = checkpoint
                ? `[Previous attempt partial result for context]:\n${checkpoint.partial.substring(0, 1000)}\n\n[Retry the task]:\n${prompt}`
                : prompt;
              const retryTask = this.spawnHeadless({ cli, prompt: enhancedPrompt, cwd, timeout, from, taskId: task.id, space: task.space, _retryAttempt: _retryAttempt + 1 });
              // Merge retry into original task
              Object.assign(task, { state: retryTask.state, _proc: retryTask._proc, startedAt: retryTask.startedAt });
            } catch (e) {
              task.state = STATE.FAILED;
              task.error = `Retry failed: ${e.message}`;
              task.completedAt = Date.now();
              this._broadcastTaskUpdate(task);
            }
          }, delay);
          return; // don't complete the task yet
        }

        task.state = task._needsAttention ? STATE.NEEDS_ATTENTION : STATE.FAILED;
        task.error = classified.flagError
          ? `CLI "${cli}" rejected flags ${JSON.stringify(finalArgs)}: ${errText.substring(0, 300)}. ` +
            `Update HEADLESS_FLAGS in orchestrator.js to match the CLI's current interface.`
          : errText || `Process exited with code ${code}`;
        task.errorClassification = classified;
        task.result = stdout.trim();
        this.heartbeats.delete(task.id);

        // Auto-failover: if this is a credit / quota / auth / model failure,
        // attach a default escalation chain (cheapest -> most capable) on the
        // fly so the user does not have to opt in to spawnWithEscalation.
        // The actual failover event is broadcast by _tryEscalate after it
        // successfully spawns the next CLI. That keeps the UI from saying
        // "sent to Copilot" when Copilot is skipped and Gemini actually runs.
        if (classified.failover && task._autoRouting && task._automaticFallback !== false) {
          if ((!task._escalationChain || !task._escalationChain.length) && !task._chainRefilled) {
            // One refill only, cloud-only, enabled/healthy providers, capped by
            // MaxFallbackAttempts minus the providers already tried.
            const cfgNow = (this.getConfig && this.getConfig()) || {};
            const cap = Math.max(0, Math.min(3, Number(cfgNow.MaxFallbackAttempts === undefined ? 3 : cfgNow.MaxFallbackAttempts)));
            const tried = new Set([...(task._visitedProviders || []), cli]);
            task._escalationChain = ESCALATION_ORDER
              .filter(c => !tried.has(c) && !isLocalProvider(c) && this.circuitBreaker.isAvailable(c)
                && (!this.providerHealth || this.providerHealth.isAvailable(c)))
              .slice(0, Math.max(0, cap - (tried.size - 1)));
            task._chainRefilled = true;
          }
          task._escalationPrompt = task._escalationPrompt || originalPrompt;
          task._escalationCwd = task._escalationCwd || cwd;
        }

        // Try cross-model escalation before giving up (once per failed attempt:
        // _broadcastTaskUpdate must not escalate the same failure again).
        if (task._autoRouting && task._escalationChain && task._escalationChain.length && classified.recoverable && !task._failoverStarted) {
          task._failoverStarted = true;
          if (this._tryEscalate(task)) return; // escalated to next CLI
        }

        // All providers exhausted: notify the UI so it can toast the user.
        if (classified.failover) {
          this.broadcast({
            type: 'orchestrator-event',
            event: 'provider-exhausted',
            taskId: task.id,
            lastCli: cli,
            reason: classified.failoverReason || 'provider error',
            timestamp: Date.now(),
          });
        }

        // Auto-record failure in learnings
        if (this.getLearnings) {
          const lrn = this.getLearnings();
          if (lrn) lrn.recordFailure({ cli, args: finalArgs, error: task.error });
        }
      }
      task.completedAt = Date.now();
      this._persistResult(task);
      this._broadcastTaskUpdate(task);
    });

    proc.on('error', (err) => {
      if (task._settled) return;
      task._settled = true;
      task._proc = null;
      task.state = STATE.FAILED;
      task.error = err.message;
      task.completedAt = Date.now();
      this._broadcastTaskUpdate(task);
    });

    // Local agents run through a shell on Windows: killing the shell leaves
    // codex.exe running (and possibly still editing files while the cloud
    // fallback works on the same tree). Kill the whole process tree instead.
    if (localSpec) {
      task._kill = () => killProcessTree(proc, (this._killTreeImpl || null));
    }

    // Timeout guard (skip if timeout is 0 = unlimited)
    if (task.timeout) task._timer = setTimeout(() => {
      if (task.state === STATE.RUNNING) {
        task.state = STATE.TIMEOUT;
        task.error = `Timed out after ${task.timeout}ms`;
        task.completedAt = Date.now();
        try { if (task._kill) task._kill(); else proc.kill('SIGTERM'); } catch (_) {}
        this._broadcastTaskUpdate(task);
      }
    }, task.timeout);

    this._broadcastTaskUpdate(task);
    return task;
  },

  // ── Task Dispatch (Tier 1 + File Mailbox) ────────────────────────────────

  /**
   * Dispatch a task to a running AI terminal via PTY injection.
   * Wraps the prompt with instructions for the target AI to write results
   * to a known file path, then monitors for completion.
   *
   * @param {Object} opts
   * @param {string} opts.targetTermId — terminal to inject into
   * @param {string} opts.prompt       — the task prompt
   * @param {string} [opts.from]       — requesting terminal ID
   * @param {number} [opts.timeout]    — ms timeout
   * @returns {Task}
   */
  dispatch({ targetTermId, prompt, from, timeout }) {
    const t = this.terminals.get(targetTermId);
    if (!t) throw new Error(`Terminal "${targetTermId}" not found`);

    const task = this._createTask({
      type: 'dispatch',
      targetTermId,
      prompt,
      from: from || null,
      timeout: 0,  // Never timeout — AI runs as long as it needs
    });

    task.state = STATE.RUNNING;
    task.startedAt = Date.now();

    // Result file the target AI should write to
    const resultFile = path.join(this.workspaceDir, 'results', `${task.id}.md`);
    task.resultFile = resultFile;

    // Build the injection payload with clear instructions for the target AI
    const wrappedPrompt = [
      '',
      `[ORCHESTRATOR TASK ${task.id}]`,
      '',
      prompt,
      '',
      `IMPORTANT: When you are done, write your complete response/result to this file:`,
      `  ${resultFile.replace(/\\/g, '/')}`,
      '',
      `Write the file using whatever tool you have (Write tool, bash echo/cat, etc).`,
      `Start the file with "TASK_COMPLETE" on the first line so the orchestrator knows you are done.`,
      `Put your actual response/result on the lines after that.`,
      '',
    ].join('\n');

    // Inject into the target terminal
    this.inject(targetTermId, wrappedPrompt);

    // Poll for the result file
    task._pollInterval = setInterval(() => {
      if (task.state !== STATE.RUNNING) {
        clearInterval(task._pollInterval);
        return;
      }
      try {
        if (fs.existsSync(resultFile)) {
          const content = fs.readFileSync(resultFile, 'utf8');
          if (content.startsWith('TASK_COMPLETE')) {
            task.state = STATE.COMPLETED;
            task.result = content.replace(/^TASK_COMPLETE\r?\n?/, '').trim();
            task.completedAt = Date.now();
            clearInterval(task._pollInterval);
            clearTimeout(task._timer);
            this._broadcastTaskUpdate(task);
          }
        }
      } catch (_) {}
    }, RESULT_POLL_MS);

    // Timeout guard (skip if timeout is 0 = unlimited)
    if (task.timeout) task._timer = setTimeout(() => {
      if (task.state === STATE.RUNNING) {
        task.state = STATE.TIMEOUT;
        task.error = `Timed out after ${task.timeout}ms`;
        task.completedAt = Date.now();
        clearInterval(task._pollInterval);
        this._broadcastTaskUpdate(task);
      }
    }, task.timeout);

    this._broadcastTaskUpdate(task);
    return task;
  },
};
