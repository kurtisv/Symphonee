'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  GeminiApiClient,
  GEMINI_INTERACTIONS_URL,
} = require('./gemini-api-client');
const spawnGeminiApi = require('./spawn-gemini-api');
const spawnVisible = require('./spawn-visible');
const taskStore = require('./task-store');
const { STATE } = require('./state');
const { CLI_CONFIG, CLI_MODELS, HEADLESS_FLAGS } = require('./cli-config');
const { registerOrchestratorRoutes } = require('./routes');

// Helper to create an isolated Orchestrator instance for testing
function createTestOrchestrator(customClient) {
  const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sym-gemini-api-test-'));
  fs.mkdirSync(path.join(workspaceDir, 'results'), { recursive: true });
  fs.mkdirSync(path.join(workspaceDir, 'config'), { recursive: true });
  fs.writeFileSync(
    path.join(workspaceDir, 'config', 'config.json'),
    JSON.stringify({ Permissions: { mode: 'bypass', allow: [], ask: [], deny: [] } }),
    'utf8'
  );

  const orch = Object.assign(
    {
      tasks: new Map(),
      heartbeats: new Map(),
      checkpoints: new Map(),
      termOutput: new Map(),
      terminals: new Map(),
      orchestrating: false,
      workspaceDir,
      _tasksFile: path.join(workspaceDir, 'tasks.json'),
      getConfig: () => ({ OrchestrateCliList: ['claude', 'gemini', 'gemini-api'] }),
      broadcast: () => {},
      sendMessage: () => {},
      saveTaskToMind: null,
      circuitBreaker: {
        isAvailable: () => true,
        recordSuccess: () => {},
        recordFailure: () => false,
      },
      getGeminiApiClient: () => customClient,
    },
    taskStore,
    spawnGeminiApi,
    spawnVisible
  );

  return orch;
}

// ── 1. Absence of GEMINI_API_KEY ──────────────────────────────────────────────
test('GeminiApiClient and spawnGeminiApi fail clearly when GEMINI_API_KEY is missing', async () => {
  const savedKey = process.env.GEMINI_API_KEY;
  delete process.env.GEMINI_API_KEY;

  try {
    const client = new GeminiApiClient({ apiKey: '' });
    await assert.rejects(
      () => client.createInteraction({ prompt: 'test' }),
      /GEMINI_API_KEY environment variable is not set/
    );

    const orch = createTestOrchestrator();
    assert.throws(
      () => orch.spawnGeminiApi({ prompt: 'test' }),
      /GEMINI_API_KEY environment variable is not set/
    );
  } finally {
    if (savedKey !== undefined) process.env.GEMINI_API_KEY = savedKey;
  }
});

// ── 2. Endpoint, Header x-goog-api-key, and Body Minimal / Default Model ───────
test('GeminiApiClient uses correct /v1beta/interactions endpoint, x-goog-api-key header, and default model', async () => {
  let capturedUrl = '';
  let capturedOptions = {};

  const mockFetch = async (url, options) => {
    capturedUrl = url;
    capturedOptions = options;
    return {
      ok: true,
      status: 200,
      json: async () => ({
        id: 'interactions/int-12345',
        model: 'gemini-3.5-flash-lite',
        outputs: [{ text: 'Response from default model' }],
        total_input_tokens: 15,
        total_output_tokens: 25,
        total_tokens: 40,
        total_cached_tokens: 0,
        total_thought_tokens: 0,
      }),
    };
  };

  const client = new GeminiApiClient({
    apiKey: 'test-gemini-key-123',
    fetchFn: mockFetch,
  });

  const res = await client.createInteraction({ prompt: 'Hello Gemini' });

  assert.equal(capturedUrl, 'https://generativelanguage.googleapis.com/v1beta/interactions');
  assert.equal(capturedUrl, GEMINI_INTERACTIONS_URL);
  assert.equal(capturedOptions.method, 'POST');
  assert.equal(capturedOptions.headers['Content-Type'], 'application/json');
  assert.equal(capturedOptions.headers['x-goog-api-key'], 'test-gemini-key-123');

  const body = JSON.parse(capturedOptions.body);
  assert.equal(body.model, 'gemini-3.5-flash-lite');
  assert.equal(body.input, 'Hello Gemini');
  assert.equal(client.extractText(res), 'Response from default model');
});

