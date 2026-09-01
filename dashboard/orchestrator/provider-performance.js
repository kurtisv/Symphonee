'use strict';
const fs = require('fs'); const path = require('path');
const INFRA_ERRORS = new Set(['AUTH_ERROR', 'RATE_LIMIT', 'QUOTA_EXHAUSTED', 'TIMEOUT', 'NETWORK_ERROR', 'PROVIDER_ERROR']);
class ProviderPerformanceStore {
  constructor({ file } = {}) { this.file = file; this.records = {}; this._load(); }
  _key(provider, role) { return `${String(provider).replace(/[^a-z0-9_.-]/gi, '_')}::${role}`; }
  _load() { try { const data = JSON.parse(fs.readFileSync(this.file, 'utf8')); if (data && typeof data === 'object') this.records = data; } catch (_) {} }
  _save() { if (!this.file) return; try { fs.mkdirSync(path.dirname(this.file), { recursive: true }); fs.writeFileSync(this.file, JSON.stringify(this.records, null, 2)); } catch (_) {} }
  get(provider, role) { return { attempts: 0, successes: 0, failures: 0, reworkEvents: 0, testPasses: 0, averageDurationMs: 0, averageInputTokens: 0, averageOutputTokens: 0, lastUpdatedAt: null, ...(this.records[this._key(provider, role)] || {}) }; }
  record(provider, role, outcome = {}) { if (!provider || !role) return null; const current = this.get(provider, role); const errorType = String(outcome.errorType || '').toUpperCase(); const eligible = outcome.qualityEligible !== false && !INFRA_ERRORS.has(errorType); current.attempts += eligible ? 1 : 0; if (eligible && outcome.ok) current.successes++; if (eligible && !outcome.ok) current.failures++; if (eligible && outcome.rework) current.reworkEvents++; if (eligible && outcome.testPassed) current.testPasses++; const avg = (old, value, count) => Number.isFinite(Number(value)) ? ((old * (count - 1)) + Number(value)) / count : old; if (eligible && current.attempts) { current.averageDurationMs = avg(current.averageDurationMs, outcome.durationMs, current.attempts); current.averageInputTokens = avg(current.averageInputTokens, outcome.inputTokens, current.attempts); current.averageOutputTokens = avg(current.averageOutputTokens, outcome.outputTokens, current.attempts); } current.lastUpdatedAt = new Date().toISOString(); this.records[this._key(provider, role)] = current; this._save(); return current; }
  publicRecords() { return JSON.parse(JSON.stringify(this.records)); }
}
module.exports = { ProviderPerformanceStore, INFRA_ERRORS };
