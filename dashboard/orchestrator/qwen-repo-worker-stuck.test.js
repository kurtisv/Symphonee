'use strict';
// 2026-11-22 live test: with a protected file it needed, the 9B alternated empty answers and the
// same READ for 26 turns before the repeat detector stopped it. These tests replay that shape.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');
const { runRepoWorker, LIMITS } = require('./qwen-repo-worker');

const MODEL = 'qwen/qwen3.5-9b';
const PROFILE = { mode: 'text', minContext: 8192, wallSeconds: 30, reasoningEffort: 'none', maxToolCalls: 0 };

function repo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-stuck-'));
  fs.writeFileSync(path.join(dir, 'a.js'), 'module.exports = 1;\n');
  fs.writeFileSync(path.join(dir, 'secret.test.js'), 'hidden\n');
  const g = (...a) => cp.spawnSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...a], { cwd: dir, encoding: 'utf8' });
  g('init', '-q'); g('add', '.'); g('commit', '-qm', 'init');
  return { dir, base: g('rev-parse', 'HEAD').stdout.trim() };
}

// A fake LM Studio: the model list says the 9B is loaded, each chat call returns the next scripted answer.
function fakeLm(answers) {
  let i = 0;
  const prompts = [];
  const fetch = async (url, init) => {
    if (url.endsWith('/api/v0/models')) return { ok: true, json: async () => ({ data: [{ id: MODEL, state: 'loaded', loaded_context_length: 8192 }] }) };
    prompts.push(JSON.parse(init.body).messages[0].content);
    const content = answers[Math.min(i++, answers.length - 1)];
    return { ok: true, json: async () => ({ choices: [{ message: { content } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }) };
  };
  return { fetch, prompts, calls: () => i };
}

function run(r, lm, extra = {}) {
  return runRepoWorker({ worktree: r.dir, base: r.base, task: { title: 't', objective: 'o', files: [] }, verify: [],
    protectedPatterns: ['secret\\.test\\.js$'], skipDirs: [], model: MODEL, profile: PROFILE, deadlineAt: Date.now() + 60000,
    dependencies: { fetch: lm.fetch, freemem: () => 64 * 1024 ** 3, runVerify: async () => ({ ok: false, results: [{ name: 'tests', ok: false, tail: 'fail' }] }) }, ...extra });
}

test('a secret file asked for again and again hands over quickly with the file named', async () => {
  const r = repo();
  fs.writeFileSync(path.join(r.dir, '.env'), 'KEY=not-for-the-model\n');
  const lm = fakeLm(['READ .env']);
  const out = await run(r, lm);
  assert.equal(out.state, 'blocked');
  assert.match(out.summary, /protected file \.env/);
  assert.equal(lm.calls(), LIMITS.protectedAsksBeforeStuck);
  // From the first refusal on, the model is told the file will never be readable, and the secret never reaches a prompt.
  assert.match(lm.prompts[1], /holds SECRETS and will NEVER be readable/);
  assert.ok(!lm.prompts.some((p) => p.includes('not-for-the-model')));
});

test('a protected (non-secret) file can be read but not changed, and edits to it are refused', async () => {
  const r = repo();
  const lm = fakeLm(['READ secret.test.js', 'EDIT secret.test.js\n<<<<<<< SEARCH\nhidden\n=======\nopen\n>>>>>>> REPLACE']);
  const out = await run(r, lm);
  assert.match(lm.prompts[1], /READ secret\.test\.js lines 1-/);
  assert.match(lm.prompts[2], /you may READ it, but it will NEVER be changed/);
  assert.equal(out.state, 'blocked');
  assert.match(out.summary, /protected file secret\.test\.js/);
  assert.equal(fs.readFileSync(path.join(r.dir, 'secret.test.js'), 'utf8'), 'hidden\n');
});

test('.env.example is readable, .env.local is a secret', async () => {
  const r = repo();
  fs.writeFileSync(path.join(r.dir, '.env.example'), 'KEY=\n');
  fs.writeFileSync(path.join(r.dir, '.env.local'), 'KEY=real-value\n');
  const lm = fakeLm(['READ .env.example\nREAD .env.local', 'STUCK x']);
  await run(r, lm);
  assert.match(lm.prompts[1], /READ \.env\.example lines 1-/);
  assert.match(lm.prompts[1], /\.env\.local holds SECRETS/);
  assert.ok(!lm.prompts.some((p) => p.includes('real-value')));
});

test('a secret value printed by a failing check never reaches the prompt', async () => {
  const r = repo();
  fs.writeFileSync(path.join(r.dir, '.gitignore'), '.env\n');
  fs.writeFileSync(path.join(r.dir, '.env'), 'API_KEY=sk-live-abcdef123456\nSHORT=abc\n');
  const lm = fakeLm(['RUN', 'STUCK x']);
  await runRepoWorker({ worktree: r.dir, base: r.base, task: { title: 't', objective: 'o', files: [] }, verify: [],
    protectedPatterns: [], skipDirs: [], model: MODEL, profile: PROFILE, deadlineAt: Date.now() + 60000,
    dependencies: { fetch: lm.fetch, freemem: () => 64 * 1024 ** 3,
      runVerify: async () => ({ ok: false, results: [{ name: 'tests', ok: false, tail: 'Error: bad key sk-live-abcdef123456 rejected (abc)' }] }) } });
  assert.match(lm.prompts[1], /bad key \[REDACTED\] rejected \(abc\)/);
  assert.ok(!lm.prompts.some((p) => p.includes('sk-live-abcdef123456')));
});

test('secret values in an ignored secrets/ folder and PEM key bodies are masked too', () => {
  const { secretValues, SECRET_PATTERNS } = require('./qwen-repo-worker');
  const r = repo();
  fs.writeFileSync(path.join(r.dir, '.gitignore'), 'secrets/\n*.pem\n');
  fs.mkdirSync(path.join(r.dir, 'secrets', 'prod'), { recursive: true });
  fs.writeFileSync(path.join(r.dir, 'secrets', 'prod', 'credentials.json'), '{ "token": "tok-9f8e7d6c5b4a" }\n');
  fs.writeFileSync(path.join(r.dir, 'server.pem'), '-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASC\n-----END PRIVATE KEY-----\n');
  const v = secretValues(r.dir, SECRET_PATTERNS.map((p) => new RegExp(p, 'i')));
  assert.ok(v.includes('tok-9f8e7d6c5b4a'), 'value inside the ignored secrets/ folder');
  assert.ok(v.includes('MIIEvQIBADANBgkqhkiG9w0BAQEFAASC'), 'PEM body line');
});

test('a secret file inside an ignored folder with an ordinary name is masked', () => {
  const { secretValues, SECRET_PATTERNS } = require('./qwen-repo-worker');
  const r = repo();
  fs.writeFileSync(path.join(r.dir, '.gitignore'), '.config/\n');
  fs.mkdirSync(path.join(r.dir, '.config'), { recursive: true });
  fs.writeFileSync(path.join(r.dir, '.config', 'credentials.json'), '{ "password": "pw-1a2b3c4d5e" }\n');
  fs.writeFileSync(path.join(r.dir, '.config', 'settings.json'), '{ "theme": "dark-but-long" }\n');
  const v = secretValues(r.dir, SECRET_PATTERNS.map((p) => new RegExp(p, 'i')));
  assert.ok(v.includes('pw-1a2b3c4d5e'));
  assert.ok(!v.includes('dark-but-long'), 'ordinary files of that folder are not treated as secrets');
});

test('Windows aliases of a secret file are refused (trailing dot, space, stream, short name, case)', () => {
  const { confine, SECRET_PATTERNS } = require('./qwen-repo-worker');
  const re = SECRET_PATTERNS.map((p) => new RegExp(p, 'i'));
  const r = repo();
  fs.writeFileSync(path.join(r.dir, '.env'), 'K=secretvalue\n');
  for (const p of ['.env.', '.env ', '.env::$DATA', 'ENV~1', '.ENV', './.env']) assert.throws(() => confine(r.dir, p, re), /Path refused/, p);
  assert.doesNotThrow(() => confine(r.dir, 'a.js', re));
});

test('a JSON secret written with escapes is masked in its decoded form', () => {
  const { secretValues, SECRET_PATTERNS } = require('./qwen-repo-worker');
  const r = repo();
  fs.writeFileSync(path.join(r.dir, '.gitignore'), 'secrets/\n');
  fs.mkdirSync(path.join(r.dir, 'secrets'));
  fs.writeFileSync(path.join(r.dir, 'secrets', 'k.json'), '{ "key": "abc\\u0023def" }\n');
  const v = secretValues(r.dir, SECRET_PATTERNS.map((p) => new RegExp(p, 'i')));
  assert.ok(v.includes('abc#def'));
});

test('an unquoted numeric secret (JSON number, YAML scalar) is masked', () => {
  const { secretValues, SECRET_PATTERNS } = require('./qwen-repo-worker');
  const r = repo();
  fs.writeFileSync(path.join(r.dir, '.gitignore'), 'secrets/\n');
  fs.mkdirSync(path.join(r.dir, 'secrets'));
  fs.writeFileSync(path.join(r.dir, 'secrets', 'c.json'), '{"pin": 123456, "port": 80}\n');
  fs.writeFileSync(path.join(r.dir, 'secrets', 'c.yml'), 'code: 987654\n');
  const v = secretValues(r.dir, SECRET_PATTERNS.map((p) => new RegExp(p, 'i')));
  assert.ok(v.includes('123456') && v.includes('987654'));
});

test('a quoted value with # is masked, and a secret deleted by the check itself is still masked', async () => {
  const { secretValues, SECRET_PATTERNS } = require('./qwen-repo-worker');
  const r = repo();
  fs.writeFileSync(path.join(r.dir, '.gitignore'), '.env\n');
  fs.writeFileSync(path.join(r.dir, '.env'), 'TOKEN="abc#def"\n');
  assert.ok(secretValues(r.dir, SECRET_PATTERNS.map((p) => new RegExp(p, 'i'))).includes('abc#def'));
  const lm = fakeLm(['RUN', 'STUCK x']);
  await runRepoWorker({ worktree: r.dir, base: r.base, task: { title: 't', objective: 'o', files: [] }, verify: [],
    protectedPatterns: [], skipDirs: [], model: MODEL, profile: PROFILE, deadlineAt: Date.now() + 60000,
    dependencies: { fetch: lm.fetch, freemem: () => 64 * 1024 ** 3,
      runVerify: async () => { fs.rmSync(path.join(r.dir, '.env')); return { ok: false, results: [{ name: 'tests', ok: false, tail: 'token was abc#def' }] }; } } });
  assert.ok(!lm.prompts.some((p) => p.includes('abc#def')));
  assert.match(lm.prompts[1], /token was \[REDACTED\]/);
});

test('a short password is masked; a link inside a secret folder makes the scan incomplete', () => {
  const { secretValues, SECRET_PATTERNS } = require('./qwen-repo-worker');
  const re = SECRET_PATTERNS.map((p) => new RegExp(p, 'i'));
  const r = repo();
  fs.writeFileSync(path.join(r.dir, '.gitignore'), '.env\nsecrets/\n');
  fs.writeFileSync(path.join(r.dir, '.env'), 'DB_PASS=k7x!q9\nNODE_ENV=production\nDEBUG=true\n');
  let v = secretValues(r.dir, re);
  assert.ok(v.includes('k7x!q9'), '6-character password');
  assert.ok(!v.includes('production'), 'a plain word under a non-sensitive key is structure, not a secret (it would blank ordinary output)');
  assert.ok(!v.includes('true'), 'under 6 characters: not masked');
  assert.equal(v.incomplete, false);
  fs.mkdirSync(path.join(r.dir, 'secrets'));
  const target = fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-link-target-'));
  fs.symlinkSync(target, path.join(r.dir, 'secrets', 'linked'), 'junction');
  v = secretValues(r.dir, re);
  assert.equal(v.incomplete, true, 'a link that could hold secrets is not followed: fail closed');
});

test('a bare token line in a secret file is masked, and an incomplete scan fails closed', async () => {
  const { secretValues, SECRET_PATTERNS } = require('./qwen-repo-worker');
  const r = repo();
  fs.writeFileSync(path.join(r.dir, '.gitignore'), 'secrets/\n');
  fs.mkdirSync(path.join(r.dir, 'secrets'));
  fs.writeFileSync(path.join(r.dir, 'secrets', 'api.txt'), 'secret-token.with.dots\n');
  const v = secretValues(r.dir, SECRET_PATTERNS.map((p) => new RegExp(p, 'i')));
  assert.ok(v.includes('secret-token.with.dots'));
  assert.equal(v.incomplete, false);
  // Incomplete scan: only test names/counts survive.
  fs.writeFileSync(path.join(r.dir, 'secrets', 'big.txt'), 'x'.repeat(300000));
  const lm = fakeLm(['RUN', 'STUCK x']);
  await runRepoWorker({ worktree: r.dir, base: r.base, task: { title: 't', objective: 'o', files: [] }, verify: [],
    protectedPatterns: [], skipDirs: [], model: MODEL, profile: PROFILE, deadlineAt: Date.now() + 60000,
    dependencies: { fetch: lm.fetch, freemem: () => 64 * 1024 ** 3,
      runVerify: async () => ({ ok: false, results: [{ name: 'tests', ok: false, tail: '✖ pays (3ms)\n  Error: unknown-secret-value-xyz\nℹ fail 1' }] }) } });
  assert.match(lm.prompts[1], /secret scan of this worktree was incomplete/);
  assert.match(lm.prompts[1], /ℹ fail 1/);
  assert.ok(!lm.prompts[1].includes('unknown-secret-value-xyz'));
  assert.ok(!lm.prompts[1].includes('✖ pays'), 'test names can carry a secret too: counts only');
});

test('LIST and GREP hide secret files but show protected ones', async () => {
  const r = repo();
  fs.writeFileSync(path.join(r.dir, '.env'), 'hidden=1\n');
  cp.spawnSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'add', '-f', '.env'], { cwd: r.dir });
  cp.spawnSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'env'], { cwd: r.dir });
  r.base = cp.spawnSync('git', ['rev-parse', 'HEAD'], { cwd: r.dir, encoding: 'utf8' }).stdout.trim();
  const lm = fakeLm(['LIST .\nGREP hidden', 'STUCK x']);
  await run(r, lm);
  assert.match(lm.prompts[1], /secret\.test\.js/);
  const last = lm.prompts[1].split('LAST RESULTS:')[1];
  assert.ok(!/\.env/.test(last), last);
});

