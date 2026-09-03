'use strict';

const { CLI_CONFIG, HEADLESS_FLAGS } = require('./cli-config');

const ERROR_TYPES = Object.freeze({
  AUTH_ERROR: 'AUTH_ERROR', RATE_LIMIT: 'RATE_LIMIT', QUOTA_EXHAUSTED: 'QUOTA_EXHAUSTED',
  TIMEOUT: 'TIMEOUT', NETWORK_ERROR: 'NETWORK_ERROR', PROVIDER_ERROR: 'PROVIDER_ERROR',
  TASK_ERROR: 'TASK_ERROR',
});

const DEFAULT_CAPABILITIES = {
  codex: ['coding', 'debugging', 'review', 'repo-edit', 'tests', 'high-reasoning'],
  claude: ['coding', 'architecture', 'review', 'reasoning', 'repo-edit'],
  'gemini-api': ['analysis', 'summarization', 'research-like reasoning', 'cheap-tasks', 'classification', 'context-compression'],
  gemini: ['coding', 'analysis', 'repo tasks'],
  antigravity: ['coding', 'repo-edit', 'tests', 'autonomous-task'],
  jules: ['long-running', 'repo-analysis', 'autonomous-task', 'async'],
  copilot: ['coding', 'review', 'analysis'],
  grok: ['analysis', 'summarization', 'classification'],
  qwen: ['coding', 'analysis', 'cheap-tasks'],
};

const DEFAULTS = {
  codex: { costTier: 3, speedTier: 3, qualityTier: 5, type: 'cli' },
  claude: { costTier: 5, speedTier: 3, qualityTier: 5, type: 'cli' },
  'gemini-api': { costTier: 1, speedTier: 5, qualityTier: 3, type: 'api' },
  gemini: { costTier: 2, speedTier: 4, qualityTier: 3, type: 'cli' },
  antigravity: { costTier: 1, speedTier: 3, qualityTier: 3, type: 'cli' },
  jules: { costTier: 2, speedTier: 1, qualityTier: 4, type: 'remote' },
  copilot: { costTier: 1, speedTier: 4, qualityTier: 3, type: 'cli' },
  grok: { costTier: 2, speedTier: 4, qualityTier: 3, type: 'cli' },
  qwen: { costTier: 2, speedTier: 4, qualityTier: 3, type: 'cli' },
};

function classifyProviderError(error) {
  const message = String(error && error.message || error || '');
  if (/401|403|unauthori[sz]ed|invalid.{0,8}(api|key)|authentication|not logged in|api key/i.test(message)) return ERROR_TYPES.AUTH_ERROR;
  if (/429|rate.?limit|too many requests|throttl/i.test(message)) return ERROR_TYPES.RATE_LIMIT;
  if (/quota|resource_exhausted|usage limit|out of credits|insufficient.{0,10}(credit|quota)|billing|payment required/i.test(message)) return ERROR_TYPES.QUOTA_EXHAUSTED;
  if (/timeout|timed out|deadline exceeded/i.test(message)) return ERROR_TYPES.TIMEOUT;
  if (/ECONNRESET|ECONNREFUSED|ENOTFOUND|EPIPE|network|socket|fetch failed/i.test(message)) return ERROR_TYPES.NETWORK_ERROR;
  if (/provider|service unavailable|503|502|500/i.test(message)) return ERROR_TYPES.PROVIDER_ERROR;
  return ERROR_TYPES.TASK_ERROR;
}

function isFailoverEligible(type) {
  return [ERROR_TYPES.RATE_LIMIT, ERROR_TYPES.QUOTA_EXHAUSTED, ERROR_TYPES.TIMEOUT, ERROR_TYPES.NETWORK_ERROR, ERROR_TYPES.PROVIDER_ERROR].includes(type);
}