// ── 3. Model Override and System Instruction / Thinking Level ─────────────────
test('GeminiApiClient supports model override, systemInstruction, and thinkingLevel', async () => {
  let capturedOptions = {};

  const mockFetch = async (url, options) => {
    capturedOptions = options;
    return {
      ok: true,
      status: 200,
      json: async () => ({
        id: 'interactions/int-custom',
        model: 'gemini-2.5-pro',
        outputs: [{ text: 'Custom model response' }],
      }),
    };
  };

  const client = new GeminiApiClient({
    apiKey: 'test-gemini-key',
    fetchFn: mockFetch,
  });

  const res = await client.createInteraction({
    prompt: 'Complex task',
    model: 'gemini-2.5-pro',
    systemInstruction: 'You are a code assistant.',
    thinkingLevel: 'low',
  });

  const body = JSON.parse(capturedOptions.body);
  assert.equal(body.model, 'gemini-2.5-pro');
  assert.equal(body.input, 'Complex task');
  assert.equal(body.system_instruction, 'You are a code assistant.');
  assert.equal(body.thinking_level, 'low');
  assert.equal(client.extractText(res), 'Custom model response');
});

// ── 4. Prompt Validation ──────────────────────────────────────────────────────
test('GeminiApiClient.createInteraction throws when prompt is missing', async () => {
  const client = new GeminiApiClient({ apiKey: 'test-key' });
  await assert.rejects(
    () => client.createInteraction({ prompt: '' }),
    /Prompt is required to create a Gemini interaction/
  );
  await assert.rejects(
    () => client.createInteraction({}),
    /Prompt is required to create a Gemini interaction/
  );
});

// ── 5. Security: Key is Never Exposed in Errors, Logs, Results ────────────────
test('GEMINI_API_KEY is never leaked in error messages or task results', async () => {
  const secretKey = 'super-secret-gemini-key-999888';

  // Network error test
  const networkClient = new GeminiApiClient({
    apiKey: secretKey,
    fetchFn: async () => {
      throw new Error(`Connection to server with key ${secretKey} failed!`);
    },
  });

  try {
    await networkClient.createInteraction({ prompt: 'test' });
    assert.fail('Should have thrown network error');
  } catch (err) {
    assert.ok(!err.message.includes(secretKey), 'API key must not be present in network error');
    assert.ok(err.message.includes('[REDACTED]'), 'API key must be redacted');
  }

  // HTTP error test (e.g. Google returns error payload referencing key or URL)
  const httpErrClient = new GeminiApiClient({
    apiKey: secretKey,
    fetchFn: async () => ({
      ok: false,
      status: 400,
      statusText: 'Bad Request',
      json: async () => ({
        error: { message: `Invalid request with key ${secretKey}` },
      }),
    }),
  });

  try {
    await httpErrClient.createInteraction({ prompt: 'test' });
    assert.fail('Should have thrown HTTP error');
  } catch (err) {
    assert.ok(!err.message.includes(secretKey), 'API key must not be present in HTTP error');
    assert.ok(err.message.includes('[REDACTED]'), 'API key must be redacted');
  }
});

