'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { verifyFixture } = require('./qwen-pure-runner');

const cases = [
  { file:'average.js', export:'average', args:[[]], expected:null },
  { file:'average.js', export:'average', args:[[1,2,3]], expected:2 },
  { file:'average.js', export:'average', args:[[-2,2]], expected:0 },
];
const good = 'function average(v){if(v.length===0)return null;return v.reduce((a,b)=>a+b,0)/v.length}module.exports={average};';

test('fixture file is independently parsed and all three private assertions are evaluated', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-assert-fixture-'));
  try {
    const file = path.join(dir, 'average.js');
    fs.writeFileSync(file, good);
    const before = fs.readFileSync(file, 'utf8');
    assert.deepEqual(await verifyFixture({ 'average.js':before }, cases), { ok:true, expected:3, executed:3 });
    assert.equal(fs.readFileSync(file, 'utf8'), before);
  } finally { fs.rmSync(dir, { recursive:true, force:true }); }
});

test('real supervisor refuses fabricated output, early exit, unsupported syntax, missing source and incorrect results', async () => {
  const attacks = [
    "console.log(JSON.stringify({ok:true,expected:3,executed:3}));process.exit(0)",
    'function average(v){process.exit(0);return 2}module.exports={average};',
    'function average(v){while(true){}return 2}module.exports={average};',
    'function average(v){return 2}module.exports={average};',
  ];
  for (const source of attacks) await assert.rejects(verifyFixture({ 'average.js':source }, cases));
  await assert.rejects(verifyFixture({}, cases));
  await assert.rejects(verifyFixture({ 'average.js':good }, [{...cases[1],expected:99}]));
});

test('a real expired deadline is refused', async () => {
  await assert.rejects(verifyFixture({ 'average.js':good }, cases, { timeoutMs:1 }), /timeout/);
});

test('refuses lossy JSON conversions and accessors before serialization', async () => {
  for (const value of [NaN, Infinity, -0, undefined, Array(1), new Date()]) {
    await assert.rejects(verifyFixture({ 'average.js':good }, [{...cases[0],args:[value]}]), /Non-JSON/);
  }
  let invoked = false;
  const array = [];
  Object.defineProperty(array, '0', { enumerable:true, get() { invoked = true; return 1; } });
  await assert.rejects(verifyFixture({ 'average.js':good }, [{...cases[0],args:[array]}]), /Non-JSON/);
  assert.equal(invoked, false);
  const altered = [1];
  Object.setPrototypeOf(altered, Object.assign(Object.create(Array.prototype), { toJSON() { invoked = true; return []; } }));
  await assert.rejects(verifyFixture({ 'average.js':good }, [{...cases[0],args:[altered]}]), /Non-JSON/);
  assert.equal(invoked, false);
});

test('child does not inherit NODE_OPTIONS', async () => {
  const previous = process.env.NODE_OPTIONS;
  try {
    process.env.NODE_OPTIONS = '--not-a-real-node-option';
    assert.equal((await verifyFixture({ 'average.js':good }, cases)).executed, 3);
  } finally {
    if (previous === undefined) delete process.env.NODE_OPTIONS; else process.env.NODE_OPTIONS = previous;
  }
});
