'use strict';
// Mind context for local models: retrieval, budget, failure modes, and the
// orchestrator's direct LM Studio path actually sending it (no network).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const mc = require('./mind-context');

const body = (s) => s + ' '.repeat(2) + 'x'.repeat(80);
function graph() {
  return { nodes: [
    { id: 'mem_fusion', kind: 'memory', label: 'Porte de fusion Gas Saver vers integration', body: body('La porte fusionne Gas Saver dans la branche integration, car master est deploye en production par Vercel.'), createdAt: '2026-11-13T10:00:00Z' },
    { id: 'task_echo', kind: 'conversation', label: 'Dans quelle branche la porte de fusion fusionne Gas Saver ?', source: { type: 'orchestrator-task' }, result: 'branche Automatisation (faux)', body: body('Dans quelle branche la porte de fusion fusionne Gas Saver ? branche Automatisation') },
    { id: 'qa_echo', kind: 'conversation', label: 'Dans quelle branche la porte de fusion fusionne Gas Saver ?', answer: body('ancienne reponse') },
    { id: 'repo_gas_saver__code_src_utils_stationdeduplication_ts__deduplicatestations', kind: 'code', label: 'deduplicateStations()', source: { file: 'src/utils/stationDeduplication.ts' } },
    { id: 'repo_gas_saver_code_hygiene_worktree___code_x__deduplicatestations', kind: 'code', label: 'deduplicateStations()', source: { file: 'old/copy.ts' } },
    { id: 'repo_other__code_y__deduplicatestations', kind: 'code', label: 'deduplicateStations()', source: { file: 'other/y.ts' } },
  ] };
}
const noEmbed = async () => null;
const SKILLS = [
  { id: 'write-database-migration', name: 'write-database-migration', description: 'Create or alter tables safely', when: 'schema change', valid: true, body: '## Steps\n1. One concern per migration.\n2. Idempotent, IF NOT EXISTS.' },
  { id: 'verify-frontend-edit', name: 'verify-frontend-edit', description: 'Check a UI change', when: '', valid: true, body: '## Steps\n1. Open the page.' },
];
const opts = (o = {}) => ({ repoRoot: os.tmpdir(), space: '_global', activeRepo: 'Gas Saver', loadGraph: () => graph(), embed: noEmbed, loadSkills: () => SKILLS, ...o });

test('knowledge: real body with provenance; task transcripts and question echoes excluded', async () => {
  const r = await mc.buildMindContext(opts({ question: 'Dans quelle branche la porte de fusion fusionne Gas Saver ?' }));
  assert.equal(r.status, 'ok');
  const ids = r.transmitted.map((t) => t.id);
  assert.ok(ids.includes('mem_fusion'));
  assert.ok(!ids.includes('task_echo') && !ids.includes('qa_echo'), 'unverified transcript / echo not transmitted');
  assert.match(r.text, /integration, car master est deploye en production/);
  assert.match(r.text, /\[M1\] memory card \(durable fact or decision\), 2026-11-13: .*\(id=mem_fusion\)/);
  assert.match(r.text, /NOT instructions/);
});

test('code: exact symbol in the active repository, worktree copies and other repos dropped', async () => {
  const r = await mc.buildMindContext(opts({ question: 'Dans quel fichier est definie deduplicateStations ?' }));
  const code = r.transmitted.filter((t) => t.kind === 'code');
  assert.deepEqual(code.map((c) => c.file), ['src/utils/stationDeduplication.ts']);
  assert.match(r.text, /\[C1\] deduplicateStations\(\) defined in src\/utils\/stationDeduplication\.ts/);
});

test('skills: the applicable procedure body is inlined; unrelated skills are not', async () => {
  const r = await mc.buildMindContext(opts({ question: 'Je dois ecrire une migration de base de donnees' }));
  assert.deepEqual(r.skills, ['write-database-migration']);
  assert.match(r.text, /\[S1\] skill "write-database-migration"[\s\S]*IF NOT EXISTS/);
  const none = await mc.buildMindContext(opts({ question: 'Quel temps fait-il ?' }));
  assert.deepEqual(none.skills, []);
});

