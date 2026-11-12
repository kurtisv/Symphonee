'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { backfillProceduralHistory, streamRecords, createAccumulator, LIMITS } = require('./cli-history-backfill');
const { discover, mountReflection, THRESHOLDS } = require('../../skill-reflection');

function fixture(t) {
  const base = path.resolve(process.cwd(), '.ai-workspace'); fs.mkdirSync(base, { recursive: true });
  const root = fs.mkdtempSync(path.join(base, 'backfill-test-'));
  t.after(() => { assert.ok(path.resolve(root).startsWith(base + path.sep)); fs.rmSync(root, { recursive: true, force: true }); });
  const repo = path.join(root, 'Symphonee-master'); fs.mkdirSync(repo);
  return { root, repo, write(cli, name, records) {
    const dir = path.join(root, '.' + cli, cli === 'claude' ? 'projects/project' : 'sessions'); fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, name + '.jsonl'); fs.writeFileSync(file, records.map(r => typeof r === 'string' ? r : JSON.stringify(r)).join('\n') + '\n'); return file;
  }, run(opts = {}) { return backfillProceduralHistory({ activeRepoPath: repo, repoRoot: repo, home: root, ...opts }); } };
}
const meta = (id, cwd, timestamp = '2026-01-01T00:00:00Z') => ({ type: 'session_meta', timestamp, payload: { id, ...(cwd ? { cwd } : {}) } });
const call = (id, cmd, workdir) => ({ type: 'response_item', payload: { type: 'function_call', name: 'exec_command', call_id: id, arguments: JSON.stringify({ cmd, ...(workdir ? { workdir } : {}) }) } });
const result = (id, exit_code, output = '') => ({ type: 'response_item', payload: { type: 'function_call_output', call_id: id, output: JSON.stringify({ exit_code, output }) } });
const correction = text => ({ type: 'response_item', payload: { role: 'user', content: text } });
function workflow(id, cwd) { return [meta(id, cwd), call('a', 'node --check dashboard/server.js'), result('a', 0), call('b', 'node --test dashboard/skill-reflection.test.js'), result('b', 0)]; }

test('backfilled multi-CLI procedures become a single candidate cluster', async t => {
  const f = fixture(t);
  for (let i = 0; i < 3; i++) f.write(i === 2 ? 'claude' : 'codex', 'session-cluster-' + i, workflow('cluster-session-' + i, f.repo));
  const history = await f.run(), mined = discover(history.evidences, []);
  assert.equal(mined.candidates.length, 1); assert.equal(mined.candidates[0].sessions, 3);
  assert.equal(new Set(mined.candidates[0].evidences.map(e => e.cli)).size, 2);
  assert.ok(mined.candidates[0].score >= THRESHOLDS.candidate);
});

test('historical corroboration can auto-create without lowering any thresholds', async t => {
  const f = fixture(t);
  for (let i = 0; i < 5; i++) {
    const records = workflow('durable-session-' + i, f.repo); records[0] = meta('durable-session-' + i, f.repo, `2026-01-${String(1 + i * 4).padStart(2, '0')}T00:00:00Z`);
    records.push(call('c', 'npm run build:renderer'), result('c', 0)); f.write(i === 4 ? 'claude' : 'codex', 'session-durable-' + i, records);
  }
  const history = await f.run(), engine = mountReflection(() => {}, () => {}, { repoRoot: f.repo, collectEvidence: async () => history });
  const out = await engine.runDigest({ autoApply: true, useLocalModel: false, reviewInventory: false });
  assert.equal(THRESHOLDS.auto, .82); assert.equal(out.summary.skillsCreated, 1);
  assert.equal(out.evidenceClusters[0].distinctSessions, 5);
  assert.ok(fs.existsSync(path.join(f.repo, 'skills', out.results.find(r => r.status === 'CREATED').id, 'SKILL.md')));
});

