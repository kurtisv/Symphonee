'use strict';
// Read-only token economy report.  Usage measured by a provider is never
// inferred from estimates, and missing usage never counts as zero consumption.
const { estimateTokens } = require('./local-providers');
const { ROUTES } = require('./routing-telemetry');

function knownUsageNumber(usage, key) {
  const value = usage && usage[key];
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

function summarizeEconomy({ tasks, routingTelemetry } = {}) {
  const taskList = tasks && typeof tasks.values === 'function'
    ? [...tasks.values()] : Array.isArray(tasks) ? tasks : [];
  const summary = {
    taskCount: taskList.length,
    measuredUsageTasks: 0,
    unknownUsageTasks: 0,
    usageCoveragePercent: 0,
    measuredInputTokens: 0,
    measuredOutputTokens: 0,
    measuredCachedTokens: 0,
    measuredTotalOnlyTokens: 0,
    estimatedPromptTokens: 0,
    estimatedPromptTasks: 0,
    localAnswersObserved: 0,
    byProvider: {},
    // Explicitly unknown until the corresponding measurements exist.
    contextOverheadTokens: null,
    duplicateSpawnsAvoided: null,
    monetarySavingsUsd: null,
    notes: [
      'Measured provider usage is separate from estimated prompt size.',
      'Cached tokens can be part of input usage and are NOT added to measured input totals.',
      'Local brain answers are observed only after this instrumentation is installed; historical answers are not reconstructed.',
      'Unknown usage or cost is not zero usage or zero cost.',
    ],
  };
  for (const task of taskList) {
    if (!task || typeof task !== 'object') continue;
    const provider = String(task.selectedProvider || task.cli || 'unknown');
    const row = summary.byProvider[provider] || {
      tasks: 0, measuredUsageTasks: 0, unknownUsageTasks: 0,
      measuredInputTokens: 0, measuredOutputTokens: 0, measuredCachedTokens: 0,
      measuredTotalOnlyTokens: 0,
    };
    row.tasks++;
    // Gemini seeds a zero-valued usage object BEFORE calling the API.
    // Its extractor also falls back to all zeros when metadata is absent.
    // Zero-only Gemini data is therefore not evidence of measured usage.
    const g = task.geminiUsage;
    const geminiZeroPlaceholder = g && ['inputTokens', 'outputTokens', 'totalTokens', 'cachedTokens', 'thoughtTokens']
      .every(key => knownUsageNumber(g, key) === 0);
    const usage = geminiZeroPlaceholder ? null : g || task.usage || null;
    const input = knownUsageNumber(usage, 'inputTokens');
    const output = knownUsageNumber(usage, 'outputTokens');
    const cached = knownUsageNumber(usage, 'cachedTokens') ?? knownUsageNumber(usage, 'cacheReadTokens');
    const total = knownUsageNumber(usage, 'totalTokens');
    if ([input, output, cached, total].some(value => value !== null)) {
      summary.measuredUsageTasks++;
      row.measuredUsageTasks++;
      // A total-only report (e.g. Codex stderr) is not mistaken for input/output.
      if (input === null && output === null && total !== null) {
        summary.measuredTotalOnlyTokens += total;
        row.measuredTotalOnlyTokens += total;
      }
    } else {
      summary.unknownUsageTasks++;
      row.unknownUsageTasks++;
    }
    summary.measuredInputTokens += input ?? 0;
    summary.measuredOutputTokens += output ?? 0;
    summary.measuredCachedTokens += cached ?? 0;
    row.measuredInputTokens += input ?? 0;
    row.measuredOutputTokens += output ?? 0;
    row.measuredCachedTokens += cached ?? 0;
    summary.byProvider[provider] = row;

    const knownEstimate = knownUsageNumber(task, 'estimatedPromptTokens');
    const estimate = knownEstimate !== null
      ? knownEstimate
      : typeof task.prompt === 'string' ? estimateTokens(task.prompt) : null;
    if (estimate !== null) {
      summary.estimatedPromptTasks++;
      summary.estimatedPromptTokens += estimate;
    }
  }
  summary.usageCoveragePercent = summary.taskCount
    ? Math.round(1000 * summary.measuredUsageTasks / summary.taskCount) / 10 : 0;
  const records = routingTelemetry && Array.isArray(routingTelemetry.records)
    ? routingTelemetry.records : [];
  summary.localAnswersObserved = records.filter(record => record && record.route === ROUTES.LOCAL_BRAIN).length;
  return summary;
}

module.exports = { knownUsageNumber, summarizeEconomy };
