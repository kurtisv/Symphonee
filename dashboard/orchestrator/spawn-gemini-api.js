'use strict';
// Google Gemini Developer API remote worker for Symphonee Orchestrator.
// Interacts with Google Gemini Developer Interactions API without spawning local processes.
// Mixed into Orchestrator.prototype (runs with the instance as `this`).

const path = require('path');
const { STATE } = require('./state');
const { GeminiApiClient } = require('./gemini-api-client');

module.exports = {
  /**
   * Spawn a remote Google Gemini Developer API task via REST API.
   *
   * @param {Object} opts
   * @param {string} [opts.cli='gemini-api']
   * @param {string} opts.prompt
   * @param {string} [opts.cwd]
   * @param {number} [opts.timeout]
   * @param {string} [opts.from]
   * @param {string} [opts.taskId]
   * @param {string} [opts.model]
   * @param {string|Object} [opts.systemInstruction]
   * @param {string|number} [opts.thinkingLevel]
   * @param {string} [opts.space]
   * @returns {Task}
   */
  spawnGeminiApi({
    cli = 'gemini-api',
    prompt,
    cwd,
    timeout,
    from,
    taskId,
    model,
    systemInstruction,
    thinkingLevel,
    space,
  } = {}) {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      throw new Error('GEMINI_API_KEY environment variable is not set. Gemini API remote worker requires a valid API key in process.env.GEMINI_API_KEY.');
    }

    // Circuit breaker: check if gemini-api is available
    if (this.circuitBreaker && !this.circuitBreaker.isAvailable('gemini-api')) {
      throw new Error('CLI/Worker "gemini-api" circuit breaker is OPEN (too many recent failures). Try again later.');
    }

    const selectedModel = model || 'gemini-3.5-flash-lite';

    const task = this._createTask({
      id: taskId,
      type: 'remote',
      cli: 'gemini-api',
      model: selectedModel,
      prompt,
      from: from || null,
      space: space || null,
      timeout,
    });
    task.state = STATE.RUNNING;
    task.startedAt = Date.now();
    task._isRemote = true;

    // Initialize required metadata containers
    task.geminiInteractionId = null;
    task.geminiModel = selectedModel;
    task.geminiUsage = {
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      cachedTokens: 0,
      thoughtTokens: 0,
    };

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
          task.error = `Gemini API task timed out after ${task.timeout}ms`;
          task.completedAt = Date.now();
          try { abortController.abort(); } catch (_) {}
          this.heartbeats.delete(task.id);
          this._persistResult(task);
          this._broadcastTaskUpdate(task);
        }
      }, task.timeout);
    }

    // Run remote API interaction asynchronously in background
    (async () => {
      const client = (this.getGeminiApiClient && this.getGeminiApiClient()) || new GeminiApiClient({ apiKey });

      try {
        this.broadcast({
          type: 'orchestrator-event',
          event: 'task-output',
          taskId: task.id,
          chunk: `[Gemini API] Dispatching interaction to model: ${selectedModel}...\n`,
          timestamp: Date.now(),
        });

        const response = await client.createInteraction({
          prompt,
          model: selectedModel,
          systemInstruction,
          thinkingLevel,
          signal: abortController.signal,
        });

        if (abortController.signal.aborted || task.state === STATE.CANCELLED || task.state === STATE.TIMEOUT) {
          return;
        }

        const text = client.extractText(response);
        const usage = client.extractUsage(response);

        task.completedAt = Date.now();
        if (task._timer) clearTimeout(task._timer);

        // Store exact required metadata
        task.geminiInteractionId = response.id || response.name || null;
        task.geminiModel = response.model || selectedModel;
        task.geminiUsage = usage;
        task.state = STATE.COMPLETED;
        task.result = text;

        if (this.circuitBreaker) this.circuitBreaker.recordSuccess('gemini-api');
      } catch (err) {
        if (task.state === STATE.CANCELLED || task.state === STATE.TIMEOUT) {
          return;
        }
        task.completedAt = Date.now();
        if (task._timer) clearTimeout(task._timer);

        task.state = STATE.FAILED;
        const sanitized = (err.message || 'Error executing Gemini API interaction')
          .split(apiKey).join('[REDACTED]');
        task.error = sanitized;
        task.result = `# Gemini API Execution Failed\n\n${sanitized}`;

        if (this.circuitBreaker) this.circuitBreaker.recordFailure('gemini-api', task.error);
      } finally {
        this.heartbeats.delete(task.id);
        this._persistResult(task);
        this._broadcastTaskUpdate(task);
      }
    })();

    return task;
  },
};
