'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const B = require('./autopilot-backlog');
const guard = require('./autopilot-verify');
const kit = require('./qwen-repo-test-kit');

const plan = (o = {}) => ({ decision: 'TASK', category: 'correctness', title: 'Fix the stuck resume of the video loop', objective: 'The loop resumes the same task forever after restart', severity: 'stuck-loop', proof: 'reproduced', evidence: ['loop.js:42 resumes the same task after restart (reproduced twice)'], acceptance: ['a'], ...o });
const H = (title, outcome, extra = {}) => ({ title, outcome, at: '2026-11-14T10:00:00Z', reviewerEvidence: 'diagnosis for ' + title, ...extra });
function gateFile(t, state) { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'sym-bl-')); t.after(() => fs.rmSync(d, { recursive: true, force: true })); const f = path.join(d, 'state.json'); fs.writeFileSync(f, JSON.stringify(state)); return f; }

test('similarity: same task in other words is similar, unrelated work is not', () => {
  assert.ok(B.similarity('Fix 60.0s duration rollover in video-use pack.js', 'Fix the 1m 60.0s duration rollover in pack.js video-use') >= B.SIMILAR);
  assert.ok(B.similarity('Fix duration rollover in pack.js', 'Harden MCP plugin tool query parameters') < 0.2);
});

test('a task that failed three times is BLOCKED with its diagnosis; one that later completed is not; two attempts are not enough', () => {
  const h = [H('Fix 60.0s duration rollover in video-use pack.js', 'interrupted'), H('Fix the 1m 60.0s duration rollover in pack.js video-use', 'verify-failed'), H('Fix duration rollover 60.0s pack.js video-use', 'interrupted'),
    H('Harden transcript normalizers', 'review-rejected'), H('Harden transcript normalizers null payloads', 'interrupted'), H('(interrupted)', 'interrupted')];
  const b = B.blockedTasks(h);
  assert.equal(b.length, 1); assert.equal(b[0].attempts, 3); assert.deepEqual(b[0].outcomes.sort(), ['interrupted', 'verify-failed']); assert.match(b[0].diagnosis, /diagnosis for/);
  assert.equal(B.blockedTasks([...h, H('Fix 60.0s duration rollover in video-use pack.js', 'completed')]).length, 0, 'solved: no longer blocked');
});

test('backlog signals come from REAL data, ordered by priority class: stopped gate, refused candidates, repeated tasks', (t) => {
  const gate = gateFile(t, { stopped: { at: 1, reason: 'CI rouge apres fusion' }, merges: [{ status: 'failed-after-merge', key: 'k', pr: 9 }],
    candidates: { a: { repo: 'Symphonee', key: 'a', branch: 'mind-autopilot/x', status: 'refused', origin: { title: 'Fix X' }, history: [{ status: 'refused', note: 'tests rouges sur la fusion' }] }, b: { repo: 'Other', key: 'b', status: 'refused', origin: { title: 'not mine' }, history: [] } } });
  const s = B.collectBacklog({ history: [H('Same task', 'interrupted'), H('Same task again', 'interrupted')], gatePath: gate, repoName: 'Symphonee', error: 'pilot halted', events: [{ kind: 'error', at: new Date().toISOString(), msg: 'engine boom' }] });
  assert.deepEqual(s.map((x) => x.class), [...s.map((x) => x.class)].sort(), 'most serious first');
  assert.equal(s[0].class, 1); assert.ok(s.some((x) => /STOPPED/.test(x.text))); assert.ok(s.some((x) => /refused by the merge gate/.test(x.text) && /tests rouges/.test(x.evidence)));
  assert.ok(!s.some((x) => /not mine/.test(x.text)), 'another repository is ignored'); assert.ok(s.some((x) => x.class === 2 && /repeated/i.test(x.text)));
  assert.deepEqual(B.collectBacklog({ history: [], gatePath: '/nonexistent/file.json' }), [], 'no data, no invented signal');
});