test('one refusal of a protected file does not stop a model that then works normally', async () => {
  const r = repo();
  const lm = fakeLm(['READ secret.test.js', 'READ a.js', 'EDIT a.js\n<<<<<<< SEARCH\nmodule.exports = 1;\n=======\nmodule.exports = 2;\n>>>>>>> REPLACE', 'DONE fixed']);
  const out = await runRepoWorker({ worktree: r.dir, base: r.base, task: { title: 't', objective: 'o', files: [] }, verify: [],
    protectedPatterns: ['secret\\.test\\.js$'], skipDirs: [], model: MODEL, profile: PROFILE, deadlineAt: Date.now() + 60000,
    dependencies: { fetch: lm.fetch, freemem: () => 64 * 1024 ** 3, runVerify: async () => ({ ok: true, results: [{ name: 'tests', ok: true }] }) } });
  assert.equal(out.state, 'completed');
  assert.deepEqual(out.changed, ['a.js']);
});

test('empty answers alternating with valid turns hand over after the window limit', async () => {
  const r = repo();
  const lm = fakeLm(['READ a.js', '', 'LIST .', '', 'READ a.js 1-1', '', 'LIST .', '', 'READ a.js', '']);
  const out = await run(r, lm);
  assert.equal(out.state, 'blocked');
  assert.match(out.summary, /empty answers/);
  assert.equal(lm.calls(), 2 * LIMITS.emptyTurnsBeforeStuck);
  assert.match(lm.prompts[2], /Your last answer was EMPTY \(1\//);
});

test('a single empty answer is only a warning', async () => {
  const r = repo();
  const lm = fakeLm(['', 'READ a.js', 'EDIT a.js\n<<<<<<< SEARCH\nmodule.exports = 1;\n=======\nmodule.exports = 3;\n>>>>>>> REPLACE', 'DONE ok']);
  const out = await runRepoWorker({ worktree: r.dir, base: r.base, task: { title: 't', objective: 'o', files: [] }, verify: [],
    protectedPatterns: [], skipDirs: [], model: MODEL, profile: PROFILE, deadlineAt: Date.now() + 60000,
    dependencies: { fetch: lm.fetch, freemem: () => 64 * 1024 ** 3, runVerify: async () => ({ ok: true, results: [{ name: 'tests', ok: true }] }) } });
  assert.equal(out.state, 'completed');
});

test('RUN after the per-turn action limit is still executed', async () => {
  const r = repo();
  const edit = (a, b) => 'EDIT a.js\n<<<<<<< SEARCH\nmodule.exports = ' + a + ';\n=======\nmodule.exports = ' + b + ';\n>>>>>>> REPLACE';
  const lm = fakeLm(['READ a.js\n' + edit(1, 2) + '\nREAD a.js\n' + edit(2, 3) + '\nLIST .\nRUN', 'DONE ok']);
  let runs = 0;
  const out = await runRepoWorker({ worktree: r.dir, base: r.base, task: { title: 't', objective: 'o', files: [] }, verify: [],
    protectedPatterns: [], skipDirs: [], model: MODEL, profile: PROFILE, deadlineAt: Date.now() + 60000,
    dependencies: { fetch: lm.fetch, freemem: () => 64 * 1024 ** 3, runVerify: async () => { runs++; return { ok: true, results: [{ name: 'tests', ok: true }] }; } } });
  assert.equal(out.state, 'completed');
  assert.ok(runs >= 1);
  assert.match(lm.prompts[1], /RUN PASSED/);
  assert.match(lm.prompts[1], /extra LIST/);
  assert.equal(fs.readFileSync(path.join(r.dir, 'a.js'), 'utf8'), 'module.exports = 3;\n');
});

test('an old saved session without the new counters still resumes', async () => {
  const r = repo();
  const sessionFile = path.join(r.dir + '-s.json');
  fs.writeFileSync(sessionFile, JSON.stringify({ v: 1, turns: 2, plan: [], notes: [], changed: [], runs: [], switches: 0, strategies: [], idleRuns: 0, formatErrors: 0, lastRunSig: null, sameSigStreak: 0, lastDiffHash: null, created: [], stuckRefusals: 0, reads: 0, recent: [], log: [], repeatStreak: 0, lastTurnSig: null, repeatDemands: 0, turnsSinceChange: 0, noChangeDemanded: false, usage: { input: 0, output: 0, calls: 0 }, observations: [], events: [] }));
  fs.writeFileSync(path.join(r.dir, '.env'), 'K=1\n');
  const lm = fakeLm(['READ .env']);
  const out = await run(r, lm, { sessionFile });
  assert.equal(out.state, 'blocked');
  assert.match(out.summary, /protected file/);
});

test('a git-quoted path (control character in the name) makes the scan incomplete', () => {
  const { secretValues, SECRET_PATTERNS } = require('./qwen-repo-worker');
  const r = repo();
  let made = true;
  try { fs.mkdirSync(path.join(r.dir, 'a\u0001b')); fs.writeFileSync(path.join(r.dir, 'a\u0001b', '.env'), 'K=hiddenvalue\n'); } catch (_) { made = false; }
  if (!made) return; // the filesystem refuses such names: nothing to scan
  const v = secretValues(r.dir, SECRET_PATTERNS.map((p) => new RegExp(p, 'i')));
  assert.equal(v.incomplete, true);
});

test('values inside arrays and lists of a secret file are masked', () => {
  const { secretValues, SECRET_PATTERNS } = require('./qwen-repo-worker');
  const r = repo();
  fs.writeFileSync(path.join(r.dir, '.gitignore'), 'secrets/\n');
  fs.mkdirSync(path.join(r.dir, 'secrets'));
  fs.writeFileSync(path.join(r.dir, 'secrets', 's.json'), '{"tokens":["abc123","xyz789"]}\n');
  fs.writeFileSync(path.join(r.dir, 'secrets', 's.yml'), 'keys:\n  - qwe456\n');
  const v = secretValues(r.dir, SECRET_PATTERNS.map((p) => new RegExp(p, 'i')));
  for (const x of ['abc123', 'xyz789', 'qwe456']) assert.ok(v.includes(x), x);
});

test('a YAML list value with spaces and an escaped string inside an array are masked', () => {
  const { secretValues, SECRET_PATTERNS } = require('./qwen-repo-worker');
  const r = repo();
  fs.writeFileSync(path.join(r.dir, '.gitignore'), 'secrets/\n');
  fs.mkdirSync(path.join(r.dir, 'secrets'));
  fs.writeFileSync(path.join(r.dir, 'secrets', 'l.yml'), 'keys:\n  - abc def\n');
  fs.writeFileSync(path.join(r.dir, 'secrets', 'a.json'), '["ab\u0063\u0023ef1"]\n');
  const v = secretValues(r.dir, SECRET_PATTERNS.map((p) => new RegExp(p, 'i')));
  assert.ok(v.includes('abc def'));
  assert.ok(v.includes('abc#ef1'));
});

test('secretMask (autopilot gate) masks values, and a string with an escaped quote is captured whole', () => {
  const { secretMask } = require('./qwen-repo-worker');
  const r = repo();
  fs.writeFileSync(path.join(r.dir, '.gitignore'), '.env\nsecrets/\n');
  fs.writeFileSync(path.join(r.dir, '.env'), 'API=gate-secret-42\n');
  fs.mkdirSync(path.join(r.dir, 'secrets'));
  fs.writeFileSync(path.join(r.dir, 'secrets', 'q.json'), '["abc\\" de"]\n');
  const redact = secretMask(r.dir)();
  assert.equal(redact('got gate-secret-42 and abc" de'), 'got [REDACTED] and [REDACTED]');
});

test('only one RUN per turn is executed, however many the model writes', async () => {
  const r = repo();
  let runs = 0;
  const lm = fakeLm(['RUN\nRUN\nRUN\nRUN\nRUN\nRUN', 'STUCK x']);
  await runRepoWorker({ worktree: r.dir, base: r.base, task: { title: 't', objective: 'o', files: [] }, verify: [],
    protectedPatterns: [], skipDirs: [], model: MODEL, profile: PROFILE, deadlineAt: Date.now() + 60000,
    dependencies: { fetch: lm.fetch, freemem: () => 64 * 1024 ** 3, runVerify: async () => { runs++; return { ok: false, results: [{ name: 't', ok: false, tail: 'x' }] }; } } });
  assert.equal(runs, 1);
});

test('a nested secrets/ folder is protected like the root one', () => {
  const { confine, SECRET_PATTERNS } = require('./qwen-repo-worker');
  const re = SECRET_PATTERNS.map((p) => new RegExp(p, 'i'));
  const r = repo();
  fs.mkdirSync(path.join(r.dir, 'apps', 'api', 'secrets'), { recursive: true });
  fs.writeFileSync(path.join(r.dir, 'apps', 'api', 'secrets', 'token.txt'), 'tok-nested-123\n');
  assert.throws(() => confine(r.dir, 'apps/api/secrets/token.txt', re), /Path refused/);
});

test('a secret created by one check and deleted by the next is still masked (scan before every check)', () => {
  const { secretMask } = require('./qwen-repo-worker');
  const r = repo();
  fs.writeFileSync(path.join(r.dir, '.gitignore'), '.env\n');
  const mask = secretMask(r.dir);
  fs.writeFileSync(path.join(r.dir, '.env'), 'K=between-checks-9\n'); // check 1 creates it
  mask.observe(); // check 2 starts
  fs.rmSync(path.join(r.dir, '.env')); // check 2 prints then deletes it
  assert.equal(mask()('leak between-checks-9'), 'leak [REDACTED]');
});

test('a YAML value followed by an inline comment is masked without the comment', () => {
  const { secretValues, SECRET_PATTERNS } = require('./qwen-repo-worker');
  const r = repo();
  fs.writeFileSync(path.join(r.dir, '.gitignore'), 'secrets/\n');
  fs.mkdirSync(path.join(r.dir, 'secrets'));
  fs.writeFileSync(path.join(r.dir, 'secrets', 'config.yml'), 'keys:\n  - abc def # note\npass: "xy z12" # old\n');
  const v = secretValues(r.dir, SECRET_PATTERNS.map((p) => new RegExp(p, 'i')));
  assert.ok(v.includes('abc def'));
  assert.ok(v.includes('xy z12'));
});

test('a SEARCH that is not found tells the model where the code really is and shows it (2026-11-23: 13 blind EDITs on lines 275-300 of a 429-line file)', () => {
  const { locateSearch } = require('./qwen-repo-worker');
  const lines = Array.from({ length: 60 }, (_, i) => 'const filler' + i + ' = ' + i + ';');
  lines[40] = 'async function flushEvents(queue) {';
  lines[41] = '  const sent = await send(queue);';
  lines[42] = '  queue.length = 0;';
  const text = lines.join('\n');
  // 1) one line of the guess exists verbatim: its line number and the real surrounding lines are shown
  let r = locateSearch(text, 'async function flushEvents(queue) {\n  const batch = queue.splice(0);\n  await send(batch);', 'x');
  assert.match(r.err, /not found/);
  assert.match(r.err, /close to line 41/);
  assert.match(r.err, /\s41 async function flushEvents\(queue\) \{/);
  assert.match(r.err, /\s43\s+queue\.length = 0;/);
  assert.ok(r.err.length < 1500, 'the hint stays small');
  // 2) no line matches but a name does: pointed to by name
  r = locateSearch(text, 'if (flushEvents) { return; }', 'x');
  assert.match(r.err, /"flushEvents" first appears at line 41/);
  // 3) nothing in common: told to GREP, no invented location
  r = locateSearch(text, 'completely unrelated(thing)', 'x');
  assert.match(r.err, /guessing code you have not READ/);
  assert.doesNotMatch(r.err, /line \d+/);
  // exact matches are unchanged
  assert.ok(locateSearch(text, '  queue.length = 0;', '  queue.length = 1;').next);
});

test('an answer cut at the token limit is named as such, once, with the way to recover (2026-11-23: new test file written as one block, cut 7 times)', async () => {
  const r = repo();
  let i = 0; const prompts = [];
  const answers = [{ c: 'CREATE a.test.js\n<<<<<<< CONTENT\nconst test = require("node:test");\ntest("x", () => {\n', f: 'length' }, { c: 'STUCK x', f: 'stop' }];
  const fetch = async (url, init) => {
    if (url.endsWith('/api/v0/models')) return { ok: true, json: async () => ({ data: [{ id: MODEL, state: 'loaded', loaded_context_length: 8192 }] }) };
    prompts.push(JSON.parse(init.body).messages[0].content);
    const a = answers[Math.min(i++, answers.length - 1)];
    return { ok: true, json: async () => ({ choices: [{ message: { content: a.c }, finish_reason: a.f }], usage: { prompt_tokens: 1, completion_tokens: 1 } }) };
  };
  await runRepoWorker({ worktree: r.dir, base: r.base, task: { title: 't', objective: 'o', files: [] }, verify: [], protectedPatterns: [], skipDirs: [], model: MODEL, profile: PROFILE, deadlineAt: Date.now() + 60000,
    dependencies: { fetch, freemem: () => 64 * 1024 ** 3, runVerify: async () => ({ ok: true, results: [] }) } });
  assert.match(prompts[1], new RegExp('YOUR ANSWER WAS CUT OFF at the length limit \\(' + LIMITS.maxTokens + ' tokens\\)'));
  assert.ok(LIMITS.maxTokens + 11000 / 1.9 < 8192, 'even a very token-dense full prompt plus the answer fits the 8192-token context');
  assert.match(prompts[1], /CREATE it with a first small version/);
  assert.equal((prompts[1].match(/YOUR ANSWER WAS CUT OFF/g) || []).length, 1);
  assert.ok(!fs.existsSync(path.join(r.dir, 'a.test.js')), 'the cut block was not applied');
});

test('the where-hint shows at most 1800 characters even for minified lines, and a read-protected file gets no hint', () => {
  const { locateSearch, confine, SECRET_PATTERNS } = require('./qwen-repo-worker');
  const big = Array.from({ length: 30 }, (_, i) => 'const v' + i + ' = "' + 'x'.repeat(5000) + '";').join('\n');
  const r = locateSearch(big, 'const v10 = "nope";', 'x');
  assert.ok(r.err.length < 2300, 'hint stays bounded: ' + r.err.length);
  // doEdit refuses (before reading) a file the model may not READ
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qhint-'));
  fs.writeFileSync(path.join(dir, '.env'), 'K=abcdefgh\n');
  assert.throws(() => confine(dir, '.env', SECRET_PATTERNS.map((p) => new RegExp(p, 'i'))), /Path refused/);
});

test('the where-hint clips a huge identifier too (hint stays under 2300 characters)', () => {
  const { locateSearch } = require('./qwen-repo-worker');
  const id = 'a' + 'b'.repeat(5000);
  const r = locateSearch('line one\nconst ' + id + ' = 1;\nline three', 'if (' + id + ') {}', 'x');
  assert.match(r.err, /first appears at line 2/);
  assert.ok(r.err.length < 2300, 'bounded: ' + r.err.length);
});

test('only the first failed EDIT of an answer shows the real lines; later ones get a one-line pointer, and the RUN result still reaches the model', async () => {
  const r = repo();
  fs.writeFileSync(path.join(r.dir, 'big.js'), Array.from({ length: 80 }, (_, i) => (i === 50 ? 'function target() { return 1; }' : 'const f' + i + ' = ' + i + ';')).join('\n') + '\n');
  cp.spawnSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'add', '.'], { cwd: r.dir });
  cp.spawnSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'big'], { cwd: r.dir });
  const base = cp.spawnSync('git', ['rev-parse', 'HEAD'], { cwd: r.dir, encoding: 'utf8' }).stdout.trim();
  const E = (n) => 'EDIT big.js\n<<<<<<< SEARCH\nfunction target() { return ' + n + '; }\n=======\nx\n>>>>>>> REPLACE';
  const lm = fakeLm([[E(7), E(8), E(9), E(10), 'RUN'].join('\n'), 'STUCK x']);
  await runRepoWorker({ worktree: r.dir, base, task: { title: 't', objective: 'o', files: [] }, verify: [], protectedPatterns: [], skipDirs: [], model: MODEL, profile: PROFILE, deadlineAt: Date.now() + 60000,
    dependencies: { fetch: lm.fetch, freemem: () => 64 * 1024 ** 3, runVerify: async () => ({ ok: false, results: [{ name: 'tests', ok: false, tail: 'RUN-RESULT-MARKER' }] }) } });
  const seen = lm.prompts[1];
  assert.equal((seen.match(/The real text around it/g) || []).length, 1, 'real lines shown once');
  assert.match(seen, /already shown once in this answer/);
  assert.match(seen, /RUN-RESULT-MARKER/, 'the RUN result is not crowded out');
});

