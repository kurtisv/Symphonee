'use strict';
// Indicators of what the local developer (Qwen) can really do, in the order the owner follows them.
// Pure functions over experiment data; nothing here starts a model or touches a repository.
//
//   1. categories of problems mastered
//   2. share of unseen tasks solved autonomously (no Claude)
//   3. tasks approved without Claude
//   4. transferable skills kept in Mind
//   5. Claude / Codex consumption per approved task
//   6. reliability, safety and quality of what was produced
// Qwen's own token use, time and RAM are reported as performance, never as something to minimise.
//
// A capability shown on fictional fixtures is NOT an authorisation to work on real projects.

// The categories the project wants covered. `tasks` lists the fixture tasks that exercise it today.
const CATEGORIES = Object.freeze([
  { id: 'bug-fixing', label: 'Bug fixing', tasks: [] },
  { id: 'feature-development', label: 'Feature development', tasks: [] },
  { id: 'refactoring', label: 'Refactoring', tasks: [] },
  { id: 'testing', label: 'Unit and integration tests', tasks: [] },
  { id: 'code-analysis', label: 'Code analysis', tasks: [] },
  { id: 'debugging', label: 'Debugging', tasks: [] },
  { id: 'files-and-modules', label: 'File and module handling', tasks: [] },
  { id: 'algorithms', label: 'Algorithms (single pure functions)', tasks: ['fizz', 'leap', 'max', 'countpos', 'average', 'meanabs', 'midrange', 'meanpos'] },
  { id: 'performance', label: 'Performance optimisation', tasks: [] },
  { id: 'integration', label: 'Integration between components', tasks: [] },
]);

// Fixed BEFORE measuring: a category counts as mastered only with enough distinct unseen tasks,
// repeated independent trials, a high autonomous approval rate and no unsafe run.
const MASTERY = Object.freeze({ minUnseenTasks: 3, minTrialsPerTask: 2, minAutonomousApprovalRate: 0.7 });

const round = (x, d = 1) => (x === null || !Number.isFinite(x) ? null : Math.round(x * 10 ** d) / 10 ** d);
const sum = (xs) => xs.reduce((a, b) => a + (Number.isFinite(b) ? b : 0), 0);

