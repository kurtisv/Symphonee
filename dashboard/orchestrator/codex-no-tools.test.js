'use strict';
// Tool-free Codex fixture reviewer: deterministic tests, no network, no real CLI.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const noTools = require('./codex-no-tools');

const tmp = (p = 'sym-cnt-') => fs.mkdtempSync(path.join(os.tmpdir(), p));
const promptInput = (tools) => JSON.stringify([
  { type: 'additional_tools', role: 'developer', tools: [{ type: 'namespace', name: 'functions', tools: tools.map(name => ({ type: 'function', name })) }] },
  { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'probe' }] }]);
const fakeRun = (tools, version = 'codex-cli 0.169.0') => (cmd, args, opts) => {
  assert.equal(opts.shell, false, 'never through a shell');
  if (args[0] === '--version') return version + '\n';
  assert.equal(args[0], 'debug'); return promptInput(tools);
};
function withCodexHome(t) {
  const home = tmp('sym-cnt-home-');
  fs.writeFileSync(path.join(home, 'models_cache.json'), JSON.stringify({ models: [{ slug: 'gpt-6.1-sol', tool_mode: 'code_mode_only', apply_patch_tool_type: 'freeform',
    multi_agent_version: 'v2', experimental_supported_tools: ['clock'], input_modalities: ['text', 'image'], web_search_tool_type: 'text_and_image', supports_search_tool: true }] }));
  const before = process.env.CODEX_HOME; process.env.CODEX_HOME = home;
  t.after(() => { if (before === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = before; fs.rmSync(home, { recursive: true, force: true }); });
  return home;
}

test('restricted catalog removes patch, image, search, sub-agent and code-mode tools', t => {
  withCodexHome(t); const dir = tmp(); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const entry = JSON.parse(fs.readFileSync(noTools.writeRestrictedCatalog(dir, 'gpt-6.1-sol'), 'utf8')).models[0];
  for (const k of ['apply_patch_tool_type', 'multi_agent_version', 'web_search_tool_type']) assert.equal(k in entry, false, k);
  assert.deepEqual([entry.tool_mode, entry.input_modalities, entry.experimental_supported_tools, entry.supports_search_tool], ['direct', ['text'], [], false]);
  assert.throws(() => noTools.writeRestrictedCatalog(dir, 'gpt-unknown'), /missing/);
  assert.throws(() => noTools.writeRestrictedCatalog(dir, '../x'), /Invalid/);
});

test('the declared tool set is checked before launch and fails closed', () => {
  const ok = noTools.verifyNoTools({ cwd: '.', catalogFile: 'c.json', model: 'm-1', run: fakeRun(['request_user_input']) });
  assert.deepEqual(ok.tools, ['functions.request_user_input']);
  assert.match(ok.promptInputHash, /^[a-f0-9]{64}$/);
  assert.throws(() => noTools.verifyNoTools({ cwd: '.', catalogFile: 'c.json', model: 'm-1', run: fakeRun(['request_user_input', 'exec']) }), /still declares tools/);
  assert.throws(() => noTools.verifyNoTools({ cwd: '.', catalogFile: 'c.json', model: 'm-1', run: fakeRun(['request_user_input'], 'codex-cli 0.170.0') }), /Unverified Codex version/);
  assert.throws(() => noTools.declaredTools([{ type: 'function_call' }]), /Unexpected Codex prompt item/);
  const args = noTools.reviewerArgs('C:\\a b\\c.json', 'm-1');
  for (const f of noTools.DISABLED_FEATURES) assert.ok(args.join(' ').includes('--disable ' + f), f);
  assert.ok(args.includes('--json') && args.includes('--ephemeral') && args.includes('read-only'));
  assert.ok(!args.some(a => /dangerously|--yolo|workspace-write/.test(a)));
});

test('event audit accepts only messages and reasoning, with measured usage', () => {
  const ok = noTools.auditEvents(['{"type":"thread.started","thread_id":"x"}', '{"type":"turn.started"}',
    '{"type":"item.completed","item":{"id":"1","type":"reasoning","text":"..."}}',
    '{"type":"item.completed","item":{"id":"2","type":"agent_message","text":"{\\"decision\\":\\"GO\\"}"}}',
    '{"type":"turn.completed","usage":{"input_tokens":5414,"cached_input_tokens":0,"output_tokens":22,"reasoning_output_tokens":15}}'].join('\n'));
  assert.equal(ok.text, '{"decision":"GO"}');
  assert.deepEqual(ok.usage, { inputTokens: 5414, cachedInputTokens: 0, outputTokens: 22, reasoningOutputTokens: 15, totalTokens: 5436, source: 'codex-json' });
  for (const bad of ['command_execution', 'file_change', 'mcp_tool_call', 'web_search', 'collab_tool_call', 'todo_list', 'error'])
    assert.throws(() => noTools.auditEvents(`{"type":"item.started","item":{"id":"1","type":"${bad}"}}`), /not allowed/, bad);
  assert.throws(() => noTools.auditEvents('{"type":"turn.completed","usage":{}}'), /no complete answer/);
  assert.throws(() => noTools.auditEvents('tokens used 12'), /Non-JSON/);
  assert.throws(() => noTools.auditEvents('{"type":"turn.failed","error":{}}'), /not allowed/);
});

test('surviving descendants are found through the whole tree', () => {
  if (process.platform !== 'win32') return;
  const table = [{ ProcessId: 10, ParentProcessId: 1, Name: 'codex.exe' }, { ProcessId: 11, ParentProcessId: 10, Name: 'node.exe' },
    { ProcessId: 12, ParentProcessId: 11, Name: 'x.exe' }, { ProcessId: 20, ParentProcessId: 2, Name: 'other.exe' }];
  assert.deepEqual(noTools.survivingDescendants(10, () => JSON.stringify(table)).map(p => p.pid).sort(), [11, 12]);
  assert.deepEqual(noTools.survivingDescendants(20, () => JSON.stringify(table)), []);
  assert.throws(() => noTools.survivingDescendants(0, () => '[]'), /Invalid/);
});

function makeOrch({ stdout, code = 0, survivors = [], verify } = {}) {
  const { Orchestrator } = require('../orchestrator');
  const orch = new Orchestrator({ terminals: new Map(), broadcast: () => {}, workspaceDir: tmp(), getConfig: () => ({ AiApiKeys: { OPENAI_API_KEY: 'sk-x' }, Permissions: { mode: 'bypass' } }) });
  orch.spawns = []; orch.pretrusted = 0;
  orch._pretrust = () => { orch.pretrusted++; };
  orch._verifyNoTools = verify || (() => ({ version: 'codex-cli 0.169.0', tools: ['functions.request_user_input'], promptInputHash: 'a'.repeat(64) }));
  orch._survivingDescendants = (pid) => { assert.equal(pid, 4242); return survivors; };
  orch._spawnImpl = (command, args, opts) => {
    orch.spawns.push({ command, args, opts });
    const proc = new EventEmitter(); proc.pid = 4242;
    proc.stdin = { write(p) { proc.prompt = p; }, end() {} }; proc.stdout = new EventEmitter(); proc.stderr = new EventEmitter(); proc.kill = () => {};
    setImmediate(() => { proc.stdout.emit('data', Buffer.from(stdout)); proc.emit('close', code); });
    return proc;
  };
  return orch;
}
const spawnOpts = (cwd) => ({ cli: 'codex', model: 'gpt-6.1-sol', prompt: 'review', cwd, readOnly: true, noRetry: true, noFallback: true, compactContext: true, cloudTimeoutMs: 5000, fixtureNoApiKeys: true, reviewerNoTools: true });
const done = (orch, id) => new Promise(r => { const i = setInterval(() => { const t = orch.getTask(id); if (t && !['running', 'pending'].includes(t.state)) { clearInterval(i); r(t); } }, 5); });
const GOOD = '{"type":"item.completed","item":{"id":"1","type":"agent_message","text":"answer"}}\n{"type":"turn.completed","usage":{"input_tokens":10,"output_tokens":2}}\n';

test('spawnHeadless launches the tool-free reviewer without shell, bypass, trust entry or API key', async t => {
  withCodexHome(t); const cwd = tmp(); const orch = makeOrch({ stdout: GOOD });
  const task = orch.spawnHeadless(spawnOpts(cwd));
  const s = orch.spawns[0];
  assert.equal(s.opts.shell, false);
  assert.equal(s.args[0], 'exec');
  assert.ok(!s.args.some(a => /dangerously|bypass/.test(a)), 'bypass mode is never inherited');
  assert.equal(s.opts.env.OPENAI_API_KEY, undefined);
  assert.equal(orch.pretrusted, 0, 'no trust entry written to the user configuration');
  const end = await done(orch, task.id);
  assert.equal(end.state, 'completed'); assert.equal(end.result, 'answer');
  assert.equal(end.execution.cleanup, 'verified-no-descendants');
  assert.deepEqual(end.execution.reviewerItems, ['agent_message']);
  assert.equal(end.usage.totalTokens, 12);
  assert.deepEqual(end.execution.reviewer.tools, ['functions.request_user_input']);
  const catalogDir = path.dirname(JSON.parse(s.args[s.args.indexOf('-c', s.args.findIndex(a => a.startsWith('model_catalog_json')) - 1) + 1].slice('model_catalog_json='.length)));
  assert.equal(fs.existsSync(catalogDir), false, 'temporary catalog removed');
});

test('a tool event, a surviving process or a refused tool proof voids the review', async t => {
  withCodexHome(t); const cwd = tmp();
  let orch = makeOrch({ stdout: '{"type":"item.started","item":{"id":"1","type":"command_execution","command":"type secret"}}\n' + GOOD });
  let end = await done(orch, orch.spawnHeadless(spawnOpts(cwd)).id);
  assert.equal(end.state, 'failed'); assert.match(end.error, /command_execution/); assert.equal(end.result, '');
  orch = makeOrch({ stdout: GOOD, survivors: [{ pid: 999999, name: 'codex.exe' }] });
  end = await done(orch, orch.spawnHeadless(spawnOpts(cwd)).id);
  assert.equal(end.state, 'failed'); assert.match(end.error, /left running processes/); assert.equal(end.execution.cleanup, 'unverified');
  orch = makeOrch({ stdout: GOOD, verify: () => { throw new Error('Codex still declares tools: functions.exec'); } });
  assert.throws(() => orch.spawnHeadless(spawnOpts(cwd)), /still declares tools/);
  assert.equal(orch.spawns.length, 0, 'nothing launched');
  assert.throws(() => orch.spawnHeadless({ ...spawnOpts(cwd), fixtureNoApiKeys: false }), /Invalid tool-free reviewer/);
  assert.throws(() => orch.spawnHeadless({ ...spawnOpts(cwd), cli: 'claude' }), /Invalid tool-free reviewer/);
});
