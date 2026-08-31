'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  JulesClient,
  parseGitHubRemote,
  formatJulesResult,
} = require('./jules-client');
const spawnJules = require('./spawn-jules');
const taskStore = require('./task-store');
const { STATE } = require('./state');
const { registerOrchestratorRoutes } = require('./routes');

// Helper to instantiate a test orchestrator
function createTestOrchestrator(customClient) {
  const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sym-jules-test-'));
  fs.mkdirSync(path.join(workspaceDir, 'results'), { recursive: true });

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
      getConfig: () => ({ OrchestrateCliList: ['claude', 'gemini', 'jules'] }),
      broadcast: () => {},
      sendMessage: () => {},
      saveTaskToMind: null,
      circuitBreaker: { isAvailable: () => true, recordSuccess: () => {}, recordFailure: () => false },
      getJulesClient: () => customClient,
    },
    taskStore,
    spawnJules
  );

  return orch;
}

// ── 1. Parsing Origin GitHub HTTPS ───────────────────────────────────────────
test('parseGitHubRemote correctly parses GitHub HTTPS formats', () => {
  const r1 = parseGitHubRemote('https://github.com/facebook/react.git');
  assert.deepEqual(r1, { owner: 'facebook', repo: 'react' });

  const r2 = parseGitHubRemote('https://github.com/google/jules');
  assert.deepEqual(r2, { owner: 'google', repo: 'jules' });

  const r3 = parseGitHubRemote('https://x-access-token:ghp_123456789@github.com/my-org/my-repo.git');
  assert.deepEqual(r3, { owner: 'my-org', repo: 'my-repo' });

  const r4 = parseGitHubRemote('http://github.com/test-owner/test-repo');
  assert.deepEqual(r4, { owner: 'test-owner', repo: 'test-repo' });

  assert.equal(parseGitHubRemote('https://gitlab.com/owner/repo.git'), null);
  assert.equal(parseGitHubRemote(''), null);
  assert.equal(parseGitHubRemote(null), null);
});

// ── 2. Parsing git@github.com (SSH) ──────────────────────────────────────────
test('parseGitHubRemote correctly parses git@github.com and SSH formats', () => {
  const r1 = parseGitHubRemote('git@github.com:vercel/next.js.git');
  assert.deepEqual(r1, { owner: 'vercel', repo: 'next.js' });

  const r2 = parseGitHubRemote('git@github.com:kurtisv/Symphonee');
  assert.deepEqual(r2, { owner: 'kurtisv', repo: 'Symphonee' });

  const r3 = parseGitHubRemote('ssh://git@github.com/octocat/Hello-World.git');
  assert.deepEqual(r3, { owner: 'octocat', repo: 'Hello-World' });

  const r4 = parseGitHubRemote('git://github.com/vuejs/core.git');
  assert.deepEqual(r4, { owner: 'vuejs', repo: 'core' });
});

// ── 3. Matching Source Jules ──────────────────────────────────────────────────
test('JulesClient.findSourceForRepository matches sources across multiple structure formats', async () => {
  const mockSources = [
    {
      name: 'sources/github-12345',
      displayName: 'acme/backend',
      githubRepo: { owner: 'acme', repo: 'backend' },
    },
    {
      name: 'sources/github-67890',
      displayName: 'my-org/web-app',
      githubRepo: 'my-org/web-app',
    },
    {
      name: 'sources/my-org/docs',
      displayName: 'my-org/docs',
    },
  ];

  const client = new JulesClient({
    apiKey: 'test-key',
    fetchFn: async (url) => {
      assert.match(url, /\/sources/);
      return {
        ok: true,
        status: 200,
        json: async () => ({ sources: mockSources }),
      };
    },
  });

  // Match by githubRepo object
  const s1 = await client.findSourceForRepository('ACME', 'BACKEND');
  assert.ok(s1);
  assert.equal(s1.name, 'sources/github-12345');

  // Match by githubRepo string
  const s2 = await client.findSourceForRepository('my-org', 'web-app');
  assert.ok(s2);
  assert.equal(s2.name, 'sources/github-67890');

  // Match by name / displayName
  const s3 = await client.findSourceForRepository('my-org', 'docs');
  assert.ok(s3);
  assert.equal(s3.name, 'sources/my-org/docs');

  // Not found
  const s4 = await client.findSourceForRepository('other', 'nonexistent');
  assert.equal(s4, null);
});

