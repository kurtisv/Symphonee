'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const vm = require('node:vm');
const corpus = require('./skill-corpus');
const reflection = require('./skill-reflection');

const STEPS = [
  'Reproduce the timeout with a focused fixture.',
  'Inspect the timeout boundary and correct the cancellation contract.',
  'Run the focused regression test and confirm success.',
];

test('truncated ids remain idempotent when a separator lands at the length boundary', () => {
  const id = corpus.safeId('a'.repeat(63) + '-long-procedure-name');
  assert.equal(corpus.safeId(id), id);
  assert.ok(!id.endsWith('-'));
});

test('JSON-shaped credential provenance is rejected before canonical writes', t => {
  const root = workspace(t);
  assert.throws(() => corpus.upsertSkill(root, { ...draft(), id: 'json-token' }, { strict: true, provenance: { token: 'VerySecret123456' } }));
  assert.equal(corpus.catalog(root).length, 0);
});
const BODY = [
  '## Use when', '- A cancellation timeout requires debugging.',
  '## Do not use when', '- The issue does not involve a timeout.',
  '## Steps (primary path)', ...STEPS.map((s, i) => `${i + 1}. ${s}`),
  '## Safety', '- Preserve the cancellation contract and avoid exposing credentials.',
  '## Verification', '- Confirm the focused regression test passes.',
].join('\n');

function evidence(count = 6, verified = true) {
  return Array.from({ length: count }, (_, i) => ({
    id: `evidence-${i}`, sessionId: `session-${i}`,
    sourceType: ['cli-history', 'correction', 'retry'][i % 3],
    cli: ['codex', 'claude', 'gemini'][i % 3],
    createdAt: `2026-09-${String(i + 1).padStart(2, '0')}T12:00:00.000Z`,
    text: `Debug cancellation timeout: ${STEPS.join(' ')} Successful correction verified.`,
    steps: [...STEPS], verified,
  }));
}

function draft() {
  return { name: 'Debug cancellation timeouts', description: 'Reproduce cancellation timeouts and verify the corrected boundary.',
    when: 'debugging a cancellation timeout', tags: ['debugging', 'timeout', 'verification'], body: BODY };
}

function workspace(t) {
  const base = path.resolve(__dirname, '../.ai-workspace');
  fs.mkdirSync(base, { recursive: true });
  const root = fs.mkdtempSync(path.join(base, 'skill-gardener-test-'));
  t.after(() => {
    assert.ok(root.startsWith(base + path.sep));
    fs.rmSync(root, { recursive: true, force: true });
  });
  return root;
}

function harness(t, evidences, overrides = {}) {
  const repoRoot = workspace(t);
  const routes = new Map(); const messages = []; const facts = [];
  const addRoute = (method, url, handler) => routes.set(`${method} ${url}`, handler);
  const json = (res, data, status = 200) => { res.data = data; res.status = status; return data; };
  const ctx = { repoRoot, getUiContext: () => ({ activeSpace: 'test' }),
    broadcast: message => messages.push(message),
    collectEvidence: async () => ({ evidences, sessionsScanned: new Set(evidences.map(e => e.sessionId)).size }),
    draftSkill: async () => draft(), saveFact: async e => facts.push(e), ...overrides };
  const skills = corpus.mountSkills(addRoute, json, ctx);
  const gardener = reflection.mountReflection(addRoute, json, ctx);
  async function request(method, url, data) {
    const req = new EventEmitter(); req.url = url;
    const res = {};
    const pending = routes.get(`${method} ${url.split('?')[0]}`)(req, res);
    if (data !== undefined) req.emit('data', JSON.stringify(data));
    req.emit('end');
    await pending;
    return res;
  }
  return { repoRoot, skills, gardener, messages, facts, request };
}

test('independent repeated procedures produce a scored candidate', () => {
  const out = reflection.discover(evidence(), []);
  assert.equal(out.candidates.length, 1);
  assert.equal(out.candidates[0].evidences.length, 6);
  assert.ok(out.candidates[0].steps.length >= 2);
  assert.ok(out.candidates[0].score >= 0.82);
  assert.ok(out.candidates[0].dimensions);
});

