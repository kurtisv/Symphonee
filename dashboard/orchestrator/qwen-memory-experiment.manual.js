'use strict';
// MANUAL, controlled experiment: does Qwen solve NEW analogous problems better when
// it can read validated, certified lessons from Mind? Fictional tasks only.
//
//   node qwen-memory-experiment.manual.js prep <id>      Claude may teach on `average` until a CERTIFIED lesson is in Mind (max 4 runs)
//   node qwen-memory-experiment.manual.js compare <id>   12 runs: 3 unseen tasks x 2 trials x {no memory, memory}; NO Claude, Codex only after the independent checks pass
//   node qwen-memory-experiment.manual.js summary <id>
//
// Pre-registered reading rule (fixed before the comparison runs): a gain is reported ONLY if
//   memory approvals - no-memory approvals >= 2 (out of 6 each) AND memory is not worse on any single task.
// Otherwise the result is "not demonstrated", whatever the trend.
const fs = require('node:fs'), path = require('node:path'), cp = require('node:child_process'), crypto = require('node:crypto');
const CHECKOUT = path.resolve(__dirname, '..', '..');
const HARNESS = path.join(__dirname, 'qwen-autopilot-fixture.manual.js');
const MODEL = 'qwen/qwen3.5-4b';
const TASKS = ['meanabs', 'midrange', 'meanpos'], TRIALS = 2, PREP_MAX = 4;
const dirOf = (id) => path.join(CHECKOUT, '.ai-workspace', 'qwen-memory-experiment', id);
const load = (id) => { try { return JSON.parse(fs.readFileSync(path.join(dirOf(id), 'state.json'), 'utf8')); } catch { return { id, space: 'fixture_' + crypto.randomBytes(8).toString('hex'), runs: {} }; } };
const save = (st) => { fs.mkdirSync(dirOf(st.id), { recursive: true }); fs.writeFileSync(path.join(dirOf(st.id), 'state.json'), JSON.stringify(st, null, 2)); };

function certifiedLessons(st) {
  const { makeFixtureController } = require('../mind/qwen-learning-fixture');
  const queue = path.join(CHECKOUT, '.ai-workspace', 'qwen-mind-isolated', st.space, 'queue');
  return makeFixtureController({ repoRoot: CHECKOUT, space: st.space, queueDir: queue }).listLessons().filter((l) => l.status === 'validated' && l.certified);
}

function runStep(st, name, def) {
  if (st.runs[name]) return st.runs[name];
  const lessons = path.join(dirOf(st.id), 'lessons-' + name);
  const env = { ...process.env, QWEN_FIXTURE_MODEL: MODEL, QWEN_FIXTURE_TASK: def.task, QWEN_FIXTURE_TEACHER: String(def.teacher), QWEN_FIXTURE_USE_MIND: String(def.mind),
    QWEN_FIXTURE_MIND_SPACE: st.space, QWEN_FIXTURE_LESSONS_ROOT: lessons, QWEN_FIXTURE_TAG: st.id + ':' + name, QWEN_FIXTURE_DEADLINE_MIN: '25' };
  const r = cp.spawnSync(process.execPath, [HARNESS], { env, encoding: 'utf8', windowsHide: true, timeout: 32 * 60000, maxBuffer: 32 * 1024 * 1024 });
  let out; try { out = JSON.parse(r.stdout); } catch { throw Error('Harness gave no report: ' + String(r.stderr).slice(-400)); }
  const rep = JSON.parse(fs.readFileSync(out.historyFile, 'utf8'));
  const unavailable = (rep.teachingLog || []).find((x) => x.state !== 'completed');
  st.runs[name] = { step: name, ...def, at: new Date().toISOString(), historyFile: path.relative(CHECKOUT, out.historyFile), metrics: rep.metrics, cleanup: rep.cleanup, sourceUnchanged: rep.sourceUnchanged,
    lessonStates: rep.lessonStates, wideCheck: rep.wideCheck || null, finalAssertions: rep.finalAssertions ? { passed: rep.finalAssertions.passed, executed: rep.finalAssertions.executed, expected: rep.finalAssertions.expected } : null,
    invalid: unavailable ? 'teacher unavailable: ' + String(unavailable.error || '').slice(0, 80) : null };
  save(st);
  return st.runs[name];
}

function prep(id) {
  const st = load(id);
  for (let i = 1; i <= PREP_MAX; i++) {
    if (certifiedLessons(st).length) break;
    const r = runStep(st, 'P' + i, { phase: 'prep', task: 'average', teacher: 1, mind: 1 });
    process.stdout.write(JSON.stringify({ step: r.step, outcome: r.metrics.outcome, attempts: r.metrics.attempts, seconds: r.metrics.seconds, claude: r.metrics.claudeTokens, codex: r.metrics.codexTokens, invalid: r.invalid }) + '\n');
    if (r.invalid) { process.stdout.write('Teacher unavailable: stopping the preparation (quota).\n'); break; }
  }
  const c = certifiedLessons(st);
  st.prepared = c.map((l) => ({ id: l.id, errorClass: l.errorClass, evidenceCount: l.validation.evidenceCount, wide: l.validation.wide, principle: l.teaching.principle || null, reviewTaskId: l.validation.reviewTaskId }));
  save(st); process.stdout.write(JSON.stringify({ certifiedLessonsInMind: st.prepared.length, lessons: st.prepared }, null, 1) + '\n');
}

