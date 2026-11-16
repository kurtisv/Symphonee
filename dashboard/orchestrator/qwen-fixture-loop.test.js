'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const cp=require('node:child_process');
const {runFixtureLoop}=require('./qwen-fixture-loop');
const {gitSnapshot,reconstructProposal}=require('./qwen-git-snapshot');
const {formatDiff}=require('./qwen-docker-adapter');
const {verifyFixture}=require('./qwen-pure-runner');

test('fictional repository: simulated Qwen receives rejection and second proposal passes independent assertions and simulated review', {timeout:30000}, async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'sym-loop-fixture-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const git=(...args)=>cp.execFileSync('git',['-C',root,...args],{windowsHide:true,stdio:'pipe'});
  git('init','-q');git('config','user.email','fixture@example.invalid');git('config','user.name','Fixture');
  const name='average.js', initial='function average(v){return null}module.exports={average};\n';
  fs.writeFileSync(path.join(root,name),initial);git('add',name);git('commit','-qm','fixture');
  const base=gitSnapshot(root,[name]);
  const make=source=>formatDiff([{path:name,content:Buffer.from(source).toString('base64')}],base.files);
  const bad=make('function average(v){return 0}module.exports={average};\n');
  const good=make('function average(v){if(v.length===0)return null;return v.reduce((a,b)=>a+b,0)/v.length}module.exports={average};\n');
  const cases=[{file:name,export:'average',args:[[]],expected:null},{file:name,export:'average',args:[[1,2,3]],expected:2},{file:name,export:'average',args:[[-2,2]],expected:0}];
  let received=null, generated=0;
  const result=await runFixtureLoop({budget:100,deadlineMs:Date.now()+25000,usage:async()=>generated,
    generate:async ({attempt,feedback})=>{generated++;if(attempt===2)received=feedback;return {diff:attempt===1?bad:good};},
    verify:async ({diff})=>{
      const candidate=reconstructProposal(root,[name],diff,[name]);
      const source=Buffer.from(candidate.files[0].content,'base64').toString('utf8');
      let passed=0;const errors=[];
      for(let i=0;i<cases.length;i++) {try{await verifyFixture({[name]:source},[cases[i]]);passed++;}catch{errors.push('assertion '+(i+1)+' failed');}}
      return {passed,total:cases.length,errors};
    },
    review:async ({attempt,technical})=>attempt===1?{decision:'fail',errors:['Handle empty input and calculate the mean']}:{decision:'pass',errors:[]},
  });
  assert.equal(result.status,'fixture-validated'); assert.equal(result.scope,'simulation-only');
  assert.deepEqual(result.history.map(x=>x.passed),[1,3]);
  assert.ok(received.includes('Handle empty input and calculate the mean'));
  assert.equal(fs.readFileSync(path.join(root,name),'utf8'),initial);
  assert.equal(gitSnapshot(root,[name]).commit,base.commit);
});

function rig(overrides={}) {
  let n=0;
  return {budget:1000,deadlineMs:Date.now()+10000,usage:async()=>n,generate:async()=>({diff:'diff-'+(++n)}),verify:async()=>({passed:0,total:5,errors:['technical-'+n]}),review:async()=>({decision:'fail',errors:['review-'+n]}),...overrides};
}
test('stops at 15 without measurable progress',async()=>{
  const r=await runFixtureLoop(rig());assert.equal(r.reason,'no-measurable-progress');assert.equal(r.history.length,15);
});
test('permits at most 20 when recent assertions measurably improve',async()=>{
  const r=await runFixtureLoop(rig({verify:async ({attempt})=>({passed:attempt<11?0:1,total:5,errors:['attempt-'+attempt]})}));
  assert.equal(r.reason,'attempt-limit');assert.equal(r.history.length,20);
});
test('rejects repeated proposals, security incidents and exhausted budgets',async()=>{
  assert.equal((await runFixtureLoop(rig({generate:async()=>({diff:'same'})}))).reason,'repeated-proposal');
  assert.equal((await runFixtureLoop(rig({verify:async()=>({securityIncident:true})}))).reason,'security-incident');
  assert.equal((await runFixtureLoop(rig({usage:async()=>1000}))).reason,'budget');
});
test('never accepts reviewer pass without complete independent assertions',async()=>{
  const r=await runFixtureLoop(rig({review:async()=>({decision:'pass',errors:[]})}));
  assert.notEqual(r.status,'fixture-validated');
});
test('blocks reviewer security incidents, changed assertion counts, and failed history persistence',async()=>{
  assert.equal((await runFixtureLoop(rig({review:async()=>({decision:'pass',errors:[],securityIncident:true})}))).reason,'security-incident');
  assert.equal((await runFixtureLoop(rig({verify:async({attempt})=>({passed:0,total:attempt===1?5:6,errors:['fail-'+attempt]})}))).reason,'assertion-set-changed');
  assert.equal((await runFixtureLoop(rig({onHistory:async()=>{throw Error('unavailable');}}))).reason,'history-error');
});
test('deadline and cancellation stop the simulated loop while a cooperative generator waits',async()=>{
  let aborted=false;
  const delayed=({signal})=>new Promise(resolve=>signal.addEventListener('abort',()=>{aborted=true;resolve({diff:'too-late'});},{once:true}));
  const expired=await runFixtureLoop(rig({generate:delayed,deadlineMs:Date.now()+50}));
  assert.equal(expired.reason,'deadline');assert.equal(aborted,true);assert.equal(expired.history.length,0);
  const controller=new AbortController();
  const promise=runFixtureLoop(rig({generate:delayed,signal:controller.signal}));
  setTimeout(()=>controller.abort(),20);
  assert.equal((await promise).reason,'cancelled');
});
test('budget exhaustion before acceptance and recurring failures stop the loop',async()=>{
  let spent=0;
  const exhausted=await runFixtureLoop(rig({budget:10,usage:async()=>spent,verify:async()=>({passed:1,total:1,errors:[]}),review:async()=>({decision:'pass',errors:[]}),onHistory:async()=>{spent=10;}}));
  assert.equal(exhausted.reason,'budget');assert.notEqual(exhausted.status,'fixture-validated');
  const stuck=await runFixtureLoop(rig({verify:async()=>({passed:0,total:1,errors:['same failure']}),review:async()=>({decision:'fail',errors:['same review']})}));
  assert.equal(stuck.reason,'persistent-blocker');assert.equal(stuck.history.length,2);
});
test('repeated unsupported syntax stops even if feedback wording changes',async()=>{
  const r=await runFixtureLoop(rig({verify:async({attempt})=>({passed:0,total:1,errors:['unsupported-'+attempt],unsupported:true})}));
  assert.equal(r.reason,'unsupported-syntax-repeated');assert.equal(r.history.length,2);
});
test('unfinished attempts are handed to the sink without fabricating review or token usage',async()=>{
  let event;
  const r=await runFixtureLoop(rig({generate:async()=>{throw Error('failed');},onAttempt:async e=>{event=e;}}));
  assert.equal(r.reason,'generator-error');assert.equal(event.attempt,1);assert.equal(event.diff,null);
  assert.equal(event.review.decision,'not-run');assert.equal(event.tokens,null);assert.equal(event.failure,'generator-error');
});