test('a trivial singleton never becomes a candidate', () => {
  const out = reflection.discover([{ id: 'one', sessionId: 'one', sourceType: 'cli-history', text: 'Run pwd.' }], []);
  assert.equal(out.candidates.length, 0);
});

test('multiple copies from one session do not count as independent reuse', () => {
  const repeated = evidence().map(e => ({ ...e, sessionId: 'same-session' }));
  assert.equal(reflection.discover(repeated, []).candidates.length, 0);
});

test('potential credentials are rejected before drafting or persistence', async t => {
  const unsafe = evidence().map(e => ({ ...e, text: e.text + ' api_key=sk-testABCDEFGHIJKLMNOPQRSTUVWXYZ123456' }));
  let calls = 0;
  const h = harness(t, unsafe, { draftSkill: async () => { calls++; return draft(); } });
  const out = await h.gardener.runDigest({ autoApply: true, max: 20 });
  assert.equal(calls, 0);
  assert.equal(corpus.loadCorpus(h.repoRoot).length, 0);
  assert.equal(h.gardener.loadProposals().length, 0);
  assert.ok(out.results.some(r => r.status === 'REJECTED_LOW_EVIDENCE'));
});

test('project facts stay in Mind and never become procedural skills', async t => {
  const fact = { id: 'fact', sessionId: 'fact-session', sourceType: 'mind', kindOfMemory: 'fact', text: 'The project uses port 3800.' };
  const h = harness(t, [fact]);
  await h.gardener.runDigest({ autoApply: true });
  assert.equal(h.facts.length, 1);
  assert.equal(h.facts[0].id, fact.id);
  assert.equal(corpus.catalog(h.repoRoot).length, 0);
});

test('high confidence Reflect creates a canonical skill visible immediately over API and UI events', async t => {
  const h = harness(t, evidence());
  const response = await h.request('POST', '/api/skills/reflect', { autoApply: true, max: 20 });
  assert.equal(response.status, 200);
  const created = response.data.results.find(r => r.status === 'CREATED');
  assert.ok(created, JSON.stringify(response.data));
  const list = await h.request('GET', '/api/skills');
  assert.equal(list.data.total, 1);
  assert.equal(list.data.skills[0].id, created.id);
  assert.equal(Object.hasOwn(list.data.skills[0], 'body'), false);
  const item = await h.request('GET', '/api/skills/item?id=' + created.id);
  assert.equal(item.data.skill.body, BODY);
  for (const section of ['Use when', 'Do not use when', 'Steps (primary path)', 'Safety', 'Verification']) {
    assert.ok(item.data.skill.body.includes('## ' + section));
  }
  assert.ok(h.messages.some(m => m.type === 'skills-changed' && m.payload.id === created.id));
  assert.ok(response.data.summary);
});

test('similar evidence strengthens an existing skill and keeps its id stable', async t => {
  const h = harness(t, evidence());
  const initial = { ...draft(), id: 'existing-timeout-procedure', body: BODY.replace(STEPS[1], 'Inspect the timeout boundary.') };
  corpus.upsertSkill(h.repoRoot, initial, { strict: true });
  const out = await h.gardener.runDigest({ autoApply: true, max: 20 });
  assert.ok(out.results.some(r => ['UPDATED', 'MERGED'].includes(r.status)), JSON.stringify(out));
  assert.deepEqual(corpus.catalog(h.repoRoot).map(s => s.id), [initial.id]);
  assert.ok(corpus.loadCorpus(h.repoRoot)[0].body.includes(STEPS[1]));
});

test('a second reflection does not duplicate an already covered procedure', async t => {
  const h = harness(t, evidence());
  await h.gardener.runDigest({ autoApply: true });
  const out = await h.gardener.runDigest({ autoApply: true });
  assert.equal(corpus.catalog(h.repoRoot).length, 1);
  assert.ok(out.results.some(r => r.status === 'SKIPPED_DUPLICATE'), JSON.stringify(out));
});

