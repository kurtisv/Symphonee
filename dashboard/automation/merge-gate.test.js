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
    readPilot: () => ({ history: [{ outcome: 'completed', title: 'Fix distance', at: 'x', worktree: { branch: 'mind-autopilot/2026-11-12-abc' }, commit: SHA,
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
      if (a.startsWith('push')) { if (w.pushRefused && a.includes('refs/heads/master')) throw new Error('non-fast-forward'); w.pushes.push(a); return ''; }
      if (a.endsWith('^2')) return w.mergedParent || SHA;
      if (a.endsWith('^1')) { if (w.unreadable) throw new Error('objet absent'); return w.mergedBase || w.base; }
      if (a.endsWith('^{tree}')) return w.mergedTree || 'tree-tested';
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
    runChain: async () => { w.chainRuns++; return w.chainOk ? { ok: true, tree: 'tree-tested', merge: 'm'.repeat(40), results: [{ name: 'jest', ok: true, code: 0, ms: 1000 }] }
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
  io.readPilot = () => ({ history: [{ outcome: 'completed', title: 'Autre', worktree: { branch: 'mind-autopilot/2026-11-13-def' }, commit: 'a'.repeat(40), reviewerEvidence: 'VERDICT: PASS', verified: ['jest'] }] });
  await gate.pass(POLICY, state, io);
  assert.equal(w.chainRuns, before);
});

test('scenario: a candidate without its loop proof is refused before any chain', async () => {
  const { w, io } = world();
  io.readPilot = () => ({ history: [{ outcome: 'completed', title: 'x', worktree: { branch: 'mind-autopilot/2026-11-12-abc' }, commit: 'a'.repeat(40), reviewerEvidence: 'VERDICT: FAIL', verified: [] }] });
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

test('a PR already open for the branch is adopted when it carries the verified commit', async () => {
  const exists = () => { throw new Error('HTTP 502 /api/github/pulls/create {"error":"GitHub API error (422): A pull request already exists for kurtisv:mind-autopilot/2026-11-12-abc."}'); };
  const setup = (headSha, listed = true) => {
    const r = world(); let creates = 0;
    r.io.sleep = async () => { throw new Error('no sleep expected on already-exists'); };
    const api = r.io.api;
    r.io.api = async (m, p, b) => {
      if (p === '/api/github/pulls/create') { creates++; return exists(); }
      if (p.startsWith('/api/github/pulls?')) return { pulls: listed ? [{ number: 126, headRef: 'other', baseRef: 'master', headSha: 'z' },
        { number: 125, headRef: 'mind-autopilot/2026-11-12-abc', baseRef: 'master', headSha: 'e'.repeat(40) }, // fork, same name
        { number: 127, headRef: 'mind-autopilot/2026-11-12-abc', baseRef: 'master', headSha: headSha || r.w.sha, htmlUrl: 'https://github.com/x/y/pull/127' }] : [] };
      return api(m, p, b);
    };
    return { ...r, creates: () => creates };
  };
  // Same commit: adopted, a comment explains it, and the flow continues.
  let r = setup();
  let st = {};
  await gate.pass(POLICY, st, r.io);
  let c = only(st);
  assert.equal(c.status, 'pr-open'); assert.equal(c.pr, 127); assert.equal(r.creates(), 1, 'no blind retry');
  assert.equal(r.w.comments.length, 1); assert.match(r.w.comments[0].body, /reprise par la porte/);
  // Another commit at the head (e.g. a fork with the same branch name): never
  // adopted, never refused on that basis; stays ready with one warning.
  r = setup('d'.repeat(40)); st = {};
  await gate.pass(POLICY, st, r.io);
  await gate.pass(POLICY, st, r.io);
  c = only(st);
  assert.equal(c.status, 'ready'); assert.equal(c.pr, undefined); assert.equal(r.w.comments.length, 0);
  assert.equal(r.w.notes.filter((n) => /aucune PR ouverte visible ne porte le commit verifie/.test(n)).length, 1);
  // Not listed yet: stays ready, retried next pass.
  r = setup(null, false); st = {};
  await gate.pass(POLICY, st, r.io);
  assert.equal(only(st).status, 'ready');
});

test('autopilot: only the commit made from the reviewed worktree is a candidate', async () => {
  const { io } = world();
  const h = { outcome: 'completed', title: 'x', worktree: { branch: 'mind-autopilot/2026-11-12-abc' }, reviewerEvidence: 'VERDICT: PASS', verified: ['jest'] };
  io.readPilot = () => ({ history: [h] });
  let state = {};
  await gate.pass(POLICY, state, io);
  assert.equal(Object.keys(state.candidates).length, 0, 'nothing committed: not a candidate');
  h.commit = 'c'.repeat(40);
  state = {};
  await gate.pass(POLICY, state, io);
  assert.equal(Object.keys(state.candidates).length, 0, 'branch moved past the reviewed commit: not a candidate');
});

test('a never-started candidate whose branch moved is replaced, not kept twice', async () => {
  const { io } = world();
  const h = { outcome: 'completed', title: 'x', worktree: { branch: 'mind-autopilot/2026-11-12-abc' }, commit: 'a'.repeat(40), reviewerEvidence: 'VERDICT: PASS', verified: ['jest'] };
  io.readPilot = () => ({ history: [h] });
  const state = { candidates: { ['Demo|mind-autopilot/2026-11-12-abc|' + 'f'.repeat(40)]: { repo: 'Demo', branch: 'mind-autopilot/2026-11-12-abc', status: 'new', history: [] } } };
  await gate.pass(POLICY, state, io);
  assert.deepEqual(Object.keys(state.candidates).map((k) => k.slice(-6)), ['aaaaaa']);
});

test('repository without GitHub CI: the gate chain stands for CI, merge confirmed at once', async () => {
  const { w, io } = world();
  w.marker = true; w.checks = []; // GitHub reports no check at all
  const NOCI = { ...REPO, githubCi: false, sources: [{ ...REPO.sources[0], gateChainIsVerification: true }, REPO.sources[1]] };
  io.readPilot = () => ({ history: [{ outcome: 'completed', title: 'Fix', at: 'x', worktree: { branch: 'mind-autopilot/2026-11-12-abc' }, commit: w.sha,
    reviewerEvidence: 'VERDICT: PASS\nok', verified: [] }] }); // a pilot that had no local checks
  const state = {};
  await gate.pass({ enabled: true, repos: [NOCI] }, state, io);
  let c = only(state);
  assert.equal(c.status, 'pr-open', 'chain green, PR opened (no local checks needed: the chain stands for them)');
  await gate.pass({ enabled: true, repos: [NOCI] }, state, io);
  c = only(state);
  assert.equal(c.status, 'merged', 'no CI to wait for: governance ok, merged');
  assert.equal(w.pushes.filter((x) => x.endsWith(':refs/heads/master')).length, 1, 'merged by pushing the tested merge');
  await gate.pass({ enabled: true, repos: [NOCI] }, state, io);
  c = only(state);
  assert.equal(c.status, 'confirmed'); assert.match(c.history.at(-1).note, /pas de CI GitHub/);
  // With GitHub CI expected, the same missing local checks are refused.
  const r = world(); r.io.readPilot = io.readPilot; const st = {};
  await gate.pass(POLICY, st, r.io);
  assert.equal(only(st).status, 'refused');
});

test('chains per pass and chain windows are per repository', async () => {
  const { w, io } = world();
  const branches = ['a', 'b', 'c'].map((x) => 'mind-autopilot/2026-11-12-' + x);
  io.readPilot = () => ({ history: branches.map((b) => ({ outcome: 'completed', title: b, at: 'x', worktree: { branch: b }, commit: w.sha,
    reviewerEvidence: 'VERDICT: PASS', verified: ['t'] })) });
  // Global windows closed at 09:00, but this repository may chain at any time, 2 per pass.
  const policy = { enabled: true, chainWindows: [{ start: '19:00', end: '22:00' }], repos: [{ ...REPO, chainWindows: null, chainsPerPass: 2 }] };
  await gate.pass(policy, {}, io);
  assert.equal(w.chainRuns, 2);
});

test('no GitHub CI: a merge that is not exactly the tested one stops the gate; unreadable stays pending', async () => {
  const NOCI = { ...REPO, githubCi: false };
  const run = async (tweak) => {
    const { w, io } = world(); w.marker = true;
    const state = {};
    for (let i = 0; i < 2; i++) await gate.pass({ enabled: true, repos: [NOCI] }, state, io); // -> merged
    assert.equal(only(state).status, 'merged');
    tweak(w);
    await gate.pass({ enabled: true, repos: [NOCI] }, state, io);
    return { w, state };
  };
  let r = await run((w) => { w.mergedBase = 'f'.repeat(40); });
  assert.ok(r.state.stopped, 'base moved: stopped'); assert.match(r.state.stopped.reason, /a bouge avant la fusion/); assert.equal(r.w.reverts, 1);
  r = await run((w) => { w.mergedTree = 'other-tree'; });
  assert.match(r.state.stopped.reason, /contenu fusionne par GitHub differe/);
  r = await run((w) => { w.unreadable = true; });
  assert.equal(r.state.stopped, undefined); assert.equal(r.state.merges[0].status, 'merged', 'not confirmed by default');
  r = await run(() => {});
  assert.equal(r.state.merges[0].status, 'confirmed');
});

test('a mismatch detected by the post-merge watch stops every merge in the same pass', async () => {
  const { w, io } = world(); w.marker = true;
  const A = { ...REPO, name: 'A', githubCi: false };
  const B = { ...REPO, name: 'B', githubCi: false };
  const state = {};
  // A: one merge already done; B: a candidate ready to merge.
  state.merges = [{ repo: 'A', key: 'k', at: w.now - 60000, sha: 'm'.repeat(40), pr: 1, verified: w.sha, base: w.base, tree: 'tree-tested', status: 'merged' }];
  state.candidates = { ['B|mind-autopilot/2026-11-12-abc|' + w.sha]: { repo: 'B', source: 'autopilot', branch: 'mind-autopilot/2026-11-12-abc', sha: w.sha,
    key: 'B|mind-autopilot/2026-11-12-abc|' + w.sha, status: 'ci-green', pr: 7, evaluatedBase: w.base, evaluatedTree: 'tree-tested', createdAt: 0, attempts: 0, history: [] } };
  w.mergedTree = 'other';
  await gate.pass({ enabled: true, repos: [B, A] }, state, io); // the failing repository comes last
  assert.ok(state.stopped);
  assert.equal(w.merges.length, 0, 'B is not merged in the pass that stopped the gate');
});

test('no GitHub CI: merges by pushing the tested merge commit (fast-forward only); a moved base re-verifies', async () => {
  const NOCI = { ...REPO, githubCi: false };
  let { w, io } = world(); w.marker = true;
  let state = {};
  for (let i = 0; i < 2; i++) await gate.pass({ enabled: true, repos: [NOCI] }, state, io);
  assert.equal(only(state).status, 'merged');
  assert.ok(w.pushes.includes('push --force-with-lease=refs/heads/master:' + w.base + ' origin ' + 'm'.repeat(40) + ':refs/heads/master'), 'the tested merge commit, leased on the tested base');
  assert.equal(w.merges.length, 0, 'no GitHub API merge');
  ({ w, io } = world()); w.marker = true; state = {};
  await gate.pass({ enabled: true, repos: [NOCI] }, state, io);
  w.pushRefused = true;
  await gate.pass({ enabled: true, repos: [NOCI] }, state, io);
  assert.equal(only(state).status, 'new', 'push refused: verified again, nothing merged');
});

test('legacy policy: repositories without own settings still share one chain per pass', async () => {
  const { w, io } = world();
  await gate.pass({ enabled: true, repos: [{ ...REPO, name: 'A' }, { ...REPO, name: 'B' }] }, {}, io);
  assert.equal(w.chainRuns, 1);
});

test('CI verdict: a listed check is superseded only by a strictly later run (fail closed otherwise)', () => {
  const G = (conclusion, startedAt, extra = {}) => ({ app: 'GitHub Actions', name: 'governance', status: 'completed', conclusion, startedAt, ...extra });
  const ok = { app: 'GitHub Actions', name: 'verify', status: 'completed', conclusion: 'success', startedAt: '2026-11-12T16:32:17Z' };
  const push = G('failure', '2026-11-12T16:32:02Z'), pr = G('success', '2026-11-12T16:32:15Z');
  assert.equal(gate.checksVerdict([push, pr, ok], ['governance']), 'success', 'push run superseded by the later PR run');
  assert.equal(gate.checksVerdict([push, pr, ok]), 'failure', 'not listed: every run counts');
  assert.equal(gate.checksVerdict([G('failure', undefined), pr, ok], ['governance']), 'failure', 'undated failure is kept');
  assert.equal(gate.checksVerdict([G('failure', '2026-11-12T16:32:15Z'), pr, ok], ['governance']), 'failure', 'equal times: kept');
  assert.equal(gate.checksVerdict([pr, G('failure', '2026-11-12T17:00:00Z'), ok], ['governance']), 'failure', 'a newer failure fails');
  assert.equal(gate.checksVerdict([push, G('success', '2026-11-12T16:32:15Z', { app: 'Other' }), ok], ['governance']), 'failure', 'another app does not supersede');
  assert.equal(gate.checksVerdict([push, G(null, '2026-11-12T16:40:00Z', { status: 'in_progress' }), ok], ['governance']), 'pending', 'newer run still running');
  assert.equal(gate.checksVerdict([push, G('skipped', '2026-11-12T16:40:00Z'), ok], ['governance']), 'failure', 'a later skipped run does not replace a failure');
});

test('push-tested: PR from porte/<branch> at the tested merge; CI on that head; merged by leased push', async () => {
  const PT = { ...REPO, mergeMode: 'push-tested', base: 'integration' };
  const { w, io } = world(); w.marker = true;
  const M = 'm'.repeat(40);
  w.headSha = M; // GitHub shows the tested merge as the PR head
  w.checks = [{ name: 'verify', status: 'completed', conclusion: 'success', startedAt: '2026-11-13T10:00:00Z' }];
  const git = io.git;
  io.git = (cwd, args) => {
    const a = args.join(' ');
    if (a === 'rev-parse origin/integration') return w.base;
    if (a.startsWith('show origin/integration:AGENTS.md')) return '... ' + gate.MARK;
    return git(cwd, args);
  };
  const state = {};
  await gate.pass({ enabled: true, repos: [PT] }, state, io);
  let c = only(state);
  assert.equal(c.status, 'pr-open');
  assert.ok(w.pushes.includes('push --force origin ' + M + ':refs/heads/porte/mind-autopilot/2026-11-12-abc'), 'tested merge published on the gate branch');
  assert.ok(!w.pushes.some((p) => p.includes(':refs/heads/mind-autopilot/')), 'the autopilot branch is not touched');
  assert.equal(w.prs[0].head, 'porte/mind-autopilot/2026-11-12-abc'); assert.equal(w.prs[0].base, 'integration');
  await gate.pass({ enabled: true, repos: [PT] }, state, io);
  c = only(state);
  assert.equal(c.status, 'merged');
  assert.ok(w.pushes.includes('push --force-with-lease=refs/heads/integration:' + w.base + ' origin ' + M + ':refs/heads/integration'));
  assert.equal(w.merges.length, 0, 'no API merge');
  // A head that is not the tested merge (after the grace period) is refused.
  const r = world(); r.w.marker = true; r.w.headSha = 'e'.repeat(40);
  const g2 = r.io.git;
  r.io.git = (cwd, args) => { const a = args.join(' '); if (a === 'rev-parse origin/integration') return r.w.base;
    if (a.startsWith('show origin/integration:AGENTS.md')) return gate.MARK; return g2(cwd, args); };
  const st = {};
  await gate.pass({ enabled: true, repos: [PT] }, st, r.io);
  r.w.now += 11 * 60000;
  await gate.pass({ enabled: true, repos: [PT] }, st, r.io);
  assert.equal(only(st).status, 'refused');
});
