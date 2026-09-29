'use strict';

const { CLI_CONFIG, HEADLESS_FLAGS } = require('./cli-config');
const { isLocalProvider, canonicalProviderId, localFirstConfig } = require('./local-providers');

const ERROR_TYPES = Object.freeze({
  AUTH_ERROR: 'AUTH_ERROR', RATE_LIMIT: 'RATE_LIMIT', QUOTA_EXHAUSTED: 'QUOTA_EXHAUSTED',
  TIMEOUT: 'TIMEOUT', NETWORK_ERROR: 'NETWORK_ERROR', PROVIDER_ERROR: 'PROVIDER_ERROR',
  TASK_ERROR: 'TASK_ERROR', RUNTIME_INCOMPATIBLE: 'RUNTIME_INCOMPATIBLE', STARTUP_ERROR: 'STARTUP_ERROR',
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
  'codex-oss-local': ['coding', 'repo-edit', 'tests', 'shell', 'cheap-tasks', 'offline', 'local'],
  'claude-local': ['coding', 'repo-edit', 'tests', 'docs', 'cheap-tasks', 'offline', 'local'],
  'lmstudio-qwen-small': ['summarization', 'classification', 'extraction', 'context-compression', 'cheap-tasks', 'offline', 'local'],
  'lmstudio-qwen-review': ['analysis', 'review', 'explanation', 'cheap-tasks', 'offline', 'local'],
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
  // Local providers: costTier 0 (free), type 'local'. Quality is deliberately
  // low so quality gates keep them off complex / security work.
  'codex-oss-local': { costTier: 0, speedTier: 1, qualityTier: 2, type: 'local' },
  'claude-local': { costTier: 0, speedTier: 1, qualityTier: 2, type: 'local' },
  'lmstudio-qwen-small': { costTier: 0, speedTier: 4, qualityTier: 2, type: 'local' },
  'lmstudio-qwen-review': { costTier: 0, speedTier: 3, qualityTier: 3, type: 'local' },
};

function classifyProviderError(error) {
  const message = String(error && error.message || error || '');
  if (/401|403|unauthori[sz]ed|invalid.{0,8}(api|key)|authentication|not logged in|api key/i.test(message)) return ERROR_TYPES.AUTH_ERROR;
  if (/429|rate.?limit|too many requests|throttl/i.test(message)) return ERROR_TYPES.RATE_LIMIT;
  if (/quota|resource_exhausted|usage limit|out of credits|insufficient.{0,10}(credit|quota)|billing|payment required/i.test(message)) return ERROR_TYPES.QUOTA_EXHAUSTED;
  if (/timeout|timed out|deadline exceeded/i.test(message)) return ERROR_TYPES.TIMEOUT;
  if (/requires? node|unsupported engine|node\.js version|minimum.*node|ebadengine|runtime incompatible/i.test(message)) return ERROR_TYPES.RUNTIME_INCOMPATIBLE;
  if (/ECONNRESET|ECONNREFUSED|ENOTFOUND|EPIPE|network|socket|fetch failed/i.test(message)) return ERROR_TYPES.NETWORK_ERROR;
  if (/provider|service unavailable|503|502|500/i.test(message)) return ERROR_TYPES.PROVIDER_ERROR;
  return ERROR_TYPES.TASK_ERROR;
}

function isFailoverEligible(type) {
  return [ERROR_TYPES.RATE_LIMIT, ERROR_TYPES.QUOTA_EXHAUSTED, ERROR_TYPES.TIMEOUT, ERROR_TYPES.NETWORK_ERROR, ERROR_TYPES.PROVIDER_ERROR].includes(type);
}

function buildProviderRegistry({ config = {}, availability = {}, now = Date.now() } = {}) {
  const enabledList = Array.isArray(config.OrchestrateCliList) && config.OrchestrateCliList.length
    ? new Set(config.OrchestrateCliList.map(canonicalProviderId)) : null;
  // Local providers are governed by LocalFirst.enabled (default on), not by the
  // cloud CLI allow-list: they cost nothing and are gated by the live LM Studio
  // health check instead.
  const localEnabled = localFirstConfig(config).enabled;
  const result = {};
  for (const id of Object.keys(CLI_CONFIG)) {
    const meta = CLI_CONFIG[id] || {};
    const d = DEFAULTS[id] || { costTier: meta.costRank || 3, speedTier: 3, qualityTier: meta.tier || 3, type: meta.isRemote ? 'remote' : 'cli' };
    const prior = availability[id] || {};
    const cooldownUntil = Number(prior.cooldownUntil || 0);
    result[id] = {
      id, enabled: isLocalProvider(id) ? (localEnabled && prior.enabled !== false) : enabledList ? enabledList.has(id) : prior.enabled !== false,
      locality: isLocalProvider(id) ? 'local' : 'cloud',
      available: prior.available !== undefined ? !!prior.available : true,
      type: d.type, capabilities: [...(prior.capabilities || DEFAULT_CAPABILITIES[id] || [])],
      costTier: prior.costTier || d.costTier, speedTier: prior.speedTier || d.speedTier,
      qualityTier: prior.qualityTier || d.qualityTier,
      supportsCodeChanges: prior.supportsCodeChanges !== undefined ? !!prior.supportsCodeChanges : ['codex', 'claude', 'gemini', 'antigravity', 'copilot', 'qwen', 'codex-oss-local', 'claude-local'].includes(id),
      supportsRepo: prior.supportsRepo !== undefined ? !!prior.supportsRepo : !['gemini-api', 'lmstudio-qwen-small', 'lmstudio-qwen-review'].includes(id),
      supportsLongRunning: prior.supportsLongRunning !== undefined ? !!prior.supportsLongRunning : id === 'jules',
      usage: { ...(prior.usage || {}) },
      health: prior.health || 'healthy', reason: prior.reason || null, cooldownUntil: cooldownUntil > now ? cooldownUntil : 0,
      consecutiveFailures: Number(prior.consecutiveFailures || 0), lastFailure: prior.lastFailure || null, lastSuccess: prior.lastSuccess || null,
      roles: { ...((config.ProviderRoleProfiles && config.ProviderRoleProfiles[id]) || {}), ...((prior.roles) || {}) },
    };
  }
  return result;
}

class ProviderHealthManager {
  constructor({ getConfig = () => ({}), cooldownMs = 5 * 60 * 1000, availability = {}, now = () => Date.now(), localHealth = null } = {}) {
    this.getConfig = getConfig; this.cooldownMs = cooldownMs; this.now = now; this.localHealth = localHealth;
    this.providers = buildProviderRegistry({ config: getConfig(), availability, now: now() });
  }
  refresh() { this.providers = buildProviderRegistry({ config: this.getConfig(), availability: this.providers, now: this.now() }); return this.providers; }
  get(id) { return this.providers[id]; }
  isAvailable(id, { manual = false } = {}) {
    const p = this.providers[id];
    if (!p || !p.enabled || !p.available) return false;
    if (!manual && p.cooldownUntil && p.cooldownUntil > this.now()) return false;
    // Local providers additionally need a healthy LM Studio. No health source
    // (or not checked yet) means unavailable: fail closed to cloud.
    if (isLocalProvider(id)) return !!(this.localHealth && this.localHealth.eligibility(id).ok);
    return true;
  }
  localEligibility(id, opts) {
    if (!isLocalProvider(id)) return { ok: true };
    if (!this.localHealth) return { ok: false, reason: 'no-local-health-source' };
    return this.localHealth.eligibility(id, opts);
  }
  recordUsage(id, usage = {}) { const p = this.providers[id]; if (!p) return; p.usage = { ...p.usage, ...usage }; }
  recordOutcome(id, { ok, error, usage, cooldown = true } = {}) {
    const p = this.providers[id]; if (!p) return null;
    if (usage) this.recordUsage(id, usage);
    if (ok) { p.health = 'healthy'; p.reason = null; p.available = true; p.consecutiveFailures = 0; p.lastSuccess = this.now(); p.cooldownUntil = 0; return null; }
    const errorClassification = typeof error === 'string' && Object.values(ERROR_TYPES).includes(error) ? error : classifyProviderError(error);
    p.lastFailure = this.now();
    p.reason = errorClassification;
    // A failure caused by the task itself (e.g. prompt too large for a local
    // model) says nothing about the provider's health: record it, no cooldown.
    if (cooldown === false) return errorClassification;
    if (errorClassification === ERROR_TYPES.RUNTIME_INCOMPATIBLE) {
      p.available = false; p.health = 'unavailable'; p.cooldownUntil = this.now() + this.cooldownMs;
    } else if (isFailoverEligible(errorClassification)) {
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
