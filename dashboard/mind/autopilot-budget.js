'use strict';
// Mind Autopilot-only token/call ledger. Real usage is recorded when available;
// otherwise a conservative per-call reservation is charged. No provider CLI
// reliably exposes a hard cap during execution, so calls are the strict guard.
// Sized from real measurements (2026-11-11, cache reads included): Claude
// discovery 175k, Codex plan review 34k-107k, Codex code review ~107k, Claude
// implementation estimated ~350k. Typical task ~715k; with one plan revision and
// one repair ~1.33M. Budget = two worst-case tasks per day plus the margin used
// on 2026-11-11 by two discoveries wasted by a repo-pinning bug (user decision).
const LIMITS = Object.freeze({
  dailyCompletions: 3,
  dailyDiscoveries: 6,
  dailyCalls: 20,
  dailyTokenBudget: 3000000,
  reservedTokensPerCall: 150000,
  repairs: 1,
  planRevisions: 1,
});

// Days are LOCAL calendar days (the user's "per day"), not UTC days: a UTC
// boundary would reset the quota mid-evening in America/Toronto.
const pad2 = (n) => String(n).padStart(2, '0');
const dayOf = (now = Date.now()) => {
  const d = new Date(now);
  return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
};
const finiteNumber = (n) => typeof n === 'number' && Number.isFinite(n) && n >= 0 ? Math.floor(n) : null;

function tokensFromTask(task) {
  const usage = task && (task.usage || task.geminiUsage || task.tokenUsage);
  if (!usage || typeof usage !== 'object') return null;
  for (const name of ['totalTokens', 'total_tokens']) {
    const n = finiteNumber(usage[name]);
    if (n !== null) return n;
  }
  const input = finiteNumber(usage.inputTokens ?? usage.input_tokens ?? usage.promptTokens ?? usage.prompt_tokens);
  const output = finiteNumber(usage.outputTokens ?? usage.output_tokens ?? usage.completionTokens ?? usage.completion_tokens);
  if (input === null || output === null) return null;
  return input + output;
}
function ensureLedger(state) {
  if (!Array.isArray(state.budgetCalls)) state.budgetCalls = [];
  return state.budgetCalls;
}
function pruneLedger(state, now = Date.now()) {
  const cutoff = now - 30 * 86400000;
  state.budgetCalls = ensureLedger(state).filter(x => Number.isFinite(x.at) && x.at >= cutoff);
}
function dailyUsage(state, now = Date.now()) {
  const day = dayOf(now);
  const calls = ensureLedger(state).filter(x => dayOf(x.at) === day);
  const byProvider = {};
  let measuredTokens = 0, reservedTokens = 0, unmeteredCalls = 0;
  for (const item of calls) {
    const provider = item.cli || 'unknown';
    if (!byProvider[provider]) byProvider[provider] = { calls: 0, measuredTokens: 0, reservedTokens: 0, unmeteredCalls: 0, cacheReadTokens: 0 };
    const v = byProvider[provider];
    v.calls++;
    v.cacheReadTokens += finiteNumber(item.cacheReadTokens) || 0;
    if (finiteNumber(item.actualTokens) !== null) {
      // Cache reads are real processed tokens: they are charged too, so a
      // "measured" day never undercounts what the provider reported.
      const tokens = finiteNumber(item.actualTokens) + (finiteNumber(item.cacheReadTokens) || 0);
      measuredTokens += tokens;
      v.measuredTokens += tokens;
    } else {
      const tokens = finiteNumber(item.reservedTokens) ?? LIMITS.reservedTokensPerCall;
      reservedTokens += tokens;
      unmeteredCalls++;
      v.reservedTokens += tokens;
      v.unmeteredCalls++;
    }
  }
  const chargedTokens = measuredTokens + reservedTokens;
  return { day, calls: calls.length, measuredTokens, reservedTokens, chargedTokens,
    unmeteredCalls, byProvider,
    remainingCalls: Math.max(0, LIMITS.dailyCalls - calls.length),
    remainingTokenBudget: Math.max(0, LIMITS.dailyTokenBudget - chargedTokens),
    // Token count is *not* a hard provider cap: actual spend can exceed reservation.
    tokenUsageExact: unmeteredCalls === 0,
    limits: { ...LIMITS } };
}
function canDispatch(state, now = Date.now()) {
  const s = dailyUsage(state, now);
  return s.calls < LIMITS.dailyCalls &&
    s.chargedTokens + LIMITS.reservedTokensPerCall <= LIMITS.dailyTokenBudget;
}
function reserveCall(state, { cli, stage, at = Date.now(), ref }) {
  if (!canDispatch(state, at)) return null;
  const record = { ref, cli, stage, at, reservedTokens: LIMITS.reservedTokensPerCall,
    actualTokens: null, taskId: null };
  ensureLedger(state).push(record);
  return record;
}
function settleCall(state, ref, task) {
  const item = ensureLedger(state).find(x => x.ref === ref);
  if (!item || item.settled) return false;
  item.settled = true;
  item.outcome = task?.state || 'unknown';
  const tokens = tokensFromTask(task);
  if (tokens !== null) item.actualTokens = tokens;
  const usage = task && (task.usage || task.geminiUsage || task.tokenUsage);
  const cacheRead = usage && finiteNumber(usage.cacheReadTokens);
  if (cacheRead !== null && cacheRead !== undefined) item.cacheReadTokens = cacheRead;
  if (usage && usage.source) item.usageSource = String(usage.source).slice(0, 40);
  return true;
}
function startOfNextDay(now = Date.now()) {
  const d = new Date(now);
  d.setHours(24, 0, 0, 0);
  return d.getTime();
}
module.exports = { LIMITS, dayOf, dailyUsage, canDispatch, reserveCall, settleCall,
  tokensFromTask, startOfNextDay, pruneLedger };