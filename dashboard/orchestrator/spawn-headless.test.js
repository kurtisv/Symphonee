'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const spawnHeadless = require('./spawn-headless');
const taskStore = require('./task-store');
const { STATE } = require('./state');
const { HEADLESS_FLAGS, CLI_MODELS } = require('./cli-config');

function inst() {
  const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sym-spawn-'));
  fs.mkdirSync(path.join(workspaceDir, 'results'), { recursive: true });
  const o = Object.assign(
    {
      tasks: new Map(),
      heartbeats: new Map(),
      checkpoints: new Map(),
      termOutput: new Map(),
      terminals: new Map(),
      orchestrating: false,
      workspaceDir,
      _tasksFile: path.join(workspaceDir, 'tasks.json'),
      getConfig: () => ({}),
      broadcast: () => {},
      sendMessage: () => {},
      saveTaskToMind: null,
      circuitBreaker: { isAvailable: () => true, recordSuccess: () => {}, recordFailure: () => false },
    },
    taskStore,
    spawnHeadless
  );
  return o;
}

test('inject writes clean text to the target PTY and broadcasts', () => {
  const o = inst();
  let written = '';
  o.terminals.set('t1', { pty: { write: (s) => { written += s; } } });
  let event = null;
  o.broadcast = (m) => { event = m; };
  const r = o.inject('t1', 'hello\n', { autoSubmit: false });
  assert.equal(r.ok, true);
  assert.equal(written, 'hello', 'trailing newline stripped, no auto-submit');
  assert.equal(event.event, 'inject');
});

test('inject errors on a missing terminal', () => {
  const o = inst();
  const r = o.inject('nope', 'x');
  assert.equal(r.ok, false);
  assert.match(r.error, /not found/);
});

test('dispatch creates a RUNNING task and injects the wrapped prompt', () => {
  const o = inst();
  let injected = '';
  o.terminals.set('t1', { pty: { write: (s) => { injected += s; } } });
  const task = o.dispatch({ targetTermId: 't1', prompt: 'do the thing' });
  try {
    assert.equal(task.state, STATE.RUNNING);
    assert.match(injected, /ORCHESTRATOR TASK/);
    assert.match(injected, /do the thing/);
    assert.ok(task.resultFile, 'result file path set for the file-mailbox');
  } finally {
    if (task._pollInterval) clearInterval(task._pollInterval);
    if (task._timer) clearTimeout(task._timer);
  }
});

test('spawnHeadless rejects an unknown CLI', () => {
  const o = inst();
  assert.throws(() => o.spawnHeadless({ cli: 'bogus', prompt: 'x' }), /Unknown CLI/);
});

test('Antigravity uses agy -p prompt mode and no Gemini API key', () => {
  assert.equal(HEADLESS_FLAGS.antigravity.cmd, 'agy');
  assert.deepEqual(HEADLESS_FLAGS.antigravity.args, ['-p']);
  assert.equal(HEADLESS_FLAGS.antigravity.promptMode, 'flag');
  assert.equal(CLI_MODELS.antigravity.defaultModel, null);
  assert.equal(CLI_MODELS.antigravity.permissionFlag, '--dangerously-skip-permissions');
  assert.equal(CLI_MODELS.antigravity.modelFlag, '--model');
  assert.equal(CLI_MODELS.antigravity.effortFlag, '--effort');
  assert.doesNotMatch(JSON.stringify(CLI_MODELS.antigravity), /GEMINI_API_KEY/);
});

test('winQuoteArg keeps argv intact through cmd.exe (the worker system prompt used to be split into words)', () => {
  const { winQuoteArg } = spawnHeadless;
  assert.equal(winQuoteArg('-p'), '-p');
  assert.equal(winQuoteArg('Bash(git diff:*)'), '"Bash(git diff:*)"');
  assert.equal(winQuoteArg(''), '""');
  if (process.platform === 'win32') {
    const { spawnSync } = require('child_process');
    const script = path.join(os.tmpdir(), 'sym-argv-' + process.pid + '.js');
    fs.writeFileSync(script, 'console.log(JSON.stringify(process.argv.slice(2)))');
    const raw = ['--append-system-prompt', 'You are a worker agent. NEVER sleep.', 'x"y', 'C:\\my dir\\', 'Bash(git push:*)'];
    const r = spawnSync('node', ['"' + script + '"', ...raw.map(winQuoteArg)], { shell: true, encoding: 'utf8' });
    fs.rmSync(script, { force: true });
    assert.deepEqual(JSON.parse(r.stdout.trim()), raw);
  }
});

test('parseCliUsage reads coloured Codex totals and Claude JSON usage, and never invents one', () => {
  const { parseCliUsage } = spawnHeadless;
  assert.deepEqual(parseCliUsage('codex', '', '\x1b[2mtokens used\x1b[0m\n107 569\n').usage, { totalTokens: 107569, source: 'codex-stderr' });
  assert.equal(parseCliUsage('codex', 'no usage here', '').usage, undefined);
  const j = parseCliUsage('claude', JSON.stringify({ type: 'result', result: 'ok', is_error: false,
    usage: { input_tokens: 5, cache_creation_input_tokens: 10, cache_read_input_tokens: 100, output_tokens: 7 } }), '', { usageJson: true });
  assert.equal(j.result, 'ok');
  assert.deepEqual([j.usage.inputTokens, j.usage.outputTokens, j.usage.cacheReadTokens], [15, 7, 100]);
  assert.deepEqual(parseCliUsage('claude', 'plain text', '', { usageJson: true }), {});
});