test('admission: duplicate of done, queued, in-flight and branch work is refused; blocked needs newEvidence; weak justification is refused', (t) => {
  const gate = gateFile(t, { candidates: { c: { repo: 'Symphonee', key: 'c', source: 'autopilot', branch: 'mind-autopilot/x', status: 'pr-open', pr: 12, origin: { pilot: 'default', title: 'Fix the stuck resume of the video loop' } } }, merges: [] });
  const base = { history: [H('Add tests for plugin hints generator', 'completed')], queue: [{ plan: plan({ title: 'Reject inherited prototype ids in the EDL validator' }) }], gatePath: gate, repoName: 'Symphonee', pilotId: 'default', branches: ['remotes/origin/mind-autopilot/2026-11-15-normalize-host-ports-site-recipes'], opts: { strict: true } };
  base.signals = [{ text: 'Task repeated without success: stuck resume of the video loop' }];
  assert.equal(B.admit(plan({ title: 'Fix the stuck resume of the video loop' }), base).code, 'duplicate', 'in flight (PR open)');
  assert.equal(B.admit(plan({ title: 'Add tests for the plugin hints generator', objective: 'x' }), base).code, 'duplicate', 'done');
  assert.equal(B.admit(plan({ title: 'Reject inherited prototype ids in the EDL validator' }), base).code, 'duplicate', 'queued');
  assert.equal(B.admit(plan({ title: 'Normalize host ports in site recipes' }), base).code, 'duplicate', 'a branch exists');
  const blocked = { ...base, gatePath: null, history: [H('Fix durations in the exporter module', 'interrupted'), H('Fix durations exporter module', 'verify-failed'), H('Fix exporter durations module', 'interrupted')], queue: [], branches: [] };
  assert.equal(B.admit(plan({ title: 'Fix durations in exporter module' }), blocked).code, 'blocked');
  assert.equal(B.admit(plan({ title: 'Fix durations in exporter module', newEvidence: 'The failing test now reproduces with the new fixture in test 14' }), blocked).ok, true, 'a new element reopens it');
  const free = { ...base, gatePath: null, history: [], queue: [], branches: [] };
  assert.equal(B.admit(plan({ category: 'cleanup', severity: 'other', proof: 'read-in-code', title: 'Remove an old helper', objective: 'unused' }), free).code, 'unjustified', 'cleanup needs cleanup-proven');
  assert.equal(B.admit(plan({ proof: 'inferred', title: 'Rename variables in the card renderer', objective: 'clarity', severity: 'other' }), free).code, 'unjustified', 'inferred and no signal');
  assert.equal(B.admit(plan({ proof: 'inferred', title: 'Fix the stuck resume of the video loop' }), { ...free, signals: base.signals }).ok, true, 'inferred but matches a real signal');
  assert.equal(B.admit({ decision: 'NO_TASK' }, free).ok, true);
});

test('engine protections: every protected area is matched, ordinary files are not, and every pattern compiles', () => {
  const re = guard.compilePatterns([...B.ENGINE_PROTECTED]);
  const hit = (p) => re.some((r) => r.test(p));
  for (const p of ['dashboard/permissions.js', 'dashboard/automation/merge-gate.js', 'scripts/merge-gate.js', 'dashboard/mind/autopilot.js', 'dashboard/mind/autopilot-verify.js', 'dashboard/mind/autopilot-backlog.js', 'dashboard/mind/lessons.js',
    'dashboard/mind/lesson-applicability.js', 'dashboard/mind/qwen-repo-test-kit.js', 'dashboard/orchestrator/qwen-repo-worker.js', 'config/merge-gate.json', '.symphonee/mind-autopilots.json', 'AGENTS.md', 'FUSION_AUTOMATIQUE.md', '.github/workflows/x.yml'])
    assert.equal(hit(p), true, p + ' must be protected');
  for (const p of ['dashboard/plugins/video-use/pack.js', 'dashboard/lib/plugin-hints.js', 'dashboard/public/app.js', 'dashboard/mind/graph.js', 'scripts/Show-Diff.ps1'])
    assert.equal(hit(p), false, p + ' must stay editable');
});

test('a pilot with selfProtect gets the engine protections by CODE, whatever its definition says; the backlog is on only when asked', () => {
  const f = kit.setup();
  try {
    f.pilot.applyDefinition({ ...f.pilot.def, protectedPaths: ['^custom/'], selfProtect: true, backlog: { strict: true } });
    for (const p of ['^custom/', ...B.ENGINE_PROTECTED]) assert.ok(f.pilot.def.protectedPaths.includes(p), p);
    assert.equal(f.pilot.def.backlog.strict, true); assert.equal(f.pilot.def.selfProtect, true);
    f.pilot.applyDefinition({ ...f.pilot.def, protectedPaths: [], selfProtect: false, backlog: null });
    assert.deepEqual(f.pilot.def.protectedPaths, []); assert.equal(f.pilot.def.backlog, null);
    assert.equal(f.pilot.backlogText(), '', 'no backlog text for a pilot without it');
  } finally { f.cleanup(); }
});