test('a successful EDIT before a failed one does not use up the real-lines hint', async () => {
  const r = repo();
  fs.writeFileSync(path.join(r.dir, 'big.js'), Array.from({ length: 40 }, (_, i) => (i === 30 ? 'function target() { return 1; }' : 'const f' + i + ' = ' + i + ';')).join('\n') + '\n');
  cp.spawnSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'add', '.'], { cwd: r.dir });
  cp.spawnSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'big'], { cwd: r.dir });
  const base = cp.spawnSync('git', ['rev-parse', 'HEAD'], { cwd: r.dir, encoding: 'utf8' }).stdout.trim();
  const ok = 'EDIT big.js\n<<<<<<< SEARCH\nconst f3 = 3;\n=======\nconst f3 = 33;\n>>>>>>> REPLACE';
  const bad = 'EDIT big.js\n<<<<<<< SEARCH\nfunction target() { return 9; }\n=======\nx\n>>>>>>> REPLACE';
  const lm = fakeLm([[ok, bad].join('\n'), 'STUCK x']);
  await runRepoWorker({ worktree: r.dir, base, task: { title: 't', objective: 'o', files: [] }, verify: [], protectedPatterns: [], skipDirs: [], model: MODEL, profile: PROFILE, deadlineAt: Date.now() + 60000,
    dependencies: { fetch: lm.fetch, freemem: () => 64 * 1024 ** 3, runVerify: async () => ({ ok: true, results: [] }) } });
  assert.match(lm.prompts[1], /applied/);
  assert.match(lm.prompts[1], /The real text around it/);
  assert.doesNotMatch(lm.prompts[1], /already shown once/);
});

