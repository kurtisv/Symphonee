'use strict';

const { ProviderHealthManager } = require('./provider-health');

function textOf(task) { return [task.goal, task.prompt, task.description, ...(task.capabilities || [])].filter(Boolean).join(' ').toLowerCase(); }
function inferTask(task = {}) {
  const text = textOf(task);
  const capabilities = new Set(task.capabilities || []);
  if (/review|audit|inspect|critique/.test(text)) capabilities.add('review');
  if (/summar|small analysis|classif|cheap|extract|compress/.test(text)) capabilities.add('cheap-tasks');
  if (/long.?running|overnight|async|autonomous|github/.test(text)) capabilities.add('long-running');
  if (/test|debug|fix|implement|refactor|code|modify|edit/.test(text)) capabilities.add('coding');
  if (/repo|repository|file|working tree/.test(text)) capabilities.add('repo-edit');
  return { capabilities: [...capabilities], needsRepo: task.needsRepo || /repo|repository|working tree|file/.test(text), longRunning: !!task.longRunning || /long.?running|overnight|async|autonomous/.test(text), review: capabilities.has('review'), complexity: task.complexity || (/architecture|complex|refactor|security/.test(text) ? 'high' : 'normal'), quality: task.quality || (capabilities.has('review') ? 'high' : 'normal') };
}

class TaskRouter {
  constructor({ health, getConfig = () => ({}) } = {}) { this.health = health || new ProviderHealthManager({ getConfig }); this.getConfig = getConfig; }
  selectProvider(task = {}, options = {}) {
    const inferred = inferTask(task); const excluded = new Set(options.exclude || []);
    const preferred = options.preferredProvider || task.preferredProvider || this.getConfig().PreferredProvider;
    const candidates = Object.values(this.health.providers).filter(p => !excluded.has(p.id) && this.health.isAvailable(p.id, { manual: false }));
    if (!candidates.length) throw new Error('No compatible providers are currently available');
    const scored = candidates.map(p => {
      let score = 0; const reasons = [];
      const matches = inferred.capabilities.filter(c => p.capabilities.includes(c)).length;
      score += matches * 28; if (matches) reasons.push(`${matches} capability match`);
      if (inferred.capabilities.includes('cheap-tasks')) {
        score += (6 - p.costTier) * 10;
        reasons.push('lower cost for cheap task');
      }
      if (inferred.needsRepo && !p.supportsRepo) score -= 100;
      if (inferred.longRunning) { score += p.supportsLongRunning ? 90 : -30; if (p.supportsLongRunning) reasons.push('long-running support'); }
      if (inferred.complexity === 'high') { score += p.qualityTier * 12; reasons.push('quality for complex task'); }
      if (options.preferCheaper || this.getConfig().PreferCheaperProviders) { score += (6 - p.costTier) * 10; reasons.push('lower cost'); }
      if (this.getConfig().PreservePremiumProviders && inferred.complexity !== 'high') score -= p.qualityTier * 4;
      score -= p.consecutiveFailures * 8;
      if (preferred === p.id) { score += 60; reasons.push('user preference'); }
      if (inferred.review && task.writerProvider && task.writerProvider !== p.id) { score += 35; reasons.push('different review provider'); }
      if (inferred.review && task.writerProvider === p.id) score -= 20;
      return { provider: p.id, score, reasons };
    }).sort((a, b) => b.score - a.score);
    const selected = scored[0];
    return { provider: selected.provider, score: selected.score, reason: selected.reasons, candidates: scored };
  }
}

module.exports = { TaskRouter, inferTask };