// ── 6. Text Output Extraction ─────────────────────────────────────────────────
test('GeminiApiClient.extractText handles various API response formats', () => {
  const client = new GeminiApiClient({ apiKey: 'mock' });

  // 1. Array of outputs with text
  assert.equal(
    client.extractText({ outputs: [{ text: 'Line 1' }, { text: 'Line 2' }] }),
    'Line 1\nLine 2'
  );

  // 2. Array of outputs with strings
  assert.equal(
    client.extractText({ outputs: ['String 1', 'String 2'] }),
    'String 1\nString 2'
  );

  // 3. Array of outputs with nested parts
  assert.equal(
    client.extractText({ outputs: [{ parts: [{ text: 'Part A' }, 'Part B'] }] }),
    'Part A\nPart B'
  );

  // 4. Single output field (string or object)
  assert.equal(client.extractText({ output: 'Direct string' }), 'Direct string');
  assert.equal(client.extractText({ output: { text: 'Nested text' } }), 'Nested text');

  // 5. Candidates structure
  assert.equal(
    client.extractText({ candidates: [{ content: { parts: [{ text: 'Candidate text' }] } }] }),
    'Candidate text'
  );

  // 6. Direct root text properties
  assert.equal(client.extractText({ text: 'Root text' }), 'Root text');
  assert.equal(client.extractText({ content: 'Root content' }), 'Root content');

  // 7. Empty or invalid responses
  assert.equal(client.extractText(null), '');
  assert.equal(client.extractText({}), '');
});

// ── 7. Usage Metadata Extraction (Input/Output/Total/Cached/Thought Tokens) ────
test('GeminiApiClient.extractUsage extracts all token counters accurately', () => {
  const client = new GeminiApiClient({ apiKey: 'mock' });

  // Canonical Interactions API format
  const canonical = {
    total_input_tokens: 120,
    total_output_tokens: 85,
    total_tokens: 205,
    total_cached_tokens: 30,
    total_thought_tokens: 40,
  };

  const usage = client.extractUsage(canonical);
  assert.deepEqual(usage, {
    inputTokens: 120,
    outputTokens: 85,
    totalTokens: 205,
    cachedTokens: 30,
    thoughtTokens: 40,
  });

  // Nested usageMetadata format fallback
  const fallback = {
    usageMetadata: {
      promptTokenCount: 50,
      candidatesTokenCount: 25,
      totalTokenCount: 75,
      cachedContentTokenCount: 10,
      candidatesBillableReasoningTokenCount: 15,
    },
  };

  const usageFallback = client.extractUsage(fallback);
  assert.deepEqual(usageFallback, {
    inputTokens: 50,
    outputTokens: 25,
    totalTokens: 75,
    cachedTokens: 10,
    thoughtTokens: 15,
  });

  // Empty response defaults to 0s
  assert.deepEqual(client.extractUsage(null), {
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    cachedTokens: 0,
    thoughtTokens: 0,
  });
});

// ── 8. HTTP 401, 429, 5xx Error Handling ───────────────────────────────────────
test('GeminiApiClient handles HTTP 401, 429, and 5xx errors correctly', async () => {
  const testStatus = async (status, statusText, errMessage) => {
    const client = new GeminiApiClient({
      apiKey: 'test-key',
      fetchFn: async () => ({
        ok: false,
        status,
        statusText,
        json: async () => ({ error: { message: errMessage } }),
      }),
    });

    await assert.rejects(
      () => client.createInteraction({ prompt: 'test' }),
      new RegExp(`Google Gemini API error \\(${status}\\): ${errMessage}`)
    );
  };

  await testStatus(401, 'Unauthorized', 'API_KEY_INVALID');
  await testStatus(429, 'Too Many Requests', 'RESOURCE_EXHAUSTED');
  await testStatus(500, 'Internal Server Error', 'Internal error encountered');
  await testStatus(503, 'Service Unavailable', 'Backend temporarily unavailable');
});