test('engine admission in the pilot: duplicate and blocked plans are refused and COUNTED; the discovery prompt lists signals and blocked tasks', () => {
  const f = kit.setup();
  try {
    f.pilot.applyDefinition({ ...f.pilot.def, backlog: { strict: true } });
    f.pilot.state.history = [H('Fix durations in the exporter module', 'interrupted'), H('Fix durations exporter module', 'verify-failed'), H('Fix exporter durations module', 'interrupted'), H('Already merged price fix', 'completed')];
    assert.equal(f.pilot.admission(plan({ title: 'Already merged price fix', objective: 'again' })).code, 'duplicate');
    assert.equal(f.pilot.admission(plan({ title: 'Fix durations in exporter module' })).code, 'blocked');
    const m = f.pilot.metricsView(); assert.equal(m.refusedAtAdmission, 2); assert.equal(m.duplicatesPrevented, 1); assert.equal(m.repeatsPrevented, 1); assert.equal(m.blocked, 1); assert.equal(m.resolved, 1);
    f.pilot.enqueue([plan({ title: 'Already merged price fix', objective: 'again' })]);
    assert.equal(f.pilot.state.queue.length, 0, 'a duplicate never enters the queue');
    f.pilot.state.active = { stage: 'discover', plan: null, localSignals: {} };
    const p = f.pilot.discoveryPrompt();
    assert.match(p, /CONCRETE BACKLOG/); assert.match(p, /A TODO comment, a large file, or the absence of a neighbouring test is NOT a justification/); assert.match(p, /BLOCKED \(kept with their diagnosis/); assert.match(p, /Fix durations in the exporter module/);
  } finally { f.cleanup(); }
});

test('restart reconciliation: an active task whose worktree is gone is archived, not resumed into nothing', () => {
  const f = kit.setup();
  try {
    f.pilot.applyDefinition({ ...f.pilot.def, backlog: { strict: true } }); f.pilot.state.enabled = true;
    f.pilot.state.active = { stage: 'implement', plan: plan(), worktree: { path: path.join(os.tmpdir(), 'sym-gone-' + Date.now()), branch: 'mind-autopilot/gone' }, planRevisions: 0 };
    f.pilot.recoverAfterRestart();
    assert.equal(f.pilot.state.active, null); assert.equal(f.pilot.state.history.at(-1).outcome, 'interrupted'); assert.equal(f.pilot.metricsView().reconciled, 1);
  } finally { f.cleanup(); }
});

test('review round 1: orchestrator and isolation helpers are protected, custom patterns cannot truncate the engine ones', () => {
  const re = guard.compilePatterns([...B.ENGINE_PROTECTED]);
  for (const p of ['dashboard/orchestrator/cli-config.js', 'dashboard/orchestrator/local-providers.js', 'dashboard/orchestrator/spawn-headless.js', 'dashboard/orchestrator.js', 'dashboard/mind/security.js', 'dashboard/mind/lock.js'])
    assert.ok(re.some((r) => r.test(p)), p);
  const f = kit.setup();
  try {
    f.pilot.applyDefinition({ ...f.pilot.def, selfProtect: true, protectedPaths: Array.from({ length: 80 }, (_, i) => '^custom' + i + '/') });
    for (const p of B.ENGINE_PROTECTED) assert.ok(f.pilot.def.protectedPaths.includes(p), 'kept: ' + p);
    assert.ok(f.pilot.def.protectedPaths.includes('^custom79/'));
  } finally { f.cleanup(); }
});

test('review round 1: weak evidence is refused whatever proof is claimed; new evidence must really be new; a task retried too often needs a human', () => {
  const free = { history: [], queue: [], gatePath: null, branches: [], signals: [], opts: { strict: true, maxAttempts: 3 } };
  assert.equal(B.admit(plan({ proof: 'reproduced', evidence: ['TODO: handle the empty case in pack.js', 'pack.js is 1200 lines long'] }), free).code, 'unjustified');
  assert.equal(B.admit(plan({ proof: 'read-in-code', evidence: ['there is no neighbouring test for pack.js'] }), free).code, 'unjustified');
  assert.equal(B.admit(plan({ proof: 'reproduced', evidence: ['pack.js:42 returns 1m 60.0s for 119.97s (reproduced with node -e)'] }), free).ok, true, 'a real observation passes');
  const fails = (n) => Array.from({ length: n }, (_, i) => H('Fix durations in the exporter module ' + (i % 2 ? 'again' : 'now'), 'verify-failed', { reviewerEvidence: 'the exporter test 14 still fails with a rounding error', newEvidence: i === 3 ? 'The fixture in test 14 now reproduces the rounding error on Windows only' : null }));
  const ctx3 = { ...free, history: fails(3) };
  const p = plan({ title: 'Fix durations in the exporter module' });
  assert.equal(B.admit({ ...p, newEvidence: 'the exporter test 14 still fails with a rounding error' }, ctx3).code, 'blocked', 'repeats what was already known');
  assert.equal(B.admit({ ...p, newEvidence: 'A Windows-only code path in formatDuration uses toFixed differently' }, ctx3).ok, true);
  assert.equal(B.admit({ ...p, newEvidence: 'A Windows-only code path in formatDuration uses toFixed differently' }, { ...free, history: fails(6) }).code, 'blocked', 'six attempts: human decision');
});

test('review round 1: an unreadable gate state fails closed, a missing one does not; stale branches do not count', (t) => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'sym-bl2-')); t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  const bad = path.join(d, 'state.json'); fs.writeFileSync(bad, '{ not json');
  const base = { history: [], queue: [], branches: [], signals: [], opts: { strict: true } };
  assert.equal(B.admit(plan(), { ...base, gatePath: bad }).code, 'unverifiable');
  assert.equal(B.admit(plan(), { ...base, gatePath: path.join(d, 'absent.json') }).ok, true, 'no gate yet is not an error');
  assert.equal(B.admit(plan({ title: 'Fix login timeout on the admin API', objective: 'x' }), { ...base, gatePath: null, branches: ['origin/mind-autopilot/fix-login'] }).ok, true, 'a short slug is not enough to call it a duplicate');
});