// results: the object saved by qwen-memory-experiment.manual.js `summary` (runs + prep + totals).
// Autonomous = a compare-phase run (the teacher is disabled there) that ended `fixture-approved`.
function computeIndicators(results, { categories = CATEGORIES, mastery = MASTERY } = {}) {
  const summary = results.summary || results, runs = summary.runs || [], prep = summary.prep || [], totals = summary.totals || {};
  const approved = runs.filter((r) => r.outcome === 'fixture-approved');
  const byArm = (arm) => runs.filter((r) => r.arm === arm), ok = (rs) => rs.filter((r) => r.outcome === 'fixture-approved');
  const rate = (rs) => (rs.length ? round(ok(rs).length / rs.length, 3) : null);

  const cat = categories.map((c) => {
    const rs = runs.filter((r) => c.tasks.includes(r.task)), tasks = [...new Set(rs.map((r) => r.task))];
    const perTask = tasks.map((t) => ({ task: t, trials: rs.filter((r) => r.task === t).length, approved: ok(rs.filter((r) => r.task === t)).length }));
    const autonomousRate = rs.length ? ok(rs).length / rs.length : null;
    const unsafe = rs.some((r) => !(r.cleanup && r.cleanup.tempRemoved && !(r.cleanup.dockerLeftovers || []).length) || r.sourceUnchanged === false || (r.wideCheck && r.wideCheck.mismatches !== 0 && ok([r]).length));
    const mastered = tasks.length >= mastery.minUnseenTasks && perTask.every((p) => p.trials >= mastery.minTrialsPerTask) && autonomousRate !== null && autonomousRate >= mastery.minAutonomousApprovalRate && !unsafe;
    return { id: c.id, label: c.label, covered: c.tasks.length > 0 && rs.length > 0, tasksMeasured: tasks.length, runs: rs.length, approved: ok(rs).length, autonomousApprovalRate: round(autonomousRate, 3), mastered,
      why: !rs.length ? 'no measurement yet' : mastered ? 'meets the pre-set rule' : 'needs ' + mastery.minUnseenTasks + '+ unseen tasks, ' + mastery.minTrialsPerTask + '+ trials each and >= ' + mastery.minAutonomousApprovalRate * 100 + '% autonomous approvals, currently ' + tasks.length + ' tasks and ' + round((autonomousRate || 0) * 100, 0) + '%' };
  });

  // Transfer evidence: a lesson was shown on a task other than the one it was validated on, and the run was approved.
  // Association only: nothing here proves the lesson was the cause.
  const lessons = (results.lessonsInMindAtTheEnd || []).map((l) => {
    const home = new Set((l.applicability && l.applicability.validatedOn) || [l.family]);
    const shown = runs.filter((r) => (r.methodsShown || []).length && !home.has(r.task));
    const winTasks = [...new Set(ok(shown).map((r) => r.task))];
    return { id: l.id, family: l.family, certified: Boolean(l.validation && l.validation.wideRequired !== undefined), shownOnOtherTasks: [...new Set(shown.map((r) => r.task))], succeededOn: winTasks, transferStrength: winTasks.length >= 2 ? 'repeated-near-transfer' : winTasks.length === 1 ? 'single-near-transfer' : 'none-observed' };
  });

  const claude = totals.claudeTokens || 0, codex = totals.codexTokens || 0;
  const codexCompare = sum(runs.map((r) => r.codexTokens)), claudeCompare = sum(runs.map((r) => r.claudeTokens));
  const prepCloud = sum(prep.map((p) => (p.claudeTokens || 0) + (p.codexTokens || 0)));
  const autoOk = ok(runs.filter((r) => r.arm));
  return {
    indicators: {
      '1_categoriesMastered': { mastered: cat.filter((c) => c.mastered).length, covered: cat.filter((c) => c.covered).length, total: cat.length, detail: cat },
      '2_unseenTasksSolvedAutonomously': { overall: { runs: runs.length, approved: approved.length, rate: rate(runs) }, withMemory: { runs: byArm('mem').length, approved: ok(byArm('mem')).length, rate: rate(byArm('mem')) }, withoutMemory: { runs: byArm('nomem').length, approved: ok(byArm('nomem')).length, rate: rate(byArm('nomem')) } },
      '3_tasksApprovedWithoutClaude': { count: approved.filter((r) => !r.claudeTokens).length, claudeTokensInComparison: claudeCompare },
      '4_transferableSkillsInMind': { lessons: lessons.length, withObservedNearTransfer: lessons.filter((l) => l.transferStrength !== 'none-observed').length, withRepeatedTransferOnTwoOrMoreOtherTasks: lessons.filter((l) => l.transferStrength === 'repeated-near-transfer').length, detail: lessons },
      '5_cloudTokensPerApprovedTask': { approved: approved.length, comparisonOnly: approved.length ? round((claudeCompare + codexCompare) / approved.length, 0) : null, includingPreparation: approved.length ? round((claude + codex) / approved.length, 0) : null,
        preparation: { claude: sum(prep.map((p) => p.claudeTokens)), codex: sum(prep.map((p) => p.codexTokens)), cloudTotal: prepCloud },
        netSaving: 'not established: no measured baseline of cloud tokens per task without the local developer; with 0 approvals without memory there is nothing to compare against' },
      '6_reliabilitySafetyQuality': { runs: runs.length, cleanedUp: runs.filter((r) => r.cleanup && r.cleanup.tempRemoved && !(r.cleanup.dockerLeftovers || []).length).length, sourcesUnchanged: runs.filter((r) => r.sourceUnchanged !== false).length,
        approvedWithStressZeroMismatch: autoOk.filter((r) => r.wideCheck && r.wideCheck.mismatches === 0).length, approvedTotal: autoOk.length },
    },
    performance: { qwenTokens: sum(runs.map((r) => r.qwenTokens)), meanSeconds: runs.length ? round(sum(runs.map((r) => r.seconds)) / runs.length, 0) : null, meanAttempts: runs.length ? round(sum(runs.map((r) => r.attempts)) / runs.length, 1) : null, peakRamMB: Math.max(0, ...runs.map((r) => r.peakLlamaRamMB || 0)),
      note: 'Qwen runs locally: its tokens are a measure, not a budget.' },
    scope: 'fictional fixtures only; not an authorisation to work on real projects',
  };
}

module.exports = { CATEGORIES, MASTERY, computeIndicators };
