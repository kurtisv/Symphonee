'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const B = require('./autopilot-backlog');
const guard = require('./autopilot-verify');
const kit = require('./qwen-repo-test-kit');

const plan = (o = {}) => ({ decision: 'TASK', category: 'correctness', title: 'Fix the stuck resume of the video loop', objective: 'The loop resumes the same task forever after restart', severity: 'stuck-loop', proof: 'reproduced', evidence: ['e'], acceptance: ['a'], ...o });
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
  const gate = gateFile(t, { candidates: { c: { repo: 'Symphonee', key: 'c', status: 'pr-open', pr: 12, origin: { pilot: 'default', title: 'Fix the stuck resume of the video loop' } } }, merges: [] });
  const base = { history: [H('Add tests for plugin hints generator', 'completed')], queue: [{ plan: plan({ title: 'Reject inherited prototype ids in the EDL validator' }) }], gatePath: gate, repoName: 'Symphonee', pilotId: 'default', branches: ['remotes/origin/mind-autopilot/2026-11-15-normalize-host-ports'], opts: { strict: true } };
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
    f.pilot.state.active = { stage: 'implement', plan: plan(), worktree: { path: path.join(os.tmpdir(), 'sym-gone-' + Date.now()), branch: 'mind-autopilot/gone' }, planRevisions: 0 };
    f.pilot.recoverAfterRestart();
    assert.equal(f.pilot.state.active, null); assert.equal(f.pilot.state.history.at(-1).outcome, 'interrupted'); assert.equal(f.pilot.metricsView().reconciled, 1);
  } finally { f.cleanup(); }
});
