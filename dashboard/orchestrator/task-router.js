'use strict';
const { ProviderHealthManager } = require('./provider-health');
const { classifyTask, planWorkflow } = require('./task-roles');
const { isLocalProvider, getLocalProvider, isDirectLocal, estimateTokens, requiredContextTokens, routedTaskClasses } = require('./local-providers');
const n = (v, fallback = 0) => Number.isFinite(Number(v)) ? Number(v) : fallback;

// A healthy local provider whose capability class matches the task outranks
// every cloud provider except an explicit user preference.
const LOCAL_FIRST_BONUS = 800;
const PREFERENCE_BONUS = 5000;
const EXCLUDED = -2000;

function inferTask(task = {}) { const c = classifyTask(task); const caps = new Set(task.capabilities || []); if (c.roles.includes('reviewer') || c.roles.includes('security-reviewer')) caps.add('review'); if (c.roles.some(r => ['coder', 'debugger', 'tester'].includes(r))) caps.add('coding'); if (c.characteristics.repoReadRequired) caps.add('repo-edit'); if (c.characteristics.longRunning) caps.add('long-running'); if (c.characteristics.costSensitivity === 'high') caps.add('cheap-tasks'); return { capabilities: [...caps], needsRepo: c.characteristics.repoReadRequired, longRunning: c.characteristics.longRunning, review: c.roles.includes('reviewer') || c.roles.includes('security-reviewer'), complexity: c.characteristics.complexity, quality: c.characteristics.qualityRequirement, roles: c.roles, characteristics: c.characteristics, taskClass: c.taskClass }; }
function policyOf(task, config, options) { return String(options.policy || task.routingPolicy || config.AutoRoutingPolicy || 'BALANCED').toUpperCase(); }

class TaskRouter {
  constructor({ health, performance, getConfig = () => ({}) } = {}) { this.health = health || new ProviderHealthManager({ getConfig }); this.performance = performance; this.getConfig = getConfig; }

  _localVerdict(p, taskClass, promptTokens) {
    if (!routedTaskClasses(p.id, this.getConfig() || {}).includes(taskClass)) {
      const optIn = (getLocalProvider(p.id).optInTaskClasses || []).includes(taskClass);
      return { ok: false, reason: optIn ? `local ${p.id} disabled for ${taskClass} (opt-in: LocalFirst.enableCodexOssSmallEdit)` : `local ${p.id} not suited for ${taskClass} tasks` };
    }
    const required = requiredContextTokens(p.id, promptTokens);
    const elig = typeof this.health.localEligibility === 'function' ? this.health.localEligibility(p.id, { requiredTokens: required }) : { ok: false, reason: 'no-local-health-source' };
    return elig.ok ? { ok: true, required, contextTokens: elig.contextTokens } : { ok: false, reason: elig.reason, required };
  }