test('review round 1: a queued task that became a duplicate while it waited never starts; reconciliation is opt-in', () => {
  const f = kit.setup();
  try {
    f.pilot.applyDefinition({ ...f.pilot.def, backlog: { strict: true } });
    f.pilot.state.repoPath = f.repo; f.pilot.state.active = { stage: 'discover', plan: null };
    f.pilot.state.queue = [{ key: 'k1', plan: plan({ title: 'Reject inherited prototype ids in the EDL validator' }), score: 1, baseSha: null, discoveredAt: new Date().toISOString() }];
    f.pilot.state.history = [H('Reject inherited prototype ids in the EDL validator', 'completed', { key: 'other-key' })];
    f.pilot.dispatch = () => { throw new Error('must not start'); };
    assert.equal(f.pilot.popQueued(Date.now(), true), false); assert.equal(f.pilot.state.queue.length, 0);
    assert.equal(f.pilot.metricsView().duplicatesPrevented, 1);
    // a pilot WITHOUT the backlog keeps the previous behaviour for a missing worktree
    f.pilot.applyDefinition({ ...f.pilot.def, backlog: null });
    f.pilot.state.enabled = true; f.pilot.state.active = { stage: 'implement', plan: plan(), worktree: { path: path.join(os.tmpdir(), 'sym-gone2-' + Date.now()) }, planRevisions: 0 };
    let archived = false; const c = f.pilot.complete; f.pilot.complete = (o) => { if (o === 'interrupted') archived = true; return c.call(f.pilot, o); };
    try { f.pilot.recoverAfterRestart(); } catch (_) { /* old path may need more state */ }
    assert.equal(archived, false, 'not archived by the new reconciliation');
  } finally { f.cleanup(); }
});

const cp = require('node:child_process');
const sh = (cwd, ...a) => cp.execFileSync('git', ['-C', cwd, ...a], { encoding: 'utf8' }).trim();

test('review round 2: a protected file renamed out of its folder is still a protected hit (real git rename)', (t) => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'sym-rn-')); t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  sh(d, 'init', '-q'); sh(d, 'config', 'user.email', 'a@b.invalid'); sh(d, 'config', 'user.name', 'a');
  fs.mkdirSync(path.join(d, 'dashboard/mind'), { recursive: true });
  fs.writeFileSync(path.join(d, 'dashboard/mind/lessons.js'), 'module.exports = { certify() { return 1 + 1 + 1 + 1; } };\n'.repeat(5)); sh(d, 'add', '-A'); sh(d, 'commit', '-qm', 'base');
  const base = sh(d, 'rev-parse', 'HEAD');
  fs.mkdirSync(path.join(d, 'dashboard/lib'), { recursive: true }); sh(d, 'mv', 'dashboard/mind/lessons.js', 'dashboard/lib/renamed.js');
  const hits = guard.protectedHits(guard.changedPaths(d, base), [...B.ENGINE_PROTECTED]);
  assert.deepEqual(hits, ['dashboard/mind/lessons.js'], 'the OLD protected path is reported');
});

test('review round 2: a change to a permission call site is a lint finding for a selfProtect pilot only', (t) => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'sym-lint-')); t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  sh(d, 'init', '-q'); sh(d, 'config', 'user.email', 'a@b.invalid'); sh(d, 'config', 'user.name', 'a');
  fs.writeFileSync(path.join(d, 'app.js'), 'function handle(req) {\n  if (!permGate(req)) return 403;\n  return 200;\n}\n'); sh(d, 'add', '-A'); sh(d, 'commit', '-qm', 'base');
  const base = sh(d, 'rev-parse', 'HEAD');
  fs.writeFileSync(path.join(d, 'app.js'), 'function handle(req) {\n  return 200;\n}\n');
  assert.ok(guard.diffLint(d, base, { selfProtect: true }).some((x) => /permission or approval call site/.test(x)), 'removing the gate call is caught');
  assert.deepEqual(guard.diffLint(d, base), [], 'other pilots are unchanged');
});

