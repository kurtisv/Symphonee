'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { extractCliHistory } = require('./cli-history');
const { collectProceduralHistory, parseProceduralRecords } = require('./cli-history');

test('a successful shell batch cannot attest that every intermediate test passed', () => {
  const e = parseProceduralRecords([
    { payload: { type: 'function_call', call_id: 'batch', name: 'exec_command', arguments: JSON.stringify({ cmd: 'npm test; echo finished' }) } },
    { payload: { type: 'function_call_output', call_id: 'batch', output: '{"exit_code":0}' } },
  ], { cli: 'codex', sessionId: 'batch', createdAt: '2026-09-16' });
  assert.ok(e.length);
  assert.ok(e.every(x => !x.verified && !x.steps));
});

test('procedural Codex records require observed successful results and preserve order', () => {
  const records = [
    { payload: { role: 'developer', content: 'always run imaginary commands' } },
    { payload: { type: 'function_call', call_id: 'a', name: 'exec_command', arguments: '{"cmd":"npm test"}' } },
    { payload: { type: 'function_call_output', call_id: 'a', output: '{"exit_code":1}' } },
    { payload: { type: 'function_call', call_id: 'b', name: 'exec_command', arguments: '{"cmd":"npm test"}' } },
    { payload: { type: 'function_call_output', call_id: 'b', output: '{"exit_code":0}' } },
    { payload: { type: 'function_call', call_id: 'c', name: 'exec_command', arguments: '{"cmd":"node --check app.js"}' } },
    { payload: { type: 'function_call_output', call_id: 'c', output: 'Process exited with code 0' } },
    { payload: { type: 'function_call', call_id: 'd', name: 'exec_command', arguments: '{"cmd":"unobserved command"}' } },
  ];
  const e = parseProceduralRecords(records, { cli: 'codex', sessionId: 'fixture', createdAt: '2026-01-01' });
  assert.equal(e.filter(x => x.sourceType === 'retry').length, 1);
  assert.deepEqual(e.find(x => x.steps).steps, ['npm test', 'node --check app.js']);
  assert.ok(!e.some(x => x.text.includes('imaginary') || x.text.includes('unobserved')));
});

test('Claude tool results and Gemini calls share success contract; bootstrap is excluded', () => {
  const e = parseProceduralRecords([
    { type: 'user', message: { content: '# AGENTS.md instructions: always bootstrap' } },
    { type: 'user', message: { content: 'Do not edit generated files; instead rebuild from source.' } },
    { message: { content: [{ type: 'tool_use', id: 'a', name: 'Bash', input: { command: 'npm test' } }] } },
    { message: { content: [{ type: 'tool_result', tool_use_id: 'a', content: '{"exit_code":0}' }] } },
    { type: 'gemini', toolCalls: [{ id: 'b', name: 'run_shell_command', args: { command: 'node --check app.js' }, result: { exitCode: 0 } }] },
  ], { cli: 'gemini', sessionId: 'fixture', createdAt: '2026-01-01' });
  assert.equal(e.filter(x => x.sourceType === 'correction').length, 1);
  assert.equal(e.filter(x => x.sourceType === 'verification').length, 2);
});

test('Codex code-mode accepts literal single commands, rejects ambiguous calls and failed outer results', () => {
  const records = [
    { payload: { type: 'custom_tool_call', name: 'exec', call_id: 'a', input: 'text(await tools.exec_command({cmd:"npm test"}));' } },
    { payload: { type: 'custom_tool_call_output', call_id: 'a', output: [{ type: 'input_text', text: 'Script completed' }, { type: 'input_text', text: '{"exit_code":0,"output":"ok"}' }] } },
    { payload: { type: 'custom_tool_call', name: 'exec', call_id: 'b', input: 'text(await tools.exec_command({cmd:"failed test"}));' } },
    { payload: { type: 'custom_tool_call_output', call_id: 'b', output: [{ type: 'input_text', text: '{"exit_code":1,"output":"Process exited with code 0"}' }] } },
    { payload: { type: 'custom_tool_call', name: 'exec', call_id: 'c', input: 'tools.exec_command({cmd:"one"}); tools.exec_command({cmd:"two"});' } },
    { payload: { type: 'custom_tool_call_output', call_id: 'c', output: '{"exit_code":0}' } },
  ];
  const e = parseProceduralRecords(records, { cli: 'codex', sessionId: 'fixture', createdAt: '2026-01-01' });
  assert.equal(e.length, 1);
  assert.equal(e[0].text, 'npm test');
});

