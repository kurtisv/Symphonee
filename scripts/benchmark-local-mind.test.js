'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { evaluate, cases } = require('./benchmark-local-mind');

test('retrieval and skill arms use synthetic data without requiring Ollama', async () => {
  const r = await evaluate({ inference: false });
  assert.equal(r.summary.cases, 4);
  assert.equal(r.summary.retrieval, '4/4');
  assert.equal(r.summary.skill, '2/2');
  assert.equal(r.summary.oracle, null);
});

test('oracle and retrieval generation are scored independently', async () => {
  const r = await evaluate({ trials: 2, chat: async (_model, prompt) => {
    if (prompt.includes('how many hours')) return 'five hours';
    if (prompt.includes('who reviews')) return 'Codex';
    if (prompt.includes('can an autopilot')) return 'No';
    return 'NaN';
  } });
  assert.equal(r.summary.oracle, '8/8');
  assert.equal(r.summary.endToEnd, '8/8');
  assert.equal(r.summary.promptCandidate, '8/8');
});

test('model errors never count as success', async () => {
  const r = await evaluate({ chat: async () => { throw new Error('offline'); } });
  assert.equal(r.summary.oracle, '0/4');
  assert.equal(r.summary.endToEnd, '0/4');
});

test('a contradictory negative answer does not pass the Git safety check', () => {
  const check = cases.find(c => c.id === 'git').check;
  assert.equal(check('No, but it can push.'), false);
  assert.equal(check('UNKNOWN'), false);
  assert.equal(check('No, it cannot push or merge.'), true);
});