// ── 4. Session Creation Request Body & Headers ────────────────────────────────
test('JulesClient.createSession sends correct request body and authentication headers', async () => {
  let capturedUrl = '';
  let capturedOptions = {};

  const client = new JulesClient({
    apiKey: 'my-secret-key-123',
    fetchFn: async (url, opts) => {
      capturedUrl = url;
      capturedOptions = opts;
      return {
        ok: true,
        status: 200,
        json: async () => ({
          name: 'sessions/sess-999',
          id: 'sess-999',
          state: 'QUEUED',
        }),
      };
    },
  });

  const session = await client.createSession({
    prompt: 'Implement auth refresh token',
    source: 'sources/src-abc',
    startingBranch: 'develop',
    requirePlanApproval: false,
  });

  assert.equal(capturedUrl, 'https://jules.googleapis.com/v1alpha/sessions');
  assert.equal(capturedOptions.method, 'POST');
  assert.equal(capturedOptions.headers['x-goog-api-key'], 'my-secret-key-123');
  assert.equal(capturedOptions.headers['Content-Type'], 'application/json');

  const parsedBody = JSON.parse(capturedOptions.body);
  assert.deepEqual(parsedBody, {
    prompt: 'Implement auth refresh token',
    sourceContext: {
      source: 'sources/src-abc',
      githubRepoContext: {
        startingBranch: 'develop',
      },
    },
    requirePlanApproval: false,
  });

  assert.equal(parsedBody.sourceContext.source, 'sources/src-abc');
  assert.equal(parsedBody.sourceContext.githubRepoContext.startingBranch, 'develop');
  assert.equal(parsedBody.githubRepoContext, undefined);

  assert.equal(session.name, 'sessions/sess-999');
});

// ── 5. Polling QUEUED -> IN_PROGRESS -> COMPLETED ─────────────────────────────
test('JulesClient.waitForCompletion polls until COMPLETED and collects activities', async () => {
  let pollCount = 0;
  const client = new JulesClient({
    apiKey: 'test-key',
    fetchFn: async (url) => {
      if (url.includes('/activities')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            activities: [
              { id: 'act-1', type: 'PLAN', description: 'Generating plan' },
              { id: 'act-2', type: 'EXECUTE', description: 'Applying changes' },
            ],
          }),
        };
      }

      pollCount++;
      const state = pollCount === 1 ? 'QUEUED' : pollCount === 2 ? 'IN_PROGRESS' : 'COMPLETED';
      return {
        ok: true,
        status: 200,
        json: async () => ({
          name: 'sessions/sess-100',
          state,
          output: 'Task successfully solved.',
          changeSet: { gitPatch: '+ const x = 1;' },
        }),
      };
    },
  });

  const polledStates = [];
  const result = await client.waitForCompletion('sess-100', {
    pollIntervalMs: 10,
    onPoll: (s) => polledStates.push(s.state),
  });

  assert.equal(result.state, 'COMPLETED');
  assert.equal(result.session.output, 'Task successfully solved.');
  assert.equal(result.activities.length, 2);
  assert.deepEqual(polledStates, ['QUEUED', 'IN_PROGRESS', 'COMPLETED']);
});

// ── 6. FAILED State Handling ──────────────────────────────────────────────────
test('JulesClient.waitForCompletion resolves with FAILED when session fails', async () => {
  const client = new JulesClient({
    apiKey: 'test-key',
    fetchFn: async (url) => {
      if (url.includes('/activities')) {
        return { ok: true, status: 200, json: async () => ({ activities: [] }) };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({
          name: 'sessions/sess-failed',
          state: 'FAILED',
          error: { message: 'Syntax error in plan generation' },
        }),
      };
    },
  });

  const result = await client.waitForCompletion('sess-failed', { pollIntervalMs: 10 });
  assert.equal(result.state, 'FAILED');
  assert.equal(result.session.error.message, 'Syntax error in plan generation');
});

// ── 7. AWAITING_USER_FEEDBACK & AWAITING_PLAN_APPROVAL ────────────────────────
test('JulesClient.waitForCompletion returns immediately on AWAITING_USER_FEEDBACK', async () => {
  let polls = 0;
  const client = new JulesClient({
    apiKey: 'test-key',
    fetchFn: async (url) => {
      if (url.includes('/activities')) {
        return { ok: true, status: 200, json: async () => ({ activities: [] }) };
      }
      polls++;
      return {
        ok: true,
        status: 200,
        json: async () => ({
          name: 'sessions/sess-feedback',
          state: 'AWAITING_USER_FEEDBACK',
          title: 'Awaiting your review on file changes',
        }),
      };
    },
  });

  const result = await client.waitForCompletion('sess-feedback', { pollIntervalMs: 10 });
  assert.equal(result.state, 'AWAITING_USER_FEEDBACK');
  assert.equal(polls, 1, 'Must not poll in an infinite loop when feedback is requested');
});