test('masking keeps config vocabulary readable but still hides secrets, including plain words under a sensitive key', () => {
  const { secretValues, SECRET_PATTERNS } = require('./qwen-repo-worker');
  const re = SECRET_PATTERNS.map((p) => new RegExp(p, 'i'));
  const r = repo();
  fs.writeFileSync(path.join(r.dir, '.gitignore'), '.env\nsecrets/\n');
  // eas.json / google-services.json are secret FILES but mostly structure: their ordinary words must stay readable.
  fs.writeFileSync(path.join(r.dir, 'eas.json'), '{ "build": { "development": { "distribution": "internal", "developmentClient": true }, "production": { "channel": "production" } } }\n');
  fs.writeFileSync(path.join(r.dir, 'google-services.json'), '{\n  "project_info": { "project_number": "123456789012" },\n  "services": { "appinvite_service": { "other_platform_oauth_client": [] } },\n  "api_key": [ { "current_key": "AIzaSyD-9tSrke72PouQMnMX-a7eZSW0jkFMBWY" } ]\n}\n');
  fs.writeFileSync(path.join(r.dir, '.env'), 'PASSWORD=sunshine\nAPP_NAME=gasmobile\nSESSION_SECRET=correcthorsebattery\n');
  const v = secretValues(r.dir, re);
  for (const word of ['development', 'distribution', 'internal', 'production', 'channel', 'services', 'completed', 'android', 'preview', 'version', 'client', 'gasmobile']) assert.ok(!v.includes(word), word + ' stays readable');
  for (const secret of ['123456789012', 'AIzaSyD-9tSrke72PouQMnMX-a7eZSW0jkFMBWY', 'sunshine', 'correcthorsebattery']) assert.ok(v.includes(secret), secret + ' is masked');
  assert.ok(!v.includes('developmentClient'), 'a KEY name is not a value: not masked');
  // and the redactor leaves a Jest path and sentence untouched
  const { secretMask } = require('./qwen-repo-worker');
  const out = secretMask(r.dir)()('src/__tests__/services/analyticsTracker.test.ts: the test run has completed; key AIzaSyD-9tSrke72PouQMnMX-a7eZSW0jkFMBWY');
  assert.equal(out, 'src/__tests__/services/analyticsTracker.test.ts: the test run has completed; key [REDACTED]');
});

