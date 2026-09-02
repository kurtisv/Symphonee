'use strict';

const crypto = require('crypto');

function estimateTokens(value) {
  const text = typeof value === 'string' ? value : '';
  return text ? Math.max(1, Math.ceil(Buffer.byteLength(text, 'utf8') / 4)) : 0;
}

function capContext(value, maxChars) {
  const text = typeof value === 'string' ? value.trim() : '';
  const limit = Math.max(0, Number(maxChars) || 0);
  if (!text || !limit || text.length <= limit) return text;
  const marker = `\n[context truncated: ${text.length - limit} chars omitted]\n`;
  const available = Math.max(0, limit - marker.length);
  const head = Math.ceil(available * 0.7);
  return text.slice(0, head) + marker + text.slice(-(available - head));
}

function requestFingerprint({ cli, prompt, cwd, model, space, role } = {}) {
  const normalized = [cli || '', String(prompt || '').trim().replace(/\s+/g, ' '), cwd || '', model || '', space || '', role || ''].join('\n');
  return crypto.createHash('sha256').update(normalized).digest('hex');
}

function summarizeTasks(tasks) {
  const list = [...(tasks && typeof tasks.values === 'function' ? tasks.values() : tasks || [])];
  const summary = {
    tasks: list.length, measuredTasks: 0, inputTokens: 0, outputTokens: 0,
    cachedTokens: 0, estimatedPromptTokens: 0, contextTokensAdded: 0,
    duplicateSpawnsAvoided: 0, localAnswers: 0, byProvider: {},
  };
  for (const task of list) {
    const usage = task.geminiUsage || task.usage || {};
    const input = Number(usage.inputTokens) || 0;
    const output = Number(usage.outputTokens) || 0;
    const cached = Number(usage.cachedTokens) || 0;
    if (input || output || cached) summary.measuredTasks++;
    summary.inputTokens += input; summary.outputTokens += output; summary.cachedTokens += cached;
    summary.estimatedPromptTokens += Number(task.promptMetrics && task.promptMetrics.finalEstimatedTokens) || estimateTokens(task.prompt);
    summary.contextTokensAdded += Number(task.promptMetrics && task.promptMetrics.contextEstimatedTokens) || 0;
    summary.duplicateSpawnsAvoided += Number(task.duplicateHits) || 0;
    if (task.handledLocally) summary.localAnswers++;
    const provider = task.selectedProvider || task.cli || 'local';
    const row = summary.byProvider[provider] || { tasks: 0, inputTokens: 0, outputTokens: 0, cachedTokens: 0 };
    row.tasks++; row.inputTokens += input; row.outputTokens += output; row.cachedTokens += cached;
    summary.byProvider[provider] = row;
  }
  summary.measurementCoverage = summary.tasks ? Math.round(summary.measuredTasks / summary.tasks * 1000) / 10 : 0;
  return summary;
}

module.exports = { estimateTokens, capContext, requestFingerprint, summarizeTasks };
