'use strict';

// Experimental-only adapter to the existing Mind graph. Queue files are
// delivery state, never a second source of lessons. No production promotion.
const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
const store=require('./store');
const lock=require('./lock');
const {acquireFixtureLock,recoverDeadFixtureLock}=require('./qwen-fixture-lock');
const {isJsonSafe}=require('../orchestrator/qwen-assertions');
const hash=x=>crypto.createHash('sha256').update(x,'utf8').digest('hex');
// Proof levels. Neither certifies a lesson for a real project.
const PROOF=Object.freeze({simulated:'simulated-review',checks:'independent-checks-only','codex-fixture':'real-codex-review-fictional-fixture'});

function makeFixtureController({repoRoot,space,queueDir}) {
  if(!repoRoot || !queueDir || !/^fixture_[a-f0-9]{16}$/.test(space || '')) throw Error('Fictional Mind space required');
  fs.mkdirSync(queueDir,{recursive:true});
  const queue=fs.realpathSync(queueDir);
  function normalize(input){
    if(!input || !isJsonSafe(input) || !/^[a-f0-9]{32}$/.test(input.runId || '') || !Number.isInteger(input.attempt) || input.attempt<1 || input.attempt>20 ||
       typeof input.problem!=='string' || !input.problem || input.problem.length>1000 || typeof input.proposal!=='string' || input.proposal.length>12000 ||
       !Array.isArray(input.errors) || input.errors.length>20 || input.errors.some(x=>typeof x!=='string' || x.length>1000) ||
       typeof input.correction!=='string' || input.correction.length>2000 || !Array.isArray(input.assertions) || input.assertions.length>32 || !isJsonSafe(input.assertions) ||
       !['pass','fail','not-run'].includes(input.verdict) || !Object.hasOwn(PROOF,input.supervisor) || (input.tokens!==null && (!Number.isInteger(input.tokens) || input.tokens<0))) throw Error('Invalid experimental observation');
    // The proof level is derived, never supplied. A codex record needs the
    // reviewer evidence the host collected (tool proof, events, cleanup).
    const ev=input.reviewEvidence;
    if(input.supervisor==='checks' && input.verdict!=='fail') throw Error('Invalid experimental observation');
    if(input.supervisor!=='codex-fixture' ? ev!==undefined : (!ev || typeof ev!=='object' || Object.keys(ev).sort().join(',')!=='cleanup,diffHash,items,promptInputHash,tools,version' ||
       ev.cleanup!=='verified-no-descendants' || !/^[a-f0-9]{64}$/.test(ev.diffHash) || !/^[a-f0-9]{64}$/.test(ev.promptInputHash) || ev.version!=='codex-cli 0.169.0' ||
       !Array.isArray(ev.tools) || ev.tools.some(t=>t!=='functions.request_user_input') || !Array.isArray(ev.items) || ev.items.some(t=>!['agent_message','reasoning'].includes(t)) ||
       input.verdict==='not-run')) throw Error('Invalid experimental observation');
    const record={runId:input.runId,attempt:input.attempt,problem:input.problem,proposal:input.proposal,errors:input.errors,correction:input.correction,assertions:input.assertions,verdict:input.verdict,supervisor:input.supervisor,proofLevel:PROOF[input.supervisor],tokens:input.tokens,...(ev?{reviewEvidence:ev}:{})};
    const encoded=JSON.stringify(record); if(Buffer.byteLength(encoded)>24000)throw Error('Observation too large');
    return {record,encoded,id:'qwen_exp_'+hash(input.runId+':'+input.attempt),digest:hash(encoded)};
  }
  const file=id=>{if(!/^qwen_exp_[a-f0-9]{64}$/.test(id))throw Error('Invalid observation id');return path.join(queue,id+'.json');};
  function enqueue(input){
    const item=normalize(input), target=file(item.id), text=JSON.stringify(item);
    const temp=target+'.'+crypto.randomBytes(12).toString('hex')+'.tmp';
    try {
      const fd=fs.openSync(temp,'wx',0o600);try{fs.writeFileSync(fd,text);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
      try {fs.linkSync(temp,target);} catch(e){if(e.code!=='EEXIST')throw e;if(fs.readFileSync(target,'utf8')!==text)throw Error('Conflicting observation id');}
    } finally {try{fs.unlinkSync(temp);}catch(e){if(e.code!=='ENOENT')throw e;}}
    return item.id;
  }
  function flush(id,{afterWrite}={}) {
    const target=file(id), item=JSON.parse(fs.readFileSync(target,'utf8'));
    const validated=normalize(item.record);
    if(item.id!==id || item.id!==validated.id || item.digest!==validated.digest || item.encoded!==validated.encoded)throw Error('Queue item integrity failure');
    const releaseFixture=acquireFixtureLock(repoRoot,space);
    let held;
    try {
      held=lock.acquire(space,'graph');if(!held.ok || held.alreadyHeld)throw Error('Mind graph lock unavailable');
      const graph=store.loadGraph(repoRoot,space) || store.emptyGraph({space});
      const existing=graph.nodes.find(n=>n.id===id);
      if(existing && (existing.observationDigest!==item.digest || existing.kind!=='artifact' || existing.source?.type!=='qwen-fixture-experiment'))throw Error('Conflicting Mind observation');
      if(!existing){
        graph.nodes.push({id,kind:'artifact',label:'EXPERIMENTAL Qwen attempt '+item.record.attempt+' ['+item.record.proofLevel+']',source:{type:'qwen-fixture-experiment',ref:id},proofLevel:item.record.proofLevel,createdAt:new Date().toISOString(),observationDigest:item.digest,content:item.encoded});
        store.saveGraph(repoRoot,space,graph);
        if(afterWrite)afterWrite();
      }
      const confirmed=store.loadGraph(repoRoot,space)?.nodes.find(n=>n.id===id);
      if(!confirmed || confirmed.observationDigest!==item.digest || confirmed.content!==item.encoded)throw Error('Mind read-back failed');
      fs.unlinkSync(target);
      return {id,confirmed:true,classification:'experimental'};
    } finally {if(held?.ok && !held.alreadyHeld)lock.release(space,'graph');releaseFixture();}
  }
  function findExperiment(id){
    file(id);
    const node=store.loadGraph(repoRoot,space)?.nodes.find(n=>n.id===id);
    if(!node || node.disabled===true || node.kind!=='artifact' || node.source?.type!=='qwen-fixture-experiment' || hash(node.content)!==node.observationDigest) return null;
    return JSON.parse(node.content);
  }
  function setExperimentDisabled(id,disabled){
    file(id);if(typeof disabled!=='boolean')throw Error('Invalid experimental rollback');
    const releaseFixture=acquireFixtureLock(repoRoot,space);
    let held;
    try {
      held=lock.acquire(space,'graph');if(!held.ok || held.alreadyHeld)throw Error('Mind graph lock unavailable');
      const graph=store.loadGraph(repoRoot,space), node=graph?.nodes.find(n=>n.id===id);
      if(!node || node.kind!=='artifact' || node.source?.type!=='qwen-fixture-experiment' || hash(node.content)!==node.observationDigest)throw Error('Experimental observation not found');
      node.disabled=disabled;store.saveGraph(repoRoot,space,graph);
      const confirmed=store.loadGraph(repoRoot,space)?.nodes.find(n=>n.id===id);
      if(confirmed?.disabled!==disabled)throw Error('Rollback read-back failed');
      return {id,disabled,classification:'experimental'};
    } finally {if(held?.ok && !held.alreadyHeld)lock.release(space,'graph');releaseFixture();}
  }
  function pending(){
    const entries=fs.readdirSync(queue);
    if(entries.some(n=>!/^qwen_exp_[a-f0-9]{64}\.json(?:\.[a-f0-9]{24}\.tmp)?$/.test(n)))throw Error('Uncertain queue state');
    return entries.filter(n=>n.endsWith('.json')).map(n=>n.slice(0,-5)).sort();
  }
  function drain(){
    const confirmed=[];
    for(const id of pending()){
      try {confirmed.push(flush(id));}
      catch(e){if(e.message!=='Fixture graph busy')throw e;recoverDeadFixtureLock(repoRoot,space);confirmed.push(flush(id));}
    }
    return confirmed;
  }
  function verifiedLessons(){ return []; } // No promotion to real projects.
  // Observations of one run at a given proof level, in attempt order.
  function findRun(runId,proofLevel){
    if(!/^[a-f0-9]{32}$/.test(runId || '') || !Object.values(PROOF).includes(proofLevel))throw Error('Invalid run query');
    return (store.loadGraph(repoRoot,space)?.nodes||[]).filter(n=>n.kind==='artifact' && n.disabled!==true && n.source?.type==='qwen-fixture-experiment' && hash(n.content)===n.observationDigest)
      .map(n=>JSON.parse(n.content)).filter(r=>r.runId===runId && r.proofLevel===proofLevel).sort((a,b)=>a.attempt-b.attempt);
  }
  return {enqueue,flush,pending,drain,findExperiment,findRun,setExperimentDisabled,verifiedLessons};
}
module.exports={makeFixtureController};