test('a sensitive key covers everything it holds: array items, indented blocks, list-of-mappings (Codex findings of 2026-11-23)', () => {
  const { secretValues, SECRET_PATTERNS } = require('./qwen-repo-worker');
  const re = SECRET_PATTERNS.map((p) => new RegExp(p, 'i'));
  const r = repo();
  fs.writeFileSync(path.join(r.dir, '.gitignore'), 'secrets/\n');
  fs.mkdirSync(path.join(r.dir, 'secrets'));
  const w = (n, c) => fs.writeFileSync(path.join(r.dir, 'secrets', n), c);
  w('a.json', '{"tokens": ["abcdef", "ghijkl"]}\n');
  w('b.yml', 'password: |\n  mnopqr\n  stuvwx\nname: gasmobile\n');
  w('c.yml', 'users:\n  - password: yzabcd\n  - name: someonehere\n');
  w('d.json', '{\n  "secrets": [\n    "efghij",\n    "klmnop"\n  ],\n  "theme": "darkmode"\n}\n');
  const v = secretValues(r.dir, re);
  for (const x of ['abcdef', 'ghijkl', 'mnopqr', 'stuvwx', 'yzabcd', 'efghij', 'klmnop']) assert.ok(v.includes(x), x + ' is masked');
  for (const x of ['gasmobile', 'someonehere', 'darkmode']) assert.ok(!v.includes(x), x + ' (non-sensitive, plain word) stays readable');
});

test('sensitivity also covers inline nested objects and YAML flow mappings (Codex findings, round 2)', () => {
  const { secretValues, SECRET_PATTERNS } = require('./qwen-repo-worker');
  const re = SECRET_PATTERNS.map((p) => new RegExp(p, 'i'));
  const r = repo();
  fs.writeFileSync(path.join(r.dir, '.gitignore'), 'secrets/\n');
  fs.mkdirSync(path.join(r.dir, 'secrets'));
  const w = (n, c) => fs.writeFileSync(path.join(r.dir, 'secrets', n), c);
  w('a.yml', 'auth: { password: abcdef, user: someoneelse }\ncreds: { password: \'ghijkl\' }\n');
  w('b.json', '{"credentials": {"username": "mnopqr", "deep": {"x": "stuvwx"}}, "theme": "darkmode"}\n');
  const v = secretValues(r.dir, re);
  for (const x of ['abcdef', 'ghijkl', 'mnopqr', 'stuvwx']) assert.ok(v.includes(x), x + ' is masked');
  assert.ok(!v.includes('darkmode'), 'a plain word outside a sensitive object stays readable');
});

test('after an applied EDIT the model is told to RUN, until it does (2026-11-23 replay: no RUN in 12 turns)', async () => {
  const r = repo();
  const edit = 'EDIT a.js\n<<<<<<< SEARCH\nmodule.exports = 1;\n=======\nmodule.exports = 2;\n>>>>>>> REPLACE';
  const lm = fakeLm([edit, 'READ a.js', 'RUN', 'STUCK x']);
  await runRepoWorker({ worktree: r.dir, base: r.base, task: { title: 't', objective: 'o', files: [] }, verify: [], protectedPatterns: [], skipDirs: [], model: MODEL, profile: PROFILE, deadlineAt: Date.now() + 60000,
    dependencies: { fetch: lm.fetch, freemem: () => 64 * 1024 ** 3, runVerify: async () => ({ ok: false, results: [{ name: 't', ok: false, tail: 'x' }] }) } });
  assert.match(lm.prompts[1], /you changed files and have not run the checks since\. Use RUN now/);
  assert.match(lm.prompts[2], /Use RUN now/, 'still told while it has not run');
  assert.doesNotMatch(lm.prompts[3], /Use RUN now/, 'not told again once RUN was executed');
});

test('every word inside a bracket opened by a sensitive key is masked, whatever its quoting (Codex round 3)', () => {
  const { secretValues, SECRET_PATTERNS } = require('./qwen-repo-worker');
  const re = SECRET_PATTERNS.map((p) => new RegExp(p, 'i'));
  const r = repo();
  fs.writeFileSync(path.join(r.dir, '.gitignore'), 'secrets/\n');
  fs.mkdirSync(path.join(r.dir, 'secrets'));
  fs.writeFileSync(path.join(r.dir, 'secrets', 'a.yml'), 'x: { password: [abcdef, ghijkl], theme: darkmode }\ny: { tokens: [mnopqr, stuvwx] }\n');
  const v = secretValues(r.dir, re);
  for (const x of ['abcdef', 'ghijkl', 'mnopqr', 'stuvwx']) assert.ok(v.includes(x), x + ' is masked');
  assert.ok(!v.includes('darkmode'), 'a sibling plain word outside the sensitive bracket stays readable');
});