  selectProvider(task = {}, options = {}) {
    const inferred = inferTask(task); const role = options.role || task.role || inferred.roles[0]; const config = this.getConfig() || {}; const policy = policyOf(task, config, options); const excluded = new Set(options.exclude || []); const preferred = options.preferredProvider || task.preferredProvider || config.PreferredProvider;
    const ch = inferred.characteristics; const taskClass = inferred.taskClass;
    const promptTokens = n(options.promptTokens || task.estimatedPromptTokens, 0) || (estimateTokens(task.prompt || task.goal || '') + n(ch.expectedContextSize));
    // Local providers are listed even when unhealthy so the decision is explainable;
    // they are excluded by score, never silently.
    const candidates = Object.values(this.health.providers).filter(p => !excluded.has(p.id) && (isLocalProvider(p.id) ? p.enabled : this.health.isAvailable(p.id, { manual: false })));
    const threshold = ch.qualityRequirement === 'high' || ch.complexity === 'high' ? 3 : 1;
    const localSkipped = {};
    const scored = candidates.map(p => {
      const local = isLocalProvider(p.id);
      const profile = (p.roles && p.roles[role]) || {}; const history = this.performance && this.performance.get(p.id, role) || {}; const samples = n(history.attempts); const success = (n(history.successes) + 1) / (samples + 2); const prior = n(profile.priorCapability || profile.capability || p.qualityTier, 1) / 5; const confidence = Math.min(1, samples / 10); const roleScore = prior * (1 - confidence) + success * confidence;
      let score = roleScore * 100; const reasons = [`${role} role fit`, samples ? `${samples} measured ${role} result(s)` : 'cold-start prior'];
      if (local) {
        const v = this._localVerdict(p, taskClass, promptTokens);
        if (!v.ok) { localSkipped[p.id] = v.reason; score += EXCLUDED; reasons.push(`local skipped: ${v.reason}`); }
        else if (policy === 'QUALITY') reasons.push('local eligible but QUALITY policy prefers cloud');
        else { score += LOCAL_FIRST_BONUS; reasons.push(`local-first: ${taskClass} task, LM Studio healthy, ~${v.required} of ${v.contextTokens} ctx tokens`); }
      }
      if (n(profile.qualityTier || p.qualityTier, 1) < threshold && (role === 'security-reviewer' || ch.complexity === 'high')) { score -= 1000; reasons.push('below quality gate'); }
      if (!local && taskClass === 'complex' && n(p.qualityTier, 1) < 4) { score -= 300; reasons.push('complex task prefers quality >= 4'); }
      if (!local && taskClass === 'security' && n(p.qualityTier, 1) < 5) { score -= 400; reasons.push('security task prefers top quality'); }
      // Direct local providers get referenced files inlined at spawn time, so a
      // simple/read-only task that mentions a file is still within their reach.
      const directLocalReads = local && isDirectLocal(p.id);
      if (ch.repoReadRequired && !p.supportsRepo && !directLocalReads) score -= 1000;
      if (ch.repoWriteRequired && !p.supportsCodeChanges) score -= 400;
      if (ch.longRunning) score += p.supportsLongRunning ? 120 : -90;
      if (policy === 'QUALITY') score += n(p.qualityTier, 1) * 12;
      if (policy === 'ECONOMY' || ch.costSensitivity === 'high') score += (6 - n(p.costTier, 3)) * 30;
      if (policy === 'SPEED' || ch.latencySensitivity === 'high') score += n(p.speedTier, 3) * 12;
      if (ch.complexity === 'high' || ch.qualityRequirement === 'high') score += n(p.qualityTier, 1) * 18;
      if (role === 'summarizer' && (p.capabilities || []).includes('cheap-tasks')) score += 100;
      score -= n(history.reworkEvents) * 5 + n(p.consecutiveFailures) * 8;
      // An explicit user preference always wins (if that provider is usable).
      if (preferred === p.id && score > EXCLUDED / 2) { score += PREFERENCE_BONUS; reasons.push('user preference'); }
      const author = options.authorProvider || task.authorProvider || task.writerProvider; if ((role === 'reviewer' || role === 'security-reviewer') && author) { if (author !== p.id) { score += 25; reasons.push('independent from author'); } else { score -= 25; reasons.push('self-review fallback'); } }
      return { provider: p.id, locality: local ? 'local' : 'cloud', score: Math.round(score * 100) / 100, roleScore: Math.round(roleScore * 1000) / 1000, health: p.health, excluded: false, reasons };
    }).sort((a, b) => b.score - a.score);
    if (!scored.length || scored[0].score < -500) throw new Error(`No compatible providers are currently available for role ${role}`);
    const selected = scored[0]; const author = options.authorProvider || task.authorProvider || task.writerProvider;
    // Failover chain: usable CLOUD providers only, never another local model
    // (a weaker local would fail the same way, e.g. on context overflow), no dupes.
    const fallbackChain = [...new Set(scored.slice(1).filter(c => c.score > -500 && c.locality === 'cloud').map(c => c.provider))].filter(id => id !== selected.provider);
    return { provider: selected.provider, selectedProvider: selected.provider, locality: selected.locality, taskClass, estimatedPromptTokens: promptTokens, localSkipped, fallbackChain, selectedRole: role, score: selected.score, routingScore: selected.score, reason: selected.reasons, routingReason: selected.reasons, candidates: scored, routingCandidates: scored, policy, roles: inferred.roles, characteristics: ch, reviewIndependence: role === 'reviewer' || role === 'security-reviewer' ? !!author && selected.provider !== author : undefined, workflow: options.plan ? planWorkflow(task) : undefined };
  }
}
module.exports = { TaskRouter, inferTask, classifyTask, planWorkflow, LOCAL_FIRST_BONUS };
