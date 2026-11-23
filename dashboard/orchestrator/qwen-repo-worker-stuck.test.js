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
  assert.ok(v.includes('production'), 'a 6+ character value of a secret file is masked even if it is an ordinary word');
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
