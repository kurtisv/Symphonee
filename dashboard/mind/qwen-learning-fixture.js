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
const lessonsMod=require('./lessons');
const {retrieveLessons}=require('../brain/mind-context');
// Validated lessons live in the same isolated fixture space, under their own source type.
const LESSON_SOURCE='qwen-fixture-lesson';
const RECALL_SPACE='zzfixturelessons';
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
  // ── Validated lessons (durable, experimental) ───────────────────────────────
  // A lesson reaches this store only with the full proof checked by
  // lessons.validationProblems (independent checks, real tool-free Codex GO,
  // current checker version, shown to the developer, after a repeated blockage).
  // Same method again = one lesson with more independent evidence; a different
  // method for the same error class and task family supersedes the older one.
  // Writes use the same locks as observations and are read back; they do not go
  // through the observation queue (no crash-replay): a failed write is simply retried.
  const lessonParse=n=>{try{const c=JSON.parse(n.content);return hash(n.content)===n.observationDigest?c:null;}catch{return null;}};
  const lessonNodes=g=>(g?.nodes||[]).filter(n=>n.kind==='artifact' && n.source?.type===LESSON_SOURCE);
  const lessonCurrent=(n,c,checkerVersion,now)=>c && n.disabled!==true && c.status==='validated' && c.validation.checkerVersion===checkerVersion && now<c.validation.validUntil;
  function lessonRecord(input,now){
    if(!input || typeof input!=='object' || !isJsonSafe(input) || typeof input.key!=='string') throw Error('Invalid lesson');
    const tp=lessonsMod.teachingProblems(input.teaching); if(tp.length) throw Error('Invalid lesson: '+tp.join(', '));
    const vp=lessonsMod.validationProblems(input.evidence,input.checkerVersion,input.key); if(vp.length) throw Error('Lesson is not validated: '+vp.join('; '));
    const t=input.teaching, ev=input.evidence;
    return {status:'validated',key:input.key,errorClass:t.errorClass,family:t.family,strategyDigest:lessonsMod.digestOf(t.strategy),
      teaching:{cause:t.cause.trim(),strategy:t.strategy.trim(),pitfalls:t.pitfalls.map(x=>x.trim()),verify:t.verify.trim(),source:t.source,model:t.model,tokens:t.tokens},
      validation:{checkerVersion:input.checkerVersion,at:now,validUntil:now+lessonsMod.VALID_DAYS*86400000,codeHash:ev.codeHash,assertionsHash:ev.assertionsHash,diffHash:ev.codex.diffHash,
        reviewTaskId:ev.codex.taskId,reviewerVersion:ev.codex.reviewer.version,independent:{executed:ev.independent.executed,expected:ev.independent.expected},
        blocked:{signature:String(ev.blocked.signature).slice(0,600),failedAttempts:ev.blocked.failedAttempts},evidenceCount:1,
        history:[{runId:ev.runId,at:now,codeHash:ev.codeHash,diffHash:ev.codex.diffHash,reviewTaskId:ev.codex.taskId,checkerVersion:input.checkerVersion}]},
      uses:0,usesSucceeded:0};
  }
  function withGraph(fn){
    const releaseFixture=acquireFixtureLock(repoRoot,space); let held;
    try {
      held=lock.acquire(space,'graph');if(!held.ok || held.alreadyHeld)throw Error('Mind graph lock unavailable');
      const graph=store.loadGraph(repoRoot,space) || store.emptyGraph({space});
      const out=fn(graph); store.saveGraph(repoRoot,space,graph); return out;
    } finally {if(held?.ok && !held.alreadyHeld)lock.release(space,'graph');releaseFixture();}
  }
  const writeLesson=(n,c)=>{n.content=JSON.stringify(c);n.observationDigest=hash(n.content);};
  function upsertLesson(input,now=Date.now()){
    const rec=lessonRecord(input,now);
    const out=withGraph(graph=>{
      const peers=lessonNodes(graph).map(n=>({n,c:lessonParse(n)})).filter(x=>x.c && x.c.status==='validated' && x.n.disabled!==true && x.c.errorClass===rec.errorClass && x.c.family===rec.family);
      const twin=peers.find(x=>x.c.strategyDigest===rec.strategyDigest || lessonsMod.similarity(x.c.teaching.strategy,rec.teaching.strategy)>=lessonsMod.SIMILAR);
      if(twin){
        const c=twin.c, h=rec.validation.history[0];
        if(!c.validation.history.some(x=>x.runId===h.runId)){c.validation.history=[...c.validation.history,h].slice(-5);c.validation.evidenceCount+=1;}
        c.validation.validUntil=rec.validation.validUntil; writeLesson(twin.n,c);
        return {id:twin.n.id,merged:true,superseded:[],evidenceCount:c.validation.evidenceCount};
      }
      const id='qwen_lesson_'+hash(rec.errorClass+'|'+rec.family+'|'+rec.strategyDigest);
      const superseded=[];
      for(const p of peers){p.c.status='obsolete';p.c.obsoleteReason='superseded';p.c.supersededBy=id;writeLesson(p.n,p.c);superseded.push(p.n.id);}
      let node=graph.nodes.find(n=>n.id===id);
      if(!node){node={id,kind:'artifact',label:'EXPERIMENTAL validated lesson ['+rec.errorClass+']',source:{type:LESSON_SOURCE,ref:id},proofLevel:PROOF['codex-fixture'],createdAt:new Date(now).toISOString()};graph.nodes.push(node);}
      node.disabled=false; writeLesson(node,rec);
      return {id,merged:false,superseded,evidenceCount:1};
    });
    const back=lessonParse(lessonNodes(store.loadGraph(repoRoot,space)).find(n=>n.id===out.id)||{});
    if(!back || back.status!=='validated') throw Error('Mind read-back failed');
    return out;
  }
  // Only current validated lessons are returned: right status, not disabled, same
  // checker version, not expired; ranked by the existing Mind lesson retrieval.
  function recallLessons({question,checkerVersion,limit=3,now=Date.now()}={}){
    if(typeof checkerVersion!=='string' || !checkerVersion) throw Error('checkerVersion required');
    const byId=new Map();
    for(const n of lessonNodes(store.loadGraph(repoRoot,space))){const c=lessonParse(n);if(lessonCurrent(n,c,checkerVersion,now))byId.set(n.id,{n,c});}
    const entries=[...byId.values()].map(({n,c})=>({scope:'mind@'+RECALL_SPACE,key:n.id,kind:c.errorClass,text:c.teaching.cause+' '+c.teaching.strategy,count:c.validation.evidenceCount,lastAt:c.validation.history.at(-1).at}));
    return retrieveLessons({all:()=>entries},repoRoot,RECALL_SPACE,Math.min(5,limit),String(question||'')).map(p=>{
      const {n,c}=byId.get(p.id);
      return {id:n.id,key:c.key,errorClass:c.errorClass,family:c.family,teaching:c.teaching,
        provenance:{nodeId:n.id,validatedAt:new Date(c.validation.at).toISOString(),reviewTaskId:c.validation.reviewTaskId,reviewerVersion:c.validation.reviewerVersion,diffHash:c.validation.diffHash,codeHash:c.validation.codeHash,
          checkerVersion:c.validation.checkerVersion,evidenceCount:c.validation.evidenceCount,uses:c.uses,usesSucceeded:c.usesSucceeded,proofLevel:PROOF['codex-fixture']}};
    });
  }
  // Counters only: a lesson shown before a success is NOT thereby proven useful.
  function recordLessonUse(id,success){
    if(!/^qwen_lesson_[a-f0-9]{64}$/.test(id) || typeof success!=='boolean') throw Error('Invalid lesson use');
    withGraph(graph=>{const n=lessonNodes(graph).find(x=>x.id===id),c=n&&lessonParse(n);if(!c)throw Error('Lesson not found');c.uses+=1;if(success)c.usesSucceeded+=1;writeLesson(n,c);});
  }
  function retireLesson(id,reason){
    if(!/^qwen_lesson_[a-f0-9]{64}$/.test(id)) throw Error('Invalid lesson id');
    withGraph(graph=>{const n=lessonNodes(graph).find(x=>x.id===id),c=n&&lessonParse(n);if(!c)throw Error('Lesson not found');c.status='obsolete';c.obsoleteReason=String(reason||'manual').slice(0,80);writeLesson(n,c);});
  }
  // Retires lessons validated under another checker version or past their date.
  function retireStale(checkerVersion,now=Date.now()){
    return withGraph(graph=>{let k=0;for(const n of lessonNodes(graph)){const c=lessonParse(n);if(c && c.status==='validated' && !lessonCurrent(n,c,checkerVersion,now)){c.status='obsolete';c.obsoleteReason=c.validation.checkerVersion!==checkerVersion?'checker-changed':'expired';writeLesson(n,c);k++;}}return k;});
  }
  function listLessons(){return lessonNodes(store.loadGraph(repoRoot,space)).map(n=>({id:n.id,disabled:n.disabled===true,...(lessonParse(n)||{status:'corrupt'})}));}
  return {enqueue,flush,pending,drain,findExperiment,findRun,setExperimentDisabled,verifiedLessons,upsertLesson,recallLessons,recordLessonUse,retireLesson,retireStale,listLessons};
}
module.exports={makeFixtureController};