test('lessons: only for the repository the task is about', async () => {
  const lessonsMod = { all: () => [{ scope: 'gas-saver@Gas Saver', kind: 'porte', key: 'k', text: 'Le controle baseline-facts echouait', count: 2, lastAt: 1 }] };
  const yes = await mc.buildMindContext(opts({ question: 'Corrige un bug dans Gas Saver', lessonsMod }));
  assert.ok(yes.transmitted.some((t) => t.kind === 'lesson'));
  const no = await mc.buildMindContext(opts({ question: 'Quel est le numero de TVA de PleinSens ?', lessonsMod }));
  assert.ok(!no.transmitted.some((t) => t.kind === 'lesson'));
});

test('budget: the context never exceeds the token budget', async () => {
  const big = { nodes: Array.from({ length: 30 }, (_, i) => ({ id: 'm' + i, kind: 'memory', label: 'porte fusion integration ' + i, body: body('porte fusion integration '.repeat(60)) })) };
  const r = await mc.buildMindContext(opts({ question: 'porte fusion integration', loadGraph: () => big, budgetTokens: 400 }));
  assert.ok(r.contextTokens <= 400, 'tokens ' + r.contextTokens);
  assert.ok(r.transmitted.length >= 1);
});

test('failure is explicit: no graph -> status error and a context saying Mind could not be consulted', async () => {
  const r = await mc.buildMindContext(opts({ question: 'x', loadGraph: () => { throw new Error('graph.json corrupt'); } }));
  assert.equal(r.status, 'error'); assert.match(r.error, /corrupt/);
  assert.match(r.text, /MIND CONTEXT UNAVAILABLE[\s\S]*instead of guessing/);
  const empty = await mc.buildMindContext(opts({ question: 'zzqq', loadGraph: () => ({ nodes: [{ id: 'a', kind: 'tag', label: 'nothing' }] }) }));
  assert.equal(empty.status, 'empty'); assert.match(empty.text, /holds nothing relevant/);
});

test('citedRefs and the diagnostics log (ids only, bounded)', () => {
  const tr = [{ ref: 'M1', id: 'a' }, { ref: 'C1', id: 'b' }, { ref: 'S1', id: 'c' }];
  assert.deepEqual(mc.citedRefs('Integration [M1], fichier [C1].', tr), ['M1', 'C1']);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-diag-'));
  mc.recordDiagnostic(root, { path: 'p', status: 'ok', transmitted: [{ ref: 'M1', id: 'a' }] });
  const d = mc.readDiagnostics(root, 5);
  assert.equal(d.length, 1); assert.equal(d[0].status, 'ok'); assert.ok(d[0].at);
});