test('a sensitive array opened with an item on its first line and continued below is covered (Codex round 4)', () => {
  const { secretValues, SECRET_PATTERNS } = require('./qwen-repo-worker');
  const re = SECRET_PATTERNS.map((p) => new RegExp(p, 'i'));
  const r = repo();
  fs.writeFileSync(path.join(r.dir, '.gitignore'), 'secrets/\n');
  fs.mkdirSync(path.join(r.dir, 'secrets'));
  fs.writeFileSync(path.join(r.dir, 'secrets', 'a.yml'), 'password: [abcdef,\n  ghijkl]\ntheme: darkmode\n');
  fs.writeFileSync(path.join(r.dir, 'secrets', 'b.json'), '{\n  "tokens": ["mnopqr",\n    "stuvwx"],\n  "label": "plainword"\n}\n');
  const v = secretValues(r.dir, re);
  for (const x of ['abcdef', 'ghijkl', 'mnopqr', 'stuvwx']) assert.ok(v.includes(x), x + ' is masked');
  for (const x of ['darkmode', 'plainword']) assert.ok(!v.includes(x), x + ' stays readable');
});

test('a failed RUN shows the real lines where the check reports its error, never from a secret file (2026-11-23 replay)', async () => {
  const r = repo();
  fs.writeFileSync(path.join(r.dir, 'big.ts'), Array.from({ length: 60 }, (_, i) => (i === 41 ? 'const broken = missingName + 1' : 'const ok' + i + ' = ' + i)).join('\n') + '\n');
  fs.writeFileSync(path.join(r.dir, '.env'), 'K=hidden-secret-value\n');
  cp.spawnSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'add', '-f', '.'], { cwd: r.dir });
  cp.spawnSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'x'], { cwd: r.dir });
  const base = cp.spawnSync('git', ['rev-parse', 'HEAD'], { cwd: r.dir, encoding: 'utf8' }).stdout.trim();
  const tail = "big.ts(42,15): error TS2304: Cannot find name 'missingName'.\n.env(1,1): error: nope\nnode_modules/x/y.js(3,1): error: ignored";
  const lm = fakeLm(['RUN', 'STUCK x']);
  await runRepoWorker({ worktree: r.dir, base, task: { title: 't', objective: 'o', files: [] }, verify: [], protectedPatterns: [], skipDirs: [], model: MODEL, profile: PROFILE, deadlineAt: Date.now() + 60000,
    dependencies: { fetch: lm.fetch, freemem: () => 64 * 1024 ** 3, runVerify: async () => ({ ok: false, results: [{ name: 'types', ok: false, tail }] }) } });
  const seen = lm.prompts[1];
  assert.match(seen, /WHERE THE CHECK FAILED/);
  assert.match(seen, /big\.ts around line 42/);
  assert.match(seen, / 42> const broken = missingName \+ 1/);
  assert.doesNotMatch(seen, /hidden-secret-value/, 'a read-protected file is never shown');
  assert.doesNotMatch(seen, /\.env around line/);
});

test('READ accepts the ranges a small model writes in its own words; a sentence after the path is still not a READ (2026-11-23 raw replay)', () => {
  const { parseActions } = require('./qwen-repo-worker');
  const read = (l) => { const r = parseActions(l).actions[0]; return r && r.type === 'read' ? [r.file, r.from, r.to] : null; };
  assert.deepEqual(read('READ src/a.ts'), ['src/a.ts', 1, null]);
  assert.deepEqual(read('READ src/a.ts 260-350'), ['src/a.ts', 260, 350]);
  assert.deepEqual(read('READ src/a.ts from 260 to 350'), ['src/a.ts', 260, 350]);
  assert.deepEqual(read('READ src/a.ts from-265 to-320'), ['src/a.ts', 265, 320]);
  assert.deepEqual(read('READ src/a.ts from-to=1-350'), ['src/a.ts', 1, 350]);
  assert.deepEqual(read('READ src/a.ts lines 260..350'), ['src/a.ts', 260, 350]);
  assert.deepEqual(read('READ src/a.ts line 275'), ['src/a.ts', 275, null]);
  assert.deepEqual(read('READ src/a.ts 350-260'), ['src/a.ts', 260, 350], 'reversed bounds are swapped');
  assert.deepEqual(read('READ `src/a.ts` 10-20'), ['src/a.ts', 10, 20]);
  assert.equal(read('READ src/a.ts and then explain the design'), null);
  assert.equal(read('READ the file carefully'), null);
});

test('an answer with text but no action is a FORMAT error that quotes what was written, never an "empty answer"', async () => {
  const r = repo();
  const lm = fakeLm(['Let me think about where the code is.', 'Still thinking.', 'Hmm.', 'Ok.', 'Well.', 'STUCK x']);
  const out = await run(r, lm);
  assert.match(lm.prompts[1], /FORMAT ERROR: no action found in what you wrote \("Let me think about where the code is\."\)/);
  assert.match(lm.prompts[1], /READ src\/file\.js 260-350/);
  assert.doesNotMatch(lm.prompts[1], /Your last answer was EMPTY/);
  assert.doesNotMatch(String(out.summary), /empty answers/);
});

test('plain "key" is a sensitive key; error-context lines are masked; a crowded turn never cuts the RUN result (Codex worker review)', async () => {
  const { secretValues, SECRET_PATTERNS } = require('./qwen-repo-worker');
  const re = SECRET_PATTERNS.map((p) => new RegExp(p, 'i'));
  const r = repo();
  fs.writeFileSync(path.join(r.dir, '.gitignore'), 'secrets/\n.env\n');
  fs.mkdirSync(path.join(r.dir, 'secrets'));
  fs.writeFileSync(path.join(r.dir, 'secrets', 'k.yml'), 'key: sunshine\n');
  assert.ok(secretValues(r.dir, re).includes('sunshine'), 'key: sunshine');
  // a source line that holds a secret value, pointed at by a failed check, is shown masked
  fs.writeFileSync(path.join(r.dir, '.env'), 'API=gate-secret-42\n');
  fs.writeFileSync(path.join(r.dir, 'src.ts'), 'const a = 1\nconst leak = "gate-secret-42"\nconst b = 2\n');
  cp.spawnSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'add', '-f', '.'], { cwd: r.dir });
  cp.spawnSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'x'], { cwd: r.dir });
  const base = cp.spawnSync('git', ['rev-parse', 'HEAD'], { cwd: r.dir, encoding: 'utf8' }).stdout.trim();
  // crowded turn: a near-5000-character READ, a failed EDIT with its hint, then RUN
  fs.writeFileSync(path.join(r.dir, 'long.ts'), Array.from({ length: 200 }, (_, i) => 'const line' + i + ' = ' + i + ';').join('\n') + '\n');
  const lm = fakeLm(['READ long.ts\nEDIT long.ts\n<<<<<<< SEARCH\nconst line5 = 999;\n=======\nx\n>>>>>>> REPLACE\nRUN', 'STUCK x']);
  await runRepoWorker({ worktree: r.dir, base, task: { title: 't', objective: 'o', files: [] }, verify: [], protectedPatterns: [], skipDirs: [], model: MODEL, profile: PROFILE, deadlineAt: Date.now() + 60000,
    dependencies: { fetch: lm.fetch, freemem: () => 64 * 1024 ** 3, runVerify: async () => ({ ok: false, results: [{ name: 'types', ok: false, tail: 'src.ts(2,16): error TS1: bad\nRUN-RESULT-MARKER-END' }] }) } });
  const seen = lm.prompts[1];
  assert.match(seen, /RUN FAILED at types/);
  assert.match(seen, /RUN-RESULT-MARKER-END/, 'the end of the RUN result survives a crowded turn');
  assert.match(seen, /const leak = "\[REDACTED\]"/, 'the shown source line is masked');
  assert.doesNotMatch(seen, /gate-secret-42/);
});