function compare(id) {
  const st = load(id);
  if (!st.prepared || !st.prepared.length) { process.stdout.write('No certified lesson in Mind: the comparison is not run (nothing to compare).\n'); return; }
  const order = [];
  for (let t = 1; t <= TRIALS; t++) for (const task of TASKS) { const arms = t % 2 ? ['nomem', 'mem'] : ['mem', 'nomem']; for (const arm of arms) order.push({ name: `E-${task}-${t}-${arm}`, task, trial: t, arm }); }
  for (const o of order) {
    const r = runStep(st, o.name, { phase: 'compare', task: o.task, trial: o.trial, arm: o.arm, teacher: 0, mind: o.arm === 'mem' ? 1 : 0 });
    process.stdout.write(JSON.stringify({ step: r.step, outcome: r.metrics.outcome, attempts: r.metrics.attempts, seconds: r.metrics.seconds, shown: r.metrics.methodsShown.length, claude: r.metrics.claudeTokens, codex: r.metrics.codexTokens }) + '\n');
  }
  summary(id);
}

function summary(id) {
  const st = load(id), rows = Object.values(st.runs), cmp = rows.filter((r) => r.phase === 'compare' && !r.invalid);
  const agg = (rs) => ({ runs: rs.length, approved: rs.filter((r) => r.metrics.approved).length, checksPassedThenReviewed: rs.filter((r) => r.metrics.codexReviews > 0).length,
    meanAttempts: rs.length ? Math.round(rs.reduce((a, r) => a + r.metrics.attempts, 0) / rs.length * 10) / 10 : null, meanSeconds: rs.length ? Math.round(rs.reduce((a, r) => a + r.metrics.seconds, 0) / rs.length) : null,
    qwenTokens: rs.reduce((a, r) => a + r.metrics.qwenTokens, 0), codexTokens: rs.reduce((a, r) => a + r.metrics.codexTokens, 0), claudeTokens: rs.reduce((a, r) => a + r.metrics.claudeTokens, 0), peakRamMB: Math.max(0, ...rs.map((r) => r.metrics.peakLlamaRamMB)),
    methodsShown: rs.reduce((a, r) => a + r.metrics.methodsShown.length, 0) });
  const arm = (a) => cmp.filter((r) => r.arm === a), per = {};
  for (const task of TASKS) per[task] = { nomem: agg(cmp.filter((r) => r.task === task && r.arm === 'nomem')), mem: agg(cmp.filter((r) => r.task === task && r.arm === 'mem')) };
  const nomem = agg(arm('nomem')), mem = agg(arm('mem'));
  const worseOnATask = TASKS.some((t) => per[t].mem.approved < per[t].nomem.approved);
  const complete = cmp.length === TASKS.length * TRIALS * 2;
  const verdict = !complete ? 'incomplete' : (mem.approved - nomem.approved >= 2 && !worseOnATask) ? 'gain-supported-by-the-preregistered-rule' : 'not-demonstrated';
  const prepRuns = rows.filter((r) => r.phase === 'prep');
  const out = { id, space: st.space, preparedLessons: st.prepared || [], prep: prepRuns.map((r) => ({ step: r.step, outcome: r.metrics.outcome, attempts: r.metrics.attempts, seconds: r.metrics.seconds, claudeCalls: r.metrics.claudeTeacherCalls, claudeTokens: r.metrics.claudeTokens, codexTokens: r.metrics.codexTokens, invalid: r.invalid })),
    comparison: { noMemory: nomem, memory: mem, perTask: per, preregisteredRule: 'gain only if memory approvals - no-memory approvals >= 2 AND memory not worse on any task', verdict },
    runs: cmp.map((r) => ({ step: r.step, task: r.task, trial: r.trial, arm: r.arm, outcome: r.metrics.outcome, attempts: r.metrics.attempts, seconds: r.metrics.seconds, qwenTokens: r.metrics.qwenTokens, codexReviews: r.metrics.codexReviews, codexTokens: r.metrics.codexTokens, claudeTokens: r.metrics.claudeTokens,
      peakLlamaRamMB: r.metrics.peakLlamaRamMB, methodsShown: r.metrics.methodsShown.map((m) => m.key), final: r.finalAssertions, wideCheck: r.wideCheck ? { inputs: r.wideCheck.inputs, mismatches: r.wideCheck.mismatches } : null, cleanup: r.cleanup, sourceUnchanged: r.sourceUnchanged })),
    invalid: rows.filter((r) => r.invalid).map((r) => r.step + ': ' + r.invalid),
    totals: { claudeTokens: rows.reduce((a, r) => a + r.metrics.claudeTokens, 0), claudeCalls: rows.reduce((a, r) => a + r.metrics.claudeTeacherCalls, 0), codexTokens: rows.reduce((a, r) => a + r.metrics.codexTokens, 0), codexReviews: rows.reduce((a, r) => a + r.metrics.codexReviews, 0), qwenTokens: rows.reduce((a, r) => a + r.metrics.qwenTokens, 0) } };
  process.stdout.write(JSON.stringify(out, null, 1) + '\n');
  return out;
}

const [cmd, id] = process.argv.slice(2);
if (!/^[a-z0-9-]{3,40}$/.test(id || '')) { process.stderr.write('usage: prep|compare|summary <id>\n'); process.exit(2); }
if (cmd === 'prep') prep(id); else if (cmd === 'compare') compare(id); else if (cmd === 'summary') summary(id); else { process.stderr.write('usage: prep|compare|summary <id>\n'); process.exit(2); }
