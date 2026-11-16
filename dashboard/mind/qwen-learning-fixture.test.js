'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const crypto=require('node:crypto');
const {makeFixtureController}=require('./qwen-learning-fixture');
const store=require('./store');
const {recall}=require('./recall');
function fixture(t){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'sym-mind-learning-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const space='fixture_'+crypto.randomBytes(8).toString('hex');
  return {root,space,queueDir:path.join(root,'queue')};
}
const observation=(runId,attempt)=>({runId,attempt,problem:'Fictional JavaScript sign function',proposal:'function sign(v){return v}',errors:['Negative input failed'],correction:'Use a conditional',assertions:[{input:-2,expected:-1,passed:false}],verdict:'fail',supervisor:'simulated',tokens:123});

test('Mind fixture persists, survives an ambiguous timeout and deduplicates on retry',t=>{
  const f=fixture(t), c=makeFixtureController({repoRoot:f.root,space:f.space,queueDir:f.queueDir});
  const event=observation('a'.repeat(32),1), id=c.enqueue(event);
  assert.equal(c.enqueue(event),id);
  assert.throws(()=>c.flush(id,{afterWrite:()=>{throw Error('simulated timeout');}}),/timeout/);
  assert.equal(store.loadGraph(f.root,f.space).nodes.filter(n=>n.id===id).length,1);
  const restarted=makeFixtureController({repoRoot:f.root,space:f.space,queueDir:f.queueDir});
  assert.deepEqual(restarted.pending(),[id]);
  assert.deepEqual(restarted.drain(),[{id,confirmed:true,classification:'experimental'}]);
  assert.deepEqual(c.findExperiment(id),{...event,proofLevel:'simulated-review'});
  assert.equal(c.setExperimentDisabled(id,true).disabled,true);
  assert.equal(c.findExperiment(id),null);
  assert.equal(c.setExperimentDisabled(id,false).disabled,false);
  assert.deepEqual(c.findExperiment(id),{...event,proofLevel:'simulated-review'});
  assert.equal(store.loadGraph(f.root,f.space).nodes.filter(n=>n.id===id).length,1);
  assert.deepEqual(c.verifiedLessons(),[]);
  assert.ok(!recall(store.loadGraph(f.root,f.space),{question:'Fictional JavaScript sign function'}).hits.some(h=>h.id===id));
  const conflict={...event,proposal:'different'};c.enqueue(conflict);
  assert.throws(()=>c.flush(id),/Conflicting/);
});

test('simulated review cannot promote observations or use non-fictitious Mind spaces',t=>{
  const f=fixture(t);
  assert.throws(()=>makeFixtureController({repoRoot:f.root,space:'_global',queueDir:f.queueDir}),/Fictional/);
  const c=makeFixtureController({repoRoot:f.root,space:f.space,queueDir:f.queueDir});
  assert.equal(c.promote,undefined);
  assert.throws(()=>c.enqueue({...observation('b'.repeat(32),1),supervisor:'codex'}),/Invalid/);
  assert.throws(()=>c.enqueue({...observation('b'.repeat(32),1),assertions:[NaN]}),/Invalid/);
});

test('corrupt queued observation is retained and cannot be written into Mind',t=>{
  const f=fixture(t), c=makeFixtureController({repoRoot:f.root,space:f.space,queueDir:f.queueDir});
  const id=c.enqueue(observation('c'.repeat(32),1));
  const file=path.join(f.queueDir,id+'.json');fs.writeFileSync(file,'{');
  assert.throws(()=>c.drain());
  assert.equal(fs.existsSync(file),true);
  assert.equal(store.loadGraph(f.root,f.space),null);
});
test('unknown token usage and an unfinished review are preserved without inventing a verdict',t=>{
  const f=fixture(t), c=makeFixtureController({repoRoot:f.root,space:f.space,queueDir:f.queueDir});
  const event={...observation('d'.repeat(32),1),verdict:'not-run',tokens:null};
  const id=c.enqueue(event);c.flush(id);assert.deepEqual(c.findExperiment(id),{...event,proofLevel:'simulated-review'});
});

const evidence={cleanup:'verified-no-descendants',diffHash:'e'.repeat(64),items:['agent_message'],promptInputHash:'f'.repeat(64),tools:['functions.request_user_input'],version:'codex-cli 0.169.0'};
test('a real Codex fixture review is stored at its own proof level and retrieved by run',t=>{
  const f=fixture(t), c=makeFixtureController({repoRoot:f.root,space:f.space,queueDir:f.queueDir});
  const run='9'.repeat(32);
  const first={...observation(run,1),supervisor:'codex-fixture',verdict:'fail',reviewEvidence:evidence};
  const second={...observation(run,2),supervisor:'codex-fixture',verdict:'pass',errors:[],reviewEvidence:evidence};
  c.flush(c.enqueue(second));c.flush(c.enqueue(first));
  c.flush(c.enqueue(observation(run,3)));
  c.flush(c.enqueue({...observation(run,4),supervisor:'checks'}));
  assert.throws(()=>c.enqueue({...observation(run,5),supervisor:'checks',verdict:'pass'}),/Invalid/,'checks alone never pass a proposal');
  assert.deepEqual(c.findRun(run,'independent-checks-only').map(r=>r.attempt),[4]);
  const real=c.findRun(run,'real-codex-review-fictional-fixture');
  assert.deepEqual(real.map(r=>[r.attempt,r.verdict,r.proofLevel]),[[1,'fail','real-codex-review-fictional-fixture'],[2,'pass','real-codex-review-fictional-fixture']]);
  assert.deepEqual(c.findRun(run,'simulated-review').map(r=>r.attempt),[3]);
  assert.deepEqual(c.verifiedLessons(),[],'a fixture review never certifies a lesson for a real project');
  assert.throws(()=>c.findRun(run,'certified'),/Invalid/);
});
test('a Codex record without complete reviewer evidence, or a forged proof level, is refused',t=>{
  const f=fixture(t), c=makeFixtureController({repoRoot:f.root,space:f.space,queueDir:f.queueDir});
  const base={...observation('8'.repeat(32),1),supervisor:'codex-fixture'};
  assert.throws(()=>c.enqueue(base),/Invalid/);
  for(const bad of [{...evidence,cleanup:'unverified'},{...evidence,tools:['functions.request_user_input','functions.exec']},{...evidence,items:['agent_message','command_execution']},{...evidence,version:'codex-cli 0.170.0'},{...evidence,extra:1}])
    assert.throws(()=>c.enqueue({...base,reviewEvidence:bad}),/Invalid/);
  assert.throws(()=>c.enqueue({...base,reviewEvidence:evidence,verdict:'not-run'}),/Invalid/);
  assert.throws(()=>c.enqueue({...observation('8'.repeat(32),1),reviewEvidence:evidence}),/Invalid/,'a simulated review cannot carry reviewer evidence');
  const id=c.enqueue({...base,reviewEvidence:evidence,proofLevel:'simulated-review'});c.flush(id);
  assert.equal(c.findExperiment(id).proofLevel,'real-codex-review-fictional-fixture','the proof level is derived, never supplied');
});