test('review round 2: gate state with the wrong shape fails closed; a plan rejected before needs a new element; observations, not keywords; short branch slugs do not block', (t) => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'sym-bl3-')); t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  const base = { history: [], queue: [], branches: [], signals: [], opts: { strict: true } };
  for (const body of ['null', '[]', '{}', '{"candidates":[]}']) { const f = path.join(d, 's.json'); fs.writeFileSync(f, body); assert.equal(B.admit(plan(), { ...base, gatePath: f }).code, 'unverifiable', body); }
  const ok = path.join(d, 'ok.json'); fs.writeFileSync(ok, '{"candidates":{},"merges":[]}'); assert.equal(B.admit(plan(), { ...base, gatePath: ok }).ok, true);
  assert.ok(B.collectBacklog({ history: [], gatePath: path.join(d, 's.json') }).some((x) => x.class === 1 && /unreadable/.test(x.text)));
  const rej = { ...base, rejected: [{ title: 'Fix the stuck resume of the video loop', evidence: 'the reviewer could not reproduce the failure on the base' }] };
  assert.equal(B.admit(plan(), rej).code, 'blocked'); assert.equal(B.admit(plan({ newEvidence: 'the reviewer could not reproduce the failure on the base' }), rej).code, 'blocked');
  assert.equal(B.admit(plan({ newEvidence: 'a new failing test in resume.test.js now reproduces it deterministically' }), rej).ok, true);
  assert.equal(B.admit(plan({ proof: 'read-in-code', evidence: ['pack.js has 900 lines', 'refactor it for readability'] }), base).code, 'unjustified');
  assert.equal(B.admit(plan({ proof: 'read-in-code', category: 'testing', evidence: ['TODO at module.js:42: missing unit tests'] }), base).code, 'unjustified', 'a located TODO is still a TODO');
  assert.equal(B.admit(plan({ proof: 'reproduced', evidence: ['pack.js:42 throws TypeError for an empty list'] }), base).ok, true, 'a real observation passes');
  assert.equal(B.admit(plan({ title: 'Normalize user email templates', objective: 'x' }), { ...base, branches: ['origin/mind-autopilot/2026-11-15-normalize-user-email-addresses'] }).ok, true, 'three of four slug words are not the same task');
  assert.equal(B.admit(plan({ title: 'Fix plugin tests for the video plugin', objective: 'x' }), { ...base, branches: ['origin/mind-autopilot/2026-11-15-fix-plugin-tests'] }).code, 'duplicate', 'the whole slug is covered');
  const two = { ...base, rejected: [{ title: 'Fix the stuck resume of the video loop', evidence: 'first finding about the resume timer' }, { title: 'Fix the stuck resume of the video loop', evidence: 'second finding: the checkpoint file is read before it is written' }] };
  assert.equal(B.admit(plan({ newEvidence: 'second finding: the checkpoint file is read before it is written' }), two).code, 'blocked', 'novelty is checked against EVERY earlier rejection');
  const dirty = path.join(d, 'dirty.json'); fs.writeFileSync(dirty, JSON.stringify({ candidates: { x: null, y: { repo: 'R', status: 'refused', history: 5 } }, stopped: { at: 'never' }, merges: [null] }));
  assert.doesNotThrow(() => B.collectBacklog({ history: [], gatePath: dirty, repoName: 'R' })); assert.doesNotThrow(() => B.admit(plan(), { ...base, gatePath: dirty }));
  assert.equal(B.admit(plan(), { ...base, gatePath: dirty }).code, 'unverifiable', 'a damaged candidate entry fails closed');
  for (const bad of [{}, [], { status: 'pr-open', branch: 'b' }, { repo: 'R', status: 5, branch: 'b' }, { repo: 'R', source: 'autopilot', status: 'pr-open', branch: 'mind-autopilot/fix-resume', origin: { pilot: 'default' } }, { repo: 'R', status: 'pr-open', branch: 'mind-autopilot/fix-resume', origin: { pilot: 'default' } }]) { fs.writeFileSync(dirty, JSON.stringify({ candidates: { x: bad }, merges: [] })); assert.equal(B.admit(plan(), { ...base, gatePath: dirty, repoName: 'R' }).code, 'unverifiable', JSON.stringify(bad)); }
  fs.writeFileSync(dirty, JSON.stringify({ candidates: {}, stopped: { at: 1e20, reason: 'x' }, merges: [] })); assert.doesNotThrow(() => B.collectBacklog({ history: [], gatePath: dirty }));
  const fails3 = ['a', 'b', 'c'].map((x) => H('Fix durations in the exporter module ' + x, 'verify-failed'));
  assert.equal(B.admit(plan({ title: 'Fix durations in the exporter module', newEvidence: 'the checkpoint file is read before it is written (seen in resume.js)' }), { ...base, history: fails3, rejected: [{ title: 'Fix durations in the exporter module', evidence: 'the checkpoint file is read before it is written (seen in resume.js)' }] }).code, 'blocked', 'a blocked task must not reuse a rejected finding as new evidence');
  assert.equal(B.collectBacklog({ history: [H('A single interrupted task', 'interrupted')] }).some((x) => /ended without success/.test(x.text)), true, 'one interruption is already a signal');
});

test('review round 2: the extended severity classes are in the discovery contract only for a pilot that opted in; a rejected plan is remembered even when the revision finds no task', () => {
  const f = kit.setup();
  try {
    f.pilot.state.repoPath = f.repo; f.pilot.state.active = { stage: 'discover', plan: null, localSignals: {} };
    assert.doesNotMatch(f.pilot.discoveryPrompt(), /stuck-loop/, 'unchanged for other pilots');
    assert.match(f.pilot.discoveryPrompt(), /"severity":"data-loss\|crash\|security\|wrong-price\|broken-flow\|measured-slowness\|other"/);
    f.pilot.applyDefinition({ ...f.pilot.def, backlog: { strict: true } });
    assert.match(f.pilot.discoveryPrompt(), /"severity":"data-loss\|crash\|security\|wrong-price\|broken-flow\|measured-slowness\|lost-work\|stuck-loop\|wrong-state\|cleanup-proven\|other"/);
  } finally { f.cleanup(); }
});

test('review round 3: a file that hosts a permission call site cannot be changed by a selfProtect pilot, even on another line', (t) => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'sym-host-')); t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  sh(d, 'init', '-q'); sh(d, 'config', 'user.email', 'a@b.invalid'); sh(d, 'config', 'user.name', 'a');
  fs.writeFileSync(path.join(d, 'agent.js'), 'const ok = permGate(req);\nif (!ok) return;\nlaunch();\n'); fs.writeFileSync(path.join(d, 'plain.js'), 'exports.a = 1;\n'); sh(d, 'add', '-A'); sh(d, 'commit', '-qm', 'base');
  const base = sh(d, 'rev-parse', 'HEAD');
  fs.writeFileSync(path.join(d, 'agent.js'), 'const ok = permGate(req);\nlaunch();\n');
  assert.ok(guard.diffLint(d, base, { selfProtect: true }).some((x) => /agent\.js: hosts a permission/.test(x)), 'removing the line that enforces the result is caught');
  fs.writeFileSync(path.join(d, 'agent.js'), 'const ok = permGate(req);\nif (!ok) return;\nlaunch();\n'); fs.writeFileSync(path.join(d, 'plain.js'), 'exports.a = 2;\n');
  assert.deepEqual(guard.diffLint(d, base, { selfProtect: true }), [], 'an ordinary file is free');
});

