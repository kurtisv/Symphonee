'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const gate = require('./merge-gate');

const REPO = {
  name: 'Demo', github: 'Demo', path: '/repo', base: 'master',
  governanceMarker: { file: 'AGENTS.md', text: gate.MARK }, maxMergesPerDay: 2, minHoursBetweenMerges: 2,
  forbidden: ['^AGENTS\\.md$', '^\\.github/', '(^|/)package(-lock)?\\.json$', 'stripe'],
  chain: [{ name: 'jest', cmd: ['node', 'x'] }],
  sources: [
    { type: 'autopilot', pilot: 'p', branchPrefix: 'mind-autopilot/', maxCodeLines: 50, maxCodeFiles: 3, forbidden: ['^admin-dashboard/'] },
    { type: 'pleinsens-loop', branchPrefix: 'codex/pleinsens-boucle-', runPrefix: 'Boucle ', allowed: ['^api/core/pleinsens/modeleLocal/', '^docs/'], maxCodeLines: 50, maxCodeFiles: 3 },
  ],
};
const AUTO = REPO.sources[0], LOOP = REPO.sources[1];
const diff = (files, extra = {}) => ({ numstat: files.map(([p, a, d]) => ({ path: p, added: a, deleted: d, binary: false })),
  status: files.map(([p]) => ({ path: p, code: 'M' })), addedLines: [], ...extra });

test('rule 4: forbidden paths, per-source forbidden, allow-list, binaries, deleted tests', () => {
  assert.equal(gate.evaluateDiff(diff([['src/a.ts', 5, 1]]), REPO, AUTO).ok, true);
  let r = gate.evaluateDiff(diff([['src/a.ts', 5, 1], ['AGENTS.md', 1, 0], ['package.json', 1, 1]]), REPO, AUTO);
  assert.equal(r.ok, false); assert.match(r.reasons[0], /interdits.*AGENTS\.md.*package\.json/);
  assert.match(gate.evaluateDiff(diff([['admin-dashboard/x.ts', 1, 0]]), REPO, AUTO).reasons[0], /interdits/);
  assert.match(gate.evaluateDiff(diff([['src/services/StripeBilling.ts', 1, 0]]), REPO, AUTO).reasons[0], /interdits/, 'case-insensitive');
  r = gate.evaluateDiff(diff([['api/core/pleinsens/modeleLocal/x.ts', 3, 0], ['src/app.ts', 1, 0]]), REPO, LOOP);
  assert.match(r.reasons.join(), /hors du perimetre.*src\/app\.ts/);
  r = gate.evaluateDiff({ numstat: [{ path: 'img.png', added: 0, deleted: 0, binary: true }], status: [{ path: 'img.png', code: 'A' }], addedLines: [] }, REPO, AUTO);
  assert.match(r.reasons.join(), /binaires/);
  r = gate.evaluateDiff({ numstat: [{ path: 'src/__tests__/a.test.ts', added: 0, deleted: 30, binary: false }], status: [{ path: 'src/__tests__/a.test.ts', code: 'D' }], addedLines: [] }, REPO, AUTO);
  assert.match(r.reasons.join(), /tests supprimes/);
  assert.match(gate.evaluateDiff(diff([]), REPO, AUTO).reasons.join(), /aucun changement/);
});

test('rule 5: size counts code only (tests, docs, data excluded)', () => {
  let r = gate.evaluateDiff(diff([['src/a.ts', 30, 10], ['src/__tests__/a.test.ts', 500, 0], ['docs/x.md', 900, 0], ['tests/corpus/d1.jsonl', 180, 0]]), REPO, AUTO);
  assert.equal(r.ok, true); assert.equal(r.stats.codeLines, 40); assert.equal(r.stats.codeFiles, 1);
  r = gate.evaluateDiff(diff([['src/a.ts', 45, 10]]), REPO, AUTO);
  assert.match(r.reasons.join(), /trop gros : 55 lignes/);
  r = gate.evaluateDiff(diff([['src/a.ts', 1, 0], ['src/b.ts', 1, 0], ['src/c.ts', 1, 0], ['src/d.ts', 1, 0]]), REPO, AUTO);
  assert.match(r.reasons.join(), /trop de fichiers de code : 4/);
});

test('rule 6: secrets in added lines are refused', () => {
  const r = gate.evaluateDiff(diff([['src/a.ts', 1, 0]], { addedLines: [{ file: 'src/a.ts', line: 'const k = "sk_live_' + 'a'.repeat(20) + '";' },
    { file: 'src/b.ts', line: 'role: service_role' }] }), REPO, AUTO);
  assert.match(r.reasons.join(), /secret probable : cle Stripe dans src\/a\.ts, service_role dans src\/b\.ts/);
});