function buildProviderRegistry({ config = {}, availability = {}, now = Date.now() } = {}) {
  const enabledList = Array.isArray(config.OrchestrateCliList) && config.OrchestrateCliList.length
    ? new Set(config.OrchestrateCliList) : null;
  const result = {};
  for (const id of Object.keys(CLI_CONFIG)) {
    const meta = CLI_CONFIG[id] || {};
    const d = DEFAULTS[id] || { costTier: meta.costRank || 3, speedTier: 3, qualityTier: meta.tier || 3, type: meta.isRemote ? 'remote' : 'cli' };
    const prior = availability[id] || {};
    const cooldownUntil = Number(prior.cooldownUntil || 0);
    result[id] = {
      id, enabled: enabledList ? enabledList.has(id) : prior.enabled !== false,
      available: prior.available !== undefined ? !!prior.available : true,
      type: d.type, capabilities: [...(prior.capabilities || DEFAULT_CAPABILITIES[id] || [])],
      costTier: prior.costTier || d.costTier, speedTier: prior.speedTier || d.speedTier,
      qualityTier: prior.qualityTier || d.qualityTier,
      supportsCodeChanges: prior.supportsCodeChanges !== undefined ? !!prior.supportsCodeChanges : ['codex', 'claude', 'gemini', 'antigravity', 'copilot', 'qwen'].includes(id),
      supportsRepo: prior.supportsRepo !== undefined ? !!prior.supportsRepo : id !== 'gemini-api',
      supportsLongRunning: prior.supportsLongRunning !== undefined ? !!prior.supportsLongRunning : id === 'jules',
      usage: { ...(prior.usage || {}) },
      health: prior.health || 'healthy', cooldownUntil: cooldownUntil > now ? cooldownUntil : 0,
      consecutiveFailures: Number(prior.consecutiveFailures || 0), lastFailure: prior.lastFailure || null, lastSuccess: prior.lastSuccess || null,
      roles: { ...((config.ProviderRoleProfiles && config.ProviderRoleProfiles[id]) || {}), ...((prior.roles) || {}) },
    };
  }
  return result;
}

class ProviderHealthManager {
  constructor({ getConfig = () => ({}), cooldownMs = 5 * 60 * 1000, availability = {}, now = () => Date.now() } = {}) {
    this.getConfig = getConfig; this.cooldownMs = cooldownMs; this.now = now;
    this.providers = buildProviderRegistry({ config: getConfig(), availability, now: now() });
  }
  refresh() { this.providers = buildProviderRegistry({ config: this.getConfig(), availability: this.providers, now: this.now() }); return this.providers; }
  get(id) { return this.providers[id]; }
  isAvailable(id, { manual = false } = {}) {
    const p = this.providers[id];
    if (!p || !p.enabled || !p.available) return false;
    if (!manual && p.cooldownUntil && p.cooldownUntil > this.now()) return false;
    return true;
  }
  recordUsage(id, usage = {}) { const p = this.providers[id]; if (!p) return; p.usage = { ...p.usage, ...usage }; }
  recordOutcome(id, { ok, error, usage } = {}) {
    const p = this.providers[id]; if (!p) return null;
    if (usage) this.recordUsage(id, usage);
    if (ok) { p.health = 'healthy'; p.consecutiveFailures = 0; p.lastSuccess = this.now(); p.cooldownUntil = 0; return null; }
    const errorClassification = typeof error === 'string' && Object.values(ERROR_TYPES).includes(error) ? error : classifyProviderError(error);
    p.lastFailure = this.now();
    if (isFailoverEligible(errorClassification)) {
      p.consecutiveFailures += 1; p.health = 'cooling_down'; p.cooldownUntil = this.now() + this.cooldownMs;
    } else {
      p.health = errorClassification === ERROR_TYPES.AUTH_ERROR ? 'auth_error' : 'task_error';
      // Non-transient provider failures still need a bounded recovery window;
      // otherwise auto-routing retries the same broken provider forever.
      p.cooldownUntil = this.now() + this.cooldownMs;
    }
    return errorClassification;
  }
  publicStatus() { return Object.fromEntries(Object.entries(this.providers).map(([id, p]) => [id, { ...p, usage: { ...p.usage } }])); }
}

module.exports = { ERROR_TYPES, DEFAULT_CAPABILITIES, classifyProviderError, isFailoverEligible, buildProviderRegistry, ProviderHealthManager };