test('review round 5: paths with non-ASCII names are matched as written, not as Git-quoted strings', (t) => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'sym-utf-')); t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  sh(d, 'init', '-q'); sh(d, 'config', 'user.email', 'a@b.invalid'); sh(d, 'config', 'user.name', 'a');
  fs.mkdirSync(path.join(d, 'dashboard'), { recursive: true });
  fs.writeFileSync(path.join(d, 'dashboard/s\u00e9curit\u00e9.js'), 'const ok = permGate(req);\nif (!ok) return;\n'); sh(d, 'add', '-A'); sh(d, 'commit', '-qm', 'base');
  const base = sh(d, 'rev-parse', 'HEAD');
  fs.writeFileSync(path.join(d, 'dashboard/s\u00e9curit\u00e9.js'), 'const ok = permGate(req);\n');
  assert.deepEqual(guard.changedPaths(d, base), ['dashboard/s\u00e9curit\u00e9.js'], 'raw name, no quotes');
  assert.ok(guard.diffLint(d, base, { selfProtect: true }).some((x) => /hosts a permission/.test(x)));
});

test('review round 6: names with tabs or quotes are matched as written (git -z), not as Git-quoted strings', (t) => {
  if (process.platform === 'win32') return t.skip('such file names do not exist on Windows');
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'sym-tab-')); t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  sh(d, 'init', '-q'); sh(d, 'config', 'user.email', 'a@b.invalid'); sh(d, 'config', 'user.name', 'a');
  const name = 'agent\t"x".js'; fs.writeFileSync(path.join(d, name), 'const ok = permGate(req);\nif (!ok) return;\n'); sh(d, 'add', '-A'); sh(d, 'commit', '-qm', 'base');
  const base = sh(d, 'rev-parse', 'HEAD'); fs.writeFileSync(path.join(d, name), 'const ok = permGate(req);\n');
  assert.deepEqual(guard.changedPaths(d, base), [name]); assert.ok(guard.diffLint(d, base, { selfProtect: true }).some((x) => /hosts a permission/.test(x)));
});

test('review round 7: valid candidates of other sources or repositories (PleinSens loop has no title) never block admission', (t) => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'sym-bl7-')); t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  const f = path.join(d, 'state.json');
  fs.writeFileSync(f, JSON.stringify({ merges: [], candidates: {
    p: { repo: 'R', source: 'pleinsens-loop', status: 'pr-open', branch: 'codex/pleinsens-boucle-3', origin: { run: 'gr_1', cycle: 3 } },
    o: { repo: 'Other', source: 'autopilot', status: 'pr-open', branch: 'mind-autopilot/x', origin: { pilot: 'gas-saver' } } } }));
  const ctx = { history: [], queue: [], gatePath: f, repoName: 'R', branches: [], signals: [], opts: { strict: true } };
  assert.equal(B.admit(plan(), ctx).ok, true);
});

test('review round 7 (real data): the same task with an extra clause is still the same task; unrelated short titles are not', () => {
  assert.ok(B.similarity("Fix the '1m 60.0s' duration rollover in video-use pack.js and add pack.test.js coverage", 'Fix the 1m 60.0s duration rollover in video-use pack.js') >= B.SIMILAR);
  assert.ok(B.similarity('Fix plugin tests', 'Fix plugin tests for the video plugin and the audio plugin helpers') < B.SIMILAR, 'fewer than four tokens: containment is not used');
  assert.ok(B.similarity('Reject inherited prototype ids in the EDL validator', 'Harden transcript normalizers for missing end times') < 0.3);
});

test('review round 9: the original evidence of a rejected plan is not new evidence; a queued duplicate of the active plan is refused', () => {
  const base = { history: [], queue: [], gatePath: null, branches: [], signals: [], opts: { strict: true } };
  const rej = { ...base, rejected: [{ title: 'Fix the stuck resume of the video loop', evidence: 'the reviewer wanted a failing test first loop.js:42 resumes the same task after restart (reproduced twice)' }] };
  assert.equal(B.admit(plan({ newEvidence: 'loop.js:42 resumes the same task after restart (reproduced twice)' }), rej).code, 'blocked');
  assert.equal(B.admit(plan({ title: 'Fix the stuck video loop resume', objective: 'x' }), { ...base, active: { title: 'Fix the stuck resume of the video loop' } }).code, 'duplicate', 'same task, other words, as the ACTIVE plan');
  const f = kit.setup();
  try {
    f.pilot.applyDefinition({ ...f.pilot.def, backlog: { strict: true } });
    f.pilot.state.active = { stage: 'plan-review', plan: plan({ title: 'Fix the stuck resume of the video loop' }) };
    f.pilot.enqueue([plan({ title: 'Fix the stuck video loop resume' })]);
    assert.equal(f.pilot.state.queue.length, 0, 'the second plan of the same discovery duplicates the first');
  } finally { f.cleanup(); }
});