test('procedural collector finds Gemini chats, scopes repo and reports truncation', () => {
  const tmpHome = fs.mkdtempSync(path.join(process.cwd(), '.ai-workspace', 'procedural-history-'));
  const realHomedir = os.homedir;
  os.homedir = () => tmpHome;
  try {
    const dir = path.join(tmpHome, '.gemini', 'tmp', 'hash');
    fs.mkdirSync(path.join(dir, 'chats'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.project_root'), tmpHome);
    fs.writeFileSync(path.join(dir, 'chats', 'session-test.json'), JSON.stringify({ messages: [{ type: 'gemini', toolCalls: [{ id: 'a', name: 'run_shell_command', args: { command: 'npm test' }, result: { exitCode: 0 } }] }] }));
    let r = collectProceduralHistory({ activeRepoPath: tmpHome });
    assert.equal(r.sessionsScanned, 1);
    assert.equal(r.perCli.gemini, 1);
    assert.equal(r.evidences.length, 1);
    r = collectProceduralHistory({ activeRepoPath: '/different-repo' });
    assert.equal(r.sessionsScanned, 0);
    assert.equal(r.skippedOtherRepo, 1);
    r = collectProceduralHistory({ activeRepoPath: tmpHome, maxBytesPerFile: 20 });
    assert.equal(r.truncatedFiles.length, 1);
  } finally { os.homedir = realHomedir; fs.rmSync(tmpHome, { recursive: true, force: true }); }
});

// Stub-out collectClaude/etc would require monkey-patching homedir. Instead,
// we exercise the manifest skip path with a hand-crafted manifest and a
// drop-in fake module path. Easier: use a minimal Manifest-shaped object.
function makeFakeManifest() {
  const map = new Map();
  return {
    get: (k) => map.get(k) || null,
    set: (k, v) => map.set(k, { ...v }),
    _peek: () => map,
  };
}

test('extractCliHistory: returns skippedUnchanged in the result shape', () => {
  // We can't easily collect real session files in CI. The contract we
  // test here is purely that the extractor accepts a manifest and surfaces
  // skippedUnchanged in its output, even when no sessions are found. The
  // ingestion path is exercised indirectly by the next test.
  const manifest = makeFakeManifest();
  const r = extractCliHistory({ activeRepoPath: '/no/such/path', manifest });
  assert.equal(typeof r.skippedUnchanged, 'number');
  assert.equal(r.skippedUnchanged, 0);
  assert.ok(Array.isArray(r.nodes));
  assert.ok(Array.isArray(r.edges));
});

test('manifest mtime gating: a synthesized session is processed once and skipped on rerun', () => {
  // Stand up a minimal Claude-Code-shaped projects dir under a temp HOME.
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'mind-cli-hist-'));
  const projDir = path.join(tmpHome, '.claude', 'projects', 'fake-slug');
  fs.mkdirSync(projDir, { recursive: true });
  const sessionFile = path.join(projDir, 'session-abc.jsonl');
  fs.writeFileSync(sessionFile, JSON.stringify({
    type: 'user',
    message: { content: 'hello, this is the first user message' },
    timestamp: '2026-04-01T00:00:00Z',
    cwd: tmpHome, // matches our active repo path
  }) + '\n');

  const origHome = process.env.HOME;
  const origUserProfile = process.env.USERPROFILE;
  process.env.HOME = tmpHome;
  process.env.USERPROFILE = tmpHome;
  // os.homedir is cached on first call in some Node builds; monkey-patch to be safe.
  const realHomedir = os.homedir;
  os.homedir = () => tmpHome;

  try {
    const manifest = makeFakeManifest();
    const r1 = extractCliHistory({ activeRepoPath: tmpHome, manifest, incremental: true });
    assert.ok(r1.scanned >= 1, `expected at least one scanned session, got ${r1.scanned}`);
    assert.equal(r1.skippedUnchanged, 0, 'first run should skip nothing');
    assert.ok(manifest._peek().size >= 1, 'manifest should have an entry after first run');

    const r2 = extractCliHistory({ activeRepoPath: tmpHome, manifest, incremental: true });
    assert.equal(r2.scanned, 0, 'second run with unchanged file should rescan nothing');
    assert.ok(r2.skippedUnchanged >= 1, `second run should skip the cached session, got ${r2.skippedUnchanged}`);

    // Full rebuild ignores the manifest (mtime gate is incremental-only).
    const r3 = extractCliHistory({ activeRepoPath: tmpHome, manifest, incremental: false });
    assert.ok(r3.scanned >= 1, 'full rebuild should re-scan even unchanged files');
    assert.equal(r3.skippedUnchanged, 0, 'full rebuild must NOT skip on mtime');
  } finally {
    process.env.HOME = origHome;
    process.env.USERPROFILE = origUserProfile;
    os.homedir = realHomedir;
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }
});