test('rule 8: CI verdict needs at least one success, nothing pending, nothing failing', () => {
  assert.equal(gate.checksVerdict([]), 'pending', 'no check is never success');
  assert.equal(gate.checksVerdict([{ status: 'completed', conclusion: 'success' }, { status: 'in_progress', conclusion: null }]), 'pending');
  assert.equal(gate.checksVerdict([{ status: 'completed', conclusion: 'success' }, { status: 'completed', conclusion: 'skipped' }]), 'success');
  assert.equal(gate.checksVerdict([{ status: 'completed', conclusion: 'success' }, { status: 'completed', conclusion: 'cancelled' }]), 'failure');
  assert.equal(gate.checksVerdict([{ status: 'completed', conclusion: 'skipped' }]), 'pending');
});

test('rule 9: pace (daily cap, spacing, previous merge confirmed first)', () => {
  const now = new Date(2026, 10, 13, 15).getTime();
  assert.equal(gate.paceAllows([], REPO, now).ok, true);
  assert.match(gate.paceAllows([{ repo: 'Demo', at: now - 5 * 3600000, status: 'merged' }], REPO, now).reason, /pas encore confirmee/);
  assert.match(gate.paceAllows([{ repo: 'Demo', at: now - 3600000, status: 'confirmed' }], REPO, now).reason, /moins de 2 h/);
  const two = [{ repo: 'Demo', at: now - 6 * 3600000, status: 'confirmed' }, { repo: 'Demo', at: now - 4 * 3600000, status: 'confirmed' }];
  assert.match(gate.paceAllows(two, REPO, now).reason, /plafond de 2/);
  assert.equal(gate.paceAllows([{ repo: 'Other', at: now - 60000, status: 'merged' }], REPO, now).ok, true);
});

test('parsers: numstat with renames and binaries, name-status, added lines', () => {
  assert.deepEqual(gate.parseNumstat('3\t1\tsrc/a.ts\n-\t-\timg.png\n2\t0\tsrc/{old => new}/b.ts'),
    [{ path: 'src/a.ts', added: 3, deleted: 1, binary: false }, { path: 'img.png', added: 0, deleted: 0, binary: true }, { path: 'src/new/b.ts', added: 2, deleted: 0, binary: false }]);
  assert.deepEqual(gate.parseNameStatus('M\tsrc/a.ts\nD\tsrc/b.test.ts\nR100\told.ts\tnew.ts'),
    [{ code: 'M', path: 'src/a.ts' }, { code: 'D', path: 'src/b.test.ts' }, { code: 'R', path: 'new.ts' }]);
  assert.deepEqual(gate.parseAddedLines('+++ b/src/a.ts\n@@ -1 +1 @@\n-old\n+new line'), [{ file: 'src/a.ts', line: 'new line' }]);
});

// ── Full scenario with fake git / GitHub ────────────────────────────────
function world() {
  const w = { now: new Date(2026, 10, 13, 9).getTime(), base: 'b'.repeat(40), marker: false, checks: [], headSha: null,
    pushes: [], prs: [], merges: [], comments: [], notes: [], logs: [], chainRuns: 0, chainOk: true, reverts: 0, masterChecks: [] };
  const SHA = 'a'.repeat(40);
  w.sha = SHA;
  const io = {
    now: () => w.now, log: (l) => w.logs.push(l), stopFileExists: () => false,
    isAncestor: () => false,
    readPilot: () => ({ history: [{ outcome: 'completed', title: 'Fix distance', at: 'x', worktree: { branch: 'mind-autopilot/2026-11-12-abc' },
      reviewerEvidence: 'VERDICT: PASS\nok', verified: ['types-app', 'jest'] }] }),
    git: (cwd, args) => {
      const a = args.join(' ');
      if (a.startsWith('fetch')) return '';
      if (a === 'rev-parse origin/master') return w.base;
      if (a.startsWith('rev-parse --verify')) return SHA;
      if (a.startsWith('merge-base')) return w.base;
      if (a.startsWith('diff --numstat')) return '12\t3\tsrc/utils/distance.ts\n40\t0\tsrc/__tests__/distance.test.ts';
      if (a.startsWith('diff --name-status')) return 'M\tsrc/utils/distance.ts\nA\tsrc/__tests__/distance.test.ts';
      if (a.startsWith('diff --unified=0')) return '+++ b/src/utils/distance.ts\n+return km;';
      if (a.startsWith('show origin/master:AGENTS.md')) return w.marker ? '... ' + gate.MARK + ' ...' : 'regles';
      if (a.startsWith('push')) { w.pushes.push(a); return ''; }
      if (a.endsWith('^2')) return w.mergedParent || SHA;
      throw new Error('git inattendu : ' + a);
    },
    api: async (method, p, body) => {
      if (p === '/api/graph-runs') return [];
      if (p === '/api/github/pulls/create') { w.prs.push(body); return { ok: true, number: 7, url: 'https://github.com/x/y/pull/7' }; }
      if (p.startsWith('/api/github/pulls/checks') && p.includes('&sha=')) return { sha: 'm', checks: w.masterChecks };
      if (p.startsWith('/api/github/pulls/checks')) return { sha: w.headSha || SHA, checks: w.checks };
      if (p === '/api/github/pulls/merge') { w.merges.push(body); return { merged: true, sha: 'c'.repeat(40) }; }
      if (p === '/api/github/pulls/comment') { w.comments.push(body); return { ok: true }; }
      throw new Error('api inattendue : ' + p);
    },
    runChain: async () => { w.chainRuns++; return w.chainOk ? { ok: true, results: [{ name: 'jest', ok: true, code: 0, ms: 1000 }] }
      : { ok: false, results: [{ name: 'jest', ok: false, code: 1, ms: 1000, preexisting: false }] }; },
    openRevert: async () => { w.reverts++; return 'https://github.com/x/y/pull/8'; },
    notify: (level, message) => w.notes.push(level + ' ' + message),
  };
  return { w, io };
}
const POLICY = { enabled: true, repos: [REPO] };
const only = (state) => Object.values(state.candidates)[0];

