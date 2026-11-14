'use strict';
// Pure, fail-closed policy. No provider calls and no changes to live configuration.
function classify(error) {
  const s = String(error || '');
  if (/security|permission|denied|unauthori|auth|\b401\b|\b403\b/i.test(s)) return 'auth-or-security';
  if (/context|maximum.*tokens|too.*large/i.test(s)) return 'context';
  if (/usage limit|insufficient_quota|quota.*(?:exhaust|exceed)|out of credits|credit.*exhaust/i.test(s)) return 'quota';
  if (/rate.?limit|\b429\b|too many requests/i.test(s)) return 'rate-limit';
  if (/ECONN|network|timeout|\b50[0239]\b/i.test(s)) return 'network';
  return 'task';
}
function profile(raw = {}) {
  return { enabled: raw.enabled === true, primary: 'claude', fallback: 'qwen', reviewer: 'codex',
    cloudConsent: raw.cloudConsent === true, worktreeWritesConsent: raw.worktreeWritesConsent === true,
    maxCalls: Number.isSafeInteger(raw.maxCalls) && raw.maxCalls > 0 ? Math.min(raw.maxCalls, 20) : 0,
    tokenCeiling: Number.isSafeInteger(raw.tokenCeiling) && raw.tokenCeiling > 0 ? raw.tokenCeiling : 0 };
}
function eligible(raw, x) {
  const p = profile(raw);
  const deny = reason => ({ ok: false, reason });
  if (!p.enabled) return deny('fallback-disabled');
  if (!['default', 'gas-saver'].includes(x.pilot)) return deny('pilot-not-eligible');
  if (!p.cloudConsent || !p.worktreeWritesConsent) return deny('separate-qwen-consents-required');
  if (x.provider !== 'claude' || !['discover', 'implement', 'repair'].includes(x.stage)) return deny('role-not-eligible');
  if (classify(x.error) !== 'quota') return deny('not-provider-quota');
  if (x.switches !== 0) return deny('switch-already-used');
  if (x.qwenReady !== true || x.executionAllowed !== true) return deny('qwen-unavailable-or-not-authorized');
  if (x.reviewerReady !== true) return deny('codex-review-capacity-unavailable');
  if (!p.maxCalls || !p.tokenCeiling || !Number.isFinite(x.calls) || !Number.isFinite(x.chargedTokens)
    || !Number.isFinite(x.reservation) || x.reservation <= 0 || x.calls >= p.maxCalls || x.chargedTokens + x.reservation > p.tokenCeiling) return deny('qwen-budget-ceiling');
  return { ok: true, reason: 'claude-quota', quota: { status: 'unknown', remaining: null, source: 'no-reliable-qwen-reader' } };
}
function checkpoint(a, changedFiles = []) {
  const clean = value => String(value || '').replace(/\b(?:Bearer\s+\S+|(?:sk-|ghp_|github_pat_)[A-Za-z0-9_-]+)\b/gi, '[redacted]')
    .replace(/\b(token|password|secret|api[_-]?key)\s*[:=]\s*[^\s,;]+/gi, '$1=[redacted]').slice(0, 2000);
  return { version: 1, stage: a.stage, baseSha: a.baseSha || null,
    objective: clean(a.plan?.title), approvedPlan: clean(JSON.stringify(a.plan || {})),
    changedFiles: changedFiles.slice(0, 100).map(clean),
    checks: (a.verify?.results || []).slice(0, 20).map(r => ({ name: clean(r.name), ok: r.ok === true, exitCode: Number.isInteger(r.code) ? r.code : null })),
    findings: clean(a.review), attempts: { repairs: a.repairs || 0, planRevisions: a.planRevisions || 0 },
    nextAction: 'Resume the same stage in the existing worktree. Inspect partial changes and run checks. Preserve Codex review; never commit, push, merge or deploy.' };
}
module.exports = { classify, profile, eligible, checkpoint };