// ── 9. Timeout & AbortSignal ──────────────────────────────────────────────────
test('spawnGeminiApi enforces timeout and triggers AbortSignal', async () => {
  const savedKey = process.env.GEMINI_API_KEY;
  process.env.GEMINI_API_KEY = 'mock-key';

  try {
    let abortReceived = false;

    const mockClient = new GeminiApiClient({
      apiKey: 'mock-key',
      fetchFn: async (url, { signal }) => {
        return new Promise((resolve, reject) => {
          const timer = setTimeout(() => {
            resolve({
              ok: true,
              json: async () => ({ outputs: [{ text: 'late' }] }),
            });
          }, 1000);

          if (signal) {
            signal.addEventListener('abort', () => {
              abortReceived = true;
              clearTimeout(timer);
              reject(new Error('Interaction aborted'));
            });
          }
        });
      },
    });

    const orch = createTestOrchestrator(mockClient);
    const task = orch.spawnGeminiApi({
      prompt: 'long running task',
      timeout: 50,
    });

    assert.equal(task.state, STATE.RUNNING);
    assert.equal(task.timeout, 50);

    // Wait for timeout to fire
    await new Promise((r) => setTimeout(r, 120));

    assert.equal(task.state, STATE.TIMEOUT);
    assert.ok(task.error.includes('timed out after 50ms'));
    assert.equal(abortReceived, true);
  } finally {
    if (savedKey !== undefined) process.env.GEMINI_API_KEY = savedKey;
  }
});

// ── 10. Successful Orchestrator Spawn with Task Metadata & Result ─────────────
test('orch.spawnGeminiApi executes successfully and stores result + usage metadata', async () => {
  const savedKey = process.env.GEMINI_API_KEY;
  process.env.GEMINI_API_KEY = 'mock-gemini-key';

  try {
    const mockClient = new GeminiApiClient({
      apiKey: 'mock-gemini-key',
      fetchFn: async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          id: 'interactions/gemini-task-abc',
          model: 'gemini-3.5-flash-lite',
          outputs: [{ text: 'The useful output produced by Gemini.' }],
          total_input_tokens: 100,
          total_output_tokens: 50,
          total_tokens: 150,
          total_cached_tokens: 10,
          total_thought_tokens: 20,
        }),
      }),
    });

    const orch = createTestOrchestrator(mockClient);
    const task = orch.spawnGeminiApi({
      prompt: 'Explain quantum computing simply',
      model: 'gemini-3.5-flash-lite',
    });

    assert.equal(task.cli, 'gemini-api');
    assert.equal(task._isRemote, true);
    assert.equal(task.type, 'remote');

    // Wait for async execution
    await new Promise((r) => setTimeout(r, 80));

    assert.equal(task.state, STATE.COMPLETED);
    assert.equal(task.result, 'The useful output produced by Gemini.');
    assert.equal(task.geminiInteractionId, 'interactions/gemini-task-abc');
    assert.equal(task.geminiModel, 'gemini-3.5-flash-lite');
    assert.deepEqual(task.geminiUsage, {
      inputTokens: 100,
      outputTokens: 50,
      totalTokens: 150,
      cachedTokens: 10,
      thoughtTokens: 20,
    });
  } finally {
    if (savedKey !== undefined) process.env.GEMINI_API_KEY = savedKey;
  }
});

// ── 11. Failed Orchestrator Spawn Execution ───────────────────────────────────
test('orch.spawnGeminiApi marks task FAILED on API error without leaking key', async () => {
  const savedKey = process.env.GEMINI_API_KEY;
  const secretKey = 'confidential-gemini-key-777';
  process.env.GEMINI_API_KEY = secretKey;

  try {
    const mockClient = new GeminiApiClient({
      apiKey: secretKey,
      fetchFn: async () => ({
        ok: false,
        status: 403,
        statusText: 'Forbidden',
        json: async () => ({
          error: { message: `Quota exceeded for key ${secretKey}` },
        }),
      }),
    });

    const orch = createTestOrchestrator(mockClient);
    const task = orch.spawnGeminiApi({ prompt: 'trigger error' });

    await new Promise((r) => setTimeout(r, 80));

    assert.equal(task.state, STATE.FAILED);
    assert.ok(!task.error.includes(secretKey), 'Secret key must not appear in error');
    assert.ok(!task.result.includes(secretKey), 'Secret key must not appear in result');
    assert.ok(task.error.includes('[REDACTED]'));
    assert.ok(task.result.includes('# Gemini API Execution Failed'));
  } finally {
    if (savedKey !== undefined) process.env.GEMINI_API_KEY = savedKey;
  }
});