test('scenario: chain, PR, CI, waits for governance, merges, confirms', async () => {
  const { w, io } = world();
  const state = {};
  await gate.pass(POLICY, state, io);
  let c = only(state);
  assert.equal(w.chainRuns, 1, 'the gate runs the chain itself');
  assert.equal(c.status, 'pr-open');
  assert.deepEqual(w.pushes, ['push origin ' + w.sha + ':refs/heads/mind-autopilot/2026-11-12-abc'], 'pushes the exact verified commit');
  assert.match(w.prs[0].body, /FUSION_AUTOMATIQUE_ENCADREE_V1/);
  await gate.pass(POLICY, state, io);
  assert.equal(only(state).status, 'pr-open', 'no check yet: pending is never success');
  w.checks = [{ name: 'CI', status: 'completed', conclusion: 'success' }];
  await gate.pass(POLICY, state, io);
  assert.equal(only(state).status, 'waiting-governance', 'no merge before the human-merged authorization');
  assert.equal(w.merges.length, 0);
  assert.equal(w.notes.filter((n) => /pas encore autorisee/.test(n)).length, 1);
  await gate.pass(POLICY, state, io);
  assert.equal(w.notes.filter((n) => /pas encore autorisee/.test(n)).length, 1, 'the waiting message is sent once');
  w.marker = true;
  await gate.pass(POLICY, state, io);
  c = only(state);
  assert.equal(c.status, 'merged');
  assert.equal(w.merges[0].method, 'merge');
  assert.equal(state.merges.length, 1);
  assert.ok(w.notes.some((n) => /^info Fusion automatique faite/.test(n)));
  w.masterChecks = [{ name: 'CI', status: 'completed', conclusion: 'success' }];
  await gate.pass(POLICY, state, io);
  assert.equal(only(state).status, 'confirmed');
  assert.equal(state.merges[0].status, 'confirmed');
  assert.equal(w.chainRuns, 1);
});

test('scenario: red chain or red CI refuses with a message; a moved base re-runs everything', async () => {
  let { w, io } = world();
  w.chainOk = false;
  let state = {};
  await gate.pass(POLICY, state, io);
  assert.equal(only(state).status, 'refused');
  assert.match(w.notes[0], /^warning Fusion refusee.*jest.*introduit par la branche/);
  assert.equal(w.prs.length, 0, 'no PR for a refused candidate');

  ({ w, io } = world()); state = {};
  await gate.pass(POLICY, state, io);
  w.checks = [{ name: 'CI', status: 'completed', conclusion: 'failure' }];
  await gate.pass(POLICY, state, io);
  assert.equal(only(state).status, 'refused');
  assert.match(w.comments[0].body, /fusion refusee/);

  ({ w, io } = world()); state = {}; w.marker = true;
  await gate.pass(POLICY, state, io);
  w.checks = [{ name: 'CI', status: 'completed', conclusion: 'success' }];
  w.base = 'd'.repeat(40); // master moved after the chain ran
  await gate.pass(POLICY, state, io);
  assert.equal(only(state).status, 'new', 'back to a full re-evaluation');
  assert.equal(w.merges.length, 0);
  await gate.pass(POLICY, state, io);
  assert.equal(w.chainRuns, 2);
  assert.equal(only(state).status, 'merged');
});