test('the RUN result survives a crowded turn by construction: many format errors, a huge READ, a long task prompt (Codex worker review round 2)', async () => {
  const r = repo();
  fs.writeFileSync(path.join(r.dir, 'long.ts'), Array.from({ length: 300 }, (_, i) => 'const line' + i + ' = ' + i + ';').join('\n') + '\n');
  const bad = Array.from({ length: 8 }, (_, i) => 'EDIT file' + i + '.ts').join('\n'); // 8 malformed EDIT headers: 8 FORMAT ERRORs
  const lm = fakeLm(['READ long.ts\n' + bad + '\nRUN', 'STUCK x']);
  await runRepoWorker({ worktree: r.dir, base: r.base, task: { title: 't', objective: 'x'.repeat(1700), files: [] }, verify: [], protectedPatterns: [], skipDirs: [], model: MODEL, profile: PROFILE, deadlineAt: Date.now() + 60000,
    memoryText: 'm'.repeat(1700),
    dependencies: { fetch: lm.fetch, freemem: () => 64 * 1024 ** 3, runVerify: async () => ({ ok: false, results: [{ name: 'types', ok: false, tail: 'THE-RUN-OUTCOME-IS-HERE' }] }) } });
  const seen = lm.prompts[1];
  assert.match(seen, /THE-RUN-OUTCOME-IS-HERE/, 'the RUN outcome is in the next prompt');
  assert.ok(seen.length < 12500, 'prompt stays bounded: ' + seen.length);
});

test('fitObs keeps priority entries last and tailClip keeps the end', () => {
  const src = fs.readFileSync(path.join(__dirname, 'qwen-repo-worker.js'), 'utf8');
  assert.match(src, /const tailClip = /);
  assert.match(src, /tailClip\(lastObs, 3300\)/);
});

test('fitObs on a really crowded turn: priority entries last, repeated format errors collapsed, bounded, the RUN outcome intact', () => {
  const { fitObs } = require('./qwen-repo-worker');
  const obs = ['READ long.ts lines 1-200:\n' + 'x'.repeat(4900), 'EDIT a.ts: the SEARCH text was not found.' + ' hint'.repeat(300)];
  for (let i = 0; i < 8; i++) obs.push('FORMAT ERROR: EDIT file' + i + '.ts: the block must start on the next line with ' + 'y'.repeat(200));
  obs.push('RUN FAILED at types:\n' + 'z'.repeat(1200) + 'THE-RUN-OUTCOME');
  const out = fitObs(obs, 6500);
  assert.ok(out.length <= 6500, 'bounded: ' + out.length);
  assert.ok(out.endsWith('THE-RUN-OUTCOME'), 'the RUN outcome is the very end');
  assert.equal((out.match(/FORMAT ERROR/g) || []).length, 2, 'repeated format errors collapsed to two');
  assert.ok(out.indexOf('READ long.ts') < out.indexOf('RUN FAILED'), 'priority entries come last');
});

test('fitObs: 100 identical format errors collapse to two; a long RUN keeps both its header and the WHERE THE CHECK FAILED block; the cut is exact', () => {
  const { fitObs } = require('./qwen-repo-worker');
  const dup = Array.from({ length: 100 }, () => 'FORMAT ERROR: EDIT a.js: the block must start on the next line with <<<<<<< SEARCH');
  const run = 'RUN FAILED at types-app:\n' + 'e'.repeat(1800) + '\nWHERE THE CHECK FAILED (the real lines):\n  42> const broken = missingName + 1';
  const out = fitObs(['READ long.ts lines 1-200:\n' + 'x'.repeat(5000), ...dup, run], 6500);
  assert.equal((out.match(/FORMAT ERROR/g) || []).length, 2);
  assert.ok(out.length <= 6500, 'exact bound: ' + out.length);
  assert.match(out, /RUN FAILED at types-app:/);
  assert.match(out, /42> const broken = missingName \+ 1/, 'the appended context is not the part that is cut');
});

test('even when the prompt is so long that the final fallback cuts the observations, the RUN status line is kept', async () => {
  const r = repo();
  const lm = fakeLm(['RUN', 'STUCK x']);
  await runRepoWorker({ worktree: r.dir, base: r.base, task: { title: 't', objective: 'o'.repeat(1700), files: [] }, verify: [], protectedPatterns: [], skipDirs: [], model: MODEL, profile: PROFILE, deadlineAt: Date.now() + 60000,
    memoryText: 'm'.repeat(1800),
    dependencies: { fetch: lm.fetch, freemem: () => 64 * 1024 ** 3, runVerify: async () => ({ ok: false, results: [{ name: 'types-app', ok: false, tail: 'q'.repeat(1800) }] }) } });
  assert.match(lm.prompts[1], /\[RUN RESULT: FAILED at types-app\]/);
  const ok = fakeLm(['RUN', 'STUCK x']);
  await runRepoWorker({ worktree: r.dir, base: r.base, task: { title: 't', objective: 'o', files: [] }, verify: [], protectedPatterns: [], skipDirs: [], model: MODEL, profile: PROFILE, deadlineAt: Date.now() + 60000,
    dependencies: { fetch: ok.fetch, freemem: () => 64 * 1024 ** 3, runVerify: async () => ({ ok: true, results: [{ name: 'types-app', ok: true }] }) } });
  assert.match(ok.prompts[1], /\[RUN RESULT: PASSED\]/);
});

test('error-context lines are masked BEFORE they are cut, so a secret straddling the 160-character limit does not leak its prefix', async () => {
  const r = repo();
  fs.writeFileSync(path.join(r.dir, '.gitignore'), '.env\n');
  fs.writeFileSync(path.join(r.dir, '.env'), 'API=gate-secret-value-4242\n');
  fs.writeFileSync(path.join(r.dir, 'src.ts'), 'const pad = "' + 'p'.repeat(140) + '"; const leak = "gate-secret-value-4242"\n');
  cp.spawnSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'add', '-f', '.'], { cwd: r.dir });
  cp.spawnSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'x'], { cwd: r.dir });
  const base = cp.spawnSync('git', ['rev-parse', 'HEAD'], { cwd: r.dir, encoding: 'utf8' }).stdout.trim();
  const lm = fakeLm(['RUN', 'STUCK x']);
  await runRepoWorker({ worktree: r.dir, base, task: { title: 't', objective: 'o', files: [] }, verify: [], protectedPatterns: [], skipDirs: [], model: MODEL, profile: PROFILE, deadlineAt: Date.now() + 60000,
    dependencies: { fetch: lm.fetch, freemem: () => 64 * 1024 ** 3, runVerify: async () => ({ ok: false, results: [{ name: 'types', ok: false, tail: 'src.ts(1,150): error TS1: bad' }] }) } });
  assert.match(lm.prompts[1], /WHERE THE CHECK FAILED/);
  assert.doesNotMatch(lm.prompts[1], /gate-secret/, 'no prefix of the secret reaches the model');
  assert.doesNotMatch(lm.prompts[1], /4242/);
});

// Codex round 1 of the teacher lot: a falling number of errors is progress even when the normalised signature is unchanged
test('teacher: a falling number of errors is measured progress, so it is not handed over as "the same failure"', async () => {
  const r = repo();
  let n = 0;
  const line = "src/t.ts(1,1): error TS2339: Property 'zz' does not exist on type 'Rec'.\n";
  const edit = (i) => 'EDIT a.js\n<<<<<<< SEARCH\nmodule.exports = ' + (i === 0 ? '1' : String(i)) + ';\n=======\nmodule.exports = ' + (i + 1) + ';\n>>>>>>> REPLACE\nRUN';
  const lm = fakeLm(Array.from({ length: 9 }, (_, i) => edit(i)).concat(['STUCK x']));
  const out = await run(r, lm, { dependencies: { fetch: lm.fetch, freemem: () => 64 * 1024 ** 3, runVerify: async () => ({ ok: false, results: [{ name: 'types', ok: false, tail: line.repeat(26 - n++) }] }) } });
  assert.doesNotMatch(String(out.summary), /same failure persists/);
  assert.equal(out.switches, 0, 'no strategy switch while the error count keeps falling');
});