// ── 12. Route POST /api/orchestrator/spawn routes cli: "gemini-api" ───────────
test('POST /api/orchestrator/spawn routes cli: "gemini-api" to spawnGeminiApi', async () => {
  const savedKey = process.env.GEMINI_API_KEY;
  process.env.GEMINI_API_KEY = 'mock-api-key';

  try {
    const mockClient = new GeminiApiClient({
      apiKey: 'mock-api-key',
      fetchFn: async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          id: 'interactions/route-test-1',
          model: 'gemini-3.5-flash-lite',
          outputs: [{ text: 'Routed successfully' }],
          total_input_tokens: 10,
          total_output_tokens: 10,
          total_tokens: 20,
          total_cached_tokens: 0,
          total_thought_tokens: 0,
        }),
      }),
    });

    const orch = createTestOrchestrator(mockClient);
    const routes = {};
    const addRoute = (method, p, handler) => {
      routes[`${method} ${p}`] = handler;
    };
    const json = (res, data, status) => {
      res.statusCode = status || 200;
      res.data = data;
    };

    registerOrchestratorRoutes(addRoute, json, orch, {
      getConfig: () => ({ OrchestrateCliList: ['claude', 'gemini', 'gemini-api'] }),
      broadcast: () => {},
      getUiContext: () => ({ activeSpace: null }),
      repoRoot: orch.workspaceDir,
    });

    const req = {
      on: (event, cb) => {
        if (event === 'data') {
          cb(
            JSON.stringify({
              cli: 'gemini-api',
              prompt: 'Route test prompt',
              autoPermit: true,
            })
          );
        }
        if (event === 'end') cb();
      },
    };
    const res = {};

    await routes['POST /api/orchestrator/spawn'](req, res);

    assert.equal(res.statusCode, 200);
    assert.equal(res.data.cli, 'gemini-api');
    assert.equal(res.data.state, STATE.RUNNING);

    await new Promise((r) => setTimeout(r, 80));

    const updatedTask = orch.getTask(res.data.id);
    assert.equal(updatedTask.state, STATE.COMPLETED);
    assert.equal(updatedTask.result, 'Routed successfully');
  } finally {
    if (savedKey !== undefined) process.env.GEMINI_API_KEY = savedKey;
  }
});

// ── 13. Gemini CLI Unchanged & Gemini API Never Spawns Local Process ─────────
test('Existing Gemini CLI is unchanged and gemini-api is never spawned as local process', () => {
  // 1. Gemini CLI checks
  assert.equal(CLI_CONFIG.gemini.cmd, 'gemini');
  assert.equal(CLI_CONFIG.gemini.label, 'Gemini CLI');
  assert.equal(CLI_CONFIG.gemini.isRemote, undefined);
  assert.equal(CLI_MODELS.gemini.defaultModel, 'flash');
  assert.equal(HEADLESS_FLAGS.gemini.cmd, 'gemini');

  // 2. Gemini API checks
  assert.equal(CLI_CONFIG['gemini-api'].cmd, null);
  assert.equal(CLI_CONFIG['gemini-api'].label, 'Gemini API');
  assert.equal(CLI_CONFIG['gemini-api'].isRemote, true);
  assert.equal(CLI_MODELS['gemini-api'].defaultModel, 'gemini-3.5-flash-lite');
  assert.equal(CLI_MODELS['gemini-api'].isRemote, true);
  assert.equal(HEADLESS_FLAGS['gemini-api'], undefined);

  // 3. spawnVisible refuses gemini-api
  const orch = createTestOrchestrator();
  orch.createTerminal = () => {};

  assert.throws(
    () => orch.spawnVisible({ cli: 'gemini-api', prompt: 'test' }),
    /Worker "gemini-api" is a remote API worker and cannot be spawned in a visible terminal/
  );
});