test('mixed identical test commands cannot borrow another-project success', async t => {
  const f = fixture(t), sym = f.repo, gas = path.join(f.root, 'Gas Saver'), cmd = 'node --test dashboard/skill-reflection.test.js';
  const records = [meta('mixed-identical-session', f.root), call('s1', 'node --check dashboard/server.js', sym), result('s1', 0), call('s2', cmd, sym), result('s2', 1), call('g1', cmd, gas), result('g1', 0)];
  f.write('codex', 'session-mixed-identical', records); const out = await f.run();
  assert.equal(out.sessionsScanned, 1);
  assert.ok(!out.evidences.some(e => e.text === cmd && e.verified));
  assert.ok(!out.evidences.some(e => e.verified && e.steps?.includes(cmd)));
  assert.ok(!out.sessions[0].testResults.some(e => e.command === cmd && e.status === 'passed'));
});

test('evidence confirmation date comes from the operation rather than session start', async t => {
  const f = fixture(t), records = workflow('operation-date-session', f.repo);
  records[0] = meta('operation-date-session', f.repo, '2026-01-01T00:00:00Z');
  for (const r of records.slice(1)) r.timestamp = '2026-01-20T00:00:00Z';
  f.write('codex', 'session-dates', records); const out = await f.run();
  assert.ok(out.evidences.filter(e => e.verified).every(e => e.createdAt.startsWith('2026-01-20')));
});

test('changing limits invalidates a previously partial incremental cache', async t => {
  const f = fixture(t); f.write('codex', 'session-limited-cache', [...workflow('limited-cache-session', f.repo), correction('Instead rebuild after editing source.')]);
  const partial = await f.run({ limits: { maxEvents: 1 } }); assert.equal(partial.coverage.codex.limitedFiles, 1);
  const complete = await f.run(); assert.equal(complete.coverage.codex.filesParsed, 1); assert.equal(complete.coverage.codex.filesCached, 0); assert.ok(complete.sessions[0].corrections.length);
});

test('Gemini project-root metadata scopes a cwd-less chat conservatively', async t => {
  const f = fixture(t), project = path.join(f.root, '.gemini', 'tmp', 'project'), chats = path.join(project, 'chats'); fs.mkdirSync(chats, { recursive: true });
  fs.writeFileSync(path.join(project, '.project_root'), f.repo);
  fs.writeFileSync(path.join(chats, 'session-metadata.json'), JSON.stringify({ startTime: '2026-01-01T00:00:00Z', messages: [{ type: 'user', content: 'Please inspect the current app.' }] }));
  const r = await f.run(); assert.equal(r.sessionsScanned, 1); assert.equal(r.perCli.gemini, 1);
});

test('file mtimes alone cannot confirm durable multi-date automatic creation', async t => {
  const f = fixture(t);
  for (let i = 0; i < 5; i++) { const records = workflow('mtime-session-' + i, f.repo); delete records[0].timestamp; records.push(call('c', 'npm run build:renderer'), result('c', 0)); const file = f.write('codex', 'session-mtime-' + i, records); const date = new Date(`2026-01-${String(i * 4 + 1).padStart(2, '0')}T00:00:00Z`); fs.utimesSync(file, date, date); }
  const history = await f.run(); assert.ok(history.evidences.every(e => e.timestampInferred));
  const engine = mountReflection(() => {}, () => {}, { repoRoot: f.repo, collectEvidence: async () => history });
  const r = await engine.runDigest({ autoApply: true, useLocalModel: false, reviewInventory: false });
  assert.equal(r.summary.skillsCreated, 0); assert.equal(r.summary.clustersHighConfidence, 0);
});