test('review round 10: a short original observation is not new evidence even when the review text is long', () => {
  const rej = { history: [], queue: [], gatePath: null, branches: [], signals: [], opts: { strict: true },
    rejected: [{ title: 'Fix the stuck resume of the video loop', items: ['The reviewer wrote a long finding about checkpoints, timers, file ordering and the absence of a failing test for this scenario in the repository', 'ECONNRESET at worker.js:42'] }] };
  assert.equal(B.admit(plan({ newEvidence: 'ECONNRESET at worker.js:42' }), rej).code, 'blocked');
  assert.equal(B.admit(plan({ newEvidence: 'A new deterministic failing test in resume.test.js reproduces the loop without any network' }), rej).ok, true);
});

test('review round 11: every finding of a rejecting review is kept (production collection), so a later one cannot be passed off as new', () => {
  const f = kit.setup();
  try {
    f.pilot.applyDefinition({ ...f.pilot.def, backlog: { strict: true } });
    f.pilot.state.active = { stage: 'plan-review', plan: plan({ title: 'Fix the stuck resume of the video loop' }), planRevisions: 0, repairs: 0 };
    f.pilot.state.queue = []; f.pilot.dispatch = () => ({});
    const raw = ['VERDICT: FAIL', 'Finding 1: the timer is reset by the scheduler on every tick of the loop', 'Finding 2: the checkpoint file is read before it is written during resume'].join('\n');
    f.pilot.advance(raw); // the PRODUCTION path that records a rejected plan
    assert.equal(f.pilot.loadRejected().length, 1);
    assert.equal(f.pilot.admission(plan({ newEvidence: 'Finding 2: the checkpoint file is read before it is written during resume' })).code, 'blocked');
  } finally { f.cleanup(); }
});

test('review round 12: terminal rejections keep their findings too; a finding late in a long line is kept; sentences are separate items', () => {
  const long = 'Context sentence about the scheduler and why it was designed that way, repeated to make the line long. '.repeat(4) + 'The checkpoint file is read before it is written during resume.';
  const items = B.reviewItems('VERDICT: FAIL\n' + long + '\nSecond line finding: the timer resets on every tick of the loop');
  assert.ok(items.some((x) => /checkpoint file is read before it is written/.test(x)), 'late finding kept');
  assert.ok(items.some((x) => /^The checkpoint file is read before it is written during resume\.$/.test(x)), 'as its own sentence');
  const f = kit.setup();
  try {
    f.pilot.applyDefinition({ ...f.pilot.def, backlog: { strict: true } });
    f.pilot.state.queue = [{ key: 'z', plan: plan({ title: 'Another queued task about the exporter' }), score: 1, baseSha: null, discoveredAt: new Date().toISOString() }];
    f.pilot.state.active = { stage: 'plan-review', plan: plan({ title: 'Fix the stuck resume of the video loop' }), planRevisions: 0, repairs: 0 };
    f.pilot.dispatch = () => ({});
    f.pilot.advance(['VERDICT: FAIL', long, 'Another unrelated finding about colours of the dashboard header'].join('\n')); // takes the "another task queued" early return
    assert.equal(f.pilot.loadRejected().length, 1, 'the terminal path remembers the plan too');
    assert.equal(f.pilot.admission(plan({ newEvidence: 'The checkpoint file is read before it is written during resume.' })).code, 'blocked');
  } finally { f.cleanup(); }
});

test('review round 13: no cap on what counts as already known; earlier code reviews and long terminal reviews are all remembered', () => {
  const many = Array.from({ length: 90 }, (_, i) => 'Finding number ' + i + ' concerns the module alpha' + i + ' and its configuration beta' + i + '.').join('\n') + '\nThe checkpoint file is read before it is written during resume.';
  const rej = { history: [], queue: [], gatePath: null, branches: [], signals: [], opts: { strict: true }, rejected: [{ title: 'Fix the stuck resume of the video loop', text: many, items: B.reviewItems(many) }] };
  assert.equal(B.admit(plan({ newEvidence: 'The checkpoint file is read before it is written during resume' }), rej).code, 'blocked', 'the 91st finding still counts');
  assert.equal(B.admit(plan({ newEvidence: 'A new deterministic failing test in resume.test.js reproduces the loop without any network' }), rej).ok, true);
  const hist = [{ title: 'Fix the stuck resume of the video loop', outcome: 'review-rejected', reviewerEvidence: 'only the terminal review: colours differ', evidence: ['x'], reviews: [{ text: 'first review: the checkpoint file is read before it is written during resume' }, { text: 'second review: colours differ' }] }];
  assert.equal(B.admit(plan({ newEvidence: 'the checkpoint file is read before it is written during resume' }), { ...rej, rejected: [], history: hist }).code, 'blocked', 'an EARLIER code review counts');
});

test('review round 14: a local-model suggestion goes through the same admission; failed code reviews keep up to 12000 characters', () => {
  const src = fs.readFileSync(path.join(__dirname, 'autopilot.js'), 'utf8');
  assert.ok(src.includes('cited && this.admission(plan).ok'), 'the local suggestion path calls admission');
  assert.ok(src.includes("verdict: 'FAIL', text: String(raw || '').slice(0, 12000)"), 'long reviews are kept');
  const f = kit.setup();
  try {
    f.pilot.applyDefinition({ ...f.pilot.def, backlog: { strict: true } });
    f.pilot.state.history = [{ title: 'Fix the stuck resume of the video loop', outcome: 'completed' }];
    assert.equal(f.pilot.admission(plan({ title: 'Fix the stuck resume of the video loop' })).ok, false, 'what the local path now asks');
  } finally { f.cleanup(); }
});

