'use strict';
// Text-only developer: fake LM Studio, real temporary Git fixture, no Docker.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { runQwenText, extractCode } = require('./qwen-text-developer');
const { PROFILES, runQwenDocker } = require('./qwen-docker-adapter');
const { reconstructProposal } = require('./qwen-git-snapshot');

const MODEL = 'qwen/qwen3.5-4b';
const NAME = 'average.js';
const CASES = [{ file: NAME, export: 'average', args: [[1, 2, 3]], expected: 2 }];

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sym-text-dev-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const git = (...a) => execFileSync('git', ['-C', root, ...a], { stdio: 'pipe', windowsHide: true });
  git('init', '-q'); git('config', 'user.email', 'f@example.invalid'); git('config', 'user.name', 'F');
  fs.writeFileSync(path.join(root, NAME), 'function average(v){return 0}\nmodule.exports={average};\n');
  fs.writeFileSync(path.join(root, 'test.js'), 'x\n');
  git('add', '.'); git('commit', '-qm', 'f');
  return root;
}
const lm = (answer, { loaded = true, context = 8192, calls = [] } = {}) => async (url, init) => {
  calls.push({ url, init });
  if (url.endsWith('/api/v0/models')) return { ok: true, json: async () => ({ data: [{ id: MODEL, state: loaded ? 'loaded' : 'not-loaded', loaded_context_length: context }] }) };
  return { ok: true, json: async () => ({ choices: [{ message: { content: answer } }], usage: { prompt_tokens: 300, completion_tokens: 40, total_tokens: 340 } }) };
};
const input = (root, extra = {}) => ({ root, files: [NAME, 'test.js'], editable: [NAME], assertions: CASES, prompt: 'Implement average.', model: MODEL, profile: PROFILES[MODEL], ...extra });
const deps = (fetch) => ({ fetch, freemem: () => 8e9 });

test('qwen3.5-4b is a text-only profile with reasoning off; the Docker agent refuses it', async t => {
  assert.deepEqual([PROFILES[MODEL].mode, PROFILES[MODEL].reasoningEffort, PROFILES[MODEL].maxToolCalls], ['text', 'none', 0]);
  assert.ok(Object.isFrozen(PROFILES[MODEL]));
  await assert.rejects(runQwenDocker({ root: fixture(t), files: [NAME, 'test.js'], editable: [NAME], assertions: CASES, prompt: 'x', model: MODEL }), /text-only mode/);
});

test('a text answer becomes the exact diff from the frozen snapshot, with measured usage', async t => {
  const root = fixture(t); const calls = [];
  const code = 'function average(v){if(v.length===0)return null;return v.reduce((a,b)=>a+b,0)/v.length}\nmodule.exports={average};';
  const r = await runQwenText(input(root), deps(lm('```javascript\n' + code + '\n```', { calls })));
  assert.deepEqual(r.tools, []); assert.equal(r.model, MODEL);
  assert.deepEqual(r.agentUsage, { input_tokens: 300, output_tokens: 40, total_tokens: 340 });
  assert.equal(r.changes.length, 1); assert.equal(r.changes[0].path, NAME);
  const rebuilt = reconstructProposal(root, [NAME, 'test.js'], r.diff, [NAME]);
  assert.equal(Buffer.from(rebuilt.files.find(f => f.path === NAME).content, 'base64').toString('utf8'), code + '\n', 'the diff rebuilds the exact model output');
  const body = JSON.parse(calls.find(c => c.url.endsWith('/v1/chat/completions')).init.body);
  assert.equal(body.reasoning_effort, 'none'); assert.equal(body.model, MODEL);
  assert.match(body.messages[0].content, /Current content of average\.js:\nfunction average\(v\)\{return 0\}/);
  assert.equal(fs.readFileSync(path.join(root, NAME), 'utf8'), 'function average(v){return 0}\nmodule.exports={average};\n', 'the working tree is never written');
});

test('guards: one editable file, loaded model with enough context, free RAM, real code, a real change', async t => {
  const root = fixture(t); const ok = lm('function average(v){return 1}\nmodule.exports={average};');
  await assert.rejects(runQwenText(input(root, { editable: [NAME, 'test.js'] }), deps(ok)), /exactly one/);
  await assert.rejects(runQwenText(input(root, { profile: { ...PROFILES[MODEL], mode: 'agent' } }), deps(ok)), /text-only developer profile/);
  await assert.rejects(runQwenText(input(root), deps(lm('x', { loaded: false }))), /is not loaded/);
  await assert.rejects(runQwenText(input(root), deps(lm('x', { context: 4096 }))), /is not loaded/);
  await assert.rejects(runQwenText(input(root), { fetch: ok, freemem: () => 1e8 }), /Insufficient free RAM/);
  await assert.rejects(runQwenText(input(root), deps(lm('   \n  '))), /no code/);
  await assert.rejects(runQwenText(input(root), deps(lm('function average(v){return 0}\nmodule.exports={average};\n'))), /No permitted changes/);
  const abort = new AbortController(); abort.abort();
  await assert.rejects(runQwenText(input(root, { signal: abort.signal }), deps(ok)), /Cancelled/);
});

test('code extraction takes a fence or the raw text and nothing else', () => {
  assert.equal(extractCode('```js\nA\n```'), 'A\n');
  assert.equal(extractCode('```\nA\n```\nsome explanation'), 'A\n');
  assert.equal(extractCode('  B  '), 'B\n');
  assert.equal(extractCode(''), '');
  assert.equal(extractCode(null), '');
});

test('temperature is bounded and reaches the model call', async t => {
  const root = fixture(t); const calls = [];
  const answer = 'function average(v){return 1}\nmodule.exports={average};';
  await runQwenText(input(root, { temperature: 0.7 }), deps(lm(answer, { calls })));
  assert.equal(JSON.parse(calls.find(c => c.url.endsWith('/v1/chat/completions')).init.body).temperature, 0.7);
  const defaults = []; await runQwenText(input(root), deps(lm(answer, { calls: defaults })));
  assert.equal(JSON.parse(defaults.find(c => c.url.endsWith('/v1/chat/completions')).init.body).temperature, 0.2);
  for (const bad of [0.1, 1.5, 'hot', NaN, null]) await assert.rejects(runQwenText(input(root, { temperature: bad }), deps(lm(answer))), /Invalid temperature/);
});