// ── 8. Absence of JULES_API_KEY ───────────────────────────────────────────────
test('JulesClient and spawnJules fail clearly when JULES_API_KEY is missing', async () => {
  const savedKey = process.env.JULES_API_KEY;
  delete process.env.JULES_API_KEY;

  try {
    const client = new JulesClient({ apiKey: '' });
    await assert.rejects(
      async () => client.listSources(),
      /JULES_API_KEY environment variable is not set/
    );

    const orch = createTestOrchestrator(client);
    assert.throws(
      () => orch.spawnJules({ prompt: 'test' }),
      /JULES_API_KEY environment variable is not set/
    );
  } finally {
    if (savedKey) process.env.JULES_API_KEY = savedKey;
  }
});

// ── 9. Security: API key never appears in outputs, results, or logs ───────────
test('JULES_API_KEY is never leaked in error messages or task results', async () => {
  const secretKey = 'super-secret-jules-api-key-999888777';

  const client = new JulesClient({
    apiKey: secretKey,
    fetchFn: async () => {
      throw new Error(`Connection to server failed using key: ${secretKey}`);
    },
  });

  // Verify sanitized error message
  try {
    await client.listSources();
    assert.fail('Should have thrown');
  } catch (err) {
    assert.doesNotMatch(err.message, new RegExp(secretKey));
    assert.match(err.message, /\[REDACTED\]/);
  }

  // Verify Markdown result formatter does not include keys
  const formatted = formatJulesResult({
    session: { name: 'sessions/123', state: 'COMPLETED', output: 'Done' },
    activities: [{ type: 'INFO', description: 'Working' }],
    owner: 'owner',
    repo: 'repo',
    branch: 'main',
    julesUrl: 'https://jules.google.com/session/123',
  });

  assert.doesNotMatch(formatted, new RegExp(secretKey));
  assert.match(formatted, /Google Jules Session Result/);
  assert.match(formatted, /https:\/\/jules\.google\.com\/session\/123/);
});

// ── 10. Route Spawn with CLI Jules ────────────────────────────────────────────
test('POST /api/orchestrator/spawn routes cli: "jules" to Jules remote worker', async () => {
  const savedKey = process.env.JULES_API_KEY;
  process.env.JULES_API_KEY = 'mock-jules-api-key';

  try {
    const mockClient = new JulesClient({
      apiKey: 'mock-jules-api-key',
      fetchFn: async (url) => {
        if (url.includes('/sources')) {
          return { ok: true, status: 200, json: async () => ({ sources: [{ name: 'sources/src-1', displayName: 'owner/repo' }] }) };
        }
        if (url.includes('/sessions') && !url.includes('/activities')) {
          return { ok: true, status: 200, json: async () => ({ name: 'sessions/sess-abc', state: 'COMPLETED', output: 'All good' }) };
        }
        return { ok: true, status: 200, json: async () => ({ activities: [] }) };
      },
    });

    const orch = createTestOrchestrator(mockClient);

    const routes = {};
    const addRoute = (m, p, h) => { routes[`${m} ${p}`] = h; };
    registerOrchestratorRoutes(addRoute, (res, data, status) => {
      res.writeHead(status || 200);
      res.end(JSON.stringify(data));
    }, orch, {
      getConfig: () => ({ OrchestrateCliList: ['claude', 'gemini', 'jules'] }),
      broadcast: () => {},
      getUiContext: () => ({}),
    });

    const handler = routes['POST /api/orchestrator/spawn'];
    assert.ok(handler, 'POST /api/orchestrator/spawn handler must exist');

    let responseData = null;
    let statusCode = 200;
    const req = {
      on(ev, cb) {
        if (ev === 'data') cb(Buffer.from(JSON.stringify({ cli: 'jules', prompt: 'Refactor parser', autoPermit: true })));
        if (ev === 'end') cb();
        return req;
      },
    };
    const res = {
      writeHead(code) { statusCode = code; return this; },
      end(body) { if (body) responseData = JSON.parse(body); },
    };

    await handler(req, res);

    assert.equal(statusCode, 200);
    assert.ok(responseData);
    assert.equal(responseData.cli, 'jules');
    assert.equal(responseData.state, STATE.RUNNING);
    assert.equal(responseData.prompt, 'Refactor parser');

    // Allow background task async lifecycle to settle cleanly
    await new Promise((r) => setTimeout(r, 50));
  } finally {
    if (savedKey) process.env.JULES_API_KEY = savedKey;
    else delete process.env.JULES_API_KEY;
  }
});