test('final defect: a finding at ANY position of an earlier review stays known, through the production code-review path and through the plan-review path', () => {
  const filler = Array.from({ length: 4000 }, (_, i) => 'Context line ' + i + ' about module alpha' + i + ' and its configuration beta' + i + '.').join('\n'); // far beyond 12000 and 30000 chars
  const early = filler + '\nThe checkpoint file is read before it is written during resume.';
  assert.ok(early.length > 100000);
  const f = kit.setup();
  try {
    f.pilot.applyDefinition({ ...f.pilot.def, backlog: { strict: true } });
    f.pilot.dispatch = () => ({});
    // production path 1: a failed CODE review (stage code-review), then a repair, then a LATER review with another reason
    const task = plan({ title: 'Fix the stuck resume of the video loop' });
    f.pilot.state.active = { stage: 'code-review', plan: task, repairs: 0, planRevisions: 0, worktree: { path: f.repo, branch: 'mind-autopilot/x' }, baseSha: 'abc', reviews: [], reviewFingerprint: require('./autopilot').worktreeFingerprint(f.repo) };
    f.pilot.advance('VERDICT: FAIL\n' + early);
    f.pilot.state.active.stage = 'code-review';
    f.pilot.state.active.reviewFingerprint = require('./autopilot').worktreeFingerprint(f.repo);
    f.pilot.advance('VERDICT: FAIL\nThe second review only complains about colours of the header.');
    const entry = f.pilot.loadRejected().find((x) => x.title === task.title);
    assert.ok(entry && entry.vocab.length > 1000, 'the vocabulary of the first, very long review is kept');
    assert.equal(f.pilot.admission(plan({ newEvidence: 'The checkpoint file is read before it is written during resume' })).code, 'blocked', 'a finding from the end of the first review is not new');
    assert.equal(f.pilot.admission(plan({ newEvidence: 'A new deterministic failing test in resume.test.js reproduces the loop without any network at all' })).ok, true, 'genuinely new vocabulary is accepted');
    // production path 2: plan review of another task, same property
    f.pilot.state.active = { stage: 'plan-review', plan: plan({ title: 'Fix the exporter rounding of durations' }), planRevisions: 0, repairs: 0 };
    f.pilot.state.queue = [];
    f.pilot.advance('VERDICT: FAIL\n' + early.replace('checkpoint file', 'exporter cache') );
    assert.equal(f.pilot.admission(plan({ title: 'Fix the exporter rounding of durations', newEvidence: 'The exporter cache is read before it is written during resume' })).code, 'blocked');
  } finally { f.cleanup(); }
});

test('last defect: a selfProtect pilot without check commands still goes through the verification gate (real implement -> next stage transition)', () => {
  const f = kit.setup();
  const next = (selfProtect) => {
    f.pilot.applyDefinition({ ...f.pilot.def, verify: [], selfProtect, backlog: selfProtect ? { strict: true } : null });
    let went = null; f.pilot.startVerify = () => { went = 'verify'; return {}; }; f.pilot.dispatch = (s) => { went = s; return {}; };
    const base = sh(f.repo, 'rev-parse', 'HEAD');
    fs.appendFileSync(path.join(f.repo, 'index.js'), '\n// change made by the task\n');
    f.pilot.state.active = { stage: 'implement', plan: plan(), repairs: 0, planRevisions: 0, worktree: { path: f.repo, branch: 'mind-autopilot/x' }, baseSha: base };
    f.pilot.advance('done');
    sh(f.repo, 'checkout', '--', 'index.js');
    return went;
  };
  try {
    assert.equal(next(true), 'verify', 'selfProtect: the diff lint gate runs');
    assert.equal(next(false), 'code-review', 'other pilots keep the previous behaviour');
  } finally { f.cleanup(); }
});

test('retention: a rejection is never forgotten because later tasks followed (own file, no count or age limit)', () => {
  const f = kit.setup();
  try {
    f.pilot.applyDefinition({ ...f.pilot.def, backlog: { strict: true } });
    f.pilot.rememberRejected(plan({ title: 'Fix the stuck resume of the video loop' }), 'VERDICT: FAIL\nThe checkpoint file is read before it is written during resume.');
    for (let i = 0; i < 400; i++) f.pilot.rememberRejected(plan({ title: 'Unrelated task number ' + i + ' about module m' + i }), 'VERDICT: FAIL\nFinding about module m' + i + ' and its configuration.');
    f.pilot.state.history = Array.from({ length: 300 }, (_, i) => ({ title: 'Other work ' + i, outcome: 'completed' }));
    assert.equal(f.pilot.loadRejected().length, 401, 'nothing was dropped');
    assert.equal(f.pilot.admission(plan({ newEvidence: 'The checkpoint file is read before it is written during resume' })).code, 'blocked', 'the first rejection still protects');
    const again = kit.setup(); // a restart: another pilot object on the same files must see it too
    again.cleanup();
    const file = f.pilot.rejectedFile(); assert.ok(fs.existsSync(file)); assert.ok(file.includes('rejected-plans-'));
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).entries.length, 401, 'on disk');
  } finally { f.cleanup(); }
});
