'use strict';
// OFFLINE analysis (no model, no cloud call) of dashboard/mind/QWEN_MEMORY_EXPERIMENT_RESULTS.json:
//   1. why the attempts failed (Qwen's reasoning, a badly adapted lesson, the strict checker, a naming slip ...)
//   2. what the applicability gate decides for each task, using the lesson that was really validated
//   3. the six indicators, with the cloud cost per approved task
//   node qwen-memory-analysis.manual.js            print and write dashboard/mind/QWEN_MEMORY_ANALYSIS.json
const fs = require('node:fs'), path = require('node:path');
const F = require('../mind/qwen-failure-analysis');
const A = require('../mind/lesson-applicability');
const { computeIndicators } = require('../mind/qwen-skills-ledger');
const { TASKS } = require('./qwen-fixture-tasks');

const dataFile = path.join(__dirname, '..', 'mind', 'QWEN_MEMORY_EXPERIMENT_RESULTS.json');
const data = JSON.parse(fs.readFileSync(dataFile, 'utf8'));

// 1. failure taxonomy per arm and per task
const rows = [];
for (const [step, run] of Object.entries(data.attemptsByRun)) {
  const m = /^E-([a-z]+)-(\d)-(mem|nomem)$/.exec(step); if (!m) continue;
  const r = F.analyzeRun(run.attempts);
  rows.push({ step, task: m[1], arm: m[3], outcome: run.outcome, counts: r.counts, repeatedSubmissions: r.repeatedSubmissions, attempts: run.attempts.length });
}
const add = (a, b) => { for (const [k, v] of Object.entries(b)) a[k] = (a[k] || 0) + v; return a; };
const tally = (rs) => rs.reduce((a, r) => add(a, r.counts), {});
const taxonomy = { overall: tally(rows), memory: tally(rows.filter((r) => r.arm === 'mem')), noMemory: tally(rows.filter((r) => r.arm === 'nomem')),
  byTask: Object.fromEntries([...new Set(rows.map((r) => r.task))].map((t) => [t, tally(rows.filter((r) => r.task === t))])),
  repeatedSubmissions: rows.reduce((a, r) => a + r.repeatedSubmissions, 0), failedAttempts: rows.reduce((a, r) => a + Object.values(r.counts).reduce((x, y) => x + y, 0), 0) };

// 2. gate replay: the lesson validated in preparation, given the structured metadata it would carry today
const prepRun = data.attemptsByRun.P3, winning = prepRun.attempts.filter((a) => a.codexDecision === 'GO').at(-1);
const stored = data.lessonsInMindAtTheEnd[0];
const lesson = { key: stored.id, applicability: A.buildApplicability({ profile: TASKS.find((t) => t.id === 'average').profile, code: winning.code, family: 'average', wide: stored.validation.wide }) };
const replay = TASKS.map((t) => { const r = A.assess(lesson, t.profile); return { task: t.id, hazard: t.profile.hazard, kind: t.profile.kind, applicable: r.applicable, reasons: r.reasons }; });

// 3. indicators
const indicators = computeIndicators(data);

// Reading: kept short and conservative on purpose.
const reading = [
  'Failures are dominated by ' + Object.entries(taxonomy.overall).sort((a, b) => b[1] - a[1]).map(([k, v]) => k + ' (' + v + ')').join(', ') + '.',
  taxonomy.repeatedSubmissions + ' of ' + taxonomy.failedAttempts + ' failed attempts re-submitted the previous code unchanged: that is the no-progress signal the loop already uses to stop.',
  'The gate keeps the lesson for the four tasks that share its hazard (intermediate overflow of a numeric array aggregate) and removes it from the four that do not; it does not (and must not) decide transfer.',
  'Nine of the ten requested skill categories have no measurement yet; the experiments so far cover only single pure functions.',
];
const out = { generatedFrom: 'QWEN_MEMORY_EXPERIMENT_RESULTS.json', offline: true, aiCalls: 0, taxonomy, perRun: rows, gateReplay: replay, indicators: indicators.indicators, performance: indicators.performance, scope: indicators.scope, reading };
fs.writeFileSync(path.join(__dirname, '..', 'mind', 'QWEN_MEMORY_ANALYSIS.json'), JSON.stringify(out, null, 1) + '\n');
process.stdout.write(JSON.stringify({ taxonomy, gateReplay: replay.map((r) => r.task + ':' + r.applicable), indicators: Object.fromEntries(Object.entries(indicators.indicators).map(([k, v]) => [k, k.startsWith('1_') ? { mastered: v.mastered, covered: v.covered, total: v.total } : k.startsWith('4_') ? { lessons: v.lessons, nearTransfer: v.withObservedNearTransfer, repeated: v.withRepeatedTransferOnTwoOrMoreOtherTasks } : v])), reading }, null, 1) + '\n');
