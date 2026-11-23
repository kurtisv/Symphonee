'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');
const W = require('./qwen-repo-worker');
// A nested `node --test` inherits the runner's context and always exits 0: the repository checks must really run.
delete process.env.NODE_TEST_CONTEXT;

const PROFILE = { mode: 'text', minContext: 8192, wallSeconds: 30, reasoningEffort: 'none' };
const g = (cwd, ...a) => cp.execFileSync('git', ['-C', cwd, ...a], { encoding: 'utf8', stdio: 'pipe' });

function repo(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sym-qwen-repo-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  g(root, 'init', '-q'); g(root, 'config', 'user.email', 'f@example.invalid'); g(root, 'config', 'user.name', 'F');
  fs.mkdirSync(path.join(root, 'src')); fs.mkdirSync(path.join(root, 'secrets')); fs.mkdirSync(path.join(root, 'cfg'));
  fs.writeFileSync(path.join(root, 'src', 'add.js'), 'function add(a, b) {\n  return a - b;\n}\nmodule.exports = { add };\n');
  fs.writeFileSync(path.join(root, 'src', 'add.test.js'), "const test = require('node:test');\nconst assert = require('node:assert/strict');\nconst { add } = require('./add');\ntest('add', () => { assert.equal(add(2, 3), 5); });\n");
  fs.writeFileSync(path.join(root, 'secrets', 'key.txt'), 'TOP-SECRET-VALUE\n');
  fs.writeFileSync(path.join(root, '.env'), 'TOKEN=abc\n');
  g(root, 'add', '-A'); g(root, 'commit', '-qm', 'init');
  return { root, base: g(root, 'rev-parse', 'HEAD').trim() };
}
const VERIFY = [{ name: 'tests', cmd: [process.execPath, '--test', 'src/add.test.js'], timeoutMs: 60000 }];
const PROT = ['^secrets/', '(^|/)\\.env'];

