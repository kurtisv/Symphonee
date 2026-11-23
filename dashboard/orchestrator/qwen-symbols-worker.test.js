'use strict';
// 2026-11-23 replay of the Gas Saver task: the 9B invented setStoredQueue / e.id next to a real clearStoredQueue.
// The host must answer "what really exists" by itself, right after the EDIT and right after the failed RUN.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');
const { runRepoWorker } = require('./qwen-repo-worker');

const MODEL = 'qwen/qwen3.5-9b';
const PROFILE = { mode: 'text', minContext: 8192, wallSeconds: 30, reasoningEffort: 'none', maxToolCalls: 0 };

function repo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-symw-'));
  fs.mkdirSync(path.join(dir, 'src'));
  fs.writeFileSync(path.join(dir, 'src/storage.ts'), 'export async function clearStoredQueue(key: string): Promise<void> {}\nexport async function getStoredQueue(key: string) { return [] }\n');
  fs.writeFileSync(path.join(dir, 'src/tracker.ts'), 'import { getStoredQueue } from "./storage"\nexport async function flush(queue: unknown[]) {\n  const q = await getStoredQueue("k")\n  return q\n}\n');
  const g = (...a) => cp.spawnSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...a], { cwd: dir, encoding: 'utf8' });
  g('init', '-q'); g('add', '.'); g('commit', '-qm', 'init');
  return { dir, base: g('rev-parse', 'HEAD').stdout.trim() };
}
function fakeLm(answers) {
  let i = 0; const prompts = [];
  const fetch = async (url, init) => {
    if (url.endsWith('/api/v0/models')) return { ok: true, json: async () => ({ data: [{ id: MODEL, state: 'loaded', loaded_context_length: 8192 }] }) };
    prompts.push(JSON.parse(init.body).messages[0].content);
    return { ok: true, json: async () => ({ choices: [{ message: { content: answers[Math.min(i++, answers.length - 1)] } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }) };
  };
  return { fetch, prompts };
}
const run = (r, lm, verify) => runRepoWorker({ worktree: r.dir, base: r.base, task: { title: 't', objective: 'o', files: ['src/tracker.ts'] }, verify: [],
  protectedPatterns: [], skipDirs: [], model: MODEL, profile: PROFILE, deadlineAt: Date.now() + 60000,
  dependencies: { fetch: lm.fetch, freemem: () => 64 * 1024 ** 3, runVerify: verify } });
const EDIT = (a, b) => 'EDIT src/tracker.ts\n<<<<<<< SEARCH\n' + a + '\n=======\n' + b + '\n>>>>>>> REPLACE';

test('an EDIT that invents a function is answered with the real, similar helper and its signature', async () => {
  const r = repo();
  const lm = fakeLm(['READ src/tracker.ts', EDIT('  return q', '  await setStoredQueue(queue)\n  return q'), 'STUCK x']);
  await run(r, lm, async () => ({ ok: true, results: [{ name: 'types', ok: true }] }));
  const seen = lm.prompts[2];
  assert.match(seen, /EDIT src\/tracker\.ts: applied/);
  assert.match(seen, /HOST CHECK: setStoredQueue\(\.\.\.\) appears NOWHERE else/);
  assert.match(seen, /clearStoredQueue\s+\(src\/storage\.ts:1\)\s+export async function clearStoredQueue\(key: string\)/);
});

test('an EDIT that only uses real helpers gets no warning', async () => {
  const r = repo();
  const lm = fakeLm(['READ src/tracker.ts', EDIT('  return q', '  await clearStoredQueue("k")\n  return q'), 'STUCK x']);
  await run(r, lm, async () => ({ ok: true, results: [{ name: 'types', ok: true }] }));
  assert.match(lm.prompts[2], /EDIT src\/tracker\.ts: applied/);
  assert.doesNotMatch(lm.prompts[2], /HOST CHECK/);
});

test('a failed RUN shows what really exists for the unknown name and the unknown property', async () => {
  const r = repo();
  fs.writeFileSync(path.join(r.dir, 'src/types.ts'), 'export interface Rec {\n  name: string\n  at: number\n}\n');
  cp.spawnSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'add', '.'], { cwd: r.dir }); cp.spawnSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'types'], { cwd: r.dir });
  const tail = "src/tracker.ts(3,9): error TS2304: Cannot find name 'setStoredQueue'.\nsrc/tracker.ts(4,5): error TS2339: Property 'id' does not exist on type 'Rec'.";
  const lm = fakeLm(['RUN', 'STUCK x']);
  await run(r, lm, async () => ({ ok: false, results: [{ name: 'types', ok: false, tail }] }));
  const seen = lm.prompts[1];
  assert.match(seen, /WHAT REALLY EXISTS/);
  assert.match(seen, /setStoredQueue does not exist/);
  assert.match(seen, /clearStoredQueue\s+\(src\/storage\.ts:1\)/);
  assert.match(seen, /id is not a field of Rec/);
  assert.match(seen, /at: number/);
  assert.match(seen, /\[RUN RESULT: FAILED at types\]/, 'the status line still ends the RUN result');
});

test('the lookup never breaks a turn: a repository git cannot search gives no note and the EDIT still applies', async () => {
  const r = repo();
  const lm = fakeLm(['READ src/tracker.ts', EDIT('  return q', '  await setStoredQueue(queue)\n  return q'), 'STUCK x']);
  const out = await run(r, lm, async () => ({ ok: true, results: [{ name: 'types', ok: true }] }));
  assert.ok(fs.readFileSync(path.join(r.dir, 'src/tracker.ts'), 'utf8').includes('setStoredQueue(queue)'), 'the model keeps the right to write what it wants');
  assert.ok(out && out.state);
});