test('medium confidence procedures remain reviewable and require acceptance', async t => {
  const h = harness(t, evidence(2, false));
  const out = await h.gardener.runDigest({ autoApply: true });
  assert.ok(out.results.some(r => r.status === 'PROPOSED'), JSON.stringify(out));
  assert.equal(corpus.catalog(h.repoRoot).length, 0);
  const pending = await h.request('GET', '/api/skills/proposals');
  assert.equal(pending.data.total, 1);
  assert.equal(pending.data.proposals[0].body, BODY);
  const accepted = await h.request('POST', '/api/skills/proposals/accept', { id: pending.data.proposals[0].id });
  assert.equal(accepted.data.ok, true);
  assert.equal(corpus.catalog(h.repoRoot).length, 1);
  assert.equal(h.gardener.loadProposals().length, 0);
});

test('catalogue and bootstrap never include skill bodies or provenance', t => {
  const h = harness(t, []);
  for (let i = 0; i < 40; i++) corpus.upsertSkill(h.repoRoot, { ...draft(), id: 'timeout-' + i, body: BODY + '\nBODY_SENTINEL_' + i }, { strict: true });
  const bootstrap = h.skills.bootstrapField();
  const text = corpus.catalogText(h.repoRoot, { max: 5 });
  assert.equal(JSON.stringify(bootstrap).includes('BODY_SENTINEL'), false);
  assert.equal(text.includes('BODY_SENTINEL'), false);
  assert.ok(bootstrap.skills.every(s => !Object.hasOwn(s, 'body') && !Object.hasOwn(s, 'provenance')));
  assert.ok(bootstrap.skills.length <= 24);
  assert.ok((text.match(/  - /g) || []).length <= 5);
});

test('strict generated skills cannot omit safety or verification', t => {
  const root = workspace(t);
  assert.equal(typeof corpus.upsertSkill, 'function');
  assert.throws(() => corpus.upsertSkill(root, { ...draft(), id: 'unsafe', body: '## Steps (primary path)\n1. Run the test.' }, { strict: true }));
  assert.equal(corpus.catalog(root).length, 0);
});

test('inventory flags missing guards and overlap before proposing new procedures', () => {
  const skills = [
    { ...draft(), id: 'timeout-one' },
    { ...draft(), id: 'timeout-two', body: '## Steps (primary path)\n1. Inspect the timeout.' },
  ];
  const report = reflection.inventory(skills);
  assert.ok(report);
  const serialized = JSON.stringify(report);
  assert.ok(serialized.includes('timeout-one'));
  assert.ok(serialized.includes('timeout-two'));
  assert.match(serialized, /safety|Safety/);
  assert.match(serialized, /verification|Verification/);
  assert.match(serialized, /overlap|duplicate|closest/i);
});

test('automatic creation cannot introduce an unsupported model-authored step', async t => {
  const invented = 'Install the unverified global repair package and execute its migration.';
  const h = harness(t, evidence(), { draftSkill: async () => ({ ...draft(), body: BODY.replace('## Safety', '4. ' + invented + '\n## Safety') }) });
  const out = await h.gardener.runDigest({ autoApply: true });
  assert.equal(corpus.catalog(h.repoRoot).length, 0);
  assert.ok(out.results.some(r => ['PROPOSED', 'REJECTED_LOW_EVIDENCE'].includes(r.status)));
});

test('a merged procedure preserves intermediate steps before final verification', async t => {
  const h = harness(t, evidence());
  const original = BODY.replace('2. ' + STEPS[1] + '\n', '').replace('3. ' + STEPS[2], '2. ' + STEPS[2]);
  corpus.upsertSkill(h.repoRoot, { ...draft(), id: 'ordered-timeout', body: original }, { strict: true });
  await h.gardener.runDigest({ autoApply: true });
  const body = corpus.loadCorpus(h.repoRoot)[0].body;
  assert.ok(body.indexOf(STEPS[1]) < body.indexOf(STEPS[2]), body);
});

