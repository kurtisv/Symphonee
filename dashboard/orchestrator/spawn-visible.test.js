'use strict';
const test = require('node:test');
const assert = require('node:assert');
const spawnVisible = require('./spawn-visible');
const taskStore = require('./task-store');

// spawnVisible drives a real PTY + interactive watcher, so unit coverage here is
// limited to its guard clauses; end-to-end behavior is covered by a live restart
// smoke (a real worker dispatch) per the refactor workflow.
function inst(extra = {}) {
  return Object.assign(
    {
      tasks: new Map(),
      terminals: new Map(),
      termOutput: new Map(),
      workspaceDir: require('os').tmpdir(),
      broadcast: () => {},
      getConfig: () => ({}),
    },
    taskStore,
    spawnVisible,
    extra
  );
}

test('spawnVisible rejects an unknown CLI', () => {
  const o = inst();
  assert.throws(() => o.spawnVisible({ cli: 'bogus', prompt: 'x' }), /Unknown CLI/);
});

test('spawnVisible requires createTerminal', () => {
  const o = inst(); // no createTerminal provided
  assert.throws(() => o.spawnVisible({ cli: 'claude', prompt: 'x' }), /createTerminal not available/);
});

// Watcher-level coverage with a fake PTY and mocked timers: the prompt must land
// in a task file, and the typed pointer line must only be submitted once echoed.
function fakePtyInst() {
  const fs = require('fs');
  const path = require('path');
  const writes = [];
  let onData = null;
  const o = inst({
    workspaceDir: fs.mkdtempSync(path.join(require('os').tmpdir(), 'spawn-visible-')),
    createTerminal(termId) {
      this.terminals.set(termId, {
        pty: {
          write: (s) => writes.push(s),
          onData: (cb) => { onData = cb; return { dispose() {} }; },
        },
      });
    },
  });
  return { o, writes, emit: (s) => onData(s) };
}

function withFakes(t) {
  t.mock.method(require('child_process'), 'execSync', () => '');
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] });
}

test('spawnVisible puts the full prompt in a task file and types a single-line pointer', (t) => {
  withFakes(t);
  const fs = require('fs');
  const { o, writes, emit } = fakePtyInst();
  const task = o.spawnVisible({ cli: 'claude', prompt: 'line one\nline two\r\nline three' });
  try {
    assert.ok(task.taskFile, 'task file path recorded on the task');
    const body = fs.readFileSync(task.taskFile, 'utf8');
    assert.match(body, /line one\nline two\r\nline three/);
    assert.match(body, /TASK_COMPLETE/);

    emit('PS C:\\work> ');                       // shell ready -> launches CLI
    assert.deepStrictEqual(writes, ['claude\r']);
    emit('Welcome to the assistant, loading...\r\n❯ ');
    t.mock.timers.tick(1000);                    // quiet window elapses -> inject
    const typed = writes[1];
    assert.ok(typed.includes(task.id));
    assert.ok(typed.includes(task.taskFile.replace(/\\/g, '/')));
    assert.ok(!/[\r\n]/.test(typed), 'typed line must not contain Enter');
  } finally { task.state = 'completed'; }
});

test('spawnVisible does not treat the shell prompt or a still-drawing CLI as ready', (t) => {
  withFakes(t);
  const { o, writes, emit } = fakePtyInst();
  const task = o.spawnVisible({ cli: 'claude', prompt: 'do the thing' });
  try {
    emit('PS C:\\work> ');
    emit('Windows PowerShell banner text\r\nPS C:\\work>');
    t.mock.timers.tick(1000);
    assert.strictEqual(writes.length, 1, 'PowerShell prompt is not a CLI ready prompt');

    emit('Starting assistant.............\r\n❯ ');
    t.mock.timers.tick(400);
    emit('...more startup output');                // output inside the quiet window
    t.mock.timers.tick(1000);
    assert.strictEqual(writes.length, 1, 'ready timer is cancelled by further output');
  } finally { task.state = 'completed'; }
});

test('spawnVisible presses Enter only after the task id echoes, and retypes if it never does', (t) => {
  withFakes(t);
  const { o, writes, emit } = fakePtyInst();
  const task = o.spawnVisible({ cli: 'claude', prompt: 'do the thing' });
  try {
    emit('PS C:\\work> ');
    emit('Welcome to the assistant, loading...\r\n❯ ');
    t.mock.timers.tick(1000);
    const line = writes[1];

    emit('some unrelated redraw output that is well over one hundred characters long ...........................');
    assert.ok(!writes.includes('\r'), 'no Enter without the task id echo');

    t.mock.timers.tick(6000);                    // health check: no echo -> retype
    assert.strictEqual(writes[2], '\x15', 'clears partial input before retyping');
    assert.strictEqual(writes[3], line);

    emit(`> ${line}`);
    assert.strictEqual(writes[writes.length - 1], '\r');
    assert.strictEqual(task.state, 'running');
  } finally { task.state = 'completed'; }
});
