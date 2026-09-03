'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { ProviderHealthManager, classifyProviderError, ERROR_TYPES } = require('./provider-health');
const { TaskRouter } = require('./task-router');
const { createContextPacket } = require('./context-packet');

function health(config = {}, availability = {}) {
  return new ProviderHealthManager({ getConfig: () => config, availability, cooldownMs: 1000 });
}

test('registry and router select an available enabled provider', () => {
  const h = health({ OrchestrateCliList: ['codex', 'gemini-api'] }, { codex: { available: true }, 'gemini-api': { available: true } });
  assert.equal(new TaskRouter({ health: h, getConfig: () => ({}) }).selectProvider({ prompt: 'small summary' }).provider, 'gemini-api');
});
test('disabled and cooling providers are ignored', () => {
  const h = health({ OrchestrateCliList: ['codex', 'claude'] }, { codex: { available: true, cooldownUntil: Date.now() + 10000 }, claude: { available: true } });
  assert.equal(new TaskRouter({ health: h, getConfig: () => ({}) }).selectProvider({ prompt: 'complex coding' }).provider, 'claude');
});
test('quota/rate limit cool down, auth and task errors do not', () => {
  const h = health({}, { codex: { available: true } });
  assert.equal(classifyProviderError('HTTP 429 rate limit'), ERROR_TYPES.RATE_LIMIT);
  assert.equal(classifyProviderError('401 invalid API key'), ERROR_TYPES.AUTH_ERROR);
  assert.equal(classifyProviderError('syntax error in task'), ERROR_TYPES.TASK_ERROR);
  h.recordOutcome('codex', { ok: false, error: 'quota exceeded' });
  assert.equal(h.get('codex').health, 'cooling_down');
  h.recordOutcome('codex', { ok: false, error: 'syntax error' });
  assert.equal(h.get('codex').cooldownUntil > 0, true);
});
test('task errors are excluded briefly, then recover after cooldown', () => {
  let now = 1000;
  const h = new ProviderHealthManager({ getConfig: () => ({}), availability: { codex: { available: true } }, cooldownMs: 1000, now: () => now });
  h.recordOutcome('codex', { ok: false, error: 'syntax error' });
  assert.equal(h.isAvailable('codex'), false);
  now = 2001;
  assert.equal(h.isAvailable('codex'), true);
});
test('routing preferences cover review, long-running, cheap and complex work', () => {
  const h = health({}, Object.fromEntries(['codex', 'claude', 'gemini-api', 'jules'].map(id => [id, { available: true }])));
  const r = new TaskRouter({ health: h, getConfig: () => ({}) });
  assert.equal(r.selectProvider({ prompt: 'long-running autonomous repo task' }).provider, 'jules');
  assert.equal(r.selectProvider({ prompt: 'cheap simple analysis' }).provider, 'gemini-api');
  assert.ok(['codex', 'claude'].includes(r.selectProvider({ prompt: 'complex architecture coding' }).provider));
  assert.equal(r.selectProvider({ prompt: 'review this code', writerProvider: 'codex' }).provider, 'claude');
});
test('context packet is bounded and redacts secrets', () => {
  const packet = createContextPacket({ taskGoal: 'continue', originalPrompt: 'x', findings: ['a'.repeat(10000)], apiKey: 'sk-secret-value' }, 500);
  assert.ok(packet.length <= 500);
  assert.doesNotMatch(packet, /sk-secret-value|apiKey/);
});
test('manual provider remains explicit and no router choice is needed', () => {
  const h = health({}, { codex: { available: true }, claude: { available: true } });
  const r = new TaskRouter({ health: h, getConfig: () => ({}) });
  assert.equal(r.selectProvider({ prompt: 'anything', preferredProvider: 'codex' }).provider, 'codex');
});
