'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { cases, classify, run } = require('./benchmark-local-discovery');
test('discovery benchmark does not call model by default', async () => {
  const r = await run({ inferFn: () => { throw new Error('unexpected inference'); } });
  assert.equal(r.rows.length, 12);
  assert.equal(r.inference, false);
});
test('rejects invented refs and contradictory abstention', () => {
  const c = cases[0];
  const base = { decision: 'TASK', category: 'testing', title: 'Test empty inventory', objective: 'Test empty inventory filter handling', evidence: ['[M99] no regression test'], acceptance: ['Run the regression test'] };
  assert.equal(classify(JSON.stringify(base), c).valid, false);
  base.evidence = ['[M1] no regression test'];
  assert.equal(classify(JSON.stringify(base), c).valid, true);
  assert.equal(classify('{"decision":"NO_TASK","title":"invented task"}', cases[1]).valid, false);
  assert.equal(classify('{"decision":"NO_TASK"}', cases[1]).valid, true);
});