test('accepting a stale proposal preserves manual target edits or rejects the conflict', async t => {
  const h = harness(t, evidence(2, false));
  const id = 'manual-timeout';
  corpus.upsertSkill(h.repoRoot, { ...draft(), id, body: BODY.replace(STEPS[1], 'Inspect the timeout boundary.') }, { strict: true });
  await h.gardener.runDigest({ autoApply: true });
  const proposal = h.gardener.loadProposals()[0];
  assert.ok(proposal);
  const manual = 'Preserve the manually reviewed cancellation constraint.';
  const edited = corpus.loadCorpus(h.repoRoot)[0];
  corpus.upsertSkill(h.repoRoot, { ...edited, body: edited.body.replace('## Verification', '- ' + manual + '\n## Verification') }, { strict: true });
  const out = await h.request('POST', '/api/skills/proposals/accept', { id: proposal.id });
  assert.ok(corpus.loadCorpus(h.repoRoot)[0].body.includes(manual));
  assert.ok(out.data.ok || out.status === 409);
});

test('unsafe evidence metadata never leaks through provenance or reflection reports', async t => {
  const privateValue = 'person@example.test';
  const es = evidence().map(e => ({ ...e, sourceType: privateValue, createdAt: privateValue }));
  const h = harness(t, es);
  const out = await h.gardener.runDigest({ autoApply: true });
  assert.equal(JSON.stringify(out).includes(privateValue), false);
  for (const p of h.gardener.loadProposals()) assert.equal(JSON.stringify(p).includes(privateValue), false);
  for (const s of corpus.catalog(h.repoRoot)) assert.equal(JSON.stringify(corpus.readProvenance(h.repoRoot, s.id)).includes(privateValue), false);
});

test('canonical writer rejects unsafe provenance before writing the skill', t => {
  const root = workspace(t);
  assert.throws(() => corpus.upsertSkill(root, { ...draft(), id: 'unsafe-provenance' }, { strict: true, provenance: { rationale: 'password=VerySecret123456' } }));
  assert.equal(corpus.catalog(root).length, 0);
});

test('knowledge disguised as a preference does not become executable steps', async t => {
  const es = evidence().map(e => ({ ...e, kindOfMemory: 'preference', text: 'The project uses port 3800 and the dashboard theme is blue.',
    steps: ['The project uses port 3800 for the dashboard server.', 'The dashboard theme is blue for this project.'] }));
  const h = harness(t, es);
  await h.gardener.runDigest({ autoApply: true });
  assert.equal(corpus.catalog(h.repoRoot).length, 0);
  assert.equal(h.gardener.loadProposals().length, 0);
});

test('score weights expose every required dimension and reproduce the computed score', () => {
  const candidate = reflection.discover(evidence(), []).candidates[0];
  const scored = reflection.scoreCandidate(candidate);
  assert.deepEqual(Object.keys(reflection.WEIGHTS).sort(), ['frequency', 'reuseValue', 'expectedTokenSaving', 'stability', 'failurePreventionValue', 'evidenceQuality', 'existingSkillOverlap'].sort());
  assert.ok(Math.abs(Object.values(reflection.WEIGHTS).reduce((n, w) => n + w, 0) - 1) < 1e-9);
  const expected = Object.entries(reflection.WEIGHTS).reduce((n, [key, weight]) => n + weight * scored.dimensions[key], 0);
  assert.equal(scored.score, Number(expected.toFixed(4)));
});