function fakeLm(replies, seen = []) {
  const queue = replies.slice();
  return {
    seen,
    fetch: async (url, init) => {
      if (String(url).endsWith('/api/v0/models')) return { ok: true, json: async () => ({ data: [{ id: 'm', state: 'loaded', loaded_context_length: 8192 }] }) };
      const body = JSON.parse(init.body); seen.push(body.messages[0].content);
      const r = queue.shift(); if (r === undefined) throw new Error('no scripted reply left');
      if (r instanceof Error) throw r;
      return { ok: true, json: async () => ({ choices: [{ message: { content: r } }], usage: { prompt_tokens: 100, completion_tokens: 20 } }) };
    },
  };
}
const FIX = 'EDIT src/add.js\n<<<<<<< SEARCH\n  return a - b;\n=======\n  return a + b;\n>>>>>>> REPLACE\nRUN';
function opts(t, r, replies, over = {}) {
  const lm = fakeLm(replies);
  return { lm, o: { worktree: r.root, base: r.base, task: { title: 'Fix add', objective: 'add(2, 3) must return 5.', files: ['src/add.js'] }, verify: VERIFY, protectedPatterns: PROT, model: 'm', profile: PROFILE,
    sessionFile: path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sym-qwen-sess-')), 's.json'), dependencies: { fetch: lm.fetch, freemem: () => 8 * 1024 ** 3, sleep: async () => {} }, ...over } };
}

test('parser: strict actions, blocks, and everything else ignored', () => {
  const p = W.parseActions('thinking...\nLIST src\nREAD src/add.js 1-5\nGREP "add(" IN src\nEDIT a.js\n<<<<<<< SEARCH\nold\n=======\nnew\n>>>>>>> REPLACE\nCREATE n.js\n<<<<<<< CONTENT\nx\n>>>>>>> END\nRUN\nNOTE a fact\nPLAN step one\nSTEP-DONE 1\nrm -rf /\nDONE fixed');
  assert.deepEqual(p.actions.map((a) => a.type), ['list', 'read', 'grep', 'edit', 'create', 'run', 'note', 'plan', 'stepdone', 'done']);
  assert.deepEqual([p.actions[1].from, p.actions[1].to, p.actions[2].dir, p.actions[3].search, p.actions[3].replace], [1, 5, 'src', 'old', 'new']);
  assert.deepEqual(p.errors, []);
  assert.match(W.parseActions('EDIT a.js\nno block').errors[0], /must start on the next line/);
  assert.match(W.parseActions('EDIT a.js\n<<<<<<< SEARCH\nold\n=======\nnew').errors[0], /incomplete block/);
  assert.equal(W.parseActions('just prose').actions.length, 0);
});

test('confine: relative paths inside the tree only; .git, parent, absolute, protected and links refused', t => {
  const r = repo(t), prot = PROT.map((x) => new RegExp(x, 'i'));
  assert.equal(W.confine(r.root, 'src/add.js', prot).rel, 'src/add.js');
  for (const bad of ['../x', '/etc/passwd', 'C:/Windows/win.ini', '.git/config', 'src/../../x', 'secrets/key.txt', '.env', 'cfg/.env', '', 'a\0b']) assert.throws(() => W.confine(r.root, bad, prot), /Path refused/, bad);
  const link = path.join(r.root, 'src', 'lnk');
  try { fs.symlinkSync(os.tmpdir(), link, 'junction'); assert.throws(() => W.confine(r.root, 'src/lnk/x', prot), /symbolic link/); } catch (e) { if (e.code !== 'EPERM') throw e; }
});

test('a real fix: PLAN, READ, EDIT, RUN, DONE; the host verifies; only the edited file changed; nothing committed', async t => {
  const r = repo(t);
  const { lm, o } = opts(t, r, ['PLAN find the bug\nPLAN fix it\nLIST src\nREAD src/add.js', FIX, 'STEP-DONE 2\nDONE add now returns the sum']);
  const out = await W.runRepoWorker(o);
  assert.equal(out.state, 'completed'); assert.equal(out.verified.ok, true); assert.deepEqual(out.changed, ['src/add.js']);
  assert.match(fs.readFileSync(path.join(r.root, 'src', 'add.js'), 'utf8'), /return a \+ b;/);
  assert.equal(g(r.root, 'rev-parse', 'HEAD').trim(), r.base, 'nothing is committed by the worker');
  assert.match(lm.seen[1], /READ src\/add\.js lines 1-5 of 5|READ src\/add\.js lines 1-4 of 4/); assert.match(lm.seen[0], /No plan yet/); assert.match(lm.seen[1], /\[ \] find the bug/);
  assert.deepEqual([out.turns, out.usage.calls, out.usage.input], [3, 3, 300]);
});

test('DONE is never believed without a passing host verification', async t => {
  const r = repo(t);
  const { o } = opts(t, r, ['EDIT src/add.js\n<<<<<<< SEARCH\n  return a - b;\n=======\n  return a * b;\n>>>>>>> REPLACE\nDONE all good', 'STUCK cannot do it', 'STUCK cannot do it', 'STUCK cannot do it']);
  const out = await W.runRepoWorker(o);
  assert.equal(out.state, 'blocked'); assert.match(out.summary, /declared itself stuck/);
});

test('protected files can be neither read, listed nor changed, and a hostile instruction does nothing', async t => {
  const r = repo(t);
  const { lm, o } = opts(t, r, ['READ secrets/key.txt\nREAD .env\nEDIT .env\n<<<<<<< SEARCH\nTOKEN=abc\n=======\nTOKEN=x\n>>>>>>> REPLACE\nREAD ../../etc/hosts\nLIST secrets', 'STUCK nothing to do']);
  const out = await W.runRepoWorker(o);
  assert.doesNotMatch(lm.seen[1], /TOP-SECRET-VALUE|TOKEN=abc/);
  // 2026-11-22: a secret refusal now says so in plain words ("holds SECRETS"); every refusal still starts with "REFUSED: ".
  assert.equal((lm.seen[1].match(/REFUSED: /g) || []).length >= 4, true);
  assert.match(lm.seen[1], /REFUSED: secrets\/key\.txt holds SECRETS/); assert.match(lm.seen[1], /REFUSED: \.env holds SECRETS/);
  assert.equal(fs.readFileSync(path.join(r.root, '.env'), 'utf8'), 'TOKEN=abc\n'); assert.equal(out.state, 'blocked');
});

test('edits must match exactly once; ambiguous, missing and no-op replacements are explained to the model', async t => {
  const r = repo(t);
  fs.writeFileSync(path.join(r.root, 'src', 'dup.js'), 'x();\nx();\n'); g(r.root, 'add', '-A'); g(r.root, 'commit', '-qm', 'dup'); r.base = g(r.root, 'rev-parse', 'HEAD').trim();
  const E = (f, a, b) => `EDIT ${f}\n<<<<<<< SEARCH\n${a}\n=======\n${b}\n>>>>>>> REPLACE`;
  const { lm, o } = opts(t, r, [[E('src/dup.js', 'x();', 'y();'), E('src/add.js', 'nothing like this', 'z'), E('src/add.js', '  return a - b;', '  return a - b;'), E('src/nope.js', 'a', 'b')].join('\n'), 'CREATE src/add.js\n<<<<<<< CONTENT\nx\n>>>>>>> END', 'STUCK done testing'], { base: r.base });
  await W.runRepoWorker(o);
  const second = lm.seen[1];
  assert.match(second, /occurs 2 times/); assert.match(second, /was not found/); assert.match(second, /identical to the original/); assert.match(second, /no such file/); assert.match(lm.seen[2], /the file exists/);
  assert.equal(fs.readFileSync(path.join(r.root, 'src', 'dup.js'), 'utf8'), 'x();\nx();\n');
});

test('no progress: RUN repeated with no change is refused, then the task is handed back as blocked', async t => {
  const r = repo(t);
  const { o } = opts(t, r, ['RUN', 'RUN', 'RUN', 'RUN', 'RUN']);
  const out = await W.runRepoWorker(o);
  assert.equal(out.state, 'blocked'); assert.match(out.summary, /No progress: RUN repeated 3 times/);
});

test('the same failure three times forces a different strategy, which is recorded; success after the switch', async t => {
  const r = repo(t);
  const wrong = (n) => `EDIT src/add.js\n<<<<<<< SEARCH\n  return ${n};\n=======\n  return ${n + 1};\n>>>>>>> REPLACE\nRUN`;
  // start from a=b-style bug; three different wrong edits that fail the same way
  fs.writeFileSync(path.join(r.root, 'src', 'add.js'), 'function add(a, b) {\n  return 0;\n}\nmodule.exports = { add };\n'); g(r.root, 'add', '-A'); g(r.root, 'commit', '-qm', 'zero'); r.base = g(r.root, 'rev-parse', 'HEAD').trim();
  const { lm, o } = opts(t, r, [wrong(0), wrong(1), wrong(2), 'NOTE the first edits just count up; the cause is the operator\nEDIT src/add.js\n<<<<<<< SEARCH\n  return 3;\n=======\n  return a + b;\n>>>>>>> REPLACE\nRUN', 'DONE fixed with the operator'], { base: r.base });
  const out = await W.runRepoWorker(o);
  assert.equal(out.state, 'completed'); assert.equal(out.switches, 1);
  assert.match(lm.seen[3], /STRATEGY SWITCH REQUIRED \(1\/3\)/); assert.match(lm.seen[4], /APPROACHES ALREADY TRIED THAT FAILED/);
  assert.equal(out.strategies.length, 1);
});

test('a persistent failure after the allowed switches is handed back as blocked, never looped forever', async t => {
  const r = repo(t);
  let n = 0; const replies = [];
  for (let i = 0; i < 20; i++) replies.push(`EDIT src/add.js\n<<<<<<< SEARCH\n  return ${i === 0 ? 'a - b' : 'a - b + ' + (i - 1)};\n=======\n  return a - b + ${i};\n>>>>>>> REPLACE\nRUN`);
  const { o } = opts(t, r, replies);
  const out = await W.runRepoWorker(o);
  assert.equal(out.state, 'blocked'); assert.match(out.summary, /same failure persists after 3 changes of strategy/); assert.equal(out.switches, 4);
});

test('format drift: repeated answers outside the protocol stop the run', async t => {
  const r = repo(t);
  const { o } = opts(t, r, Array(8).fill('I will think about it and explain what to do in prose only.'));
  const out = await W.runRepoWorker(o);
  // 2026-11-22: prose is ignored instead of being a format error, so prose-only turns are counted as empty answers.
  assert.equal(out.state, 'blocked'); assert.match(out.summary, /outside the protocol|repeats the same actions|empty answers/);
});

test('resources and health: low RAM, unloaded model, unreachable server and the work slot pause the run with the progress saved', async t => {
  const r = repo(t);
  let a = opts(t, r, ['READ src/add.js'], { dependencies: { fetch: fakeLm([]).fetch, freemem: () => 100 * 1024 * 1024, sleep: async () => {} } });
  assert.match((await W.runRepoWorker(a.o)).summary, /Free RAM below/);
  a = opts(t, r, [], { dependencies: { fetch: async () => { throw new Error('ECONNREFUSED'); }, freemem: () => 8 * 1024 ** 3 } });
  const res = await W.runRepoWorker(a.o); assert.equal(res.state, 'interrupted'); assert.match(res.summary, /LM Studio unreachable/);
  a = opts(t, r, [], { dependencies: { fetch: async () => ({ ok: true, json: async () => ({ data: [{ id: 'other', state: 'loaded', loaded_context_length: 8192 }] }) }), freemem: () => 8 * 1024 ** 3 } });
  assert.match((await W.runRepoWorker(a.o)).summary, /is not loaded/);
  a = opts(t, r, ['READ src/add.js'], { deadlineAt: Date.now() - 1 });
  assert.match((await W.runRepoWorker(a.o)).summary, /Work slot ended/);
  const ac = new AbortController(); ac.abort(); a = opts(t, r, [], { signal: ac.signal });
  assert.equal((await W.runRepoWorker(a.o)).state, 'interrupted');
});

test('resumability: after an interruption the plan, notes, changes and failures are restored and the work continues', async t => {
  const r = repo(t);
  const first = opts(t, r, ['PLAN find it\nNOTE operator is minus\nREAD src/add.js', new Error('socket hang up')]);
  const one = await W.runRepoWorker(first.o);
  assert.equal(one.state, 'interrupted'); assert.equal(one.turns, 1); assert.deepEqual(one.notes, ['operator is minus']);
  const second = opts(t, r, [FIX, 'DONE fixed'], { sessionFile: first.o.sessionFile });
  const two = await W.runRepoWorker(second.o);
  assert.equal(two.state, 'completed'); assert.match(second.lm.seen[0], /YOUR NOTES:\n- operator is minus/); assert.match(second.lm.seen[0], /\[ \] find it/); assert.equal(two.turns, 3);
});

test('a protected path touched through the repository scripts is reverted', async t => {
  const r = repo(t);
  const verify = [{ name: 'tests', cmd: [process.execPath, '-e', "require('fs').writeFileSync('secrets/key.txt','HACKED')"], timeoutMs: 20000 }];
  const { lm, o } = opts(t, r, [FIX, 'STUCK enough'], { verify });
  await W.runRepoWorker(o);
  assert.equal(fs.readFileSync(path.join(r.root, 'secrets', 'key.txt'), 'utf8').replace(/\r\n/g, '\n'), 'TOP-SECRET-VALUE\n');
  assert.match(lm.seen[1], /changes to protected path\(s\) were reverted: secrets\/key\.txt/);
});

test('the prompt stays within the context budget whatever the observations', async t => {
  const r = repo(t); fs.writeFileSync(path.join(r.root, 'src', 'big.js'), ('// line of text that fills the file\n').repeat(2000)); g(r.root, 'add', '-A'); g(r.root, 'commit', '-qm', 'big'); r.base = g(r.root, 'rev-parse', 'HEAD').trim();
  const { lm, o } = opts(t, r, ['READ src/big.js\nGREP line IN src\nLIST .', 'READ src/big.js 100-2000', 'STUCK x'], { base: r.base });
  await W.runRepoWorker(o);
  assert.ok(lm.seen.every((p) => p.length <= W.LIMITS.promptChars + 400), lm.seen.map((p) => p.length).join());
  assert.match(lm.seen[1], /cut at 5000 characters/);
});

test('identical turns with identical results are warned about, then the task is handed back as blocked', async t => {
  const r = repo(t);
  const { lm, o } = opts(t, r, Array(12).fill('READ src/add.js'));
  const out = await W.runRepoWorker(o);
  assert.equal(out.state, 'blocked'); assert.match(out.summary, /repeats the same actions with the same results/);
  assert.ok(lm.seen.some((p) => /YOU ARE REPEATING THE SAME ACTIONS/.test(p)));
  assert.ok(out.log.length >= 8 && /^read src\/add\.js/.test(out.log[0].acts), 'every turn is logged for diagnosis');
});

test('exploring without ever changing anything is called out, then handed back, even when each turn looks different', async t => {
  const r = repo(t);
  const replies = []; for (let i = 0; i < 40; i++) replies.push('NOTE observation number ' + i + '\nGREP add IN src\nLIST src');
  const { lm, o } = opts(t, r, replies);
  const out = await W.runRepoWorker(o);
  assert.equal(out.state, 'blocked'); assert.match(out.summary, /No change to the repository after 26 turns/);
  assert.ok(lm.seen.some((p) => /CHANGED NOTHING/.test(p)), 'warned once at 12 turns');
});

test('memory pressure that passes is waited out; memory pressure that stays pauses the run with progress saved', async t => {
  const r = repo(t);
  let free = 100 * 1024 * 1024, slept = 0;
  const lm = fakeLm([FIX, 'DONE ok']);
  const o = { ...opts(t, r, []).o, dependencies: { fetch: lm.fetch, freemem: () => free, sleep: async () => { slept++; if (slept === 3) free = 8 * 1024 ** 3; } } };
  const out = await W.runRepoWorker(o);
  assert.equal(out.state, 'completed'); assert.equal(slept, 3, 'waited three polls, then went on');
  const low = { ...opts(t, r, []).o, dependencies: { fetch: fakeLm([]).fetch, freemem: () => 100 * 1024 * 1024, sleep: async () => {} } };
  const res = await W.runRepoWorker(low);
  assert.equal(res.state, 'interrupted'); assert.match(res.summary, /Free RAM below 1536 MB for 180 s/);
});

test('the protocol carries worked examples that the host parser accepts, and a read-only model is told to write the change', async t => {
  assert.match(W.PROTOCOL, /Worked examples/);
  const ex = W.parseActions(W.PROTOCOL.slice(W.PROTOCOL.indexOf('Worked examples')));
  assert.deepEqual(ex.actions.filter((a) => a.type === 'create' || a.type === 'edit').map((a) => a.type), ['create', 'edit']); assert.deepEqual(ex.errors, []);
  const r = repo(t);
  const { lm, o } = opts(t, r, ['READ src/add.js', 'READ src/add.js', 'STUCK x']);
  await W.runRepoWorker(o);
  assert.doesNotMatch(lm.seen[0], /NEXT STEP/); assert.match(lm.seen[1], /NEXT STEP: you have read what you need\. Do NOT read again and do NOT say DONE yet: write the change now/);
});

test('an A,B,A,B cycle (read, say DONE, read, say DONE ...) is detected as repetition and DONE-without-change is explained in the results', async t => {
  const r = repo(t);
  const replies = []; for (let i = 0; i < 40; i++) replies.push(i % 2 ? 'DONE finished' : 'READ src/add.js');
  const { lm, o } = opts(t, r, replies);
  const out = await W.runRepoWorker(o);
  assert.equal(out.state, 'blocked'); assert.match(out.summary, /repeats the same actions|No change to the repository/);
  assert.ok(lm.seen.some((p) => /DONE refused: nothing was changed yet\. Write the change with an EDIT or CREATE block/.test(p)));
  assert.ok(lm.seen.some((p) => /YOU ARE REPEATING THE SAME ACTIONS/.test(p)));
});

test('a file the model created may be rewritten whole; any other existing file may not', async t => {
  const r = repo(t);
  const mk = (body) => `CREATE src/new.test.js\n<<<<<<< CONTENT\n${body}\n>>>>>>> END`;
  const { lm, o } = opts(t, r, [mk('first') + '\nCREATE src/add.js\n<<<<<<< CONTENT\nx\n>>>>>>> END', mk('second'), 'STUCK enough']);
  await W.runRepoWorker(o);
  assert.match(lm.seen[1], /CREATE src\/add\.js: the file exists \(use EDIT\)/);
  assert.equal(fs.readFileSync(path.join(r.root, 'src', 'new.test.js'), 'utf8').trim(), 'second');
  assert.match(lm.seen[2], /rewritten \(it is a file you created\)/);
  assert.match(fs.readFileSync(path.join(r.root, 'src', 'add.js'), 'utf8'), /return a - b/, 'the original file is untouched');
});

test('giving up after a single failure is refused twice with an explanation, then accepted', async t => {
  const r = repo(t);
  const bad = 'CREATE src/x.test.js\n<<<<<<< CONTENT\nthrow new Error("boom");\n>>>>>>> END\nRUN';
  const verify = [{ name: 'tests', cmd: [process.execPath, '--test', 'src/x.test.js'], timeoutMs: 60000 }];
  const { lm, o } = opts(t, r, [bad, 'STUCK it fails', 'STUCK it still fails', 'STUCK I give up'], { verify });
  const out = await W.runRepoWorker(o);
  assert.equal(out.state, 'blocked'); assert.match(out.summary, /declared itself stuck: I give up/); assert.equal(out.turns, 4);
  assert.match(lm.seen[2], /STUCK refused \(1\/2\): you have tried only 1 time\(s\)/); assert.match(lm.seen[3], /STUCK refused \(2\/2\)/);
});
