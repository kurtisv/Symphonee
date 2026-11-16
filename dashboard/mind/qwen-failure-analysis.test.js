'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const F = require('./qwen-failure-analysis');

test('classify: each failure goes to one cause, and a lesson shown changes only the reading of wrong values', () => {
  const c = (observation, code = 'function f(v){return 1}', extra = {}) => F.classify({ observation, code, ...extra }).category;
  assert.equal(c('x', ''), 'generation-format');
  assert.equal(c('Developer produced no verifiable proposal'), 'generation-format');
  assert.equal(c('Unsupported statement: ForStatement'), 'verifier-restriction');
  assert.equal(c('Unsupported reduce callback'), 'verifier-restriction');
  assert.equal(c('Unsupported expression: CallExpression'), 'verifier-restriction');
  assert.equal(c('Expected values to be strictly deep-equal: 1 !== 2'), 'reasoning');
  assert.equal(c('Expected values to be strictly deep-equal: 1 !== 2', undefined, { lessonShown: true }), 'lesson-adaptation');
  assert.equal(c('Unsupported result'), 'reasoning');
  assert.equal(c('Unsupported result', undefined, { lessonShown: true }), 'lesson-adaptation');
  const imp = F.classify({ observation: 'Unsupported expression: CallExpression', code: 'function f(v){return 1}', requires: ['spread'], profileFeatures: ['reduce'] });
  assert.equal(imp.category, 'task-impossible'); assert.match(imp.detail, /needs spread/);
});

test('a placeholder name copied from a hint is recognised as a naming slip, with the real parameter name', () => {
  const code = 'function midRange(v){const lo=arr.reduce((m,x)=>Math.min(m,x),v[0]);return lo}';
  assert.deepEqual(F.unknownNames(code), ['arr']); assert.equal(F.paramOf(code), 'v');
  const r = F.classify({ observation: 'Unknown identifier', code });
  assert.equal(r.category, 'naming-slip'); assert.match(r.detail, /arr.*the array parameter is v/);
  assert.deepEqual(F.unknownNames('function f(v){const n=v.length;return v.reduce((a,b)=>a+b/n,0)}'), [], 'declared names and Math are known');
  assert.deepEqual(F.unknownNames('this is not javascript'), []);
});

test('analyzeRun counts causes and repeated identical submissions', () => {
  const A = (attempt, code, failure, shown = []) => ({ attempt, code, failure, shown });
  const r = F.analyzeRun([A(1, 'function f(v){return 1}', 'Expected values to be strictly deep-equal: 1 !== 2'), A(2, 'function f(v){return 1}', 'Expected values to be strictly deep-equal: 1 !== 2'), A(3, 'function f(v){for(;;){}}', 'Unsupported statement: ForStatement'), A(4, 'function f(v){return 2}', null)]);
  assert.deepEqual(r.counts, { reasoning: 2, 'verifier-restriction': 1 }); assert.equal(r.repeatedSubmissions, 1);
  assert.deepEqual(r.attempts.map((x) => x.category), ['reasoning', 'reasoning', 'verifier-restriction', 'passed']);
});