test('real UI receives websocket skill changes, renders the summary and opens the existing editor', async () => {
  const hosts = Object.fromEntries(['skMindList', 'skMindDetail', 'skReflectionSummary', 'skReflectButton'].map(id => [id, { innerHTML: '', textContent: '' }]));
  const created = { ...draft(), id: 'created-timeout' };
  const report = { ok: true, summary: { scannedSessions: 6, scannedExistingSkills: 12, candidatesFound: 1,
    skillsCreated: 1, skillsUpdated: 0, skillsMerged: 0, pendingProposals: 0, rejectedCandidates: 2,
    estimatedTokenSavingOpportunities: 840, catalogueBeforeTokens: 500, catalogueAfterTokens: 550 },
    results: [{ id: created.id, name: created.name, status: 'CREATED' }] };
  const requests = []; const runtimeState = {};
  const context = vm.createContext({ window: {}, state: runtimeState, API: '/api',
    document: { getElementById: id => hosts[id] || null }, $: id => hosts[id] || null,
    escapeHtml: value => String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/'/g, '&#39;'),
    _toast() {}, render() {}, location: { protocol: 'http:', host: 'localhost' },
    WebSocket: class { constructor() {} }, setTimeout,
    fetch: async url => { requests.push(url); return { json: async () => url.startsWith('/api/skills/item') ? { ok: true, skill: created }
      : url === '/api/skills/reflection' ? report : url === '/api/skills/proposals' ? { proposals: [] } : { skills: [{ ...created, body: undefined }] } }; },
  });
  // Only remove ESM wiring; all executed behavior is the production source.
  const evaluate = file => vm.runInContext(fs.readFileSync(path.join(__dirname, 'public/mind-ui/src', file), 'utf8').replace(/^import .*;\r?\n/gm, '').replace(/^export .*;\r?\n?/gm, ''), context, { filename: file });
  evaluate('skills.js'); evaluate('data.js');
  vm.runInContext('connectWS()', context);
  runtimeState.ws.onmessage({ data: JSON.stringify({ type: 'skills-changed', payload: { action: 'reflection', ...report } }) });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(context.window.MindSkills.state.skills[0].id, created.id);
  assert.match(hosts.skReflectionSummary.innerHTML, /Scanned sessions: <b>6/);
  assert.match(hosts.skReflectionSummary.innerHTML, /Skills created: <b>1/);
  assert.match(hosts.skReflectionSummary.innerHTML, /840/);
  assert.ok(hosts.skReflectionSummary.innerHTML.includes("MindSkills.select('created-timeout')"));
  assert.equal(requests.some(url => url.startsWith('/api/skills/item')), false);
  await context.window.MindSkills.select(created.id);
  assert.equal(context.window.MindSkills.state.current.body, BODY);
  context.window.MindSkills.edit();
  assert.match(hosts.skMindDetail.innerHTML, /skmBody/);
  assert.ok(hosts.skMindDetail.innerHTML.includes(STEPS[1]));
});

test('runtime header tokens are rejected but symbolic environment references remain usable', () => {
  assert.equal(corpus.safetyIssue('x-symphonee-token: abcdef12345678901234567890'), 'potential-secret');
  assert.equal(corpus.safetyIssue('token=abcdef12345678901234567890'), 'potential-secret');
  assert.equal(corpus.safetyIssue('x-symphonee-token: $env:SYMPHONEE_TOKEN'), null);
});

test('required headings must be real separate Markdown sections', t => {
  const root = workspace(t);
  const malformed = '## Use when, ## Do not use when, ## Steps (primary path), ## Safety, ## Verification\n1. Inspect the timeout boundary carefully.\n2. Run the regression test and verify success.';
  assert.throws(() => corpus.upsertSkill(root, { ...draft(), id: 'comma-headings', body: malformed }, { strict: true }));
  assert.equal(corpus.catalog(root).length, 0);
});

test('malformed disk skills remain editable but are excluded from prompt catalogues', t => {
  const h = harness(t, []);
  const dir = path.join(h.repoRoot, 'skills', 'malformed');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'SKILL.md'), '---\nname: Missing description\n---\n## Steps\n1. Run something.');
  assert.equal(corpus.loadCorpus(h.repoRoot).length, 1);
  assert.equal(corpus.catalog(h.repoRoot).length, 1);
  assert.equal(corpus.catalog(h.repoRoot)[0].runnable, false);
  assert.equal(corpus.selectCatalog(h.repoRoot).skills.length, 0);
  assert.equal(corpus.catalogText(h.repoRoot), '');
  assert.equal(h.skills.bootstrapField().skills.length, 0);
});