test('teacher: a file Qwen created (not in git diff) is part of the hand-over evidence, masked', async () => {
  const r = repo();
  const lm = fakeLm(['CREATE new.test.js\n<<<<<<< CONTENT\nconst v = "visible-line";\nconst k = "Zq7Xk29LmN4pRtW8";\n>>>>>>> END\nRUN', 'RUN', 'RUN', 'RUN', 'RUN']);
  fs.writeFileSync(path.join(r.dir, '.gitignore'), '.env\n'); // like a real repository: the secret file is ignored
  fs.writeFileSync(path.join(r.dir, '.env'), 'API_TOKEN=Zq7Xk29LmN4pRtW8\n');
  const out = await run(r, lm);
  assert.equal(out.state, 'blocked');
  assert.match(String(out.teach), /\+\+\+ NEW FILE new\.test\.js/);
  assert.match(String(out.teach), /visible-line/);
  assert.doesNotMatch(String(out.teach), /Zq7Xk29LmN4pRtW8/);
});

test('behaviour gate: DONE is refused while a source change has no test, and accepted once a test file comes with it', async () => {
  const r = repo();
  fs.mkdirSync(path.join(r.dir, 'src'));
  fs.writeFileSync(path.join(r.dir, 'src/add.js'), 'function add(a, b) { return a }\nmodule.exports = { add }\n');
  const g = (...a) => cp.spawnSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...a], { cwd: r.dir, encoding: 'utf8' });
  g('add', '.'); g('commit', '-qm', 'src'); r.base = g('rev-parse', 'HEAD').stdout.trim();
  const edit = 'EDIT src/add.js\n<<<<<<< SEARCH\nfunction add(a, b) { return a }\n=======\nfunction add(a, b) { return a + b }\n>>>>>>> REPLACE\nRUN\nDONE fixed';
  const test = 'CREATE src/add.test.js\n<<<<<<< CONTENT\nconst t = require("node:test");\nt("adds", () => {});\n>>>>>>> END\nRUN\nDONE fixed with a test';
  const lm = fakeLm([edit, test, 'STUCK x']);
  const out = await run(r, lm, { behavior: { required: true, sourceDirs: ['src/'], lintOnly: true },
    dependencies: { fetch: lm.fetch, freemem: () => 64 * 1024 ** 3, runVerify: async () => ({ ok: true, results: [{ name: 'types', ok: true }] }) } });
  assert.equal(out.state, 'completed');
  assert.match(lm.prompts[1], /DONE refused: BEHAVIOUR TEST REQUIRED: you changed src\/add\.js but no test file/);
  assert.doesNotMatch(lm.prompts[2] || '', /BEHAVIOUR TEST REQUIRED/, 'once the test file exists the refusal is gone');
});

test('behaviour gate: without the option (or with required false) DONE is accepted as before', async () => {
  const r = repo();
  fs.mkdirSync(path.join(r.dir, 'src'));
  fs.writeFileSync(path.join(r.dir, 'src/add.js'), 'function add(a, b) { return a }\n');
  const g = (...a) => cp.spawnSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...a], { cwd: r.dir, encoding: 'utf8' });
  g('add', '.'); g('commit', '-qm', 'src'); r.base = g('rev-parse', 'HEAD').stdout.trim();
  const lm = fakeLm(['EDIT src/add.js\n<<<<<<< SEARCH\nfunction add(a, b) { return a }\n=======\nfunction add(a, b) { return a + b }\n>>>>>>> REPLACE\nRUN\nDONE fixed']);
  const out = await run(r, lm, { dependencies: { fetch: lm.fetch, freemem: () => 64 * 1024 ** 3, runVerify: async () => ({ ok: true, results: [{ name: 'types', ok: true }] }) } });
  assert.equal(out.state, 'completed');
});

test('behaviour gate: when a REQUIRED gate breaks, DONE is refused (fail closed), not accepted', async () => {
  const r = repo();
  const g = (...a) => cp.spawnSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...a], { cwd: r.dir, encoding: 'utf8' });
  fs.writeFileSync(path.join(r.dir, 'a.js'), 'module.exports = 1;\n'); g('add', '.'); g('commit', '-qm', 'x'); r.base = g('rev-parse', 'HEAD').stdout.trim();
  const broken = new Proxy({ required: true }, { get(target, key) { if (key === 'required') return true; throw new Error('boom ' + String(key)); } });
  const lm = fakeLm(['EDIT a.js\n<<<<<<< SEARCH\nmodule.exports = 1;\n=======\nmodule.exports = 2;\n>>>>>>> REPLACE\nRUN\nDONE ok', 'STUCK x']);
  const out = await run(r, lm, { behavior: broken, dependencies: { fetch: lm.fetch, freemem: () => 64 * 1024 ** 3, runVerify: async () => ({ ok: true, results: [{ name: 'types', ok: true }] }) } });
  assert.notEqual(out.state, 'completed');
  assert.match(lm.prompts[1], /DONE refused: BEHAVIOUR GATE ERROR/);
});

// 2026-11-24: guidance and findings used to be glued to the objective, which the worker cuts at 1800 characters:
// Qwen saw almost nothing of what Claude wrote (replays 7-9 were run with a guidance that was mostly invisible).
test('Claude guidance and findings are separate prompt sections and are NOT cut with a long objective', async () => {
  const r = repo();
  const lm = fakeLm(['STUCK x']);
  const guidance = '1. ROOT CAUSE: ' + 'g'.repeat(2500) + ' 6. KEY STATEMENTS: const sentSet = new Set(batch) TAILMARK-GUIDANCE';
  const findings = 'LOCAL VERIFICATION FAILED: ' + 'f'.repeat(1500) + ' TAILMARK-FINDINGS';
  await run(r, lm, { task: { title: 't', objective: 'o'.repeat(3000), findings, guidance, files: [] } });
  assert.match(lm.prompts[0], /FINDINGS TO FIX \(from the repository checks or the code review\):/);
  assert.match(lm.prompts[0], /TAILMARK-FINDINGS/);
  assert.match(lm.prompts[0], /GUIDANCE FROM CLAUDE \(your senior assistant\) - follow it exactly\. If it contains a test file/);
  assert.match(lm.prompts[0], /TAILMARK-GUIDANCE/, 'the end of the guidance (the key statements) reaches the model');
  assert.ok(lm.prompts[0].length <= LIMITS.promptChars + 400, 'the prompt stays inside the context budget');
});

test('when the prompt is too long, memory and old notes give way first: Claude guidance (with its test file) stays whole', async () => {
  const r = repo();
  const guidance = 'KEY ' + 'g'.repeat(5000) + ' TAILMARK-GUIDANCE-WHOLE';
  const findings = 'FINDINGS ' + 'f'.repeat(6800) + ' TAILMARK-FINDINGS';
  const notes = Array.from({ length: 8 }, (_, i) => 'NOTE ' + 'NOTE-' + i + ' ' + 'n'.repeat(250)).join('\n');
  const lm = fakeLm([notes + '\nREAD a.js', 'STUCK x']);
  await run(r, lm, { memoryText: 'MEMORY-BLOCK ' + 'm'.repeat(1700), task: { title: 't', objective: 'o'.repeat(1700), findings, guidance, files: [] } });
  const p = lm.prompts[1];
  assert.ok(p, 'a second turn happened');
  assert.match(p, /TAILMARK-GUIDANCE-WHOLE/, 'the end of the guidance is still there');
  assert.ok(p.length <= LIMITS.promptChars + 3500, 'inside the budget');
  assert.doesNotMatch(p, /MEMORY-BLOCK/, 'memory was sacrificed first');
  assert.doesNotMatch(p, /NOTE-0 /, 'the oldest notes were sacrificed too');
});
