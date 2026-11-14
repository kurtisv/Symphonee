'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { trackProcess, ensureTerminated } = require('./process-termination');

test('cancelled/null process and parent close never prove tree termination', async () => {
  const t = { id: 't', state: 'cancelled', _proc: null };
  assert.equal((await ensureTerminated(t)).proven, false);
  assert.equal((await ensureTerminated({terminationEvidence:{proven:true,scope:'process-tree',method:'windows-job-object'}})).proven,false);
  const p = new EventEmitter(); p.pid = 123;
  trackProcess(t, p); p.emit('close', 1);
  assert.equal((await ensureTerminated(t)).proven, false);
});
test('concurrent verification is one operation and binds complete tree evidence to attempt', async () => {
  const t = { id: 't' }, p = new EventEmitter(); p.pid = 123;
  trackProcess(t, p); let calls = 0;
  const verify = async ({ attemptId }) => { calls++; await Promise.resolve(); return { attemptId, terminated: true, scope: 'process-tree', method: 'windows-job-object' }; };
  const [a,b] = await Promise.all([ensureTerminated(t, { verify }), ensureTerminated(t, { verify })]);
  assert.equal(calls, 1); assert.equal(a.proven, true); assert.deepEqual(a,b);
  const restored = JSON.parse(JSON.stringify(t));
  assert.equal((await ensureTerminated(restored)).proven, true);
  trackProcess(t, p);
  assert.equal((await ensureTerminated(t)).proven, false);
});
test('wrong attempt, parent-only, verifier failure and restart uncertainty fail closed', async () => {
  for (const evidence of [{ attemptId: 'wrong', terminated: true, scope: 'process-tree', method: 'windows-job-object' }, { terminated: true, scope: 'parent' }]) {
    const t = { id: 't' }, p = new EventEmitter(); p.pid = 12; trackProcess(t,p);
    assert.equal((await ensureTerminated(t, { verify: async () => evidence })).proven, false);
  }
  const t = { id: 't' }, p = new EventEmitter(); p.pid = 12; trackProcess(t,p);
  assert.equal((await ensureTerminated(t, { verify: async () => { throw Error('secret must not persist'); } })).proven, false);
  assert.ok(!JSON.stringify(t).includes('secret'));
  assert.equal((await ensureTerminated(JSON.parse(JSON.stringify(t)))).proven, false);
});
test('late verification cannot prove a replacement attempt or overwrite a timeout', async () => {
  const t = { id: 't' }, p = new EventEmitter(); p.pid = 123; trackProcess(t,p);
  let finish;
  const pending = ensureTerminated(t, { verify: ({attemptId}) => new Promise(resolve => { finish=()=>resolve({attemptId,terminated:true,scope:'process-tree',method:'windows-job-object'}); }) });
  await Promise.resolve(); trackProcess(t,p); finish();
  assert.equal((await pending).proven,false);
  assert.equal(t.terminationEvidence.proven,false);
  const timed = ensureTerminated(t, { timeoutMs: 10, verify: ({attemptId}) => new Promise(resolve => { finish=()=>resolve({attemptId,terminated:true,scope:'process-tree',method:'windows-job-object'}); }) });
  assert.equal((await timed).reason,'tree-verification-timeout');
  finish(); await Promise.resolve(); await Promise.resolve();
  assert.equal(t.terminationEvidence.proven,false);
});