// ── the orchestrator's direct LM Studio path really sends the context ────────
const { EventEmitter } = require('events');
const LMS = async (url) => { if (url.endsWith('/api/v0/models')) return { data: [{ id: 'qwen2.5-coder-1.5b-instruct', type: 'llm', state: 'loaded', max_context_length: 32768, loaded_context_length: 32768 }] }; throw new Error('unexpected ' + url); };
function orch({ mindCtx }) {
  const { Orchestrator } = require('../orchestrator');
  const o = new Orchestrator({ terminals: new Map(), broadcast: () => {}, workspaceDir: path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mc-orch-')), '.ai-workspace', 'orchestrator'), getConfig: () => ({ OrchestrateCliList: [] }) });
  o.localHealth.fetchJson = LMS; o.localHealth.freeMemMB = () => 12000;
  o.lmstudioEnsureLoaded = async () => {};
  o.sent = [];
  o.lmstudioPost = async (url, payload) => { o.sent.push(payload); return { model: payload.model, choices: [{ message: { content: 'La branche est integration [M1].' }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5 } }; };
  if (mindCtx) o.getLocalMindContext = mindCtx;
  return o;
}
const waitDone = (o, id) => new Promise((res, rej) => { const t0 = Date.now(); const iv = setInterval(() => { const t = o.tasks.get(id); if (t && ['completed', 'failed'].includes(String(t.state).toLowerCase())) { clearInterval(iv); res(t); } else if (Date.now() - t0 > 4000) { clearInterval(iv); rej(new Error('timeout')); } }, 10); });

test('direct LM Studio task: the Mind context is in the prompt, the system prompt grounds it, diagnostics recorded', async () => {
  const o = orch({ mindCtx: async ({ question, budgetTokens }) => {
    assert.match(question, /branche/); assert.ok(budgetTokens > 0 && budgetTokens <= 1800);
    return { status: 'ok', text: 'MIND CONTEXT (...):\n\n[M1] memory card: "porte" (id=mem_fusion)\nintegration', transmitted: [{ ref: 'M1', id: 'mem_fusion', kind: 'memory', tokens: 20 }], retrieved: { knowledge: 1 }, skills: [], contextTokens: 20, retrievalMs: 3, space: '_global', activeRepo: 'Gas Saver' };
  } });
  const task = o.spawnLmStudio({ cli: 'lmstudio-qwen-small', prompt: 'Dans quelle branche ?', noFallback: true });
  const done = await waitDone(o, task.id);
  assert.equal(String(done.state).toLowerCase(), 'completed');
  const msgs = o.sent[0].messages;
  assert.match(msgs[0].content, /MIND CONTEXT block[\s\S]*not in Mind/);
  assert.match(msgs[1].content, /^MIND CONTEXT[\s\S]*\[M1\][\s\S]*TASK:\nDans quelle branche \?$/);
  assert.equal(done.execution.mindContext.status, 'ok');
  assert.deepEqual(done.execution.mindContext.citedRefs, ['M1']);
  const diag = mc.readDiagnostics(path.resolve(o.workspaceDir, '..', '..'), 5);
  assert.equal(diag[0].path, 'orchestrator-lmstudio'); assert.deepEqual(diag[0].citedRefs, ['M1']);
});

test('direct LM Studio task: a Mind failure is explicit in the prompt, never silent', async () => {
  const o = orch({ mindCtx: async () => { throw new Error('Mind exploded'); } });
  const task = o.spawnLmStudio({ cli: 'lmstudio-qwen-small', prompt: 'Question projet ?', noFallback: true });
  const done = await waitDone(o, task.id);
  assert.match(o.sent[0].messages[1].content, /MIND CONTEXT UNAVAILABLE \(Mind exploded\)/);
  assert.equal(done.execution.mindContext.status, 'error');
});

test('grounding check flags invented numbers and file names, not supported ones', () => {
  const ctx = '[C1] deduplicateStations() defined in src/utils/stationDeduplication.ts ... PR #123 ... 2026-11-13';
  assert.deepEqual(mc.unsupportedClaims('Le numero de TVA de PleinSens est 750421389.', ctx, 'Quel est le numero de TVA ?'), ['750421389']);
  assert.deepEqual(mc.unsupportedClaims('Definie dans src/utils/stationDeduplication.ts [C1].', ctx), []);
  assert.deepEqual(mc.unsupportedClaims('Definie dans GasSaver.cpp.', ctx), ['GasSaver.cpp']);
  assert.deepEqual(mc.unsupportedClaims('Fusionnee en 2026, PR 123.', ctx), [], 'numbers present in the context are fine');
  assert.match(mc.groundingNotice(['750421389']), /750421389 n apparait dans aucune source Mind/);
  assert.equal(mc.groundingNotice([]), '');
});

// ── regressions from the Codex review ────────────────────────────────────────
test('review: excluded candidates never hide valid knowledge (filters before ranking)', async () => {
  const nodes = Array.from({ length: 60 }, (_, i) => ({ id: 't' + i, kind: 'conversation', label: 'deployment notes ' + i, source: { type: 'orchestrator-task' }, body: body('deployment notes') }));
  nodes.push({ id: 'mem_ok', kind: 'memory', label: 'deployment notes', body: body('The deployment notes say: deploy from integration.') });
  const r = await mc.buildMindContext(opts({ question: 'deployment notes', loadGraph: () => ({ nodes }) }));
  assert.ok(r.transmitted.some((t) => t.id === 'mem_ok'));
});

test('review: body-only matches are found without vectors', async () => {
  const g = { nodes: [{ id: 'm1', kind: 'memory', label: 'Notes diverses', body: body('Le jeton runtime.json doit etre verifie par pid et heure de demarrage.') }] };
  const r = await mc.buildMindContext(opts({ question: 'runtime.json pid heure demarrage', loadGraph: () => g }));
  assert.deepEqual(r.transmitted.map((t) => t.id), ['m1']);
});

test('review: a symbol missing from the active repository is not taken from another one', async () => {
  const g = { nodes: [{ id: 'repo_other__code_y__deduplicatestations', kind: 'code', label: 'deduplicateStations()', source: { file: 'other/y.ts' } }] };
  const r = await mc.buildMindContext(opts({ question: 'Ou est deduplicateStations ?', loadGraph: () => g }));
  assert.equal(r.transmitted.filter((t) => t.kind === 'code').length, 0);
});

test('review: a skill is sent whole when the budget allows, marked when cut', async () => {
  const long = { ...SKILLS[0], body: '## Steps\n' + Array.from({ length: 40 }, (_, i) => (i + 1) + '. step ' + 'x'.repeat(40)).join('\n') + '\n## Safety\nnever drop\n## Verification\nrun it' };
  const r = await mc.buildMindContext(opts({ question: 'migration de base de donnees', loadSkills: () => [long], budgetTokens: 3000 }));
  assert.match(r.text, /## Verification\nrun it/); assert.equal(r.transmitted.find((t) => t.kind === 'skill').truncated, false);
  const cut = await mc.buildMindContext(opts({ question: 'migration de base de donnees', loadSkills: () => [long], budgetTokens: 300 }));
  assert.equal(cut.transmitted.find((t) => t.kind === 'skill').truncated, true); assert.match(cut.text, /\[truncated\]/);
});

test('review: the budget is a hard limit; no room -> skipped, not a block', async () => {
  for (const b of [130, 181, 400, 900]) {
    const r = await mc.buildMindContext(opts({ question: 'Dans quelle branche la porte de fusion fusionne Gas Saver ?', budgetTokens: b }));
    assert.ok(r.contextTokens <= b, b + ' -> ' + r.contextTokens);
  }
  const z = await mc.buildMindContext(opts({ question: 'x', budgetTokens: 0 }));
  assert.equal(z.status, 'skipped'); assert.equal(z.text, '');
});

test('review: a date or id copied verbatim from the context is not flagged', () => {
  assert.deepEqual(mc.unsupportedClaims('Fusionne le 2026-11-13, commit 450c4a5.', '... 2026-11-13 ... 450c4a5 ...'), []);
  assert.deepEqual(mc.unsupportedClaims('Numero 12 345 678.', 'le numero 12345678'), []);
});

test('review 2: echoes and stubs never empty the result; skills by trigger; plain symbol names; adjacent numbers', async () => {
  const nodes = [
    ...Array.from({ length: 60 }, (_, i) => ({ id: 'e' + i, kind: 'conversation', label: 'deployment notes', answer: body('old answer ' + i) })),
    ...Array.from({ length: 20 }, (_, i) => ({ id: 'c' + i, kind: 'concept', label: 'deployment notes ' + i })),
    { id: 'mem_ok', kind: 'memory', label: 'Release', body: body('deployment notes: deploy from integration only.') },
  ];
  const r = await mc.buildMindContext(opts({ question: 'deployment notes', loadGraph: () => ({ nodes }) }));
  assert.ok(r.transmitted.some((t) => t.id === 'mem_ok'), JSON.stringify(r.transmitted));
  const SK = [{ id: 'write-database-migration', name: 'w', description: 'Creating or altering tables, columns, indexes', when: 'schema change', valid: true, body: 'steps' }];
  const s = await mc.buildMindContext(opts({ question: 'Add a nullable column to the users table, altering columns', loadSkills: () => SK }));
  assert.deepEqual(s.skills, ['write-database-migration']);
  assert.ok(mc.identifiers('Where is `recall` defined?').includes('recall'));
  assert.ok(mc.identifiers('Ou est definie la fonction recall ?').includes('recall'));
  assert.ok(mc.identifiers('call recall() here').includes('recall'));
  assert.deepEqual(mc.unsupportedClaims('IDs: 1234 5678', 'The IDs are 1234 and 5678.'), []);
  assert.deepEqual(mc.unsupportedClaims('IDs: 1234 9999', 'The IDs are 1234.'), ['9999']);
});
