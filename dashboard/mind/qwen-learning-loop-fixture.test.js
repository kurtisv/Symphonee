'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const crypto=require('node:crypto');
const {runFixtureLoop}=require('../orchestrator/qwen-fixture-loop');
const {makeFixtureController}=require('./qwen-learning-fixture');

test('two fictional tasks persist and retrieve an explicitly unverified experiment, never a lesson',async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'sym-learning-loop-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  fs.mkdirSync(path.join(root,'project-a'));fs.mkdirSync(path.join(root,'project-b'));
  const space='fixture_'+crypto.randomBytes(8).toString('hex');
  const controller=makeFixtureController({repoRoot:root,space,queueDir:path.join(root,'queue')});
  const runId=crypto.randomBytes(16).toString('hex');let used=0,firstId;
  const common={budget:100,deadlineMs:Date.now()+10000,usage:async()=>used,
    verify:async({diff})=>diff==='correct'?{passed:1,total:1,errors:[]}:{passed:0,total:1,errors:['incorrect result']},
    review:async({technical})=>technical.passed===technical.total?{decision:'pass',errors:[]}:{decision:'fail',errors:['Use the correct result']},
  };
  const a=await runFixtureLoop({...common,generate:async({attempt})=>{used+=10;return {diff:attempt===1?'wrong':'correct'};},
    onAttempt:async event=>{
      const item={runId,attempt:event.attempt,problem:'Fictional task A',proposal:event.diff,errors:event.technical.errors,correction:event.review.errors.join('; '),assertions:[{passed:event.technical.passed,total:event.technical.total}],verdict:event.review.decision,supervisor:'simulated',tokens:event.tokens};
      const id=controller.enqueue(item);controller.flush(id);if(event.attempt===1)firstId=id;
    }});
  assert.equal(a.status,'fixture-validated'); assert.equal(a.history.length,2);
  const recovered=makeFixtureController({repoRoot:root,space,queueDir:path.join(root,'queue')}).findExperiment(firstId);
  assert.equal(recovered.supervisor,'simulated');assert.equal(recovered.correction,'Use the correct result');
  assert.deepEqual(controller.verifiedLessons(),[]);
  used=0;let delivered='';
  const b=await runFixtureLoop({...common,generate:async()=>{used+=10;delivered='EXPERIMENTAL example: '+recovered.correction;return {diff:delivered.includes('correct result')?'correct':'wrong'};}});
  assert.equal(b.status,'fixture-validated');assert.equal(b.history.length,1);
  assert.match(delivered,/^EXPERIMENTAL/);
  assert.deepEqual({attemptsA:a.history.length,tokensA:a.usage,attemptsB:b.history.length,tokensB:b.usage},{attemptsA:2,tokensA:20,attemptsB:1,tokensB:10});
});