test('merging preserves multiline explanations attached to existing ordered steps', async t => {
  const h = harness(t, evidence());
  const continuation = '   Preserve the timeout fixture isolation.\n   Do not share cancellation state between cases.';
  const original = BODY.replace('1. ' + STEPS[0], '1. ' + STEPS[0] + '\n' + continuation).replace(STEPS[1], 'Inspect the timeout boundary.');
  corpus.upsertSkill(h.repoRoot, { ...draft(), id: 'multiline-timeout', body: original }, { strict: true });
  await h.gardener.runDigest({ autoApply: true });
  const body = corpus.loadCorpus(h.repoRoot)[0].body;
  assert.ok(body.includes(continuation), body);
  assert.ok(body.indexOf(continuation) > body.indexOf(STEPS[0]));
  assert.ok(body.indexOf(continuation) < body.indexOf(STEPS[1]));
});

test('same-day sibling sessions cannot auto-promote even with a high score', async t => {
  const es = evidence(12).map((e, i) => ({ ...e, createdAt: `2026-09-01T${String(i).padStart(2, '0')}:00:00.000Z` }));
  assert.ok(reflection.discover(es, []).candidates[0].score >= reflection.THRESHOLDS.auto);
  const h = harness(t, es);
  const out = await h.gardener.runDigest({ autoApply: true });
  assert.equal(corpus.catalog(h.repoRoot).length, 0);
  assert.ok(out.results.some(r => r.status === 'PROPOSED'));
});

test('inventory review exposes an incomplete existing skill without creating another skill', async t => {
  const h = harness(t, []);
  const dir = path.join(h.repoRoot, 'skills', 'incomplete-timeout');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'SKILL.md'), corpus.renderSkill({ ...draft(), body: '## Use when\n- Debugging timeouts.\n## Steps (primary path)\n1. Inspect the timeout boundary.' }));
  const out = await h.gardener.runDigest({ autoApply: true });
  assert.equal(out.summary.skillsCreated, 0);
  assert.deepEqual(corpus.loadCorpus(h.repoRoot).map(s => s.id), ['incomplete-timeout']);
  const proposal = h.gardener.loadProposals().find(p => p.kind === 'inventory-review');
  assert.ok(proposal);
  assert.equal(proposal.targetId, 'incomplete-timeout');
  assert.ok(proposal.missingSections.includes('Safety'));
  assert.ok(proposal.missingSections.includes('Verification'));
});

test('dryRun reports opportunities without writing canonical or reflection artifacts', async t => {
  const h = harness(t, evidence());
  const out = await h.gardener.runDigest({ autoApply: true, dryRun: true });
  assert.equal(out.ok, true);
  assert.ok(out.results.some(r => r.status === 'CREATED' && r.dryRun));
  assert.equal(fs.existsSync(path.join(h.repoRoot, 'skills')), false);
  assert.equal(h.messages.length, 0);
  assert.equal(h.facts.length, 0);
});

test('background reflection respects canWrite while approved API reflection proceeds', async t => {
  let approvals = 0;
  const h = harness(t, evidence(), { canWrite: () => false, permGate: async () => { approvals++; return true; } });
  const blocked = await h.gardener.runDigest({ autoApply: true });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.reason, 'background-reflection-not-permitted');
  assert.equal(fs.existsSync(path.join(h.repoRoot, 'skills')), false);
  const allowed = await h.request('POST', '/api/skills/reflect', { autoApply: true });
  assert.equal(approvals, 1);
  assert.equal(allowed.data.ok, true);
  assert.equal(corpus.loadCorpus(h.repoRoot).length, 1);
});

test('coincidental legacy log proposals are rejected and cleaned without promotion', async t => {
  const h = harness(t, []);
  const dir = path.join(h.repoRoot, 'skills', '.proposals');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'legacy-log.json'), JSON.stringify({ ...draft(), id: 'legacy-log', name: 'Recurring theme: text(await tools.exec_command', status: 'proposed' }));
  const out = await h.gardener.runDigest({ autoApply: true });
  assert.equal(corpus.loadCorpus(h.repoRoot).length, 0);
  assert.equal(h.gardener.loadProposals().length, 0);
  assert.ok(out.results.some(r => r.status === 'REJECTED_LOW_EVIDENCE' && r.reason === 'legacy-coincidental-log-proposal'));
});