test('scenario: the PR moved after verification -> refused; red CI after merge -> gate stops and opens a revert PR', async () => {
  let { w, io } = world();
  let state = {}; w.marker = true;
  await gate.pass(POLICY, state, io);
  w.headSha = 'e'.repeat(40);
  await gate.pass(POLICY, state, io);
  assert.equal(only(state).status, 'refused');
  assert.match(only(state).history.slice(-1)[0].note, /a change depuis la verification/);

  ({ w, io } = world()); state = {}; w.marker = true;
  await gate.pass(POLICY, state, io);
  w.checks = [{ name: 'CI', status: 'completed', conclusion: 'success' }];
  await gate.pass(POLICY, state, io);
  assert.equal(only(state).status, 'merged');
  w.masterChecks = [{ name: 'CI', status: 'completed', conclusion: 'failure' }];
  await gate.pass(POLICY, state, io);
  assert.ok(state.stopped, 'the gate stopped itself');
  assert.equal(w.reverts, 1);
  assert.ok(w.notes.some((n) => /^error PORTE DE FUSION ARRETEE.*PR d annulation ouverte/.test(n)));
  // Stopped: no new candidate is processed.
  const before = w.chainRuns;
  io.readPilot = () => ({ history: [{ outcome: 'completed', title: 'Autre', worktree: { branch: 'mind-autopilot/2026-11-13-def' }, reviewerEvidence: 'VERDICT: PASS', verified: ['jest'] }] });
  await gate.pass(POLICY, state, io);
  assert.equal(w.chainRuns, before);
});

test('scenario: a candidate without its loop proof is refused before any chain', async () => {
  const { w, io } = world();
  io.readPilot = () => ({ history: [{ outcome: 'completed', title: 'x', worktree: { branch: 'mind-autopilot/2026-11-12-abc' }, reviewerEvidence: 'VERDICT: FAIL', verified: [] }] });
  const state = {};
  await gate.pass(POLICY, state, io);
  assert.equal(only(state).status, 'refused');
  assert.equal(w.chainRuns, 0);
  assert.match(only(state).history[0].note, /VERDICT: PASS.*verifications locales/);
});

test('the CPU-heavy chain runs only inside chainWindows; light steps run at any time', async () => {
  const { w, io } = world();
  const policy = { ...POLICY, chainWindows: [{ start: '13:00', end: '14:00' }, { start: '19:00', end: '22:00' }] };
  w.now = new Date(2026, 10, 13, 9).getTime(); // 09:00: PleinSens window
  const state = {};
  await gate.pass(policy, state, io);
  assert.equal(w.chainRuns, 0, 'no chain at 09:00');
  assert.equal(only(state).status, 'new');
  w.now = new Date(2026, 10, 13, 13, 10).getTime();
  await gate.pass(policy, state, io);
  assert.equal(w.chainRuns, 1, 'chain at 13:10');
  assert.equal(only(state).status, 'pr-open');
  w.now = new Date(2026, 10, 13, 23).getTime(); w.marker = true;
  w.checks = [{ name: 'CI', status: 'completed', conclusion: 'success' }];
  await gate.pass(policy, state, io);
  assert.equal(only(state).status, 'merged', 'reading CI and merging need no chain window');
  assert.equal(gate.inAnyWindow([{ start: '22:00', end: '04:00' }], new Date(2026, 10, 13, 2).getTime()), true);
  assert.equal(gate.inAnyWindow(undefined, 0), true);
});

test('a transient API error is retried (PR creation) and never aborts the other candidates', async () => {
  const { w, io } = world();
  io.sleep = async () => {};
  const api = io.api; let fails = 2;
  io.api = async (m, p, b) => { if (p === '/api/github/pulls/create' && fails-- > 0) throw new Error('HTTP 502 head invalid'); return api(m, p, b); };
  const state = {};
  await gate.pass(POLICY, state, io);
  assert.equal(only(state).status, 'pr-open', 'created at the third try');
  // An error that persists leaves the candidate in place, with one message.
  const r = world(); r.io.sleep = async () => {};
  r.io.api = async (m, p, b) => { if (p === '/api/github/pulls/create') throw new Error('HTTP 502 GitHub en panne'); return world().io.api(m, p, b); };
  const st = {};
  await gate.pass(POLICY, st, r.io);
  await gate.pass(POLICY, st, r.io);
  assert.equal(only(st).status, 'ready', 'not refused: retried next pass');
  assert.equal(r.w.notes.filter((n) => /erreur transitoire/.test(n)).length, 1, 'one message for the same error');
});