test('no cwd is attributed only by multiple actual Symphonee tool file signals', async t => {
  const f = fixture(t); f.write('codex', 'session-nocwd', [meta('nocwd-session'), call('a', 'node --check dashboard/server.js'), result('a', 0), call('b', 'node --check dashboard/skill-reflection.js'), result('b', 0)]);
  const r = await f.run(); assert.equal(r.sessionsScanned, 1); assert.equal(r.coverage.codex.noCwd, 1); assert.ok(r.sessions[0].repoConfidence >= .85);
});
test('repo moved or extracted twice preserves attribution without exact cwd', async t => {
  const f = fixture(t); f.write('codex', 'session-moved', workflow('moved-session', 'D:/old/Symphonee-master')); f.write('codex', 'session-copy', workflow('copy-session', 'D:/archive/Symphonee-master (2)'));
  const r = await f.run(); assert.equal(r.sessionsScanned, 2); assert.equal(r.coverage.codex.cwdMismatch, 2);
});
test('foreign project cwd wins over copied Symphonee commands or instructions', async t => {
  const f = fixture(t); f.write('codex', 'session-foreign', [...workflow('foreign-session', 'D:/Gas Saver'), correction('Always inspect Symphonee dashboard/server.js and dashboard/skill-reflection.js')]);
  const r = await f.run(); assert.equal(r.sessionsScanned, 0); assert.equal(r.skippedOtherRepo, 1); assert.equal(r.evidences.length, 0);
});
test('conversation references alone remain uncertain and cannot manufacture file signals', async t => {
  const f = fixture(t); f.write('codex', 'session-uncertain', [meta('uncertain-session'), correction('Always review Symphonee dashboard/server.js and dashboard/skill-reflection.js')]);
  const r = await f.run(); assert.equal(r.sessionsScanned, 0); assert.equal(r.uncertainSessions, 1);
});
test('identical sessions and a history rollup share one stable session fingerprint', async t => {
  const f = fixture(t), records = workflow('duplicate-session', f.repo); f.write('codex', 'session-original', records); f.write('codex', 'session-copy', records);
  fs.writeFileSync(path.join(f.root, '.codex', 'history.jsonl'), JSON.stringify({ session_id: 'duplicate-session', ts: 1767225600, text: 'Always run the focused tests.' }) + '\n');
  const r = await f.run(); assert.equal(r.sessionsScanned, 1); assert.equal(r.coverage.codex.duplicates, 2); assert.equal(new Set(r.evidences.map(e => e.fingerprint)).size, r.evidences.length);
});
test('stream reads useful late corrections beyond 256 KB', async t => {
  const f = fixture(t), records = [meta('late-session', f.repo)]; for (let i = 0; i < 350; i++) records.push({ type: 'response_item', payload: { role: 'assistant', content: 'filler-' + i + ':' + 'x'.repeat(1000) } });
  records.push(correction('Do not edit generated bundles; instead rebuild from source.')); f.write('codex', 'session-late', records);
  const r = await f.run(); assert.ok(r.coverage.codex.bytesRead > 256 * 1024); assert.ok(r.sessions[0].corrections.some(x => x.includes('rebuild from source')));
});
test('failed test then correction and successful retry retain observed outcomes', async t => {
  const f = fixture(t); f.write('codex', 'session-retry', [meta('retry-session', f.repo), call('a', 'node --test dashboard/skill-reflection.test.js'), result('a', 1, 'AssertionError: expected stable id\n at test.js:22:4'), correction('Instead preserve the original stable id when updating.'), call('b', 'node --test dashboard/skill-reflection.test.js'), result('b', 0)]);
  const r = await f.run(), s = r.sessions[0]; assert.equal(s.errors.length, 1); assert.equal(s.corrections.length, 1); assert.ok(s.tests.length); assert.ok(s.outcomes.some(x => /Successful retry/.test(x))); assert.ok(r.evidences.some(x => x.sourceType === 'retry' && x.verified));
});
test('a shared verified procedure retains three independent sessions and two CLIs', async t => {
  const f = fixture(t); f.write('codex', 'session-a', workflow('independent-session-a', f.repo)); f.write('codex', 'session-b', workflow('independent-session-b', f.repo));
  f.write('claude', 'session-c', [{ type: 'user', sessionId: 'independent-session-c', cwd: f.repo, timestamp: '2026-01-03T00:00:00Z', message: { content: 'Please validate the change.' } }, { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'a', name: 'Bash', input: { command: 'node --check dashboard/server.js' } }] } }, { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'a', content: 'passed', is_error: false }] } }, { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'b', name: 'Bash', input: { command: 'node --test dashboard/skill-reflection.test.js' } }] } }, { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'b', content: 'passed', is_error: false }] } }]);
  const r = await f.run(), procedures = r.evidences.filter(x => x.steps?.length >= 2); assert.equal(r.sessionsScanned, 3); assert.equal(new Set(procedures.map(x => x.sessionId)).size, 3); assert.equal(new Set(procedures.map(x => x.cli)).size, 2);
});
test('partial JSONL corruption is counted without losing following valid events', async t => {
  const f = fixture(t); f.write('codex', 'session-corrupt', [meta('corrupt-session', f.repo), '{bad-json', correction('Instead rebuild the renderer from source.')]);
  const r = await f.run(); assert.equal(r.sessionsScanned, 1); assert.equal(r.coverage.codex.corruptLines, 1); assert.equal(r.sessions[0].corrections.length, 1);
});
test('stream byte event and oversized-line limits bound work and resume at next line', async t => {
  const f = fixture(t), file = f.write('codex', 'session-huge', [JSON.stringify({ text: 'x'.repeat(10000) }), meta('huge-session', f.repo), correction('Instead use the focused test.')]);
  const records = []; const st = await streamRecords(file, r => records.push(r), { ...LIMITS, maxLineBytes: 1024 }); assert.equal(st.oversizedLines, 1); assert.equal(records.length, 2);
  const bytes = await streamRecords(file, () => {}, { ...LIMITS, maxBytes: 2048 }); assert.equal(bytes.limited, true); assert.ok(bytes.bytesRead <= 2048);
  const eventsFile = f.write('codex', 'session-events', [meta('events-session', f.repo), correction('Instead do this.'), correction('Instead do that.')]); const events = await streamRecords(eventsFile, () => {}, { ...LIMITS, maxEvents: 1 }); assert.equal(events.events, 1); assert.equal(events.limited, true);
});
test('unchanged files reuse compact incremental index and changed files reparse', async t => {
  const f = fixture(t), file = f.write('codex', 'session-cache', workflow('cached-session', f.repo)); const first = await f.run(); assert.equal(first.coverage.codex.filesParsed, 1);
  const second = await f.run(); assert.equal(second.coverage.codex.filesParsed, 0); assert.equal(second.coverage.codex.filesCached, 1); assert.equal(second.coverage.codex.bytesRead, 0); assert.deepEqual(second.evidences.map(x => x.fingerprint), first.evidences.map(x => x.fingerprint));
  fs.appendFileSync(file, JSON.stringify(correction('Instead preserve stable ids.')) + '\n'); const third = await f.run(); assert.equal(third.coverage.codex.filesParsed, 1); assert.ok(third.sessions[0].corrections.some(x => /stable ids/.test(x)));
});
test('compact cache excludes entire transcript, secrets and personal paths', async t => {
  const f = fixture(t), marker = 'PRIVATE_TRANSCRIPT_MARKER'; f.write('codex', 'session-private', [meta('private-session', f.repo), { payload: { role: 'assistant', content: marker + 'x'.repeat(60000) } }, correction('Instead use token=supersecretcredential12345'), call('a', 'node --check C:/Users/Private Person/Symphonee/dashboard/server.js'), result('a', 0)]);
  await f.run(); const stored = fs.readFileSync(path.join(f.repo, 'skills', '.reflection', 'history-index.json'), 'utf8'); assert.ok(!stored.includes(marker)); assert.ok(!stored.includes('supersecretcredential12345')); assert.ok(!stored.includes('Private Person'));
});
test('accumulator returns opaque stable ids and deduplicates repeated events inside a session', () => {
  const a = createAccumulator('codex', 'file-key', 'D:/Symphonee', '2026-01-01'); const records = workflow('opaque-session', 'D:/Symphonee'); records.forEach(a.consume); a.consume(records[1]); const r = a.finish(); assert.equal(r.duplicateEvents, 1); assert.match(r.summary.sessionId, /^session-[a-f0-9]+$/); assert.ok(!r.summary.sessionId.includes('opaque-session'));
});
test('a parent cwd needs actual tool corroboration rather than parent equality', async t => {
  const f = fixture(t); f.write('codex', 'session-parent', [meta('parent-session', f.root), call('a', 'node --check dashboard/server.js', f.repo), result('a', 0), call('b', 'node --check dashboard/skill-reflection.js', f.repo), result('b', 0)]);
  const r = await f.run(); assert.equal(r.sessionsScanned, 1); assert.ok(r.sessions[0].attribution.reasons.includes('command-working-directory'));
});
test('missing source files are counted unreadable without throwing or admitting evidence', async t => {
  const f = fixture(t); const r = await f.run({ files: [{ cli: 'codex', file: path.join(f.root, 'missing.jsonl'), size: 100, mtimeMs: Date.now() }] }); assert.equal(r.coverage.codex.unreadable, 1); assert.equal(r.sessionsScanned, 0); assert.equal(r.evidences.length, 0);
});
test('Gemini JSON messages stream preserves tool outcomes and top-level cwd metadata', async t => {
  const f = fixture(t), dir = path.join(f.root, '.gemini', 'tmp', 'project', 'chats'); fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'session-fixture.json'), JSON.stringify({ sessionId: 'gemini-session', cwd: f.repo, startTime: '2026-01-03T00:00:00Z', messages: [{ type: 'gemini', toolCalls: [{ id: 'a', name: 'run_shell_command', args: { command: 'node --check dashboard/server.js' }, result: { exitCode: 0 } }] }, { type: 'gemini', toolCalls: [{ id: 'b', name: 'run_shell_command', args: { command: 'node --test dashboard/skill-reflection.test.js' }, result: { exitCode: 0 } }] }] }));
  const r = await f.run(); assert.equal(r.perCli.gemini, 1); assert.ok(r.evidences.some(x => x.verified && x.steps?.length === 2));
});
test('summary rejects literal credentials even when they appear in tool arguments', async t => {
  const f = fixture(t); f.write('codex', 'session-key', [meta('secret-session', f.repo), call('a', 'echo Bearer abcdefghijklmnopqrstuvwxyz123456'), result('a', 0), correction('Instead use password=verysecretpassword')]);
  const r = await f.run(); assert.ok(r.sessions[0].unsafeItemsRejected >= 2); assert.ok(!JSON.stringify(r).includes('verysecretpassword')); assert.ok(!JSON.stringify(r).includes('abcdefghijklmnopqrstuvwxyz123456'));
});
test('history rollup groups distinct declared sessions without counting mirrored records twice', async t => {
  const f = fixture(t); f.write('codex', 'session-original', workflow('rollup-session-one', f.repo));
  fs.writeFileSync(path.join(f.root, '.codex', 'history.jsonl'), [
    { session_id: 'rollup-session-one', ts: 1767225600, text: 'Mirror of the full session.' },
    { session_id: 'rollup-session-two', ts: 1767312000, text: 'Discuss Symphonee without attributable tool data.' },
    { session_id: 'rollup-session-two', ts: 1767312001, text: 'Another turn of the same conversation.' },
  ].map(x => JSON.stringify(x)).join('\n') + '\n');
  const r = await f.run(); assert.equal(r.sessionsScanned, 1); assert.equal(r.uncertainSessions, 1); assert.equal(r.coverage.codex.duplicates, 1); assert.equal(r.sessionsDiscovered, 2);
});
test('observed shell batch exit zero never confers verified validation procedure', async t => {
  const f = fixture(t); f.write('codex', 'session-batch', [meta('batch-session', f.repo), call('a', 'node --test dashboard/skill-reflection.test.js; echo finished'), result('a', 0)]);
  const r = await f.run(); assert.ok(r.evidences.length); assert.ok(r.evidences.every(e => !e.verified && !e.steps));
});
test('mixed HOME session never lends another project commands results or corrections', async t => {
  const f = fixture(t); f.write('codex', 'session-mixed', [meta('mixed-home-session', f.root), call('s1', 'node --check dashboard/server.js', f.repo), result('s1', 0), call('g1', 'node --test gasmobile/payment.test.js', 'D:/Gas Saver'), result('g1', 0), correction('Instead disable gasmobile billing validation.'), call('s2', 'node --check dashboard/skill-reflection.js', f.repo), result('s2', 0)]);
  const r = await f.run(); assert.equal(r.sessionsScanned, 1); assert.ok(r.evidences.length); assert.ok(r.evidences.every(e => !/gasmobile|billing validation|Gas Saver/i.test(e.text))); assert.ok(r.evidences.every(e => !e.steps || e.steps.every(s => !/gasmobile/i.test(s))));
});
test('same canonical session UUID mirrored across CLIs counts once', async t => {
  const f = fixture(t); f.write('codex', 'session-id', workflow('mirrored-canonical-session', f.repo)); f.write('claude', 'session-id', [{ type: 'user', sessionId: 'mirrored-canonical-session', cwd: f.repo, timestamp: '2026-01-01T00:00:00Z', message: { content: 'Mirror of same conversation.' } }]);
  const r = await f.run(); assert.equal(r.sessionsScanned, 1); assert.equal(Object.values(r.coverage).reduce((n, c) => n + c.duplicates, 0), 1);
});
